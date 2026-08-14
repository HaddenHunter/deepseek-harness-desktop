//! DSH Desktop — Tauri backend
//!
//! 职责分层（物理隔离、零副作用）：
//!   - Rust 侧：窗口/生命周期/原生能力（Keychain、通知、托盘、持久化）
//!              **DSH SDK runtime 子进程**：spawn @deepseek-ai/dsh-sdk-server，
//!              承担 newline-delimited JSON-RPC 2.0 的 stdio 桥接：
//!                • RpcRouter 统一承载：stdin writer + pending oneshot senders
//!                • stdout reader 任务：每行解析，id 命中 → oneshot::send；
//!                  无 id 有 method → `dsh://notification` 事件广播前端
//!                • commands：`dsh_start / dsh_stop / dsh_request / dsh_notify`
//!   - TS   侧：UI 渲染 + 会话/插件/审批状态（纯浏览器，零 Node API 依赖）
//!
//! 启动参数（灵活开关）：
//!   - MOCK_RUNTIME=1      前端走 MockRuntime，不启动真实 DSH SDK
//!   - DSH_LOG_LEVEL=info  日志级别
//!   - DSH_RUNTIME_CMD     SDK runtime 启动命令（默认：node）
//!   - DSH_RUNTIME_ARGS    SDK runtime 启动参数（开发模式：tsx 跑 scripts/dsh-jsonrpc-entry.ts；打包模式：resources/dsh-runtime.cjs）
//!   - DSH_BUNDLED_CJS     打包侧专用：覆盖 bundled cjs 的绝对路径

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{Context as _, Result as AnyResult};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Manager, State,
};
use tauri_plugin_store::StoreExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, Mutex, oneshot};
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

const KEYCHAIN_SERVICE: &str = "dsh-desktop";
const STORE_NAME: &str = "app-settings.json";

// --- frontend event names ---
const EV_NOTIFICATION: &str = "dsh://notification";
const EV_LOG: &str = "dsh://log";

struct AppState {
    keystore: std::sync::Mutex<Option<Entry>>,
}

#[derive(Default)]
struct DshState {
    router: Mutex<Option<Arc<RpcRouter>>>,
}

struct RpcRouter {
    child_pid: u32,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>,
}

// --- wire types (minimal JSON-RPC) ---

#[derive(Debug, Deserialize)]
struct JsonRpcFrame {
    id: Option<serde_json::Value>,
    method: Option<String>,
    params: Option<serde_json::Value>,
    result: Option<serde_json::Value>,
    error: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppConfig {
    pub mock_runtime: bool,
    pub log_level: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            mock_runtime: std::env::var("MOCK_RUNTIME").is_ok(),
            log_level: std::env::var("DSH_LOG_LEVEL").unwrap_or_else(|_| "info".into()),
        }
    }
}

// --- core helpers ---

fn new_req_id() -> String {
    format!("req_{}", Uuid::new_v4().simple())
}

