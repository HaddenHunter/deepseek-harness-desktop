# DeepSeek Harness Desktop

> **English** &nbsp;|&nbsp; [中文](#zh--deepseek-harness-desktop) &nbsp;|&nbsp; [Releases](https://github.com/HaddenHunter/deepseek-harness-desktop/releases) &nbsp;|&nbsp; [License](#license-mit)

A cross-platform desktop GUI for **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** — powered by the official Harness SDK over a JSON-RPC 2.0 sidecar, wrapped in a Tauri 2.x native shell.

No browser tab needed. One-click session creation, visual tool-approval modal, trajectory timeline, and workspace isolation — with the **exact same plugin pipeline and agent runtime** as DeepSeek Harness v0.1 (MIT).

---

## ✨ Features

| Feature | Details |
|---|---|
| **Real Harness runtime** | Not a re-implementation. Spawns the upstream Cordis plugin graph (`agent-spine → jsonl-persistence → sdk-jsonrpc-server`) as a Node.js sidecar, drives it via newline-delimited JSON-RPC over stdio. |
| **Visual tool approval** | Shell `exec`, `write`, `read`, `search`, `browser`, and custom plugin actions surface in an Approvals modal one at a time — one-click **Allow / Allow once / Deny**, with regex auto-allow lists. |
| **Trajectory timeline** | Full `SessionEvent` replay: user message → thought → tool_call → tool_result → assistant message, with diffs and per-event metadata. |
| **Multi-provider, multi-model** | Configure any LLM provider Harness supports (DeepSeek Official, OpenAI-compatible, Anthropic, …) via `Settings`; per-session model / temperature / top_p / max-tokens switches. |
| **4 runtime modes** | `standard` / `ptc` (plan-then-code) / `minimal` / `creative` — mapped straight to Harness `RuntimeMode`. |
| **Zero browser APIs in UI** | Strict Tauri 2.x security model: WebView only sees pure JS APIs. Sidecar spawn, keychain, filesystem, notifications, tray, menu, dialogs — all owned by the Rust shell (physical isolation). |
| **Cross-platform** | macOS (`.dmg` / `.app`), Windows (NSIS `.exe` / `.msi` / portable `.zip`), Linux (`.deb` / `.AppImage`). Single ~15 MB native binary + bundled CJS sidecar. |
| **Keychain secrets** | API keys are stored in the OS keyring (macOS Keychain / Windows CredMan / Linux Secret Service), never on disk. |
| **JSONL session persistence** | Each session is an append-only JSONL file under `~/Library/…/dsh-workspace/sessions/` — loadable by any Harness CLI tool. |

---

## 🧭 Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                     DSH Desktop App                           │
│                                                               │
│  ┌───────────────────────────┐   ┌─────────────────────────┐  │
│  │  WebView (React 18 + TS) │   │  Rust Shell (Tauri 2.x) │  │
│  │                           │   │                         │  │
│  │  zustand stores           │   │  #[tauri::command]      │  │
│  │  ├── runtimeStore         │◄──┼── dsh_start             │  │
│  │  ├── sessionStore         │◄──┼── dsh_stop              │  │
│  │  ├── approvalsStore       │◄──┼── dsh_request           │  │
│  │  ├── pluginStore          │◄──┼── dsh_notify            │  │
│  │  └── settingsStore        │   │                         │  │
│  │                           │   │  RpcRouter               │  │
│  │  IRuntime interface ◄─────┼───┤  ├── pending HashMap    │  │
│  │  ├── MockRuntime (dev)    │   │  └── stdin / stdout tx/rx│  │
│  │  └── DshRuntime (prod)    │   └────────┬────────────────┘  │
│  └───────────────────────────┘            │ JSON-RPC 2.0       │
│                                            │ (lines over stdio) │
│                                 ┌──────────▼──────────┐        │
│                                 │  Node sidecar 22+   │        │
│                                 │                     │        │
│                                 │  agent-spine-demo   │        │
│                                 │  ├─ jsonl-session   │        │
│                                 │  ├─ LLM providers   │        │
│                                 │  ├─ tools/plugins   │        │
│                                 │  └─ supervisor-loop │        │
│                                 └─────────────────────┘        │
└───────────────────────────────────────────────────────────────┘
```

### IRuntime contract

The entire UI depends on a single interface (`src/runtime/IRuntime.ts`). Two implementations exist:

- [**`MockRuntime`**](src/runtime/mock/MockRuntime.ts) — pure in-memory mock, no subprocess. Toggle with `MOCK_RUNTIME=1`.
- [**`DshRuntime`**](src/runtime/dsh/DshRuntime.ts) — Tauri IPC bridge. Invokes Rust commands, subscribes to events. Same UI code = no behavior drift.

### Sidecar wire protocol

The Rust shell talks to the Node sidecar using the **official Harness SDK JSON-RPC 2.0 transport** (newline-delimited JSON over stdio, the same `JsonRpcLineTransport` from `@deepseek-ai/dsh-sdk-jsonrpc-server`). Method set:

| Direction | Method / Notice | Purpose |
|---|---|---|
| client → server | `initialize` | Handshake: `cwd`, `provider`, `model`, `maxTokens` |
| client → server | `session/prompt` | Send a user message (array of content blocks) |
| client → server | `shutdown` | Graceful shutdown |
| server → client | `session.event` | Emitted once per `SessionEvent` (append-only log) |
| server → client | `session.status` | `running` / `idle` / `error` |
| server → client | `subagent.started` / `.finished` | Supervisor / multi-agent lifecycle |

---

## 🚀 Quick Start

### 1. Install a prebuilt release

Go to [**Releases →**](https://github.com/HaddenHunter/deepseek-harness-desktop/releases)

| Platform | Download | Runtime requirement |
|---|---|---|
| **macOS (Apple Silicon / Intel)** | `DSH-Desktop_<version>_universal.dmg` | Node.js ≥ 22 in `PATH` (`brew install node@22`) |
| **Windows 10/11 x64** | `DSH-Desktop_<version>_x64-setup.exe` (NSIS) <br> or `*.msi` (enterprise) | Node.js ≥ 22 in `PATH` (official installer, tick *Add to PATH*) |
| **Linux** | `*.deb` (Debian / Ubuntu) <br> or `*.AppImage` (portable) | Node.js ≥ 22 in `PATH` (`apt install nodejs npm`) |

Then open DSH Desktop, go to **Settings → API Keys**, paste your `DEEPSEEK_API_KEY`. (Or export it before launching the app — same env var is inherited by the sidecar.)

### 2. First run — end-to-end smoke

```
New Session → choose "standard" mode
    → Prompt:  List this repo's src/runtime folder, include file sizes
    → Expected flow:
          1. (tool approval pops up)  "ls -lah src/runtime"
          2. click [Allow once]
          3. Trajectory shows:  tool_call → tool_result → assistant_message
          4. Session status = idle
```

### 3. Build from source

#### Prerequisites

| Layer | macOS | Windows | Linux |
|---|---|---|---|
| **Node.js** | ≥ 22 (`brew install node@22`) | ≥ 22 (installer + add to PATH) | ≥ 22 (`apt install nodejs npm`) |
| **Rust toolchain** | [rustup.rs](https://rustup.rs) → stable channel | [rustup.rs](https://rustup.rs) → `stable-x86_64-pc-windows-msvc` | [rustup.rs](https://rustup.rs) → stable + `libwebkit2gtk` |
| **Tauri deps** | Xcode Command Line Tools (`xcode-select --install`) | MSVC Build Tools (winget) + WebView2 | `sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev` |

#### Commands

```bash
# 1. Clone
git clone git@github.com:HaddenHunter/deepseek-harness-desktop.git
cd deepseek-harness-desktop

# 2. Install JS dependencies
npm install

# 3. Dev loop (auto opens app window, HMR on React)
MOCK_RUNTIME=1 npm run tauri:dev      # UI smoke only — no sidecar
npm run tauri:dev                      # Full stack: Rust + sidecar + LLM
                                       # (set DEEPSEEK_API_KEY first)

# 4. Production build (installer bundles)
npm run tauri:build
# →
#   src-tauri/target/release/bundle/macos/DSH Desktop.app
#   src-tauri/target/release/bundle/dmg/DSH-Desktop_<version>_universal.dmg
#   src-tauri/target/release/bundle/nsis/DSH-Desktop_<version>_x64-setup.exe
#   src-tauri/target/release/bundle/msi/DSH-Desktop_<version>_x64.msi
```

---

## ⚙️ Configuration

| Environment variable | Default | What it does |
|---|---|---|
| `MOCK_RUNTIME=1` | *(off)* | Skip the real sidecar — use `MockRuntime` for pure UI work. |
| `DEEPSEEK_API_KEY` | *(empty)* | Inherited by the sidecar → SDK LLM providers. |
| `DSH_WORKSPACE` | `$TMPDIR/dsh-desktop-$PID` | Session JSONL + per-workspace state. Set to a project folder to persist. |
| `DSH_LOG_LEVEL` | `info` | Sidecar + Rust log level: `debug` `info` `warn` `error`. |
| `DSH_RUNTIME_CMD` | `node` | Override the sidecar binary path (e.g. `/opt/nodes/v24/bin/node`). |
| `DSH_RUNTIME_ARGS` | *(see lib.rs)* | Override sidecar args. Dev default: `--import tsx/esm scripts/dsh-jsonrpc-entry.ts`; Release: `resources/dsh-runtime.cjs` (bundled). |
| `DSH_BUNDLED_CJS` | *(release only)* | Override the absolute path to the bundled sidecar CJS. |

---

## 🧱 Plugin / Tool development

DSH Desktop shares the same Cordis plugin architecture as DeepSeek Harness core — plugins written for the CLI **drop in without modification**.

```bash
# In Settings → Plugins → Add folder  (or set DSH_PLUGINS env var)
DSH_PLUGINS=my-plugin.mjs,./dist/plugin-bundled.cjs npm run tauri:dev
```

See [Upstream Harness plugins docs](https://github.com/deepseek-ai/deepseek-harness/tree/v0.1) for the full `definePlugin` / `defineTool` / `defineAgent` API.

---

## 🧪 Tests

```bash
# Front-end type-check + production bundle
npm run build      # tsc -b && vite build   (zero-errors on main)

# Rust type-check
cd src-tauri && cargo check && cd -

# Sidecar handshake smoke test
node scripts/harness-smoke.mjs
# Expected:
#   {"jsonrpc":"2.0","id":"r1","result":{"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}}}
```

---

## 🛣️ Roadmap

- [ ] Embed `node` binary into the bundle (via `@yao-pkg/pkg`) so end-users **don't need Node** installed.
- [ ] Session list UI with search + JSONL import/export.
- [ ] Git diff review panel for `write` / `edit` tool results.
- [ ] Custom approval flow: per-directory allowlist, remote approval service webhook.
- [ ] Multi-window: side-by-side sessions with drag-drop tool results.
- [ ] Auto-updater via Tauri `updater` plugin.

---

## 🆘 Troubleshooting

| Symptom | Fix |
|---|---|
| `DSH SDK bridge start failed: invalid args params for command dsh_start` | Wipe `node_modules`, re-run `npm install && npm run tauri:build` — forces Rust side to be rebuilt against the newest IPC contract. |
| Handshake timeouts, no `session.status` | Set `DSH_LOG_LEVEL=debug` and re-run. Verify `node --version` ≥ 22. If sidecar is missing, rebuild with `node scripts/bundle-sidecar.mjs`. |
| macOS "DSH Desktop is damaged and can't be opened" | `xattr -d com.apple.quarantine /Applications/DSH\ Desktop.app` — or use the `.dmg` which bypasses most of Gatekeeper. |
| Windows SmartScreen blocks the installer | Right-click the `.exe` → Properties → tick *Unblock* → OK. (This happens because the build is not yet code-signed.) |

---

## 🧾 License (MIT)

```
MIT License

Copyright (c) 2026 HaddenHunter & Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

Bundles code from **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** v0.1 (also MIT) inside the SDK sidecar — full attribution preserved in `node_modules/@deepseek-ai/*` per upstream licenses.

---

---

<a id="zh--deepseek-harness-desktop"></a>

# 🌏 中文：DeepSeek Harness Desktop

> [English](#deepseek-harness-desktop) &nbsp;|&nbsp; **中文** &nbsp;|&nbsp; [发布页](https://github.com/HaddenHunter/deepseek-harness-desktop/releases) &nbsp;|&nbsp; [开源协议](#-mit-开源协议)

基于 **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** 官方 SDK 的跨平台桌面客户端。使用 Tauri 2.x 原生壳包裹，**所有推理、工具调用、Agent 编排均走 Harness 官方 Cordis 插件流水线**，不是前端 Replay / Mock。

不用再开浏览器标签页了。一键创建 Session、可视化工具审批弹窗、Trajectory 时间轴、工作区隔离 —— **完全对齐 DeepSeek Harness v0.1（MIT 协议）的语义。**

---

## ✨ 特性一览

| 特性 | 说明 |
|---|---|
| **跑的就是 Harness 本体** | 非二次实现。在 Node.js sidecar 里按官方 fixture 加载 Cordis 插件链：`agent-spine-demo → jsonl-persistence → sdk-jsonrpc-server`，使用换行分隔 JSON-RPC 2.0 over stdio 驱动。 |
| **可视化工具审批** | `exec / write / read / search / browser` 等所有工具调用一次性只弹一个 Approvals 弹窗：**允许一次 / 始终允许 / 拒绝**，支持按正则做自动放行。 |
| **Trajectory 时间轴** | 完整 `SessionEvent` 回放：user → thought → tool_call → tool_result → assistant；每个事件带 diff + metadata。 |
| **多 Provider、多模型** | Settings 页面可配置 Harness 支持的任意 LLM（DeepSeek 官方、OpenAI 兼容、Anthropic…）。每个 Session 可切模型 / temperature / top_p / maxTokens。 |
| **4 种 Runtime Mode** | `standard`（默认）/ `ptc`（先想后写）/ `minimal`（精简）/ `creative`（创意），与 Harness `RuntimeMode` 枚举一一对应。 |
| **物理隔离的安全模型** | 严格遵守 Tauri 2.x：WebView 完全看不到 Node / 文件系统 / 密钥。Sidecar 启动、Keychain、磁盘、通知、托盘、菜单、对话框 **全部在 Rust 壳里拥有**。 |
| **跨平台** | macOS（`.dmg` / `.app`）、Windows（NSIS `.exe` / `.msi` / 绿色 `.zip`）、Linux（`.deb` / `.AppImage`）。原生 bin ≈ 15 MB + CJS sidecar 1.8 MB。 |
| **系统级密钥存储** | API Key 存进系统 Keychain（macOS 钥匙串 / Windows 凭据管理器 / Linux Secret Service），不落到明文磁盘。 |
| **JSONL 会话持久化** | 每个 Session 是一个 append-only JSONL 文件（`~/Library/…/dsh-workspace/sessions/`），任何 Harness CLI 工具都能直接读。 |

---

## 🧭 架构总览

```
┌───────────────────────────────────────────────────────────────┐
│                     DSH Desktop App                           │
│                                                               │
│  ┌───────────────────────────┐   ┌─────────────────────────┐  │
│  │     WebView (React 18)    │   │    Rust Shell (Tauri)   │  │
│  │                           │   │                         │  │
│  │  zustand stores           │   │  #[tauri::command]      │  │
│  │  ├ runtimeStore           │◄──┼── dsh_start             │  │
│  │  ├ sessionStore           │◄──┼── dsh_stop              │  │
│  │  ├ approvalsStore         │◄──┼── dsh_request           │  │
│  │  └ pluginStore            │◄──┼── dsh_notify            │  │
│  │                           │   │                         │  │
│  │  IRuntime interface       │   │  RpcRouter              │  │
│  │  ├ MockRuntime (纯内存)   │   │   ├ pending HashMap     │  │
│  │  └ DshRuntime (IPC 桥)    │   │   └ stdin / stdout 双工 │  │
│  └───────────────────────────┘   └─────────┬───────────────┘  │
│                                            │ JSON-RPC 2.0       │
│                                            │ (stdio 按行)       │
│                                  ┌─────────▼──────────┐        │
│                                  │   Node sidecar 22+  │        │
│                                  │  ├ agent-spine-demo │        │
│                                  │  ├ jsonl-session    │        │
│                                  │  ├ LLM providers    │        │
│                                  │  ├ tools/plugins    │        │
│                                  │  └ supervisor-loop  │        │
│                                  └────────────────────┘        │
└───────────────────────────────────────────────────────────────┘
```

### IRuntime 契约

UI 只依赖一个接口（[`IRuntime.ts`](src/runtime/IRuntime.ts)），双实现：

- [**MockRuntime**](src/runtime/mock/MockRuntime.ts) — 纯内存模拟，无进程；`MOCK_RUNTIME=1` 切换。
- [**DshRuntime**](src/runtime/dsh/DshRuntime.ts) — 纯 IPC 桥：发命令 + 收事件。UI 代码同一套，不会语义漂移。

### Sidecar 线协议

Rust ↔ Node 使用 Harness SDK 官方 JSON-RPC 2.0 协议（与 `@deepseek-ai/dsh-sdk-jsonrpc-server` 的 `JsonRpcLineTransport` 完全一致，按行换行分隔的 JSON）：

| 方向 | 方法 / 通知 | 作用 |
|---|---|---|
| client→server | `initialize` | 握手：`cwd` / `provider` / `model` / `maxTokens` |
| client→server | `session/prompt` | 发送 user message（content blocks 数组） |
| client→server | `shutdown` | 优雅退出 |
| server→client | `session.event` | 每产生一个 `SessionEvent` 发一次（append-only 日志） |
| server→client | `session.status` | `running` / `idle` / `error` |
| server→client | `subagent.started / .finished` | Supervisor 多 Agent 生命周期 |

---

## 🚀 快速开始

### 1. 下载安装包（普通用户）

打开 [**Releases 发布页 →**](https://github.com/HaddenHunter/deepseek-harness-desktop/releases)

| 平台 | 下载文件 | 前置依赖 |
|---|---|---|
| **macOS（Apple Silicon / Intel）** | `DSH-Desktop_<版本号>_universal.dmg` | 系统 `PATH` 里有 Node ≥ 22（`brew install node@22`） |
| **Windows 10/11 x64** | `DSH-Desktop_<版本号>_x64-setup.exe`（NSIS 向导）<br>或者 `*.msi`（企业部署） | Node ≥ 22（官网 msi，安装时勾选 *Add to PATH*） |
| **Linux** | `*.deb`（Debian / Ubuntu）<br>或者 `*.AppImage`（免安装） | Node ≥ 22（`apt install nodejs npm`） |

启动后进入 **设置 → API Keys**，粘贴你的 `DEEPSEEK_API_KEY`。（或者启动前 export 该环境变量，sidecar 会直接继承。）

### 2. 第一次跑通端到端

```
新建会话 → 选 standard 模式
    → 发消息： "列出 src/runtime 目录和每个文件大小"
    → 预期流程：
          1. 弹工具审批：shell "ls -lah src/runtime"
          2. 点 [允许一次]
          3. Trajectory 面板：tool_call → tool_result → assistant_message
          4. 会话状态：idle
```

### 3. 源码构建（开发者）

#### 前置条件

| 组件 | macOS | Windows | Linux |
|---|---|---|---|
| **Node.js** | ≥ 22（`brew install node@22`） | ≥ 22（msi 安装 + PATH） | ≥ 22（`apt install nodejs npm`） |
| **Rust 工具链** | [rustup.rs](https://rustup.rs) → stable 通道 | [rustup.rs](https://rustup.rs) → `stable-x86_64-pc-windows-msvc` | [rustup.rs](https://rustup.rs) + `libwebkit2gtk` |
| **Tauri 依赖** | Xcode Command Line Tools（`xcode-select --install`） | MSVC Build Tools + WebView2 | `sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev` |

#### 命令

```bash
# 1. 克隆
git clone git@github.com:HaddenHunter/deepseek-harness-desktop.git
cd deepseek-harness-desktop

# 2. JS 依赖
npm install

# 3. 开发循环（自动开窗口，React HMR）
MOCK_RUNTIME=1 npm run tauri:dev    # 只跑 UI，不启动 sidecar
npm run tauri:dev                    # 全栈：Rust + Sidecar + 真实 LLM
                                     # （先 export DEEPSEEK_API_KEY）

# 4. 生产打包（安装包）
npm run tauri:build
# →
#   src-tauri/target/release/bundle/macos/DSH Desktop.app
#   src-tauri/target/release/bundle/dmg/DSH-Desktop_<版本号>_universal.dmg
#   src-tauri/target/release/bundle/nsis/DSH-Desktop_<版本号>_x64-setup.exe
#   src-tauri/target/release/bundle/msi/DSH-Desktop_<版本号>_x64.msi
```

---

## ⚙️ 环境变量配置

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `MOCK_RUNTIME=1` | 关 | 跳过真实 sidecar，走 MockRuntime（纯 UI 开发用） |
| `DEEPSEEK_API_KEY` | 空 | sidecar → SDK LLM 层会继承该值 |
| `DSH_WORKSPACE` | `$TMPDIR/dsh-desktop-$PID` | 会话 JSONL + 工作区状态；改成项目目录即可持久化 |
| `DSH_LOG_LEVEL` | `info` | Sidecar + Rust 日志级别：`debug` `info` `warn` `error` |
| `DSH_RUNTIME_CMD` | `node` | 覆盖 sidecar 可执行文件路径（如 `/opt/nodes/v24/bin/node`） |
| `DSH_RUNTIME_ARGS` | 见 lib.rs | 覆盖 sidecar 启动参数。Dev：`--import tsx/esm scripts/dsh-jsonrpc-entry.ts`；Release：`resources/dsh-runtime.cjs`（打包注入） |
| `DSH_BUNDLED_CJS` | 仅 Release | 覆盖已打包 sidecar CJS 的绝对路径 |

---

## 🧱 插件 / 工具二次开发

DSH Desktop 与 DeepSeek Harness 本体共享同一套 Cordis 插件架构 —— CLI 写的插件 **零改动就能跑**。

```bash
# 在 设置 → 插件 → 添加目录   （或设置 DSH_PLUGINS 环境变量）
DSH_PLUGINS=my-plugin.mjs,./dist/plugin-bundled.cjs npm run tauri:dev
```

`definePlugin / defineTool / defineAgent` 完整 API 请参考 [上游 Harness 插件文档](https://github.com/deepseek-ai/deepseek-harness/tree/v0.1)。

---

## 🧪 测试 / 质量门禁

```bash
# 前端类型 + 产物
npm run build      # tsc -b && vite build    （main 分支 0 errors）

# Rust 类型
cd src-tauri && cargo check && cd -

# Sidecar 握手烟测
node scripts/harness-smoke.mjs
# 预期输出：
#   {"jsonrpc":"2.0","id":"r1","result":{"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}}}
```

---

## 🛣️ Roadmap（路线图）

- [ ] 通过 `@yao-pkg/pkg` 把 Node 二进制嵌入安装包，终端用户**无需装 Node**。
- [ ] 会话列表 UI：搜索 + JSONL 导入 / 导出。
- [ ] Git Diff 审阅面板：针对 `write` / `edit` 工具结果。
- [ ] 自定义审批流：目录级 allowlist、远程审批服务 webhook。
- [ ] 多窗口：会话并排、工具结果拖拽粘贴。
- [ ] 接入 Tauri `updater` 插件，App 内自动升级。

---

## 🆘 常见问题排查

| 症状 | 修复 |
|---|---|
| `DSH SDK bridge start failed: invalid args params for command dsh_start` | 删除 `node_modules`，重跑 `npm install && npm run tauri:build`，强制 Rust 端按最新 IPC 契约重建。 |
| 握手超时，收不到 `session.status` | 设 `DSH_LOG_LEVEL=debug` 再跑。确认 `node --version` ≥ 22。若 sidecar 丢失，手跑 `node scripts/bundle-sidecar.mjs` 重新打 CJS。 |
| macOS 提示「DSH Desktop 已损坏，无法打开」 | `xattr -d com.apple.quarantine /Applications/DSH\ Desktop.app`；或使用 `.dmg` 直接拖入 Application 避开多数 Gatekeeper 拦截。 |
| Windows SmartScreen 拦截安装程序 | 右键 `.exe` → 属性 → 勾选 **解除锁定** → 确定。（构建暂未做代码签名，属正常提示。） |

---

## 🧾 MIT 开源协议

```
MIT License

Copyright (c) 2026 HaddenHunter & Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

SDK sidecar 里同步打包了 **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** v0.1 的 npm 包（同样 MIT 协议），完整署名与子协议保留在各自 `node_modules/@deepseek-ai/*` 包内。
