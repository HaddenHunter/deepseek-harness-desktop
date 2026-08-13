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
fn resolve_runtime_binary(cmd: &str) -> String {
    // If absolute or already has a path separator or file extension, pass as-is.
    if std::path::Path::new(cmd).is_absolute()
        || cmd.contains('/')
        || cmd.contains('\\')
        || cmd.ends_with(".exe")
    {
        return cmd.to_string();
    }

    // First, try the PATH inherited from the current process (works for tauri:dev).
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(cmd);
            if candidate.exists() {
                return candidate.to_string_lossy().into_owned();
            }
            #[cfg(windows)]
            {
                let with_ext = dir.join(format!("{cmd}.exe"));
                if with_ext.exists() {
                    return with_ext.to_string_lossy().into_owned();
                }
            }
        }
    }

    // Fallbacks: common Node.js install locations (searched in order of popularity).
    let fallbacks: &[&str] = &[
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
    ];
    for p in fallbacks {
        if std::path::Path::new(p).exists() {
            return (*p).to_string();
        }
    }

    // nvm fallbacks (try common NVM_DIR variants)
    let nvm_default = std::env::var("HOME").map(|home| format!("{home}/.nvm"));
    if let Ok(nvm) = std::env::var("NVM_DIR").or_else(|_| nvm_default.clone()) {
        if let Ok(entries) = std::fs::read_dir(format!("{nvm}/versions/node")) {
            let mut versions: Vec<_> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            versions.sort();
            if let Some(latest) = versions.last() {
                let bin = latest.join("bin").join("node");
                if bin.exists() {
                    return bin.to_string_lossy().into_owned();
                }
            }
        }
    }

    #[cfg(windows)]
    {
        for p in [
            r"C:\Program Files\nodejs\node.exe",
            r"C:\Program Files (x86)\nodejs\node.exe",
        ] {
            if std::path::Path::new(p).exists() {
                return p.to_string();
            }
        }
        if let Ok(appdata) = std::env::var("APPDATA") {
            let p = format!("{appdata}\\npm\\node.exe");
            if std::path::Path::new(&p).exists() {
                return p;
            }
        }
    }

    // Nothing found. Return the original string; tokio::process::Command will
    // surface an IO error that we emit back to the UI as a log line.
    cmd.to_string()
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

/// Relaxed parameter shape for dsh_start.
///
/// The UI invokes `invoke("dsh_start", { mode, cwd, provider, model, ... })` with
/// top-level keys — Tauri maps them directly to the struct fields (there is no
/// outer `params` wrapper). To avoid the extremely misleading aggregate error
///   `invalid args 'params' for command 'dsh_start': missing required key params`
/// whenever ANY deserialization fails, this struct:
///
///   * declares `#[serde(default)]` on every optional field so new-style frontends
///     that send fewer fields never error;
///   * adds `alias = "<camelCase>"` next to snake_case names so old/new frontends
///     using either convention both work (`maxTokens` / `max_tokens`, etc.);
///   * captures any unknown keys into a flattened `extra` HashMap so struct-level
///     `deny_unknown_fields` can never bite us.
///
/// The only truly required keys are `mode`, `cwd`, `provider`, `model` — missing
/// any of these now produces the precise serde error `missing field 'mode'` etc.
#[derive(Debug, Deserialize)]
pub struct DshStartParams {
    pub mode: String,
    pub cwd: String,
    pub provider: String,
    pub model: String,
    #[serde(default, alias = "maxTokens")]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub plugins: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default, alias = "runtimeCmd")]
    pub runtime_cmd: Option<String>,
    #[serde(default, alias = "runtimeArgs")]
    pub runtime_args: Option<Vec<String>>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

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

// NOTE: the argument list here MUST exactly match the keys the frontend sends in
//   await invoke("dsh_start", { mode, cwd, provider, model, max_tokens, maxTokens,
//                                plugins, env, runtime_cmd, runtimeCmd,
//                                runtime_args, runtimeArgs })
// We deliberately avoid taking a single struct param. Tauri aggregates all
// struct-deserialize failures into a single cryptic string that looks like
//   "invalid args 'params' for command 'dsh_start': missing required key params"
// which does not name the real field mismatch. By listing each argument by name,
// any missing key error becomes precise (e.g. "missing field 'mode'") and
// Option<T> handles forward/backward compat (snake_case + camelCase variants are
// duplicated as separate params, then merged in the body).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn dsh_start(
    app: AppHandle,
    state: State<'_, DshState>,
    mode: String,
    cwd: String,
    provider: String,
    model: String,
    max_tokens: Option<u32>,
    maxTokens: Option<u32>,
    plugins: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    runtime_cmd: Option<String>,
    runtimeCmd: Option<String>,
    runtime_args: Option<Vec<String>>,
    runtimeArgs: Option<Vec<String>>,
    // Unknown extras — the `_trailing_args_json` trick does not exist on Tauri
    // args, so instead we lean on the documented Tauri behaviour: extra named
    // arguments not declared here are silently ignored for invoke.  Any other
    // struct-driven deserialize path was the source of the "missing required
    // key params" message; pure flat args don't trigger it.
) -> Result<(), String> {
    // Merge snake_case + camelCase variants. The snake_case copy wins if both
    // are supplied.
    let max_tokens = max_tokens.or(maxTokens);
    let runtime_cmd = runtime_cmd.or(runtimeCmd);
    let runtime_args = runtime_args.or(runtimeArgs);
    let plugins = plugins.unwrap_or_default();
    let env = env.unwrap_or_default();
    {
        let guard = state.router.lock().await;
        if guard.is_some() {
            return Ok(());
        }
    }

    let cmd = runtime_cmd
        .unwrap_or_else(|| std::env::var("DSH_RUNTIME_CMD").unwrap_or_else(|_| "node".into()));
    let cmd = resolve_runtime_binary(&cmd);
    #[cfg(debug_assertions)]
    let default_args: Vec<String> = vec![
        "--import".into(),
        "tsx/esm".into(),
        "scripts/dsh-jsonrpc-entry.ts".into(),
    ];
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

    let mut child_env: HashMap<String, String> = std::env::vars().collect();
    child_env.insert("DSH_PROFILE".into(), mode.clone());
    if !plugins.is_empty() {
        child_env.insert("DSH_PLUGINS".into(), plugins.join(","));
    }
    for (k, v) in env {
        child_env.insert(k, v);
    }
    child_env.insert("DSH_JSONRPC_IO".into(), "stdio".into());

    emit_log(
        &app,
        LogLevel::Info,
        &format!("spawning dsh-runtime: {cmd} {}", args.join(" ")),
    );

    let mut child = Command::new(&cmd)
        .args(&args)
        .current_dir(&cwd)
        .envs(&child_env)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("failed to spawn dsh runtime '{cmd}'"))
        .map_err(|e| e.to_string())?;

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