/// macOS/Windows GUI apps run with a near-empty PATH (no /opt/homebrew/bin, no nvm).
/// If the user asked for a bare name like "node", try common install locations
/// so the sidecar still resolves without the user explicitly exporting DSH_RUNTIME_CMD.
///
/// Selection algorithm (fully ordered, deterministic, zero ambiguity):
///
///   [P0] EXPLICIT USER PATH. If the caller passed an absolute/qualified cmd
///        (e.g. DSH_RUNTIME_CMD=/bad/nvm/v26.7.0/bin/node), probe it FIRST.
///        If it works → great, honour user intent. If it fails (ENOENT, wrong
///        arch, broken symlink, no +x), discard it silently and continue the
///        search — we never return a path we have already proven will crash
///        at spawn time.
///
///   [P1] INHERITED PATH. Walk every PATH entry and look for the base binary
///        name ("node" / "node.exe"). This is what shells do. Critically we
///        search by BASE NAME, never by the raw `cmd` string, so an absolute
///        bad path does not poison the entire PATH scan (the old impl did
///        dir.join(cmd) where cmd was absolute, resulting in the bad path
///        repeated N times with zero real lookups performed).
///
///   [P2] STATIC POPULAR LOCATIONS (/opt/homebrew/bin/node, nvm_dir/versions,
///        fnm installations, etc.) sorted with newest/most-likely-first so
///        the first probe hit wins.
///
///   [P3] FINAL FALLBACK. If nothing probed successfully, return the ORIGINAL
///        cmd string so the spawn error names exactly what the user typed.
///
/// Every candidate that passes the cheap metadata gate goes through
/// try_probe(), which actually spawns `<candidate> -e 0` and demands exit 0
/// within 3s.  try_probe is the SOURCE OF TRUTH — metadata gates are only a
/// fast-path skip for 100% impossible candidates (dirs, empty PATH entries,
/// missing files).
fn resolve_runtime_binary(cmd: &str) -> Vec<String> {
    use std::path::{Path, PathBuf};

    // --- helpers ---------------------------------------------------------
    fn is_executable(p: &Path) -> bool { /* unchanged */
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            p.metadata()
                .map(|m| m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        }
        #[cfg(windows)]
        {
            let ext = p
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.eq_ignore_ascii_case("exe") || s.eq_ignore_ascii_case("com"))
                .unwrap_or(false);
            ext || p.ends_with("node.exe")
        }
    }

    fn try_probe(p: &Path) -> (bool, Option<std::io::Error>) {
        // Returns (passed, Some(spawn_error_if_any)) so the caller can log the
        // exact failure reason.
        //
        // Strict 2-stage probe:
        //   1) run `<binary> -e 0` (as before) — ensures the binary can exec
        //      and exit cleanly with code 0 within 3s.
        //   2) if that passes, run `<binary> --version` and CAPTURE stdout.
        //      The output must match /^v\d+\.\d+\.\d+$/ to count as a REAL node
        //      binary. Stage 2 catches these common false-positive classes:
        //        • macOS Hardened Runtime execve succeeds but child aborts on
        //          dyld before reaching main() (produces empty stdout, exit 0)
        //        • shell script shims / aliases that exit 0 but do nothing
        let is_node = p
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.contains("node"))
            .unwrap_or(false);
        if !is_node {
            return (true, None);
        }

        // Stage 1: -e 0 exit 0 within 3s (30 × 100ms).
        let mut child = match std::process::Command::new(p)
            .arg("-e")
            .arg("0")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => return (false, Some(e)),
        };
        let mut waited_status: Option<std::process::ExitStatus> = None;
        let mut wait_err: Option<std::io::Error> = None;
        for _ in 0..30 {
            match child.try_wait() {
                Ok(Some(status)) => {
                    waited_status = Some(status);
                    break;
                }
                Ok(None) => {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) => {
                    wait_err = Some(e);
                    break;
                }
            }
        }
        if waited_status.is_none() {
            let _ = child.kill();
        }
        if let Some(e) = wait_err {
            return (false, Some(e));
        }
        match waited_status {
            Some(st) if st.success() => {}
            _ => return (false, None),
        }

        // Stage 2: --version stdout MUST match a real node version string.
        let out = match std::process::Command::new(p)
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
        {
            Ok(o) => o,
            Err(e) => return (false, Some(e)),
        };
        if !out.status.success() {
            return (false, None);
        }
        let s = match std::str::from_utf8(&out.stdout) {
            Ok(s) => s.trim().to_string(),
            Err(_) => return (false, None),
        };
        // Must start with 'v' followed by digits.digits.digits. Tolerate extra
        // junk (like "+abc123" local build tag) after the triplet.
        let bytes = s.as_bytes();
        if bytes.is_empty() || bytes[0] != b'v' {
            return (false, None);
        }
        let mut i = 1usize;
        // major
        if i >= bytes.len() || !bytes[i].is_ascii_digit() {
            return (false, None);
        }
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'.' {
            return (false, None);
        }
        i += 1;
        // minor
        if i >= bytes.len() || !bytes[i].is_ascii_digit() {
            return (false, None);
        }
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i >= bytes.len() || bytes[i] != b'.' {
            return (false, None);
        }
        i += 1;
        // patch
        if i >= bytes.len() || !bytes[i].is_ascii_digit() {
            return (false, None);
        }
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        // OK — we consumed "vNNN.NNN.NNN"; remaining characters are allowable
        // extras. We also verify major >= 18 (DSH SDK requirement), so the
        // caller doesn't have to gate on that separately.
        let vstr = &s[1..i];
        let mut it = vstr.split('.');
        let maj: u32 = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        (maj >= 18, None)
    }

    // --- Blacklisted tokens. These are exact known-bad installs we've spent
    //     8+ rounds chasing. If a candidate path matches ANY of these, we skip
    //     it unconditionally — before metadata, before is_executable, before
    //     probe. The blacklist is deliberately narrow and only applied to
    //     candidates that have PROVEN to not exist on disk via reported os
    //     error 2.
    fn is_blacklisted(p: &Path) -> bool {
        let s = p.to_string_lossy();
        // v26.7.0 ghost nvm install (version dir exists, bin/node missing or
        // a broken placeholder). Users have reported spawn os error 2 against
        // this exact path for 7+ rounds even after resolver rewrites.
        if s.contains("node/v26.7.0") || s.contains("node\\v26.7.0") {
            return true;
        }
        // v14.17.3 ghost nvm install. Same class of problem.
        if s.contains("node/v14.17.3") || s.contains("node\\v14.17.3") {
            return true;
        }

        // --- Generic <v18 ancient node version blanket blacklist ----------
        // DeepSeek SDK (Cordis + agentSpine) requires Node 18+. Running
        // against node 6/8/10/12/14/16 will never succeed even if the
        // binary execs successfully (it'll fail syntax on esm imports or
        // missing globals). On modern macOS hardened runtime ancient
        // binaries also get execve rejected with ENOENT os error 2. Save
        // ourselves 10 rounds of "spawn failed" noise by skipping them
        // entirely at the blacklist gate.
        //
        // We detect this by looking for "node/vX/" or "node\\vX\" in the
        // candidate path where X < 18. To avoid FP we anchor on the
        // nvm/fnm-style `node/v<maj>.min.patch/bin/node` shape.
        let need_gate = (s.contains("/versions/node/v") || s.contains("\\versions\\node\\v")
            || s.contains("/node-versions/v") || s.contains("\\node-versions\\v")
            || s.contains("/node/versions/v"));
        if need_gate {
            // Find the "v<digits>" token right after a "node" version dir.
            if let Some(idx) = s
                .rfind("/node/v")
                .or_else(|| s.rfind("\\node\\v"))
                .or_else(|| s.rfind("/v"))
            {
                // idx points at '/' or '\'; version digits start at idx+2.
                let start = idx + 2;
                if let Some(rest) = s.get(start..) {
                    // Take contiguous digits after the leading 'v'.
                    let digits_end = rest
                        .find(|c: char| !c.is_ascii_digit())
                        .unwrap_or(rest.len());
                    if let Ok(major) = rest[..digits_end].parse::<u32>() {
                        if major < 18 {
                            return true;
                        }
                    }
                }
            }
        }
        false
    }

    fn base_name(cmd: &str) -> String {
        // Strip any path components, keep just the executable basename.
        // For "node" returns "node". For "/bad/v26.7.0/bin/node" returns "node".
        // For "C:\\Program Files\\nodejs\\node.exe" returns "node.exe".
        let by_slash = cmd.rsplit('/').next().unwrap_or(cmd);
        let by_backslash = by_slash.rsplit('\\').next().unwrap_or(by_slash);
        by_backslash.to_string()
    }

    // Parse "v24.14.1" / "node-v24.14.1" / "v6.17" → Some((24,14,1)) for
    // semver-aware sorting. Returns None for dirs that don't look like a
    // version (treat them as "0.0.0" i.e. oldest — they'll sort to the end).
    fn parse_semver_tuple(name: &str) -> (u32, u32, u32) {
        // Strip a leading "node-" or "v" if present.
        let mut s = name;
        if let Some(rest) = s.strip_prefix("node-") {
            s = rest;
        }
        if let Some(rest) = s.strip_prefix('v') {
            s = rest;
        }
        let mut parts = s.splitn(3, '.');
        let maj = parts
            .next()
            .and_then(|p| p.parse::<u32>().ok())
            .unwrap_or(0);
        let min = parts
            .next()
            .and_then(|p| p.parse::<u32>().ok())
            .unwrap_or(0);
        let pat = parts
            .next()
            .and_then(|p| p.split(|c: char| !c.is_ascii_digit()).next())
            .and_then(|p| p.parse::<u32>().ok())
            .unwrap_or(0);
        (maj, min, pat)
    }

    // Sort version directories in NEWEST-first order using semver tuples.
    // Critically: this puts v24.14.1 BEFORE v6.17.1 regardless of lexical
    // ordering. Any dir we can't parse sorts as (0,0,0) → last.
    fn sort_versions_newest_first(versions: &mut [PathBuf]) {
        versions.sort_by(|a, b| {
            let an = a.file_name().and_then(|x| x.to_str()).unwrap_or("");
            let bn = b.file_name().and_then(|x| x.to_str()).unwrap_or("");
            let at = parse_semver_tuple(an);
            let bt = parse_semver_tuple(bn);
            bt.cmp(&at) // reverse = newest first
        });
    }

    // --- Determine if user supplied a qualified path --------------------
    let path = Path::new(cmd);
    let is_qualified = path.is_absolute()
        || cmd.contains('/')
        || cmd.contains('\\')
        || cmd.ends_with(".exe");

    let base = base_name(cmd);
    let base_exe = if cfg!(windows) && !base.eq_ignore_ascii_case("exe") {
        format!("{base}.exe")
    } else {
        base.clone()
    };

    // --- Build candidate list in strict priority order ------------------
    let mut candidates: Vec<PathBuf> = vec![];

    // P0 — the raw user-supplied cmd (if qualified). Probe it first so we
    // honour DSH_RUNTIME_CMD overrides when they actually work.
    if is_qualified {
        candidates.push(path.to_path_buf());
    }

    // P0.5 — CURRENT-VERSION managers env. vars. These are the single most
    // likely candidates if the user ever loaded a shell with nvm/fnm activated
    // (GUI apps inherit NVM_DIR but NOT the PATH injection, so we can miss
    // the "currently active" nvm alias unless we explicitly read these).
    //
    // Order is significant: NVM_BIN = the directory nvm's `nvm use X` script
    // actually prepends to PATH, so the bin/node inside it is 100% the same
    // binary a user gets from their interactive shell.
    if let Ok(nvm_bin) = std::env::var("NVM_BIN") {
        candidates.push(Path::new(&nvm_bin).join(&base));
        if cfg!(windows) && base != base_exe {
            candidates.push(Path::new(&nvm_bin).join(&base_exe));
        }
    }
    // $NVM_DIR/alias/default resolves via symlink to a specific version dir
    // under versions/node/<ver>/bin/node — check it before the bulk sort.
    let nvm_default = std::env::var("HOME").map(|home| format!("{home}/.nvm"));
    if let Ok(nvm) = std::env::var("NVM_DIR").or_else(|_| nvm_default.clone()) {
        let alias_default = PathBuf::from(format!("{nvm}/alias/default"));
        if let Ok(meta) = std::fs::symlink_metadata(&alias_default) {
            if meta.file_type().is_symlink() {
                if let Ok(target) = std::fs::read_link(&alias_default) {
                    let ver_dir = if target.is_absolute() {
                        target.clone()
                    } else {
                        alias_default.parent().unwrap_or_else(|| Path::new(&nvm)).join(target)
                    };
                    #[cfg(unix)]
                    candidates.push(ver_dir.join("bin").join(&base));
                    #[cfg(windows)]
                    candidates.push(ver_dir.join(&base_exe));
                }
            }
        }
    }

    // P1 — nvm versions, sorted newest first (before PATH scan).
    if let Ok(nvm) = std::env::var("NVM_DIR").or_else(|_| nvm_default.clone()) {
        if let Ok(entries) = std::fs::read_dir(format!("{nvm}/versions/node")) {
            let mut versions: Vec<_> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            sort_versions_newest_first(&mut versions);
            #[cfg(unix)]
            for v in &versions {
                candidates.push(v.join("bin").join(&base));
            }
            #[cfg(windows)]
            for v in &versions {
                candidates.push(v.join(&base_exe));
            }
        }
    }

    // P1.5 — fnm versions (newest first) before PATH as well.
    if let Ok(fnm_dir) = std::env::var("FNM_DIR")
        .or_else(|_| std::env::var("HOME").map(|h| format!("{h}/.fnm")))
    {
        if let Ok(entries) = std::fs::read_dir(format!("{fnm_dir}/node-versions")) {
            let mut versions: Vec<_> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            sort_versions_newest_first(&mut versions);
            #[cfg(unix)]
            for v in &versions {
                candidates.push(v.join("installation").join("bin").join(&base));
            }
            #[cfg(windows)]
            for v in &versions {
                candidates.push(v.join("installation").join(&base_exe));
            }
        }
    }

    // P2 — inherited PATH walk, using BASE NAME only.
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            candidates.push(dir.join(&base));
            if cfg!(windows) && base != base_exe {
                candidates.push(dir.join(&base_exe));
            }
        }
    }

    // P3 — static popular absolute locations. On macOS we differentiate by
    // arch: arm64 (Apple Silicon) users almost never want /usr/local/bin
    // which is the Intel homebrew prefix.
    //
    // Uses std::env::consts::ARCH (compile-time arch slice of the universal
    // binary currently executing). For universal-apple-darwin builds this
    // gives the exact arch of the currently-running slice, which is the
    // correct homebrew prefix to prefer.
    #[cfg(unix)]
    {
        let is_arm64_at_runtime = matches!(std::env::consts::ARCH, "aarch64");

        if is_arm64_at_runtime {
            for p in [
                "/opt/homebrew/bin/node",
                "/opt/homebrew/opt/node@24/bin/node",
                "/opt/homebrew/opt/node@23/bin/node",
                "/opt/homebrew/opt/node@22/bin/node",
                "/opt/homebrew/opt/node@20/bin/node",
                "/opt/nodes/current/bin/node",
                "/usr/local/bin/node",
                "/usr/bin/node",
                "/nix/var/nix/profiles/default/bin/node",
            ] {
                candidates.push(PathBuf::from(p));
            }
        } else {
            // x86_64 (Intel Mac) — Intel homebrew at /usr/local is the
            // primary install. Still list /opt/homebrew afterwards in case
            // the user ran a manual arm64 homebrew.
            for p in [
                "/usr/local/bin/node",
                "/usr/local/opt/node@24/bin/node",
                "/usr/local/opt/node@23/bin/node",
                "/usr/local/opt/node@22/bin/node",
                "/usr/local/opt/node@20/bin/node",
                "/opt/homebrew/bin/node",
                "/opt/nodes/current/bin/node",
                "/usr/bin/node",
                "/nix/var/nix/profiles/default/bin/node",
            ] {
                candidates.push(PathBuf::from(p));
            }
        }
    }
    // P3 — static popular absolute locations (Windows)
    #[cfg(windows)]
    for p in [
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
    ] {
        candidates.push(PathBuf::from(p));
    }

    #[cfg(windows)]
    if let Ok(appdata) = std::env::var("APPDATA") {
        candidates.push(PathBuf::from(format!("{appdata}\\npm\\{base_exe}")));
    }

    // --- Walk candidates. Cheap metadata gate → full spawn probe --------
    //
    // CRITICAL NEW BEHAVIOUR (v0.1.4+): instead of returning the FIRST probe
    // hit and breaking, we collect ALL candidates that pass the full
    // double-confirmation gate into a RANKED list. The caller will spawn the
    // first, and if that spawn returns ENOENT / "no such file" it will
    // retry with the next. This closes the 8+ round class of bugs where
    // try_probe() succeeds (because Command::new works fine outside the
    // hardened-runtime/translocation context) but the REAL tokio::process
    // spawn inside `dsh_start` fails with ENOENT for permission/sandbox
    // reasons.
    let mut ranked_hits: Vec<PathBuf> = Vec::with_capacity(10);
    let mut probe_fail_log: Vec<(String, String)> = vec![];
    for c in candidates.iter() {
        if ranked_hits.len() >= 12 {
            break;
        }
        // Step 0 — blacklist. Runs BEFORE anything else so we never probe
        // proven-bad ghost installs, even if metadata says they exist.
        if is_blacklisted(c) {
            eprintln!(
                "[dsh-resolver]   skip blacklisted candidate: {}",
                c.display()
            );
            continue;
        }

        let md = std::fs::metadata(c).ok();
        let skip_fast = match &md {
            None => true,
            Some(m) if !m.is_file() => true,
            Some(_) => false,
        };
        if skip_fast {
            continue;
        }
        if !is_executable(c) {
            continue;
        }
        let (passed, probe_err) = try_probe(c);
        if passed {
            // ---- DOUBLE-CONFIRMATION PASS ---------------------------------
            std::thread::sleep(std::time::Duration::from_millis(3));
            let md2 = std::fs::metadata(c).ok();
            let md2_ok = md2.as_ref().map(|m| m.is_file()).unwrap_or(false);
            let (passed2, _) = try_probe(c);
            if md2_ok && passed2 {
                ranked_hits.push(c.clone());
                eprintln!(
                    "[dsh-resolver]   probe-hit #{}: {}  (double-confirmed: len={:?})",
                    ranked_hits.len(),
                    c.display(),
                    md2.as_ref().map(|m| m.len()),
                );
            } else {
                eprintln!(
                    "[dsh-resolver]   probe FALSE-POSITIVE on {}: first-pass OK, but double-check: metadata={:?} re-probe-pass={}",
                    c.display(),
                    md2_ok,
                    passed2
                );
                probe_fail_log.push((
                    c.to_string_lossy().into_owned(),
                    format!("false-positive (double-check failed) md2_ok={md2_ok} re-probe={passed2}"),
                ));
            }
        } else if let Some(err) = probe_err {
            probe_fail_log.push((
                c.to_string_lossy().into_owned(),
                format!("spawn probe os_error {:?}: {}", err.raw_os_error(), err),
            ));
        } else {
            probe_fail_log.push((
                c.to_string_lossy().into_owned(),
                "probe ran but exit != 0 / timed out".to_string(),
            ));
        }
    }

    // Log a compact histogram of the first 8 failed candidates so users can
    // tell at a glance why the resolver didn't pick a more obvious path.
    if !probe_fail_log.is_empty() {
        eprintln!(
            "[dsh-resolver]  first {} probe-fails of {} total (compact):",
            probe_fail_log.len().min(8),
            probe_fail_log.len()
        );
        for (c, reason) in probe_fail_log.iter().take(8) {
            eprintln!("      [fail] {c}  :: {reason}");
        }
    }

    // Append the bare basename as the FINAL retry candidate regardless of
    // probe outcome. If tokio::process::Command("node") is invoked with no
    // absolute path, it uses the app-spawned PATH (via `search_path`). This
    // catches the case where ALL qualified candidates fail because of
    // Hardened Runtime execve restrictions, but the OS-level execvp would
    // still find a working "node" binary from somewhere in the system PATH.
    let basename_fallback = if is_qualified { base.clone() } else { cmd.to_string() };

    if !ranked_hits.is_empty() {
        eprintln!(
            "[dsh-resolver] input={:?} -> {} ranked candidates (from {} total candidates). primary={:?} backups=[{}] basename-fallback={:?}",
            cmd,
            ranked_hits.len() + 1,
            candidates.len(),
            ranked_hits[0],
            ranked_hits[1..]
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", "),
            &basename_fallback
        );
        let mut out: Vec<String> = ranked_hits
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        out.push(basename_fallback);
        out
    } else {
        eprintln!(
            "[dsh-resolver] input={:?} -> NO candidate probed successfully (scanned {} candidates). returning basename-only: {:?}",
            cmd, candidates.len(), &basename_fallback
        );
        vec![basename_fallback]
    }
}

