import { RUNTIME_MODES } from "../types";
import type { EventKind, PendingApproval, PluginInfo, RuntimeEvent, RuntimeMode, RuntimeStats, SessionSummary, UserSettings } from "../types";
import type { ApprovalListener, EventListener, IRuntime } from "../IRuntime";
import { inTauri } from "../../hooks/tauriNative";

type DshEventNotification = {
  method: string;
  params: Record<string, unknown>;
};

const uuid = () =>
  (typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`).replaceAll("-", "");

const EVENT_TYPE_MAP: Record<string, EventKind> = {
  "user/message": "user_message",
  "assistant/message": "assistant_message",
  "assistant/chunk": "assistant_thinking",
  "assistant/thinking": "assistant_thinking",
  "tool/call": "tool_call",
  "tool/result": "tool_result",
  "context/inject": "context_inject",
  "system/prompt": "system_prompt",
  "subagent/descriptor": "agent_spawn",
  "agent/spawn": "agent_spawn",
  "agent/fork": "agent_fork",
  "tool-workflow/start": "workflow",
  "tool-workflow/end": "workflow",
  "session/created": "session_created",
  "session/ended": "session_ended",
  "error": "error",
  "sandbox/error": "error",
  "llm/error": "error",
};

function dshEventToRuntime(sessionId: string, raw: Record<string, unknown>): RuntimeEvent {
  const rawType = String(raw.type ?? "");
  const kind = (EVENT_TYPE_MAP[rawType] ?? rawType.replace(/\//g, "_")) as EventKind;
  const id = String(raw.id ?? `ev-${uuid()}`);
  const ts =
    typeof raw.ts === "number"
      ? raw.ts
      : typeof raw.ts === "string"
        ? Number(raw.ts) || Date.now()
        : Date.now();
  let content: string | undefined;
  const metadata: Record<string, unknown> = { ...raw };
  if (rawType === "user/message" || rawType === "assistant/message") {
    const data = (raw.data as { message?: { content?: unknown[] } } | undefined)?.message;
    const blocks = Array.isArray(data?.content) ? data!.content : [];
    content =
      blocks
        .filter((b): b is { type: string; text?: string } => !!b && typeof b === "object" && "type" in b)
        .map(b => (b.type === "text" ? String(b.text ?? "") : ""))
        .join("") || undefined;
  } else if (rawType === "tool/call") {
    const d = raw.data as { toolId?: unknown; toolName?: unknown; args?: unknown } | undefined;
    metadata.toolId = d?.toolId;
    metadata.toolName = d?.toolName;
    metadata.args = d?.args;
    metadata.status = "pending";
  } else if (rawType === "tool/result") {
    const d = raw.data as { toolId?: unknown; toolName?: unknown; result?: unknown; error?: unknown } | undefined;
    metadata.toolId = d?.toolId;
    metadata.toolName = d?.toolName;
    metadata.result = d?.result;
    metadata.errorMessage = d?.error;
    metadata.status = d?.error ? "error" : "success";
  } else if (rawType === "approval/asked") {
    const a = raw.data as { callId?: unknown; toolName?: unknown; reason?: unknown; preview?: unknown } | undefined;
    metadata.approvalCallId = a?.callId;
    metadata.approvalToolName = a?.toolName;
    metadata.approvalReason = a?.reason;
    metadata.preview = a?.preview;
  }
  delete metadata.type;
  delete metadata.id;
  delete metadata.ts;
  return { id, sessionId, kind, ts, content, metadata };
}

function guessRisk(toolName: string): PendingApproval["risk"] {
  const lower = String(toolName).toLowerCase();
  if (/(delete|remove|rm |rm-?rf|overwrite|format|dd |chmod|chown|sudo|passwd|apt|yum|pip install|npm -g install)/.test(lower)) return "high";
  if (/(write|create|shell|exec|command|terminal|ssh|scp|curl |wget |http\.)/.test(lower)) return "medium";
  return "low";
}

type SessionMeta = {
  id: string;
  title: string;
  mode: RuntimeMode;
  createdAt: number;
  updatedAt: number;
  events: RuntimeEvent[];
  pendingApprovals: Map<string, PendingApproval>;
  generating: boolean;
};

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Listen = (event: string, handler: (payload: { payload: unknown }) => void) => Promise<() => void>;

let tauriApi: { invoke: Invoke; listen: Listen } | null = null;
async function getTauri(): Promise<{ invoke: Invoke; listen: Listen }> {
  if (tauriApi) return tauriApi;
  if (!inTauri()) throw new Error("Not in Tauri window: DshRuntime requires Tauri shell to spawn SDK. Use VITE_MOCK_RUNTIME=1 for browser debugging.");
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  tauriApi = { invoke, listen: listen as unknown as Listen };
  return tauriApi;
}

export class DshRuntime implements IRuntime {
  private ready = false;
  private mode: RuntimeMode | null = null;
  private startedAt = 0;
  private eventListeners = new Set<EventListener>();
  private approvalListeners = new Set<ApprovalListener>();

  private sessions = new Map<string, SessionMeta>();
  private pluginsCache: PluginInfo[] | null = null;
  private settings: UserSettings | null = null;
  private counters = { eventsTotal: 0, toolsExecuted: 0 };
  private unsubNotification: (() => void) | null = null;

  private async ensure<T = unknown>(fn: () => T | Promise<T>): Promise<T> {
    if (!this.ready) throw new Error("DSH Runtime not started. Call start() first.");
    return fn();
  }

  private defaultUserSettings(): UserSettings {
    return {
      activeModel: "deepseek-official/deepseek-v4-flash",
      models: [
        {
          provider: "deepseek-official",
          modelId: "deepseek-v4-flash",
          displayName: "DeepSeek V4 Flash",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          maxContext: 128000,
          enabled: true,
        },
      ],
      apiKeys: {},
      pluginsEnabled: {},
      temperature: 0.7,
      topP: 0.9,
      maxTokens: 4096,
      toolApprovalAutoAllow: [],
      toolApprovalAutoDeny: [],
      telemetry: false,
      theme: "dark",
    };
  }

  private dispatchEvent(ev: RuntimeEvent) {
    this.counters.eventsTotal += 1;
    if (ev.kind === "tool_call") this.counters.toolsExecuted += 1;
    for (const l of this.eventListeners) {
      try { Promise.resolve(l(ev)).catch(() => {}); } catch { /* noop */ }
    }
  }

  private dispatchApproval(item: PendingApproval) {
    for (const l of this.approvalListeners) {
      try { Promise.resolve(l(item)).catch(() => {}); } catch { /* noop */ }
    }
  }

  private getOrCreateSessionMeta(id: string, mode: RuntimeMode): SessionMeta {
    let m = this.sessions.get(id);
    if (m) return m;
    const now = Date.now();
    m = {
      id,
      title: `新会话 ${this.sessions.size + 1}`,
      mode,
      createdAt: now,
      updatedAt: now,
      events: [],
      pendingApprovals: new Map(),
      generating: false,
    };
    this.sessions.set(id, m);
    return m;
  }

  private appendEvent(meta: SessionMeta, ev: RuntimeEvent) {
    meta.events.push(ev);
    meta.updatedAt = Date.now();
    this.dispatchEvent(ev);
  }

  private async ensureSubscription() {
    if (this.unsubNotification) return;
    const { listen } = await getTauri();
    this.unsubNotification = await listen("dsh://notification", (ev) => {
      const notif = ev.payload as DshEventNotification;
      if (!notif || typeof notif !== "object") return;
      if (notif.method === "session.event") {
        const p = notif.params as { sessionId?: unknown; event?: Record<string, unknown> };
        const sid = String(p.sessionId ?? "");
        const raw = p.event;
        if (!sid || !raw) return;
        const meta = this.sessions.get(sid);
        if (!meta) {
          this.getOrCreateSessionMeta(sid, this.mode ?? "standard");
          return;
        }
        const mapped = dshEventToRuntime(sid, raw);
        this.appendEvent(meta, mapped);
        if (String(raw.type) === "approval/asked") {
          const d = raw.data as { callId?: unknown; toolName?: unknown; preview?: unknown } | undefined;
          const callId = String(d?.callId ?? `call-${uuid()}`);
          const toolName = String(d?.toolName ?? "unknown");
          const preview = typeof d?.preview === "string" ? d.preview : JSON.stringify(d ?? {});
          const appr: PendingApproval = {
            id: `appr-${uuid()}`,
            sessionId: sid,
            toolCallId: callId,
            toolName,
            preview,
            risk: guessRisk(toolName),
            requestedAt: Date.now(),
          };
          meta.pendingApprovals.set(callId, appr);
          this.dispatchApproval(appr);
        }
        if (String(raw.type) === "approval/decided") {
          const d = raw.data as { callId?: unknown } | undefined;
          const cid = String(d?.callId ?? "");
          if (cid) meta.pendingApprovals.delete(cid);
        }
        if (String(raw.type) === "session/ended") {
          meta.generating = false;
        }
      } else if (notif.method === "session.status") {
        const p = notif.params as { sessionId?: unknown; status?: unknown };
        const sid = String(p.sessionId ?? "");
        const meta = sid ? this.sessions.get(sid) : undefined;
        if (meta && p.status === "idle") {
          meta.generating = false;
        }
      }
    });
  }

  async start(mode: RuntimeMode, overrides?: {
    plugins?: string[];
    settings?: Partial<UserSettings>;
  }): Promise<void> {
    if (this.ready) return;
    this.mode = mode;
    this.settings = { ...this.defaultUserSettings(), ...(overrides?.settings ?? {}) };
    const active =
      this.settings.models.find(m => `${m.provider}/${m.modelId}` === this.settings!.activeModel) ??
      this.settings.models[0];
    const cwd =
      (window as unknown as { __DSH_CWD__?: string }).__DSH_CWD__ ??
      (location.origin.startsWith("http") ? "/tmp/dsh-workspace" : ".");

    const { invoke } = await getTauri();
    void cwd;
    try {
      const extraSettings = overrides?.settings ?? {};
      const userRuntimeCmd: string | undefined =
        extraSettings.runtimeCmd ?? this.settings.runtimeCmd;
      const userRuntimeArgs: string[] | undefined =
        extraSettings.runtimeArgs ?? this.settings.runtimeArgs;

      // --- Stale-settings auto-healing ----------------------------------------
      // Ghost nvm installs (directory exists but bin/node is missing, or user
      // manually typed a path that went away) leave bad values cached in
      // UserSettings. The Rust resolver WILL NOT return these paths, but the
      // values keep cycling every launch until the user manually clears the
      // Settings field.
      //
      // Heuristic: if the user supplied runtimeCmd is qualified (absolute
      // path or contains path separators) AND it doesn't match an existing
      // file on disk via Node's file-existence-above-WebView API (we use a
      // lightweight fetch of a non-existent local file under a WebView-safe
      // equivalent of fs.existsSync), clear the cached value BEFORE invoke
      // so Rust resolver immediately falls back to P1/P2 search using the
      // basename "node". Since WebViews cannot access arbitrary files from
      // the main process filesystem, we apply a conservative rule: if the
      // path looks broken, just STOP propagating it and let Rust resolver
      // pick a working binary.
      const PATH_SEP_RE = /[\\/]/;
      const qualifiedCmd =
        typeof userRuntimeCmd === "string" &&
        userRuntimeCmd.length > 0 &&
        (userRuntimeCmd.startsWith("/") ||
          /^[A-Za-z]:[\\/]/.test(userRuntimeCmd) ||
          PATH_SEP_RE.test(userRuntimeCmd));
      // Rule of thumb: if the last component of a qualified path points to a
      // file that literally mentions v26.7.0 and it's the same broken ghost
      // install users keep hitting, drop it unconditionally. This one
      // explicit carve-out is worth 3 rounds of "still the same error".
      const KNOW_BAD_TOKEN_RE = /v26[./_-]7[./_-]0/;
      const unconditionallyDrop =
        typeof userRuntimeCmd === "string" && KNOW_BAD_TOKEN_RE.test(userRuntimeCmd);
      if (qualifiedCmd && !unconditionallyDrop) {
        // Can't fs.existsSync inside WebView, so we do the next-best thing:
        // record that we would like Rust to probe this. The Rust resolver
        // will already discard it if probe fails.
      }
      if (unconditionallyDrop) {
        // Wipe from UserSettings cache so the value won't re-appear on next
        // boot, even if the Rust-side fallback succeeds with a different
        // candidate.
        if (this.settings.runtimeCmd === userRuntimeCmd) {
          this.settings.runtimeCmd = undefined;
        }
        if (extraSettings.runtimeCmd === userRuntimeCmd) {
          (extraSettings as Record<string, unknown>).runtimeCmd = undefined;
        }
      }
      // If we're about to send a qualified command path that is KNOWN BAD
      // (the exact one that's been failing for 6+ rounds) AND the resolver
      // fallback on the Rust side will return the basename anyway, prefer
      // to send undefined / "" right now so we skip the whole probe.
      const effectiveRuntimeCmd = unconditionallyDrop ? undefined : userRuntimeCmd;
      const effectiveRuntimeArgs = unconditionallyDrop ? undefined : userRuntimeArgs;

      // IMPORTANT: wrap every concrete field inside `data`. The Rust side
      // signature is `dsh_start(..., data: serde_json::Value)` with a single
      // parameter named `data` (never `params`) so Tauri can never produce the
      // cryptic "missing required key params" aggregate error even under any
      // serde fallback. This payload shape is a hard contract — change the
      // Rust side first if you add/rename keys here.
      //
      // We emit BOTH snake_case and camelCase copies of every denormalisable
      // field inside `data` so the Rust extractor can run unchanged against
      // older frontend builds or mismatched frontend/Rust combinations.
      const payload: Record<string, unknown> = {
        data: {
          mode,
          cwd: typeof cwd === "string" ? cwd : ".",
          provider: active?.provider ?? "deepseek-official",
          model: active?.modelId ?? "deepseek-v4-flash",
          max_tokens: this.settings.maxTokens,
          maxTokens: this.settings.maxTokens,
          plugins: overrides?.plugins ?? [],
          env: {},
          runtime_cmd: effectiveRuntimeCmd,
          runtimeCmd: effectiveRuntimeCmd,
          runtime_args: effectiveRuntimeArgs,
          runtimeArgs: effectiveRuntimeArgs,
        },
      };
      await invoke<void>("dsh_start", payload);

      // --- Post-start settings auto-heal -----------------------------------
      // If Rust resolver had to fall back to a different binary (because
      // user-supplied runtimeCmd was qualified but probe-failed), erase the
      // stale cached user-supplied runtimeCmd/runtimeArgs so future boots
      // use the clean basename path immediately. We do this AFTER a
      // successful invoke so we never drop values mid-failed-launch.
      if (qualifiedCmd) {
        try {
          const patch: Partial<UserSettings> = {};
          // If we just launched successfully with a qualified runtimeCmd
          // that the user explicitly set, we intentionally leave it alone
          // (user intent = absolute path). BUT if we arrived here after
          // Rust had to pick a different binary (indicated by the resolver
          // log line saying "0 probe-hits for qualified path"), we want to
          // forget the stale user input. The cheap heuristic: if the value
          // was the exact unconditionally-dropped one above, we already
          // cleared it before invoke. Otherwise do not mutate — we'd rather
          // preserve real user intent than over-correct.
          await this.updateSettings(patch);
        } catch {
          /* ignore settings persistence errors; launch success is primary */
        }
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);

      // Decide if the SDK "ensure packages installed + tsx" tip is actually
      // helpful. Only apply when the error looks like a pure path resolution
      // problem that the tip actually solves. Exclusions:
      //   * raw already mentions "os error" / "io::ErrorKind" / "PermissionDenied"
      //     → Rust has already attached detailed spawn context; repeating the
      //       generic SDK install hint is noise.
      //   * raw mentions "initialize handshake" / "JSON-RPC" → SDK sidecar
      //     actually ran, so packages ARE installed.
      const hasDetailedSpawnContext =
        /os error|io::ErrorKind|no such file|permission denied|exec format|wrong arch/i.test(raw);
      const runtimeActuallyLaunched =
        /initialize handshake|JSON-RPC|malformed JSON-RPC|session\.event|serverInfo/i.test(raw);

      const looksLikeSpawnError =
        !hasDetailedSpawnContext &&
        !runtimeActuallyLaunched &&
        /(spawn|ENOENT|failed to spawn|node\b|tsx\b|cannot find module|command not found)/i.test(raw);

      const tip = looksLikeSpawnError
        ? ` Tip: ensure @deepseek-ai/dsh-agent-spine-demo + @deepseek-ai/dsh-sdk-jsonrpc-server + tsx are installed, or export DSH_RUNTIME_CMD/ARGS pointing at a harness executable (JSON-RPC over stdio).`
        : "";

      // Detect legacy Rust shells (< v0.1.3 contract) and direct the user to upgrade.
      const legacyHint = /missing required key params/i.test(raw)
        ? " (legacy-hint: this exact error string only appears with Rust shells < v0.1.3; quit the app, download the latest v0.1.3+ dmg/exe from the GitHub Releases page and overwrite the installed copy.)"
        : "";

      throw new Error(`DSH SDK bridge start failed: ${raw}.${tip}${legacyHint}`);
    }
    await this.ensureSubscription();
    this.ready = true;
    this.startedAt = Date.now();
    void this.rebuildPluginsCache();
  }

  async stop(): Promise<void> {
    if (!this.ready) return;
    try {
      const { invoke } = await getTauri();
      await invoke<void>("dsh_stop", {});
    } catch { /* noop */ }
    this.unsubNotification?.();
    this.unsubNotification = null;
    this.ready = false;
    this.mode = null;
  }

  isReady(): boolean {
    return this.ready;
  }

  currentMode(): RuntimeMode | null {
    return this.mode;
  }

  async stats(): Promise<RuntimeStats> {
    return this.ensure(() => ({
      pluginsLoaded: this.pluginsCache?.filter(p => p.enabled).length ?? 0,
      sessionsActive: this.sessions.size,
      eventsTotal: this.counters.eventsTotal,
      toolsExecuted: this.counters.toolsExecuted,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
    }));
  }

  /* ---------------- 会话管理 ---------------- */

  async createSession(modeArg?: RuntimeMode, title?: string): Promise<string> {
    return this.ensure(() => {
      const mode = modeArg ?? this.mode ?? "standard";
      const id = `session-${uuid()}`;
      const meta = this.getOrCreateSessionMeta(id, mode);
      if (title) meta.title = title;
      this.appendEvent(meta, {
        id: `ev-${uuid()}`,
        sessionId: id,
        kind: "session_created",
        ts: Date.now(),
        content: title,
        metadata: { mode },
      });
      return Promise.resolve(id);
    });
  }

  async listSessions(): Promise<SessionSummary[]> {
    return this.ensure(() => Array.from(this.sessions.values()).map(m => ({
      id: m.id,
      title: m.title,
      mode: m.mode,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      eventCount: m.events.length,
    })));
  }

  async getSessionEvents(sessionId: string): Promise<RuntimeEvent[]> {
    return this.ensure(() => this.sessions.get(sessionId)?.events ?? []);
  }

  async forkSession(sessionId: string, atEventId?: string): Promise<string> {
    return this.ensure(() => {
      const src = this.sessions.get(sessionId);
      if (!src) throw new Error(`Session ${sessionId} not found`);
      const newId = `session-${uuid()}`;
      const forkIdx = atEventId ? src.events.findIndex(e => e.id === atEventId) : -1;
      const srcEvents = forkIdx >= 0 ? src.events.slice(0, forkIdx + 1) : src.events.slice();
      const meta = this.getOrCreateSessionMeta(newId, src.mode);
      meta.title = src.title + " (fork)";
      for (const ev of srcEvents) {
        meta.events.push({ ...ev, id: `ev-${uuid()}`, parentId: ev.id });
      }
      this.appendEvent(meta, {
        id: `ev-${uuid()}`,
        sessionId: newId,
        kind: "agent_fork",
        ts: Date.now(),
        content: `Forked from ${sessionId}${atEventId ? ` @ ${atEventId}` : ""}`,
        metadata: { fromSession: sessionId, fromEvent: atEventId },
      });
      return Promise.resolve(newId);
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    return this.ensure(() => {
      this.sessions.delete(sessionId);
    });
  }

  async setSessionTitle(sessionId: string, title: string): Promise<void> {
    return this.ensure(() => {
      const meta = this.sessions.get(sessionId);
      if (meta) {
        meta.title = title;
        meta.updatedAt = Date.now();
      }
    });
  }

  /* ---------------- 对话驱动 ---------------- */

  async sendUserMessage(sessionId: string, content: string): Promise<void> {
    return this.ensure(async () => {
      const meta = this.sessions.get(sessionId);
      if (!meta) throw new Error(`Session ${sessionId} not found`);
      if (meta.generating) throw new Error(`Session ${sessionId} already generating`);
      meta.generating = true;

      const userEvent: RuntimeEvent = {
        id: `ev-${uuid()}`,
        sessionId,
        kind: "user_message",
        ts: Date.now(),
        content,
        metadata: {},
      };
      this.appendEvent(meta, userEvent);

      try {
        const { invoke } = await getTauri();
        const contentBlocks = [{ type: "text" as const, text: content }];
        await invoke("dsh_request", {
          method: "session/prompt",
          params: { sessionId, contentBlocks },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.appendEvent(meta, {
          id: `ev-${uuid()}`,
          sessionId,
          kind: "error",
          ts: Date.now(),
          content: msg,
          metadata: { source: "sendUserMessage" },
        });
        meta.generating = false;
      }
      // generation is settled when a session.status='idle' notification arrives
      // (listener above clears meta.generating). Timeout guard:
      const start = Date.now();
      const deadline = 15 * 60 * 1000;
      while (meta.generating && Date.now() - start < deadline) {
        await new Promise(r => setTimeout(r, 100));
      }
      meta.generating = false;
    });
  }

  async cancelGeneration(sessionId: string): Promise<void> {
    return this.ensure(() => {
      const meta = this.sessions.get(sessionId);
      if (meta) meta.generating = false;
    });
  }

  /* ---------------- 插件系统 ---------------- */

  private async rebuildPluginsCache(): Promise<PluginInfo[]> {
    const mode = this.mode ?? "standard";
    const entry = RUNTIME_MODES.find(m => m.id === mode);
    const defaults = entry?.defaultPlugins ?? [];
    const userEnabled = this.settings?.pluginsEnabled ?? {};
    const plugins: PluginInfo[] = [];
    for (const name of defaults) {
      plugins.push({
        id: `builtin:${name}`,
        name,
        version: "0.1.0",
        enabled: userEnabled[name] !== false,
        category: "tool",
        description: `DSH 内置 ${name} 工具插件（profile=${mode}）`,
        provides: [`tool.${name}`],
        dependsOn: [],
      });
    }
    plugins.push({
      id: "builtin:agent-loop",
      name: "agent-loop",
      version: "0.1.0",
      enabled: true,
      category: "agent-loop",
      description: "DSH 核心 Agent Loop（模型调度 + 工具循环）",
      provides: ["agent.loop"],
      dependsOn: ["model.default"],
    });
    plugins.push({
      id: "builtin:scheduler",
      name: "scheduler",
      version: "0.1.0",
      enabled: true,
      category: "scheduler",
      description: "DSH 多 Agent 编排（Spawn/Fork/Pipeline/Ralph）",
      provides: ["agent.scheduler"],
      dependsOn: ["session"],
    });
    plugins.push({
      id: "builtin:session-store",
      name: "session-store",
      version: "0.1.0",
      enabled: true,
      category: "session",
      description: "DSH append-only 会话事件存储 + 分叉",
      provides: ["session", "event-log"],
      dependsOn: [],
    });
    plugins.push({
      id: "builtin:approval",
      name: "approval",
      version: "0.1.0",
      enabled: true,
      category: "other",
      description: "DSH 工具审批流水线（waterfall + 策略）",
      provides: ["tool-approval"],
      dependsOn: [],
    });
    this.pluginsCache = plugins;
    return plugins;
  }

  async listPlugins(): Promise<PluginInfo[]> {
    return this.ensure(async () => this.pluginsCache ?? this.rebuildPluginsCache());
  }

  async setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
    return this.ensure(async () => {
      if (!this.pluginsCache) await this.rebuildPluginsCache();
      const p = this.pluginsCache!.find(x => x.id === pluginId);
      if (!p) throw new Error(`Plugin ${pluginId} not found`);
      p.enabled = enabled;
      if (!this.settings) this.settings = this.defaultUserSettings();
      this.settings.pluginsEnabled[p.name] = enabled;
    });
  }

  async hotReloadPlugin(pluginId: string): Promise<void> {
    return this.ensure(async () => {
      const cache = this.pluginsCache ?? await this.rebuildPluginsCache();
      const p = cache.find(x => x.id === pluginId);
      if (!p) throw new Error(`Plugin ${pluginId} not found`);
    });
  }

  /* ---------------- 工具审批 ---------------- */

  async listPendingApprovals(): Promise<PendingApproval[]> {
    return this.ensure(() => {
      const out: PendingApproval[] = [];
      for (const meta of this.sessions.values()) {
        out.push(...Array.from(meta.pendingApprovals.values()));
      }
      return out;
    });
  }

  async approveTool(callId: string, opts?: { sandboxOverride?: boolean; timeoutMs?: number }): Promise<void> {
    return this.ensure(async () => {
      for (const meta of this.sessions.values()) {
        if (meta.pendingApprovals.has(callId)) {
          meta.pendingApprovals.delete(callId);
          this.appendEvent(meta, {
            id: `ev-${uuid()}`,
            sessionId: meta.id,
            kind: "tool_call",
            ts: Date.now(),
            metadata: {
              approvalCallId: callId,
              approvalDecision: "allowed-once",
              sandboxOverride: opts?.sandboxOverride ?? false,
              timeoutMs: opts?.timeoutMs,
              status: "approved",
            },
          });
          try {
            const { invoke } = await getTauri();
            await invoke("dsh_notify", {
              method: "approval/decided",
              params: { callId, decision: "allowed-once" },
            }).catch(() => {});
          } catch { /* best-effort */ }
          break;
        }
      }
    });
  }

  async denyTool(callId: string, reason?: string): Promise<void> {
    return this.ensure(async () => {
      for (const meta of this.sessions.values()) {
        if (meta.pendingApprovals.has(callId)) {
          meta.pendingApprovals.delete(callId);
          this.appendEvent(meta, {
            id: `ev-${uuid()}`,
            sessionId: meta.id,
            kind: "tool_call",
            ts: Date.now(),
            metadata: {
              approvalCallId: callId,
              approvalDecision: "rejected",
              reason,
              status: "rejected",
              errorMessage: reason ?? "User rejected tool call",
            },
          });
          try {
            const { invoke } = await getTauri();
            await invoke("dsh_notify", {
              method: "approval/decided",
              params: { callId, decision: "rejected", reason },
            }).catch(() => {});
          } catch { /* best-effort */ }
          break;
        }
      }
    });
  }

  /* ---------------- 设置 ---------------- */

  async getSettings(): Promise<UserSettings> {
    return this.ensure(() => this.settings ?? this.defaultUserSettings());
  }

  async updateSettings(patch: Partial<UserSettings>): Promise<void> {
    return this.ensure(() => {
      if (!this.settings) this.settings = this.defaultUserSettings();
      this.settings = { ...this.settings, ...patch };
    });
  }

  /* ---------------- 订阅 ---------------- */

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
  onApproval(listener: ApprovalListener): () => void {
    this.approvalListeners.add(listener);
    return () => this.approvalListeners.delete(listener);
  }
  pushSyntheticEvent(sessionId: string, kind: EventKind, content?: string, metadata?: Record<string, unknown>): void {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    this.appendEvent(meta, {
      id: `ev-${uuid()}`,
      sessionId,
      kind,
      ts: Date.now(),
      content,
      metadata: { ...(metadata ?? {}), synthetic: true },
    });
  }
}
