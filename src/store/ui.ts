import { create } from "zustand";
import type { IRuntime } from "@/runtime/IRuntime";
import type { PendingApproval, PluginInfo, RuntimeEvent, RuntimeMode, RuntimeStats, SessionSummary, UserSettings } from "@/runtime/types";
import { RUNTIME_MODES } from "@/runtime/types";

export type ViewName = "chat" | "settings" | "plugins" | "approvals" | "about";

export interface UIState {
  runtime: IRuntime | null;
  runtimeReady: boolean;
  runtimeKind: "mock" | "dsh" | null;
  runtimeError: string | null;
  mode: RuntimeMode;
  stats: RuntimeStats | null;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  events: RuntimeEvent[];
  sessionsLoading: boolean;
  settings: UserSettings | null;
  plugins: PluginInfo[];
  approvals: PendingApproval[];
  view: ViewName;
  sidebarOpen: boolean;
  input: string;
  generating: boolean;
  lastError: string | null;
  rightPanel: "trajectory" | "tool" | null;
}

export interface UIActions {
  boot: (runtime: IRuntime, kind: "mock" | "dsh") => Promise<void>;
  setMode: (mode: RuntimeMode) => Promise<void>;
  refreshStats: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  createSession: (mode?: RuntimeMode, title?: string) => Promise<void>;
  selectSession: (id: string | null) => Promise<void>;
  forkSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  sendMessage: () => Promise<void>;
  cancelGeneration: () => Promise<void>;
  setInput: (v: string) => void;
  refreshPlugins: () => Promise<void>;
  togglePlugin: (id: string, enabled: boolean) => Promise<void>;
  hotReloadPlugin: (id: string) => Promise<void>;
  refreshApprovals: () => Promise<void>;
  approveTool: (callId: string) => Promise<void>;
  denyTool: (callId: string, reason?: string) => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: (patch: Partial<UserSettings>) => Promise<void>;
  setApiKeyMask: (envName: string, hasKey: boolean) => void;
  setView: (v: ViewName) => void;
  toggleSidebar: (v?: boolean) => void;
  setRightPanel: (p: UIState["rightPanel"]) => void;
  clearError: () => void;
  _pushEvent: (ev: RuntimeEvent) => void;
  _pushApproval: (a: PendingApproval) => void;
}

export type UIStore = UIState & UIActions;

const INITIAL: UIState = {
  runtime: null,
  runtimeReady: false,
  runtimeKind: null,
  runtimeError: null,
  mode: "standard",
  stats: null,
  sessions: [],
  activeSessionId: null,
  events: [],
  sessionsLoading: false,
  settings: null,
  plugins: [],
  approvals: [],
  view: "chat",
  sidebarOpen: true,
  input: "",
  generating: false,
  lastError: null,
  rightPanel: "trajectory",
};