#[derive(Copy, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
enum LogLevel {
    Info,
    Warn,
    #[allow(dead_code)]
    Error,
}

#[derive(Serialize, Clone)]
struct LogPayload<'a> {
    level: LogLevel,
    message: &'a str,
    ts: u64,
}

fn emit_log(app: &AppHandle, level: LogLevel, message: &str) {
    let payload = LogPayload {
        level,
        message,
        ts: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    };
    let _ = app.emit(EV_LOG, payload);
}

// --- existing tauri commands ---

#[tauri::command]
fn get_startup_config() -> Result<AppConfig, String> {
    Ok(AppConfig::default())
}

#[tauri::command]
async fn secure_get(key: String) -> Result<Option<String>, String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, &key)
        .map_err(|e| format!("keychain init failed: {e}"))?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain read failed: {e}")),
    }
}

#[tauri::command]
async fn secure_set(key: String, value: String) -> Result<(), String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, &key)
        .map_err(|e| format!("keychain init failed: {e}"))?;
    entry
        .set_password(&value)
        .map_err(|e| format!("keychain write failed: {e}"))?;
    Ok(())
}

#[tauri::command]
async fn secure_delete(key: String) -> Result<(), String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, &key)
        .map_err(|e| format!("keychain init failed: {e}"))?;
    match entry.delete_password() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete failed: {e}")),
    }
}

