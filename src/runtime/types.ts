export type RuntimeMode = "standard" | "ptc" | "minimal" | "creative";

export const RUNTIME_MODES: {
  id: RuntimeMode;
  label: string;
  description: string;
  defaultPlugins: string[];
}[] = [
  {
    id: "standard",
    label: "标准模式",
    description: "完整工具组合，面向常规 Agent 任务",
    defaultPlugins: ["shell", "file", "search", "mcp", "web"],
  },
  {
    id: "ptc",
    label: "PTC 模式",
    description: "程序化工具调用：模型生成代码编排多轮工具调用",
    defaultPlugins: ["shell", "file", "code-interpreter"],
  },
  {
    id: "minimal",
    label: "极简模式",
    description: "仅 shell + 文件编辑，最小环境测试模型能力",
    defaultPlugins: ["shell", "file"],
  },
  {
    id: "creative",
    label: "创造模式",
    description: "Agent 可检查运行时，试装 Cordis 插件创作新模式",
    defaultPlugins: ["shell", "file", "cordis-inspector"],
  },
];

export type EventKind =
  | "user_message"
  | "assistant_message"
  | "assistant_thinking"
  | "tool_call"
  | "tool_result"
  | "context_inject"
  | "system_prompt"
  | "agent_spawn"
  | "agent_fork"
  | "workflow"
  | "session_created"
  | "session_ended"
  | "error";

export interface RuntimeEvent {
  id: string;
  sessionId: string;
  kind: EventKind;
  ts: number;
  parentId?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  hidden?: boolean;
}

export interface SessionSummary {
  id: string;
  title: string;
  mode: RuntimeMode;
  createdAt: number;
  updatedAt: number;
  eventCount: number;
  tags?: string[];
}

export interface ToolCallMeta {
  toolId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: "pending" | "approved" | "running" | "success" | "error" | "rejected";
  approvalRequired: boolean;
  sandboxed: boolean;
  timeoutMs?: number;
  startedAt?: number;
  finishedAt?: number;
  errorMessage?: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  category:
    | "model"
    | "tool"
    | "skill"
    | "session"
    | "sandbox"
    | "storage"
    | "agent-loop"
    | "scheduler"
    | "ui"
    | "other";
  description?: string;
  provides?: string[];
  dependsOn?: string[];
}

export interface ModelConfig {
  provider: string;
  modelId: string;
  displayName: string;
  apiKeyEnv: string;
  baseUrl?: string;
  maxContext?: number;
  enabled: boolean;
}

export interface UserSettings {
  activeModel: string;
  models: ModelConfig[];
  apiKeys: Record<string, boolean>;
  pluginsEnabled: Record<string, boolean>;
  temperature: number;
  topP: number;
  maxTokens: number;
  toolApprovalAutoAllow: string[];
  toolApprovalAutoDeny: string[];
  telemetry: boolean;
  theme: "dark" | "light" | "system";
  runtimeCmd?: string;
  runtimeArgs?: string[];
}

export interface RuntimeStats {
  pluginsLoaded: number;
  sessionsActive: number;
  eventsTotal: number;
  toolsExecuted: number;
  uptimeMs: number;
}

export interface PendingApproval {
  id: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  preview: string;
  risk: "low" | "medium" | "high";
  requestedAt: number;
}
