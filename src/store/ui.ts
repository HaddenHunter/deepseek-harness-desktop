import { create } from "zustand";
import { shallow } from "zustand/shallow";
import type { IRuntime } from "@/runtime/IRuntime";
import type { PendingApproval, PluginInfo, RuntimeEvent, RuntimeMode, RuntimeStats, SessionSummary, UserSettings } from "@/runtime/types";
import { RUNTIME_MODES } from "@/runtime/types";

// Re-export for consumers that want stable selector comparisons across
// components without having to import zustand themselves.
export { shallow };

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

  // RAF-batching internals — consumers MUST NOT read directly.
  readonly _evBuffer: RuntimeEvent[];
  readonly _evRaf: ReturnType<typeof requestAnimationFrame> | 0;
  readonly _apprBuffer: Map<string, PendingApproval>;
  readonly _apprRaf: ReturnType<typeof requestAnimationFrame> | 0;
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
  _flushEventBuffer: () => void;
  _pushEvent: (ev: RuntimeEvent) => void;
  _flushApprovalBuffer: () => void;
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
  _evBuffer: [],
  _evRaf: 0,
  _apprBuffer: new Map(),
  _apprRaf: 0,
};

export const useUIStore = create<UIStore>((set, get) => ({
  ...INITIAL,

  /* ---------------------- Batching internals ----------------------
   * All per-event/per-approval pushes accumulate here. A single RAF
   * coalesces 10–200 events/sec into 1 set() call per animation frame,
   * collapsing N React renders into 1.
   */
  _evBuffer: [] as RuntimeEvent[],
  _evRaf: 0 as unknown as ReturnType<typeof requestAnimationFrame> | 0,
  _apprBuffer: new Map<string, PendingApproval>(),
  _apprRaf: 0 as unknown as ReturnType<typeof requestAnimationFrame> | 0,

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

  /* ---------------- Event batching (biggest single perf win) ----------------
   *
   * SDK streams evs at ~10–200/s during tool-heavy runs. Naively re-rendering
   * the entire chat list per event produces visible jank. Instead we collect
   * events for up to `BATCH_MS` and flush them once per animation frame,
   * which collapses N re-renders into 1.
   */
  async setMode(mode) {
    const prev = get();
    const rt = prev.runtime;
    if (!rt) return;
    if (prev.mode === mode) return; // same mode, nothing to do.

    // UI-level busy indicator: show switching animation until setMode promise resolves
    // (Sidebar component reads via its own local switching state too; this
    //  block is intentionally tolerant of double-clicks / React StrictMode
    //  double-invoke where start() itself now handles mode equality guard.)
    try {
      await rt.stop();
      await rt.start(mode);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ lastError: `切换运行模式失败：${msg}` });
      // If the switch failed, make sure the store reflects actual runtime
      // reality instead of a stale pending mode (prevents UI from
      // incorrectly highlighting the target mode when runtime is still the
      // old one).
      if (rt.isReady()) {
        const actualMode = rt.currentMode();
        if (actualMode) {
          set({ mode: actualMode });
          return;
        }
      }
      // If runtime is not ready after a failed stop+start, leave mode=prev.mode
      // so the sidecar "highlighted active mode" stays consistent with reality.
      set({ mode: prev.mode });
      return;
    }
    set({ mode });
    // refreshSessions is important: DshRuntime.stop() clears the frontend
    // sessions map, so after restart we MUST re-list for the sidebar to
    // populate correctly.
    try {
      await Promise.all([
        get().refreshSessions(),
        get().refreshStats(),
        get().refreshPlugins(),
      ]);
      if (!get().activeSessionId) {
        await get().createSession(mode);
      } else {
        // Re-hydrate events for the currently selected session so messages
        // don't visually "disappear" across a mode switch.
        try { await get().selectSession(get().activeSessionId); } catch { /* ignore */ }
      }
    } catch {
      // Post-switch session refresh failure is non-fatal; the user can still
      // click around to make data appear.
    }
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

  _flushEventBuffer() {
    const s = get();
    const buffer = s._evBuffer;
    if (buffer.length === 0) {
      set({ _evRaf: 0 });
      return;
    }
    const activeId = s.activeSessionId;
    let events = s.events;
    const newOnes: RuntimeEvent[] = [];
    let crossSession = false;
    for (const ev of buffer) {
      if (ev.sessionId !== activeId) { crossSession = true; continue; }
      newOnes.push(ev);
    }
    if (newOnes.length) events = [...events, ...newOnes];
    const generating = events.some(
      (e) => (e.kind === "assistant_thinking" || e.kind === "tool_call") &&
        !events.some((x) => x.kind === "assistant_message" && x.ts > e.ts),
    );
    set({ _evBuffer: [], _evRaf: 0, events, generating });
    if (crossSession) void s.refreshSessions();
  },

  _pushEvent(ev) {
    const s0 = get();
    s0._evBuffer.push(ev);
    if (s0._evRaf) return;
    const handle = requestAnimationFrame(() => get()._flushEventBuffer());
    set({ _evRaf: handle });
  },

  _flushApprovalBuffer() {
    const s = get();
    const buf = s._apprBuffer;
    if (buf.size === 0) { set({ _apprRaf: 0 }); return; }
    const existing = new Map(s.approvals.map((a) => [a.toolCallId, a] as const));
    for (const [id, a] of buf.entries()) existing.set(id, a);
    buf.clear();
    set({ _apprBuffer: buf, _apprRaf: 0, approvals: Array.from(existing.values()) });
  },

  _pushApproval(a) {
    const s0 = get();
    s0._apprBuffer.set(a.toolCallId, a);
    if (s0._apprRaf) return;
    const handle = requestAnimationFrame(() => get()._flushApprovalBuffer());
    set({ _apprRaf: handle });
  },
}));
