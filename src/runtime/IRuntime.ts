import type {
  EventKind,
  PendingApproval,
  PluginInfo,
  RuntimeEvent,
  RuntimeMode,
  RuntimeStats,
  SessionSummary,
  UserSettings,
} from "./types";

export type EventListener = (ev: RuntimeEvent) => void | Promise<void>;
export type ApprovalListener = (item: PendingApproval) => void | Promise<void>;

export interface IRuntime {
  /** 启动 Runtime，加载默认插件集合。实现必须幂等。 */
  start(mode: RuntimeMode, overrides?: {
    plugins?: string[];
    settings?: Partial<UserSettings>;
  }): Promise<void>;

  /** 停止 Runtime，卸载所有插件，清理资源。实现必须幂等。 */
  stop(): Promise<void>;

  /** 是否已经启动并可用 */
  isReady(): boolean;

  /** 当前运行模式 */
  currentMode(): RuntimeMode | null;

  /** 健康检查，返回关键指标 */
  stats(): Promise<RuntimeStats>;

  /* ---------------- 会话管理 ---------------- */

  createSession(mode?: RuntimeMode, title?: string): Promise<string>;
  listSessions(): Promise<SessionSummary[]>;
  getSessionEvents(sessionId: string): Promise<RuntimeEvent[]>;
  forkSession(sessionId: string, atEventId?: string): Promise<string>;
  deleteSession(sessionId: string): Promise<void>;
  setSessionTitle(sessionId: string, title: string): Promise<void>;

  /* ---------------- 对话驱动 ---------------- */

  sendUserMessage(sessionId: string, content: string): Promise<void>;
  cancelGeneration(sessionId: string): Promise<void>;

  /* ---------------- 插件系统 ---------------- */

  listPlugins(): Promise<PluginInfo[]>;
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<void>;
  hotReloadPlugin(pluginId: string): Promise<void>;

  /* ---------------- 工具审批 ---------------- */

  listPendingApprovals(): Promise<PendingApproval[]>;
  approveTool(callId: string, opts?: { sandboxOverride?: boolean; timeoutMs?: number }): Promise<void>;
  denyTool(callId: string, reason?: string): Promise<void>;

  /* ---------------- 设置 ---------------- */

  getSettings(): Promise<UserSettings>;
  updateSettings(patch: Partial<UserSettings>): Promise<void>;

  /* ---------------- 事件订阅 ---------------- */

  onEvent(listener: EventListener): () => void;
  onApproval(listener: ApprovalListener): () => void;

  /**
   * 向事件流手动追加一条事件（用于 UI 本地注入、调试回放）。
   * 注意：仅追加 UI 层事件，不进入 Cordis 的 append-only 日志。
   */
  pushSyntheticEvent(sessionId: string, kind: EventKind, content?: string, metadata?: Record<string, unknown>): void;
}
