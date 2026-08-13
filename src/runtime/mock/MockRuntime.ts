import type {
  EventKind,
  PendingApproval,
  PluginInfo,
  RuntimeEvent,
  RuntimeMode,
  RuntimeStats,
  SessionSummary,
  UserSettings,
} from "../types";
import type { ApprovalListener, EventListener, IRuntime } from "../IRuntime";
import { RUNTIME_MODES } from "../types";

const DEFAULT_SETTINGS: UserSettings = {
  activeModel: "deepseek-chat",
  models: [
    {
      provider: "deepseek",
      modelId: "deepseek-chat",
      displayName: "DeepSeek V3 Chat",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      maxContext: 128_000,
      enabled: true,
    },
    {
      provider: "deepseek",
      modelId: "deepseek-coder",
      displayName: "DeepSeek Coder V2",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      maxContext: 128_000,
      enabled: true,
    },
  ],
  apiKeys: {},
  pluginsEnabled: {},
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 4096,
  toolApprovalAutoAllow: ["file_read", "search"],
  toolApprovalAutoDeny: ["shell:rm -rf"],
  telemetry: false,
  theme: "dark",
};

const MOCK_PLUGINS: PluginInfo[] = [
  { id: "model-deepseek", name: "DeepSeek Model", version: "0.1.0", enabled: true, category: "model", provides: ["llm"], description: "DeepSeek LLM provider" },
  { id: "tool-shell", name: "Shell Tool", version: "0.1.0", enabled: true, category: "tool", provides: ["shell"], description: "Execute shell commands in sandbox" },
  { id: "tool-file", name: "File Tool", version: "0.1.0", enabled: true, category: "tool", provides: ["file"], description: "Read / write / edit files" },
  { id: "tool-search", name: "Search Tool", version: "0.1.0", enabled: true, category: "tool", provides: ["search"], description: "Search codebase and web" },
  { id: "tool-mcp", name: "MCP Client", version: "0.1.0", enabled: false, category: "tool", provides: ["mcp"], description: "Connect to MCP servers" },
  { id: "skill-planning", name: "Planning Skill", version: "0.1.0", enabled: true, category: "skill", provides: ["planning"] },
  { id: "loop-standard", name: "Standard Agent Loop", version: "0.1.0", enabled: true, category: "agent-loop", provides: ["agent-loop"], dependsOn: ["llm", "tool-approval"] },
  { id: "sandbox-local", name: "Local Sandbox", version: "0.1.0", enabled: true, category: "sandbox", provides: ["sandbox"] },
  { id: "storage-sqlite", name: "SQLite Storage", version: "0.1.0", enabled: true, category: "storage", provides: ["session-storage", "event-log"] },
  { id: "scheduler-hybrid", name: "Hybrid Scheduler", version: "0.1.0", enabled: true, category: "scheduler", provides: ["spawn", "fork", "pipeline", "ralph"] },
  { id: "cordis-inspector", name: "Cordis Inspector", version: "0.1.0", enabled: false, category: "other", provides: ["runtime-inspect"] },
];

