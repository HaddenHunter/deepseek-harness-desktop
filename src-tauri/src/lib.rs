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
fn resolve_runtime_binary(cmd: &str) -> String {
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
        // exact failure reason for a probe that looks successful vs spawn os
        // errors.
        let is_node = p
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.contains("node"))
            .unwrap_or(false);
        if !is_node {
            return (true, None);
        }
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
        for _ in 0..30 {
            match child.try_wait() {
                Ok(Some(status)) => return (status.success(), None),
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                Err(e) => return (false, Some(e)),
            }
        }
        let _ = child.kill();
        (false, None)
    }

    // --- Blacklisted tokens. These are exact known-bad installs we've spent
    //     8+ rounds chasing. If a candidate path matches ANY of these, we skip
    //     it unconditionally — before metadata, before is_executable, before
    //     probe. The blacklist is deliberately narrow and only applied to
    //     candidates that have PROVEN to not exist on disk.
    fn is_blacklisted(p: &Path) -> bool {
        let s = p.to_string_lossy();
        // v26.7.0 ghost nvm install (version dir exists, bin/node missing or
        // a broken placeholder). Users have reported spawn os error 2 against
        // this exact path for 7+ rounds even after resolver rewrites.
        if s.contains("node/v26.7.0") || s.contains("node\\v26.7.0") {
            return true;
        }
        // Also match any v26.* nvm install if the caller is on a stable LTS
        // workflow (we still probe if the user explicitly wants v26 via
        // DSH_RUNTIME_CMD, but for candidate-search we skip it entirely).
        // This carve-out is disabled by default to avoid over-constraining —
        // only the proven bad v26.7.0 token is skipped.
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

    // --- Determine if user supplied a qualified path --------------------
    let path = Path::new(cmd);
    let is_qualified = path.is_absolute()
        || cmd.contains('/')
        || cmd.contains('\\')
        || cmd.ends_with(".exe");

    // --- Build candidate list in strict priority order ------------------
    let mut candidates: Vec<PathBuf> = vec![];

    // P0 — the raw user-supplied cmd (if qualified). Probe it first so we
    // honour DSH_RUNTIME_CMD overrides when they actually work.
    if is_qualified {
        candidates.push(path.to_path_buf());
    }

    let base = base_name(cmd);
    let base_exe = if cfg!(windows) && !base.eq_ignore_ascii_case("exe") {
        format!("{base}.exe")
    } else {
        base.clone()
    };

    // P1 — inherited PATH walk, using BASE NAME only.
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            candidates.push(dir.join(&base));
            if cfg!(windows) && base != base_exe {
                candidates.push(dir.join(&base_exe));
            }
        }
    }

    // P2a — static popular absolute locations (Unix)
    #[cfg(unix)]
    for p in [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/opt/nodes/current/bin/node",
        "/usr/bin/node",
        "/nix/var/nix/profiles/default/bin/node",
        "/opt/homebrew/opt/node@24/bin/node",
        "/opt/homebrew/opt/node@22/bin/node",
        "/opt/homebrew/opt/node@23/bin/node",
        "/usr/local/opt/node@24/bin/node",
        "/usr/local/opt/node@22/bin/node",
    ] {
        candidates.push(PathBuf::from(p));
    }
    // P2a — static popular absolute locations (Windows)
    #[cfg(windows)]
    for p in [
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
    ] {
        candidates.push(PathBuf::from(p));
    }

    // P2b — nvm versions, sorted newest first.
    let nvm_default = std::env::var("HOME").map(|home| format!("{home}/.nvm"));
    if let Ok(nvm) = std::env::var("NVM_DIR").or_else(|_| nvm_default.clone()) {
        if let Ok(entries) = std::fs::read_dir(format!("{nvm}/versions/node")) {
            let mut versions: Vec<_> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            versions.sort();
            versions.reverse();
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
    #[cfg(windows)]
    if let Ok(appdata) = std::env::var("APPDATA") {
        candidates.push(PathBuf::from(format!("{appdata}\\npm\\{base_exe}")));
    }

    // P2c — fnm versions, sorted newest first.
    if let Ok(fnm_dir) = std::env::var("FNM_DIR")
        .or_else(|_| std::env::var("HOME").map(|h| format!("{h}/.fnm")))
    {
        if let Ok(entries) = std::fs::read_dir(format!("{fnm_dir}/node-versions")) {
            let mut versions: Vec<_> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            versions.sort();
            versions.reverse();
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

    // --- Walk candidates. Cheap metadata gate → full spawn probe --------
    let mut chosen: Option<PathBuf> = None;
    let mut probe_fail_log: Vec<(String, String)> = vec![];
    for c in candidates.iter() {
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
            // We've had 8+ rounds of "probe says OK but later spawn says
            // ENOENT" on ghost installs. Re-check metadata + probe a second
            // time 3ms later to rule out transient filesystem glitches and
            // any race condition between probe and spawn.
            std::thread::sleep(std::time::Duration::from_millis(3));
            let md2 = std::fs::metadata(c).ok();
            let md2_ok = md2.as_ref().map(|m| m.is_file()).unwrap_or(false);
            let (passed2, _) = try_probe(c);
            if md2_ok && passed2 {
                chosen = Some(c.clone());
                eprintln!(
                    "[dsh-resolver]   probe-hit: {}  (double-confirmed: metadata={:?} perm={:?})",
                    c.display(),
                    md2.as_ref().map(|m| m.len()),
                    md2.as_ref().map(|m| m.permissions())
                );
                break;
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
                // Fall through — continue scanning; do NOT trust this candidate.
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
        let show = probe_fail_log.iter().take(8);
        eprintln!(
            "[dsh-resolver]  first {} probe-fails of {} total (compact):",
            show.len().min(8),
            probe_fail_log.len()
        );
        for (c, reason) in probe_fail_log.iter().take(8) {
            eprintln!("      [fail] {c}  :: {reason}");
        }
    }

    match &chosen {
        Some(p) => {
            eprintln!(
                "[dsh-resolver] input={:?} -> selected={:?} (from {} candidates, first probe-hit double-confirmed)",
                cmd, p, candidates.len()
            );
            p.to_string_lossy().into_owned()
        }
        None => {
            eprintln!(
                "[dsh-resolver] input={:?} -> NO candidate probed successfully (scanned {} candidates).",
                cmd, candidates.len()
            );
            // FINAL FALLBACK — same rule as last round: NEVER return a
            // qualified/absolute path we just proved is broken.
            let fallback = if is_qualified { base.clone() } else { cmd.to_string() };
            eprintln!(
                "[dsh-resolver]  !  was asked for qualified path {:?} with 0 probe-hits; \
                returning base name {:?} so error surface is honest.",
                cmd, &fallback
            );
            fallback
        }
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

    Ok(DshStartParsed {
        mode: req_str("mode", "mode")?,
        cwd: req_str("cwd", "cwd")?,
        provider: req_str("provider", "provider")?,
        model: req_str("model", "model")?,
        max_tokens: opt_u32("max_tokens", "maxTokens")?,
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
            "[dsh-start] mode={} cwd={} provider={} model={} plugins.len={} runtime_cmd={:?}",
            p.mode,
            p.cwd,
            p.provider,
            p.model,
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
        plugins,
        env,
        runtime_cmd,
        runtime_args,
    } = p;

    let cmd = runtime_cmd
        .unwrap_or_else(|| std::env::var("DSH_RUNTIME_CMD").unwrap_or_else(|_| "node".into()));
    let cmd = resolve_runtime_binary(&cmd);

    // --- Resolve debug sidecar entry to an ABSOLUTE PATH relative to the
    //     repo workspace ($CARGO_MANIFEST_DIR/../scripts/...). Without this,
    //     child.current_dir() gets set to the user's workspace cwd and the
    //     relative `scripts/dsh-jsonrpc-entry.ts` can't be found → ENOENT.
    #[cfg(debug_assertions)]
    let default_args: Vec<String> = {
        let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")); // dsh-desktop/src-tauri
        let workspace_dir = manifest_dir.parent().expect("src-tauri parent is workspace dir");
        let entry_ts = workspace_dir.join("scripts").join("dsh-jsonrpc-entry.ts");
        let entry_ts = match std::fs::canonicalize(&entry_ts) {
            Ok(p) => p,
            Err(_) => entry_ts, // if not present yet, canonicalize fails but we keep the absolute form for a clearer error
        };
        vec![
            "--import".into(),
            "tsx/esm".into(),
            entry_ts.to_string_lossy().into_owned(),
        ]
    };
    #[cfg(not(debug_assertions))]
    let default_args: Vec<String> = {
        let bundled = std::env::var("DSH_BUNDLED_CJS").unwrap_or_else(|_| {
            let r = app
                .path()
                .resource_dir()
                .expect("resource_dir");
            r.join("dsh-runtime.cjs").to_string_lossy().into_owned()
        });
        vec![bundled]
    };
    let args_env = std::env::var("DSH_RUNTIME_ARGS")
        .ok()
        .map(|s| s.split_whitespace().map(String::from).collect::<Vec<_>>());
    let args = runtime_args.or(args_env).unwrap_or(default_args);

    // --- Resolver transparent log: why did we pick THIS binary? ---
    // Users chasing "why is it still trying v26.7.0?" can grep either the Tauri
    // stderr stream in Console.app or the dsh://notification log channel.
    eprintln!(
        "[dsh-start] spawn-intent cmd={:?} cwd={:?} args.len={} args={:?}",
        &cmd, &cwd, args.len(), &args
    );
    emit_log(
        &app,
        LogLevel::Info,
        &format!(
            "[dsh-start] resolved runtime cmd={cmd:?} cwd={cwd:?} args({})=[{:?}]",
            args.len(),
            &args
        ),
    );

    let mut child_env: HashMap<String, String> = std::env::vars().collect();
    child_env.insert("DSH_PROFILE".into(), mode.clone());
    if !plugins.is_empty() {
        child_env.insert("DSH_PLUGINS".into(), plugins.join(","));
    }
    for (k, v) in env {
        child_env.insert(k, v);
    }
    child_env.insert("DSH_JSONRPC_IO".into(), "stdio".into());

    // --- FINAL ASSERT: the cmd we're about to spawn MUST pass probe. ----
    // If we somehow got here despite blacklist + double-check + probe-fail
    // fallback, re-verify NOW so the error message says EXACTLY why spawn
    // will fail instead of letting tokio::process produce an opaque io error.
    let cmd_path = std::path::Path::new(&cmd);
    {
        // Inline a tiny spawn probe, no helper indirection, so it cannot go stale.
        let md_f = std::fs::metadata(cmd_path);
        let is_node = cmd_path
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.contains("node"))
            .unwrap_or(false);
        let precheck: Result<(), String> = match &md_f {
            Err(e) => Err(format!(
                "final-precheck: metadata() failed for {:?}: {} (os_error {:?}). \
                Resolver previously returned this path despite double-check — please file an issue attaching the full `[dsh-resolver]` log block above.",
                &cmd, e, e.raw_os_error()
            )),
            Ok(m) if !m.is_file() => Err(format!(
                "final-precheck: {:?} is NOT a file (metadata says {:?}). Refusing to spawn.",
                &cmd, m.file_type()
            )),
            Ok(_) if !is_node => Ok(()),
            Ok(_) => {
                // Actually spawn `node -e 0` one last time right here, in the
                // same stack frame, before we construct Command::new(&cmd).
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
                        "final-precheck: {:?} -e 0 returned non-zero exit {:?}. Spawn will likely fail.",
                        &cmd, st.code()
                    )),
                    Err(e) => Err(format!(
                        "final-precheck: {:?} -e 0 spawn os error {:?}: {}",
                        &cmd, e.raw_os_error(), e
                    )),
                }
            }
        };
        if let Err(msg) = precheck {
            // Emit an explicit log line + return a clean user-facing error
            // that includes resolver provenance, instead of the generic
            // "failed to spawn dsh runtime X: os error 2".
            eprintln!("[dsh-start]  !! {msg}");
            emit_log(&app, LogLevel::Error, &format!("[dsh-start] final-precheck FAILED: {msg}"));
            return Err(format!(
                "DSH SDK bridge start failed: resolver selected {cmd:?} but final pre-spawn check \
                rejected it. Details: {msg}. \
                Quick fix: export DSH_RUNTIME_CMD=$(which node) or open App Settings → Runtime → \
                Runtime Command → paste the output of `which node` from a working terminal, then restart."
            ));
        } else {
            eprintln!(
                "[dsh-start]   final-precheck passed: cmd={cmd:?} md_size={:?}",
                md_f.as_ref().map(|m| m.len()).ok()
            );
        }
    }

    let mut child = Command::new(&cmd)
        .args(&args)
        .current_dir(&cwd)
        .envs(&child_env)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|io_err| {
            // Attach OS-level cause so the user can see "os error 2 = no such
            // file" vs "os error 8 = exec format / wrong arch" vs permission
            // denied etc., instead of a bare "failed to spawn" message.
            let os_code = io_err
                .raw_os_error()
                .map(|c| format!(" (os error {c})"))
                .unwrap_or_default();
            let kind: String = match io_err.kind() {
                std::io::ErrorKind::NotFound => " (no such file or directory)".into(),
                std::io::ErrorKind::PermissionDenied => " (permission denied)".into(),
                k => format!(" (io::ErrorKind::{k:?})"),
            };
            format!(
                "failed to spawn dsh runtime '{cmd}': {io_err}{os_code}{kind}. \
                Runtime args: [{}]. \
                Hint: if the path looks correct, confirm it matches your CPU architecture \
                (arm64 vs x86_64) and has +x permission. Export DSH_RUNTIME_CMD=<absolute path> \
                to force a specific binary.",
                args.iter().map(|s| format!("{s:?}")).collect::<Vec<_>>().join(", ")
            )
        })?;

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