export const useUIStore = create<UIStore>((set, get) => ({
  ...INITIAL,

  async boot(runtime, kind) {
    try {
      set({ runtime, runtimeKind: kind });
      const mode = RUNTIME_MODES[0].id;
      await runtime.start(mode);
      const offEvent = runtime.onEvent((ev) => get()._pushEvent(ev));
      const offAppr = runtime.onApproval((a) => get()._pushApproval(a));
      void offEvent; void offAppr;
      set({ runtimeReady: true, mode });
      await Promise.all([
        get().refreshStats(),
        get().refreshSessions(),
        get().refreshPlugins(),
        get().refreshApprovals(),
        get().loadSettings(),
      ]);
      if (!get().activeSessionId) {
        await get().createSession(mode);
      }
    } catch (e) {
      set({ runtimeError: (e as Error).message, lastError: (e as Error).message });
    }
  },

  async setMode(mode) {
    const rt = get().runtime;
    if (!rt) return;
    await rt.stop();
    await rt.start(mode);
    set({ mode });
    await Promise.all([get().refreshStats(), get().refreshPlugins()]);
  },

  async refreshStats() {
    const rt = get().runtime;
    if (!rt?.isReady()) return;
    set({ stats: await rt.stats() });
  },

  async refreshSessions() {
    const rt = get().runtime;
    if (!rt?.isReady()) return;
    set({ sessionsLoading: true });
    try {
      set({ sessions: await rt.listSessions(), sessionsLoading: false });
    } catch (e) {
      set({ sessionsLoading: false, lastError: (e as Error).message });
    }
  },

  async createSession(mode, title) {
    const rt = get().runtime;
    if (!rt?.isReady()) return;
    const id = await rt.createSession(mode ?? get().mode, title);
    await get().refreshSessions();
    await get().selectSession(id);
  },

  async selectSession(id) {
    set({ activeSessionId: id, events: [] });
    if (!id) return;
    const rt = get().runtime;
    if (!rt) return;
    const evs = await rt.getSessionEvents(id);
    set({ events: evs });
  },

  async forkSession(id) {
    const rt = get().runtime;
    if (!rt?.isReady()) return;
    const newId = await rt.forkSession(id);
    await get().refreshSessions();
    await get().selectSession(newId);
  },

  async deleteSession(id) {
    const rt = get().runtime;
    if (!rt?.isReady()) return;
    await rt.deleteSession(id);
    const next = get().sessions.filter((s) => s.id !== id);
    set({
      sessions: next,
      activeSessionId: get().activeSessionId === id ? next[0]?.id ?? null : get().activeSessionId,
      events: get().activeSessionId === id ? [] : get().events,
    });
    if (!get().activeSessionId) {
      await get().createSession();
    }
  },

  async renameSession(id, title) {
    const rt = get().runtime;
    if (!rt?.isReady()) return;
    await rt.setSessionTitle(id, title);
    await get().refreshSessions();
  },

  async sendMessage() {
    const rt = get().runtime;
    const sid = get().activeSessionId;
    const text = get().input.trim();
    if (!rt?.isReady() || !sid || !text) return;
    set({ input: "", generating: true });
    try {
      await rt.sendUserMessage(sid, text);
    } catch (e) {
      set({ lastError: (e as Error).message, generating: false });
    }
  },

  async cancelGeneration() {
    const rt = get().runtime;
    const sid = get().activeSessionId;
    if (!rt || !sid) return;
    await rt.cancelGeneration(sid);
    set({ generating: false });
  },

  setInput(v) {
    set({ input: v });
  },

  async refreshPlugins() {
    const rt = get().runtime;
    if (!rt?.isReady()) return;
    set({ plugins: await rt.listPlugins() });
  },

  async togglePlugin(id, enabled) {
    const rt = get().runtime;
    if (!rt?.isReady()) return;
    await rt.setPluginEnabled(id, enabled);
    await get().refreshPlugins();
    await get().refreshStats();
  },

  async hotReloadPlugin(id) {
    const rt = get().runtime;
    if (!rt?.isReady()) return;
    await rt.hotReloadPlugin(id);
    await get().refreshPlugins();
  },

  async refreshApprovals() {
    const rt = get().runtime;
    if (!rt?.isReady()) return;
    set({ approvals: await rt.listPendingApprovals() });
  },

  async approveTool(callId) {
    const rt = get().runtime;
    if (!rt?.isReady()) return;
    await rt.approveTool(callId);
    await get().refreshApprovals();
  },

  async denyTool(callId, reason) {
    const rt = get().runtime;
    if (!rt?.isReady()) return;
    await rt.denyTool(callId, reason);
    await get().refreshApprovals();
  },

  async loadSettings() {
    const rt = get().runtime;
    if (!rt?.isReady()) return;
    set({ settings: await rt.getSettings() });
  },

  async saveSettings(patch) {
    const rt = get().runtime;
    if (!rt?.isReady()) return;
    await rt.updateSettings(patch);
    await get().loadSettings();
  },

  setApiKeyMask(envName, hasKey) {
    const s = get().settings;
    if (!s) return;
    set({ settings: { ...s, apiKeys: { ...s.apiKeys, [envName]: hasKey } } });
  },

  setView(v) {
    set({ view: v });
  },
  toggleSidebar(v) {
    set({ sidebarOpen: typeof v === "boolean" ? v : !get().sidebarOpen });
  },
  setRightPanel(p) {
    set({ rightPanel: p });
  },
  clearError() {
    set({ lastError: null });
  },

  _pushEvent(ev) {
    const s = get();
    if (ev.sessionId !== s.activeSessionId) {
      void s.refreshSessions();
      return;
    }
    const next = [...s.events, ev];
    const generating = next.some(
      (e) => (e.kind === "assistant_thinking" || e.kind === "tool_call") && !next.some((x) => x.kind === "assistant_message" && x.ts > e.ts),
    );
    set({ events: next, generating });
  },

  _pushApproval(a) {
    set((s) => ({ approvals: [...s.approvals.filter((x) => x.toolCallId !== a.toolCallId), a] }));
  },
}));