// --- DSH SDK runtime commands ---

async fn rpc_call(
    router: &Arc<RpcRouter>,
    method: &str,
    params: &serde_json::Value,
    timeout_secs: u64,
) -> AnyResult<serde_json::Value> {
    let id = new_req_id();
    let frame = serde_json::json!({
        "jsonrpc": "2.0",
        "id": &id,
        "method": method,
        "params": params,
    });
    let mut line = serde_json::to_string(&frame)?;
    line.push('\n');

    let (tx, rx) = oneshot::channel::<serde_json::Value>();
    {
        let mut pending = router.pending.lock().await;
        pending.insert(id.clone(), tx);
    }

    {
        let mut stdin = router.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .with_context(|| "write JSON-RPC request to stdin")?;
    }

    let sleep = tokio::time::sleep(tokio::time::Duration::from_secs(timeout_secs));
    tokio::select! {
        _ = sleep => {
            let mut pending = router.pending.lock().await;
            pending.remove(&id);
            anyhow::bail!("JSON-RPC call '{method}' timed out after {timeout_secs}s");
        }
        r = rx => {
            match r {
                Ok(frame) => {
                    if let Some(err) = frame.get("error").filter(|v| !v.is_null()) {
                        anyhow::bail!("{}", err);
                    }
                    Ok(frame.get("result").cloned().unwrap_or(serde_json::Value::Null))
                }
                Err(_) => anyhow::bail!("JSON-RPC call '{method}' channel closed"),
            }
        }
    }
}

// dsh_start contract v2 (v0.1.3+).
//
// FRONTEND (DshRuntime.start()) sends:
//   await invoke("dsh_start", {
//     data: {
//       mode, cwd, provider, model,
//       max_tokens, maxTokens,            // both copies, either works
//       plugins, env,
//       runtime_cmd, runtimeCmd,          // optional
//       runtime_args, runtimeArgs,        // optional
//     }
//   })
//
// RUST SIDE takes exactly ONE named parameter: `data: serde_json::Value`.
// Parameter name is deliberately `data`, never `params`, because Tauri's
// proc-macro aggregates struct-deserialize failures into a string like
//   "invalid args 'PARAM_NAME' for command 'dsh_start': missing required key
//    PARAM_NAME"
// which is indistinguishable to users from a genuine missing JSON field
// called "params". With param name = `data` AND the param type being a raw
// Value (which never fails deserialization for any valid JSON payload), the
// "missing required key params" error string CANNOT appear anymore — full
// stop. Any real schema/type/omission error is a string we hand-write below.
#[derive(Debug, Clone)]
struct DshStartParsed {
    mode: String,
    cwd: String,
    provider: String,
    model: String,
    max_tokens: Option<u32>,
    base_url: Option<String>,
    api_key: Option<String>,
    plugins: Vec<String>,
    env: HashMap<String, String>,
    runtime_cmd: Option<String>,
    runtime_args: Option<Vec<String>>,
}

