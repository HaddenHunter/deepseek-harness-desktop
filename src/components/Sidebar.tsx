import { useUIStore } from "@/store/ui";
import { RUNTIME_MODES, type RuntimeMode } from "@/runtime/types";

export default function Sidebar() {
  const sessions = useUIStore((s) => s.sessions);
  const activeSessionId = useUIStore((s) => s.activeSessionId);
  const sessionsLoading = useUIStore((s) => s.sessionsLoading);
  const mode = useUIStore((s) => s.mode);
  const setMode = useUIStore((s) => s.setMode);
  const createSession = useUIStore((s) => s.createSession);
  const selectSession = useUIStore((s) => s.selectSession);
  const forkSession = useUIStore((s) => s.forkSession);
  const deleteSession = useUIStore((s) => s.deleteSession);
  const renameSession = useUIStore((s) => s.renameSession);
  const setView = useUIStore((s) => s.setView);
  const view = useUIStore((s) => s.view);
  const approvals = useUIStore((s) => s.approvals);
  const runtimeKind = useUIStore((s) => s.runtimeKind);

  return (
    <aside className="w-72 border-r border-dsh-border flex flex-col bg-dsh-panel">
      <div className="p-3 border-b border-dsh-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-dsh-accent to-dsh-accent2 grid place-items-center text-xs font-bold">
            D
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">DSH Desktop</div>
            <div className="text-[10px] text-slate-500 leading-tight">
              harness · {runtimeKind === "mock" ? "demo mock" : "sdk"}
            </div>
          </div>
        </div>
        <div className="dsh-chip" title="运行模式">
          {mode}
        </div>
      </div>

      <div className="px-3 pt-3">
        <button className="dsh-btn-primary w-full" onClick={() => createSession(mode)}>
          <span>＋</span> 新会话
        </button>
      </div>

      <div className="px-3 pt-3">
        <div className="dsh-label">运行模式</div>
        <div className="grid grid-cols-2 gap-1.5">
          {RUNTIME_MODES.map((m) => (
            <button
              key={m.id}
              title={m.description}
              onClick={() => setMode(m.id as RuntimeMode)}
              className={
                "text-xs px-2 py-1.5 rounded-md border text-left transition-colors " +
                (mode === m.id
                  ? "bg-dsh-accent/15 border-dsh-accent/50 text-dsh-accent"
                  : "bg-dsh-panel2 border-dsh-border text-slate-300 hover:bg-dsh-panel2/80")
              }
            >
              <div className="font-medium">{m.label}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="dsh-divider mx-3" />

      <div className="px-3 flex items-center justify-between">
        <div className="text-xs text-slate-400">
          会话{sessions.length ? ` · ${sessions.length}` : ""}
        </div>
        {approvals.length > 0 && (
          <span className="dsh-chip !bg-dsh-warn/20 !text-dsh-warn !border-dsh-warn/40 animate-pulse">
            待审批 {approvals.length}
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-1">
        {sessionsLoading && sessions.length === 0 && (
          <div className="text-xs text-slate-500 px-2 py-3">加载中…</div>
        )}
        {!sessionsLoading && sessions.length === 0 && (
          <div className="text-xs text-slate-500 px-2 py-3">还没有会话，点上方「新会话」开始</div>
        )}
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => selectSession(s.id)}
            className={
              "group rounded-md px-2.5 py-2 cursor-pointer border transition-colors " +
              (activeSessionId === s.id
                ? "bg-dsh-accent/10 border-dsh-accent/40"
                : "border-transparent hover:bg-dsh-panel2 hover:border-dsh-border")
            }
          >
            <div className="flex items-center justify-between gap-2">
              <input
                value={s.title}
                onChange={(e) => renameSession(s.id, e.target.value)}
                onClick={(e) => e.stopPropagation()}
                className="bg-transparent outline-none text-sm w-full truncate"
              />
              <div className="hidden group-hover:flex items-center gap-0.5">
                <button
                  title="分叉会话"
                  onClick={(e) => {
                    e.stopPropagation();
                    forkSession(s.id);
                  }}
                  className="px-1.5 py-0.5 text-slate-400 hover:text-dsh-accent text-[11px]"
                >
                  ⎇
                </button>
                <button
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteSession(s.id);
                  }}
                  className="px-1.5 py-0.5 text-slate-400 hover:text-red-400 text-[11px]"
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="flex items-center justify-between mt-0.5">
              <span className="dsh-chip">{s.mode}</span>
              <span className="text-[10px] text-slate-500">
                {new Date(s.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-dsh-border p-2 grid grid-cols-3 gap-1">
        <button
          onClick={() => setView("chat")}
          className={"text-xs py-1.5 rounded " + (view === "chat" ? "bg-dsh-accent/15 text-dsh-accent" : "hover:bg-dsh-panel2 text-slate-400")}
        >
          💬 会话
        </button>
        <button
          onClick={() => setView("plugins")}
          className={"text-xs py-1.5 rounded " + (view === "plugins" ? "bg-dsh-accent/15 text-dsh-accent" : "hover:bg-dsh-panel2 text-slate-400")}
        >
          🧩 插件
        </button>
        <button
          onClick={() => setView("settings")}
          className={"text-xs py-1.5 rounded " + (view === "settings" ? "bg-dsh-accent/15 text-dsh-accent" : "hover:bg-dsh-panel2 text-slate-400")}
        >
          ⚙️ 设置
        </button>
      </div>
    </aside>
  );
}