function uid(prefix = "ev"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

interface SessionInternals {
  summary: SessionSummary;
  events: RuntimeEvent[];
  generatTimer?: ReturnType<typeof setTimeout>;
}

export class MockRuntime implements IRuntime {
  private ready = false;
  private mode: RuntimeMode | null = null;
  private startedAt = 0;
  private settings: UserSettings = { ...DEFAULT_SETTINGS };
  private sessions = new Map<string, SessionInternals>();
  private plugins: PluginInfo[] = MOCK_PLUGINS.map((p) => ({ ...p }));
  private eventListeners = new Set<EventListener>();
  private approvalListeners = new Set<ApprovalListener>();
  private approvals = new Map<string, PendingApproval>();
  private toolsExecuted = 0;

  async start(mode: RuntimeMode, overrides?: { plugins?: string[]; settings?: Partial<UserSettings> }): Promise<void> {
    if (this.ready) return;
    this.mode = mode;
    this.startedAt = Date.now();
    const modeCfg = RUNTIME_MODES.find((m) => m.id === mode)!;
    const enableIds = overrides?.plugins ?? modeCfg.defaultPlugins;
    for (const p of this.plugins) {
      p.enabled = enableIds.some((id) => p.provides?.includes(id) || p.id === id);
    }
    if (overrides?.settings) {
      this.settings = { ...this.settings, ...overrides.settings };
    }
    this.ready = true;
  }

  async stop(): Promise<void> {
    for (const s of this.sessions.values()) {
      if (s.generatTimer) clearTimeout(s.generatTimer);
    }
    this.sessions.clear();
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
    return {
      pluginsLoaded: this.plugins.filter((p) => p.enabled).length,
      sessionsActive: this.sessions.size,
      eventsTotal: [...this.sessions.values()].reduce((a, s) => a + s.events.length, 0),
      toolsExecuted: this.toolsExecuted,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }

  /* ---------------- 会话 ---------------- */

  async createSession(mode: RuntimeMode = this.mode ?? "standard", title = ""): Promise<string> {
    const id = uid("ses");
    const now = Date.now();
    const summary: SessionSummary = {
      id,
      title: title || `新会话 · ${RUNTIME_MODES.find((m) => m.id === mode)?.label}`,
      mode,
      createdAt: now,
      updatedAt: now,
      eventCount: 0,
    };
    const session: SessionInternals = { summary, events: [] };
    this.appendEventInternal(session, "session_created", "", { mode });
    this.sessions.set(id, session);
    return id;
  }

  async listSessions(): Promise<SessionSummary[]> {
    return [...this.sessions.values()]
      .map((s) => ({ ...s.summary, eventCount: s.events.length }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getSessionEvents(sessionId: string): Promise<RuntimeEvent[]> {
    return this.sessions.get(sessionId)?.events ?? [];
  }

  async forkSession(sessionId: string, atEventId?: string): Promise<string> {
    const src = this.sessions.get(sessionId);
    if (!src) throw new Error("session not found");
    const newId = await this.createSession(src.summary.mode, `${src.summary.title} (fork)`);
    const dst = this.sessions.get(newId)!;
    const srcEvents = atEventId
      ? src.events.slice(0, src.events.findIndex((e) => e.id === atEventId) + 1)
      : src.events;
    dst.events = srcEvents.map((e) => ({ ...e, id: uid("ev"), sessionId: newId }));
    dst.summary.eventCount = dst.events.length;
    return newId;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s?.generatTimer) clearTimeout(s.generatTimer);
    this.sessions.delete(sessionId);
  }

  async setSessionTitle(sessionId: string, title: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) s.summary.title = title;
  }

  /* ---------------- 对话 ---------------- */

  async sendUserMessage(sessionId: string, content: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("session not found");
    this.appendEventInternal(s, "user_message", content);
    this.runMockGeneration(s, content);
  }

  async cancelGeneration(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s?.generatTimer) {
      clearTimeout(s.generatTimer);
      s.generatTimer = undefined;
      this.appendEventInternal(s, "error", "用户取消了生成");
    }
  }

  /* ---------------- 插件 ---------------- */

  async listPlugins(): Promise<PluginInfo[]> {
    return this.plugins.map((p) => ({ ...p }));
  }

  async setPluginEnabled(pluginId: string, enabled: boolean): Promise<void> {
    const p = this.plugins.find((x) => x.id === pluginId);
    if (p) p.enabled = enabled;
  }

  async hotReloadPlugin(pluginId: string): Promise<void> {
    void pluginId;
  }

  /* ---------------- 审批 ---------------- */

  async listPendingApprovals(): Promise<PendingApproval[]> {
    return [...this.approvals.values()];
  }

  async approveTool(callId: string): Promise<void> {
    const appr = this.approvals.get(callId);
    if (!appr) return;
    this.approvals.delete(callId);
    const s = this.sessions.get(appr.sessionId);
    if (!s) return;
    const ev = s.events.find((e) => e.id === appr.toolCallId);
    if (ev && ev.metadata) {
      ev.metadata = { ...(ev.metadata as object), status: "approved" };
      this.emitEvent({ ...ev });
    }
    setTimeout(() => {
      this.toolsExecuted += 1;
      this.appendEventInternal(s, "tool_result", JSON.stringify({ ok: true, output: "mock output" }, null, 2), { toolCallId: callId });
    }, 500);
  }

  async denyTool(callId: string, reason = "用户拒绝"): Promise<void> {
    const appr = this.approvals.get(callId);
    if (!appr) return;
    this.approvals.delete(callId);
    const s = this.sessions.get(appr.sessionId);
    if (s) this.appendEventInternal(s, "error", `工具调用被拒绝：${reason}`, { toolCallId: callId });
  }

  /* ---------------- 设置 ---------------- */

  async getSettings(): Promise<UserSettings> {
    return { ...this.settings, models: this.settings.models.map((m) => ({ ...m })) };
  }

  async updateSettings(patch: Partial<UserSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
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
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.appendEventInternal(s, kind, content, metadata, true);
  }

  /* ---------------- 内部 ---------------- */

  private appendEventInternal(
    s: SessionInternals,
    kind: EventKind,
    content?: string,
    metadata?: Record<string, unknown>,
    synthetic = false,
  ): RuntimeEvent {
    const ev: RuntimeEvent = {
      id: uid("ev"),
      sessionId: s.summary.id,
      kind,
      ts: Date.now(),
      content,
      metadata: synthetic ? { ...metadata, synthetic: true } : metadata,
    };
    s.events.push(ev);
    s.summary.updatedAt = ev.ts;
    s.summary.eventCount = s.events.length;
    this.emitEvent(ev);
    return ev;
  }

  private emitEvent(ev: RuntimeEvent) {
    for (const l of this.eventListeners) {
      try {
        void l(ev);
      } catch {
        /* 生产环境不打印监听方错误 */
      }
    }
  }

  private emitApproval(item: PendingApproval) {
    for (const l of this.approvalListeners) {
      try {
        void l(item);
      } catch {
        /* swallow */
      }
    }
  }

  private runMockGeneration(s: SessionInternals, userContent: string) {
    if (s.generatTimer) clearTimeout(s.generatTimer);

    const steps: Array<{ kind: EventKind; afterMs: number; content?: string; metadata?: Record<string, unknown>; approval?: boolean }> = [
      { kind: "assistant_thinking", afterMs: 200, content: "分析请求中……" },
      {
        kind: "tool_call",
        afterMs: 800,
        content: JSON.stringify({ command: "ls -la", args: {} }, null, 2),
        metadata: { tool: "shell", toolName: "shell:ls", approvalRequired: true, sandboxed: true },
        approval: true,
      },
      { kind: "assistant_message", afterMs: 2400, content: `好的，已收到：「${userContent.slice(0, 80)}」。\n\n（这是 Mock Runtime 生成的示例回复。将 DshRuntime 接入真实 @deepseek-ai/dsh SDK 后即可启用 Cordis 插件系统和真实推理。）` },
    ];

    let cursor = 0;
    const runNext = () => {
      if (cursor >= steps.length) {
        s.generatTimer = undefined;
        return;
      }
      const step = steps[cursor++];
      const ev = this.appendEventInternal(s, step.kind, step.content, step.metadata);
      if (step.approval) {
        const appr: PendingApproval = {
          id: uid("appr"),
          sessionId: s.summary.id,
          toolCallId: ev.id,
          toolName: (step.metadata?.toolName as string) ?? "tool",
          preview: step.content ?? "",
          risk: "medium",
          requestedAt: Date.now(),
        };
        this.approvals.set(ev.id, appr);
        this.emitApproval(appr);
      }
      s.generatTimer = setTimeout(runNext, step.afterMs);
    };

    s.generatTimer = setTimeout(runNext, steps[0].afterMs);
  }
}