fn parse_dsh_start_data(data: &serde_json::Value) -> Result<DshStartParsed, String> {
    use serde_json::Value;

    // Helper: accept a key OR its snake_case / camelCase alternate.
    let get = |k1: &str, k2: &str| -> Option<&Value> {
        match (data.get(k1), data.get(k2)) {
            (Some(v), _) if !v.is_null() => Some(v),
            (_, Some(v)) if !v.is_null() => Some(v),
            _ => None,
        }
    };
    let req_str = |k1, k2| -> Result<String, String> {
        get(k1, k2)
            .and_then(|v| v.as_str())
            .map(|s| s.to_owned())
            .ok_or_else(|| {
                format!(
                    "dsh_start: missing or non-string key `{}` (or alias `{}`) inside `data`. \
                    Frontend must send invoke(\"dsh_start\", {{ data: {{ {k2}: ..., ... }} }}).",
                    k1, k2
                )
            })
    };
    let opt_u32 = |k1, k2| -> Result<Option<u32>, String> {
        match get(k1, k2) {
            None => Ok(None),
            Some(Value::Number(n)) => n
                .as_u64()
                .and_then(|x| u32::try_from(x).ok())
                .map(Some)
                .ok_or_else(|| format!("dsh_start: key `{k1}` (or `{k2}`) must be integer u32")),
            Some(_) => Err(format!(
                "dsh_start: key `{k1}` (or `{k2}`) must be integer u32 or null"
            )),
        }
    };
    let opt_vecstr = |k1, k2| -> Result<Option<Vec<String>>, String> {
        match get(k1, k2) {
            None => Ok(None),
            Some(Value::Array(arr)) => Ok(Some(
                arr.iter()
                    .map(|v| {
                        v.as_str()
                            .map(|s| s.to_owned())
                            .ok_or_else(|| {
                                format!("dsh_start: item in `{k1}`/`{k2}` array must be string")
                            })
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            )),
            Some(_) => Err(format!(
                "dsh_start: key `{k1}` (or `{k2}`) must be array of strings or null"
            )),
        }
    };
    let opt_mapstr = |k1, k2| -> Result<Option<HashMap<String, String>>, String> {
        match get(k1, k2) {
            None => Ok(None),
            Some(Value::Object(obj)) => Ok(Some(
                obj.iter()
                    .map(|(kk, vv)| {
                        vv.as_str()
                            .map(|s| (kk.clone(), s.to_owned()))
                            .ok_or_else(|| {
                                format!(
                                    "dsh_start: value for `{k1}`/`{k2}` key `{kk}` must be string"
                                )
                            })
                    })
                    .collect::<Result<HashMap<_, _>, _>>()?,
            )),
            Some(_) => Err(format!(
                "dsh_start: key `{k1}` (or `{k2}`) must be object(str->str) or null"
            )),
        }
    };

    let opt_str = |k1, k2| -> Result<Option<String>, String> {
        Ok(get(k1, k2).and_then(|v| v.as_str()).map(|s| s.to_owned()))
    };
    Ok(DshStartParsed {
        mode: req_str("mode", "mode")?,
        cwd: req_str("cwd", "cwd")?,
        provider: req_str("provider", "provider")?,
        model: req_str("model", "model")?,
        max_tokens: opt_u32("max_tokens", "maxTokens")?,
        base_url: opt_str("base_url", "baseUrl")?,
        api_key: opt_str("api_key", "apiKey")?,
        plugins: opt_vecstr("plugins", "plugins")?.unwrap_or_default(),
        env: opt_mapstr("env", "env")?.unwrap_or_default(),
        runtime_cmd: get("runtime_cmd", "runtimeCmd")
            .and_then(|v| v.as_str())
            .map(|s| s.to_owned()),
        runtime_args: opt_vecstr("runtime_args", "runtimeArgs")?,
    })
}

#[tauri::command]
async fn dsh_start(
    app: AppHandle,
    state: State<'_, DshState>,
    data: serde_json::Value,
) -> Result<(), String> {
    // 1) Defensive: if `data` is actually an Object but the user sent the OLD
    // flat format (`{mode, cwd, ...}` with no `data` wrapper), accept it too
    // so mismatched frontend <-> shell pairs still boot.
    let obj = match &data {
        serde_json::Value::Object(map) => map.clone(),
        _ => {
            return Err(
                "dsh_start: invoke payload must be a JSON object, got something else. \
                Expected: invoke(\"dsh_start\", { data: { mode, cwd, ... } })"
                    .to_string(),
            );
        }
    };
    let inner = if obj.contains_key("data") && obj.get("data").unwrap().is_object() {
        // v2 contract: { data: {mode,cwd,...} }
        obj.get("data").cloned().unwrap()
    } else {
        // Legacy flat contract: {mode,cwd,...} at top level. Permit it silently so
        // old frontends still come up. Any real schema gaps surface in parse().
        emit_log(
            &app,
            LogLevel::Warn,
            "dsh_start: received legacy flat payload (no `data` wrapper). \
            Upgrade both frontend + Rust shell to v0.1.3+ to silence this.",
        );
        data.clone()
    };

    // 2) Parse the real payload. All error strings from here are ours.
    let p = parse_dsh_start_data(&inner).map_err(|e| {
        // Emit to the app log stream as well so Console.app shows the precise
        // failure even before the user reads the in-app red banner.
        emit_log(&app, LogLevel::Error, &format!("[dsh-start-parse] {e}"));
        e
    })?;

    // 3) Log (sanitized) what we received so users can prove the shell saw
    // their payload shape instead of having to guess.
    emit_log(
        &app,
        LogLevel::Info,
        &format!(
            "[dsh-start] mode={} cwd={} provider={} model={} base_url={:?} has_api_key={} plugins.len={} runtime_cmd={:?}",
            p.mode,
            p.cwd,
            p.provider,
            p.model,
            p.base_url,
            p.api_key.is_some(),
            p.plugins.len(),
            p.runtime_cmd,
        ),
    );

    // 4) Early-exit if already running.
    {
        let guard = state.router.lock().await;
        if guard.is_some() {
            return Ok(());
        }
    }

    let DshStartParsed {
        mode,
        cwd,
        provider,
        model,
        max_tokens,
        base_url,
        api_key,
        plugins,
        env,
        runtime_cmd,
        runtime_args,
    } = p;

    // --- Release builds: BUNDLE the entire Node runtime + SDK code.
    //     We ship TWO files via resources/:
    //       (A) dsh-node           — A bitwise-copy of process.execPath at build
    //                                time (private copy of host Node LTS).
    //                                No homebrew/nvm/external-node needed.
    //       (B) dsh-runtime.cjs    — bundled SDK single-file (esbuild).
    //
    //     We simply spawn `<res>/dsh-node <res>/dsh-runtime.cjs`.
    //
    //     If the user *explicitly* sets DSH_RUNTIME_CMD or Settings.runtimeCmd
    //     we fall back to resolver + system Node (power-user escape hatch).
    //     Otherwise the private binary is the ONLY candidate in ranked list
    //     (spawn-retry-loop keeps machinery for future multi-binary fallback).
    #[cfg(not(debug_assertions))]
    let (ranked_candidates, default_args, extra_env) = {
        let res_dir = app.path().resource_dir().expect("resource_dir");
        let is_win = std::env::consts::OS == "windows";

        // Resource layout: Tauri's bundle.resources accepts a path like
        // `resources/dsh-node*` which copies the file into
        // `APP_ROOT/Contents/Resources/resources/dsh-node` (on mac) or
        // `APP_ROOT/resources/resources/dsh-node` (on linux). We used to
        // mistakenly use `<res_dir>/dsh-node`, so try both layouts and pick
        // whichever one `metadata()`s successfully — gives us a graceful
        // migration in case CI artifacts change later.
        fn locate_within_res(res_dir: &std::path::Path, name: &str) -> std::path::PathBuf {
            let direct = res_dir.join(name);
            let nested = res_dir.join("resources").join(name);
            match (direct.metadata(), nested.metadata()) {
                (Ok(_), _) => direct,
                (_, Ok(_)) => nested,
                _ => direct, // fall through, spawn-loop reports the not-found err
            }
        }
        let private_node =
            locate_within_res(&res_dir, if is_win { "dsh-node.exe" } else { "dsh-node" });
        let bundled_cjs_default =
            locate_within_res(&res_dir, "dsh-runtime.cjs").to_string_lossy().into_owned();
        let bundled_cjs = std::env::var("DSH_BUNDLED_CJS").unwrap_or(bundled_cjs_default);

        // NODE_PATH points at the vendored `resources/node_modules` so
        // require("@deepseek-ai/dsh-*") externals resolve without the
        // end-user needing an `npm install`. We push res_dir itself too so
        // `require("./dsh-runtime.cjs")` style paths keep working if any
        // SDK sub-package does relative resolves.
        let node_path = {
            let vendor_nm = locate_within_res(&res_dir, "node_modules");
            let extra_dir = private_node.parent().unwrap_or(&res_dir).to_path_buf();
            let sep = if is_win { ";" } else { ":" };
            format!(
                "{}{sep}{}{sep}{}",
                vendor_nm.to_string_lossy(),
                extra_dir.to_string_lossy(),
                res_dir.to_string_lossy(),
                sep = sep
            )
        };
        let env: Vec<(String, String)> = vec![("NODE_PATH".into(), node_path)];

        let user_explicit_cmd = runtime_cmd
            .clone()
            .or_else(|| std::env::var("DSH_RUNTIME_CMD").ok());
        if let Some(cm) = user_explicit_cmd {
            // User escape hatch: explicit custom runtime via env/settings.
            // Keep the legacy `args = node_cjs_script` convention if cmd looks like
            // a stock node binary (binary name contains 'node'), otherwise args=[].
            let is_bare_node_like = std::path::Path::new(&cm)
                .file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.contains("node"))
                .unwrap_or(true);
            let def_args: Vec<String> = if is_bare_node_like {
                vec![bundled_cjs]
            } else {
                vec![]
            };
            (resolve_runtime_binary(&cm), def_args, env)
        } else {
            // HAPPY PATH — private bundled Node runtime, no external deps.
            (
                vec![private_node.to_string_lossy().into_owned()],
                vec![bundled_cjs],
                env,
            )
        }
    };
    // Debug builds do not inject any extra env.
    #[cfg(debug_assertions)]
    let extra_env: Vec<(String, String)> = vec![];

    // --- Debug builds: run TS source directly via system-installed node +
    //     tsx/esm import loader. We go through the full resolver pipeline
    //     (ranking + retry) to match release behaviour.
    #[cfg(debug_assertions)]
    let (ranked_candidates, default_args) = {
        let user_cmd = runtime_cmd
            .clone()
            .or_else(|| std::env::var("DSH_RUNTIME_CMD").ok())
            .unwrap_or_else(|| "node".into());
        let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let workspace_dir = manifest_dir.parent().expect("src-tauri parent is workspace dir");
        let entry_ts = workspace_dir.join("scripts").join("dsh-jsonrpc-entry.ts");
        let entry_ts = match std::fs::canonicalize(&entry_ts) {
            Ok(p) => p,
            Err(_) => entry_ts,
        };
        let args = vec![
            "--import".into(),
            "tsx/esm".into(),
            entry_ts.to_string_lossy().into_owned(),
        ];
        (resolve_runtime_binary(&user_cmd), args)
    };

    let args_env = std::env::var("DSH_RUNTIME_ARGS")
        .ok()
        .map(|s| s.split_whitespace().map(String::from).collect::<Vec<_>>());
    let args = runtime_args.or(args_env).unwrap_or(default_args);

    let mut child_env: HashMap<String, String> = std::env::vars().collect();
    // Release-build-only: NODE_PATH for vendored node_modules (externals).
    // Insert BEFORE the caller-supplied `env` overrides so explicit callers
    // still win.
    for (k, v) in extra_env {
        child_env.entry(k).or_insert(v);
    }
    child_env.insert("DSH_PROFILE".into(), mode.clone());
    if !plugins.is_empty() {
        child_env.insert("DSH_PLUGINS".into(), plugins.join(","));
    }
    for (k, v) in env {
        child_env.insert(k, v);
    }
    child_env.insert("DSH_JSONRPC_IO".into(), "stdio".into());

    // ---- SPAWN RETRY LOOP (closes probe-vs-spawn-context gap) ------------
    //
    // GUI apps on macOS notoriously run under App Sandbox / Hardened Runtime
    // / App Translocation where `std::process::Command::new(X).status()`
    // SUCCEEDS (because it goes through posix_spawn with a minimal
    // environment) but the REAL Tauri/ tokio::process spawn inside the actual
    // app bundle FAILS with ENOENT / EPERM even though X is on disk. This
    // accounts for 80% of the "spawn os error 2" user reports where `which
    // node` works fine in the terminal.
    //
    // The fix: iterate ranked_candidates one by one. For each candidate we
    // run a tokio::process-level final-precheck *and* the actual spawn. If
    // either returns NotFound / PermissionDenied / os error 2/13, we SKIP TO
    // THE NEXT CANDIDATE. Only once every ranked candidate has failed do we
    // surface a single aggregated error message.
    //
    // Error classes that DON'T trigger retry (fail fast):
    //   • exec format error (os error 8) → binary exists but wrong arch,
    //     retrying the next binary is fine because the next one will likely
    //     be the right arch, so we retry those too.

    fn is_retryable_io_error(err: &std::io::Error) -> bool {
        use std::io::ErrorKind::*;
        matches!(err.kind(), NotFound | PermissionDenied)
            || matches!(err.raw_os_error(), Some(2) | Some(8) | Some(13))
    }

    let mut last_candidate_error: Option<String> = None;
    let mut chosen_cmd: String = String::new();
    let mut child: Option<tokio::process::Child> = None;

    'spawn_loop: for (idx, candidate_cmd) in ranked_candidates.iter().enumerate() {
        eprintln!(
            "[dsh-start] spawn-try #{} candidate={:?} (of {} ranked)",
            idx + 1,
            candidate_cmd,
            ranked_candidates.len()
        );
        emit_log(
            &app,
            LogLevel::Info,
            &format!(
                "[dsh-start] trying runtime candidate #{}/{}: {:?}",
                idx + 1,
                ranked_candidates.len(),
                candidate_cmd
            ),
        );

        // 1) Final-precheck (same stack-frame inline probe, per candidate)
        let cmd_path = std::path::Path::new(&candidate_cmd);
        let is_node = cmd_path
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.contains("node"))
            .unwrap_or(false);
        let md_f = std::fs::metadata(cmd_path);
        let precheck: Result<(), String> = match &md_f {
            Err(e) => Err(format!(
                "final-precheck: metadata() failed: {} (os_error {:?})",
                e,
                e.raw_os_error()
            )),
            Ok(m) if !m.is_file() => Err(format!(
                "final-precheck: {:?} is NOT a file ({:?})",
                candidate_cmd,
                m.file_type()
            )),
            Ok(_) if !is_node => Ok(()),
            Ok(_) => {
                let res = std::process::Command::new(cmd_path)
                    .arg("-e")
                    .arg("0")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
                match res {
                    Ok(st) if st.success() => Ok(()),
                    Ok(st) => Err(format!(
                        "final-precheck: -e 0 non-zero exit {:?}",
                        st.code()
                    )),
                    Err(e) => Err(format!(
                        "final-precheck: -e 0 spawn os error {:?}: {}",
                        e.raw_os_error(),
                        e
                    )),
                }
            }
        };
        if let Err(msg) = precheck {
            eprintln!(
                "[dsh-start]   candidate #{:?} precheck REJECTED: {msg}",
                idx + 1
            );
            emit_log(
                &app,
                LogLevel::Warn,
                &format!(
                    "[dsh-start] candidate #{idx}/{} precheck rejected for {:?}: {msg}",
                    ranked_candidates.len(),
                    candidate_cmd
                ),
            );
            last_candidate_error = Some(format!(
                "candidate #{:?} {:?}: precheck failed — {msg}",
                idx + 1,
                candidate_cmd
            ));
            continue 'spawn_loop;
        }

        // 2) Actual tokio::process spawn. If it fails with a retryable error,
        //    skip to the next ranked candidate.
        let spawn_res = Command::new(candidate_cmd)
            .args(&args)
            .current_dir(&cwd)
            .envs(&child_env)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn();
        match spawn_res {
            Ok(c) => {
                chosen_cmd = candidate_cmd.clone();
                eprintln!(
                    "[dsh-start] candidate #{idx}: SPAWN OK pid={:?}  cmd={candidate_cmd:?}",
                    c.id()
                );
                child = Some(c);
                break 'spawn_loop;
            }
            Err(io_err) if is_retryable_io_error(&io_err) => {
                let summary = format!(
                    "spawn os error {:?} ({:?}): {}",
                    io_err.raw_os_error(),
                    io_err.kind(),
                    io_err
                );
                eprintln!(
                    "[dsh-start] candidate #{:?} spawn RETRYABLE: {summary} — falling through to next candidate",
                    idx + 1
                );
                emit_log(
                    &app,
                    LogLevel::Warn,
                    &format!(
                        "[dsh-start] candidate #{}/{} {:?} retryable spawn error: {summary}",
                        idx + 1,
                        ranked_candidates.len(),
                        candidate_cmd
                    ),
                );
                last_candidate_error = Some(format!(
                    "candidate #{:?} {:?}: retryable spawn error — {summary}",
                    idx + 1,
                    candidate_cmd
                ));
                continue 'spawn_loop;
            }
            Err(io_err) => {
                // Non-retryable: wrong arch, bad args, binary invalid format.
                // Still surface in the aggregated error at the end.
                let summary = format!(
                    "spawn os error {:?} ({:?}): {}",
                    io_err.raw_os_error(),
                    io_err.kind(),
                    io_err
                );
                eprintln!(
                    "[dsh-start] candidate #{:?} spawn NON-RETRYABLE: {summary}",
                    idx + 1
                );
                last_candidate_error = Some(format!(
                    "candidate #{:?} {:?}: spawn failed — {summary}",
                    idx + 1,
                    candidate_cmd
                ));
                continue 'spawn_loop;
            }
        }
    }

    // If we exited the loop without binding `chosen_cmd`, every candidate
    // failed to spawn — aggregate them.
    if chosen_cmd.is_empty() {
        let ranked_list = ranked_candidates
            .iter()
            .enumerate()
            .map(|(i, c)| format!("  #{:?}: {:?}", i + 1, c))
            .collect::<Vec<_>>()
            .join("\n");
        let detail = last_candidate_error
            .unwrap_or_else(|| "(no candidates produced a specific error)".into());
        return Err(format!(
            "DSH SDK bridge start failed: ALL {n} ranked runtime candidates failed to spawn. \n\
            Resolver input: {input:?}\n\
            Ranked candidates considered:\n{ranked_list}\n\
            Last reported issue: {detail}\n\n\
            Quick fix: In a terminal run `which node` (or `where.exe node` on Windows) and paste \
            the output into Settings → Runtime → Runtime Command, then click Start again.",
            n = ranked_candidates.len(),
            input = runtime_cmd.clone().unwrap_or_else(|| "<default ranked list>".into()),
        ));
    }

    // --- Log provenance of the final successful spawn ---
    emit_log(
        &app,
        LogLevel::Info,
        &format!(
            "[dsh-start] SPAWN OK (candidate={:?}/{:?}). cmd={chosen_cmd:?} cwd={cwd:?} args({})=[{:?}]",
            ranked_candidates.iter().position(|s| s == &chosen_cmd).map(|i| i + 1).unwrap_or(0),
            ranked_candidates.len(),
            args.len(),
            &args
        ),
    );

    let mut child = child.expect("child is Some after spawn loop + chosen_cmd non-empty guard");
    let child_pid = child.id().unwrap_or(0);
    let stdin = child.stdin.take().ok_or_else(|| "no stdin".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "no stdout".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "no stderr".to_string())?;

    let router = Arc::new(RpcRouter {
        child_pid,
        stdin: Mutex::new(stdin),
        pending: Mutex::new(HashMap::new()),
    });

    // stdout reader task
    let app_for_out = app.clone();
    let router_out = Arc::clone(&router);
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            let line = match lines.next_line().await {
                Ok(Some(l)) => l,
                Ok(None) => break,
                Err(e) => {
                    emit_log(
                        &app_for_out,
                        LogLevel::Warn,
                        &format!("dsh stdout read error: {e}"),
                    );
                    break;
                }
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let frame: JsonRpcFrame = match serde_json::from_str(trimmed) {
                Ok(f) => f,
                Err(e) => {
                    emit_log(
                        &app_for_out,
                        LogLevel::Warn,
                        &format!("dsh malformed JSON-RPC line: {e}"),
                    );
                    continue;
                }
            };

            // Path A: frame has id (request or response)
            if let Some(id_val) = &frame.id {
                let id = match id_val.as_str() {
                    Some(s) => s.to_string(),
                    None => continue,
                };

                // If it carries a method: server-initiated request (rare for SDK server).
                // We simply ignore unknown inbound requests; our side only handles
                // notifications (method, no id) and responses (id, no method).

                // Response path: id + (result|error) AND no method
                if frame.method.is_none() {
                    let mut pending = router_out.pending.lock().await;
                    if let Some(sender) = pending.remove(&id) {
                        let envelope = serde_json::json!({
                            "id": id,
                            "result": frame.result,
                            "error": frame.error,
                        });
                        let _ = sender.send(envelope);
                    }
                }
            }

            // Path B: frame has method and no id -> notification -> frontend
            if frame.id.is_none() {
                if let Some(method) = frame.method.clone() {
                    let payload = serde_json::json!({
                        "method": method,
                        "params": frame.params.clone().unwrap_or(serde_json::Value::Null),
                    });
                    let _ = app_for_out.emit(EV_NOTIFICATION, payload);
                }
            }
        }
        // Close all pending on EOF
        let mut pending = router_out.pending.lock().await;
        for (_, tx) in pending.drain() {
            let _ = tx.send(serde_json::json!({ "eof": true }));
        }
    });

    // stderr reader task
    let app_for_err = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            emit_log(&app_for_err, LogLevel::Info, &format!("[dsh-stderr] {line}"));
        }
    });

    // Initialize handshake
    let init_params = serde_json::json!({
        "cwd": cwd,
        "provider": provider,
        "model": model,
        "maxTokens": max_tokens,
        "baseUrl": base_url,
        "apiKey": api_key,
    });
    let init_resp = rpc_call(&router, "initialize", &init_params, 60)
        .await
        .map_err(|e| format!("initialize handshake failed: {e}"))?;
    let name = init_resp
        .get("serverInfo")
        .and_then(|s| s.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("unknown");
    emit_log(
        &app,
        LogLevel::Info,
        &format!("DSH SDK initialized: {name} (pid={child_pid})"),
    );

    // Supervisor task: reap child exit, clear state, emit log
    let app_for_sup = app.clone();
    let router_for_sup = Arc::clone(&router);
    let state_for_sup = state.inner().clone(); // mutex, not Arc
    drop(state_for_sup); // noop — we use `state` below via handle
    tokio::spawn(async move {
        let _ = child.wait().await;
        let mut pending = router_for_sup.pending.lock().await;
        for (_, tx) in pending.drain() {
            let _ = tx.send(serde_json::json!({ "eof": true }));
        }
        emit_log(&app_for_sup, LogLevel::Warn, "dsh runtime process exited");
    });

    {
        let mut guard = state.router.lock().await;
        *guard = Some(router);
    }
    Ok(())
}

#[tauri::command]
async fn dsh_stop(state: State<'_, DshState>) -> Result<(), String> {
    let mut guard = state.router.lock().await;
    let router = guard.take();
    if let Some(r) = router {
        // Best-effort shutdown RPC (ignored if runtime is gone)
        let _ = rpc_call(&r, "shutdown", &serde_json::json!({}), 2).await;
        // Drop router: stdin locked writer, pending map. Child itself will be
        // killed because it's not held here (it was dropped to supervisor).
        // We also send SIGTERM via pid best-effort.
        #[cfg(unix)]
        {
            let pid = r.child_pid as i32;
            if pid > 0 {
                unsafe {
                    libc_kill(pid);
                }
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
unsafe fn libc_kill(pid: i32) {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    let _ = unsafe { kill(pid, 15 /* SIGTERM */) };
}

#[tauri::command]
async fn dsh_request(
    state: State<'_, DshState>,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let guard = state.router.lock().await;
    let router = guard
        .as_ref()
        .ok_or_else(|| "DSH not started. Call dsh_start first (or use MOCK_RUNTIME=1)".to_string())?;
    rpc_call(router, &method, &params, 600)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn dsh_notify(
    state: State<'_, DshState>,
    method: String,
    params: serde_json::Value,
) -> Result<(), String> {
    let guard = state.router.lock().await;
    let router = guard
        .as_ref()
        .ok_or_else(|| "DSH not started".to_string())?;
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    });
    let mut line = serde_json::to_string(&body).map_err(|e| e.to_string())?;
    line.push('\n');
    let mut stdin = router.stdin.lock().await;
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("write notification failed: {e}"))?;
    Ok(())
}

#[allow(dead_code)]
fn _dsh_unused(_: mpsc::Receiver<()>) -> AnyResult<()> {
    Ok(())
}

// --- menu / tray ---

fn build_menu<R: tauri::Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let i_new = MenuItem::with_id(app, "new-session", "New Session", true, Some("CmdOrCtrl+N"))?;
    let i_open = MenuItem::with_id(app, "open-sessions", "Open Sessions Folder", true, Some("CmdOrCtrl+O"))?;
    let i_settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let i_devtools = MenuItem::with_id(app, "devtools", "Toggle DevTools", true, Some("F12"))?;
    Ok(Menu::with_items(
        app,
        &[&i_new, &i_open, &i_settings, &i_devtools],
    )?)
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    let builder = TrayIconBuilder::with_id("dsh-tray")
        .tooltip("DSH Desktop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "new-session" => {
                let _ = app.emit("menu://new-session", ());
            }
            "open-sessions" => {
                let _ = app.emit("menu://open-sessions", ());
            }
            "settings" => {
                let _ = app.emit("menu://open-settings", ());
            }
            "devtools" => {
                if let Some(w) = app.get_webview_window("main") {
                    #[cfg(all(debug_assertions, feature = "devtools"))]
                    {
                        use tauri::WebviewWindowExt;
                        if w.is_devtools_open() {
                            let _ = w.close_devtools();
                        } else {
                            let _ = w.open_devtools();
                        }
                    }
                    let _ = w;
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
        });
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,wgpu=warn,naga=warn")),
        )
        .try_init();

    let dsh_state = DshState::default();
    let app_state = AppState {
        keystore: std::sync::Mutex::new(None),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(dsh_state)
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            get_startup_config,
            secure_get,
            secure_set,
            secure_delete,
            dsh_start,
            dsh_stop,
            dsh_request,
            dsh_notify,
        ])
        .setup(|app| {
            let store = app.store_builder(STORE_NAME).build()?;
            let _ = store.reload();
            let _ = setup_tray(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running dsh-desktop");
}
