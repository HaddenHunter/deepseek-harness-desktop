import { memo, useState } from "react";
import { shallow, useUIStore } from "@/store/ui";
import { RUNTIME_MODES, type RuntimeMode, type SessionSummary } from "@/runtime/types";

export default function Sidebar() {
  const {
    sessions,
    activeSessionId,
    sessionsLoading,
    mode,
    runtimeReady,
    generating,
    setMode,
    createSession,
    selectSession,
    forkSession,
    deleteSession,
    renameSession,
    setView,
    view,
    approvals,
    runtimeKind,
    lastError,
    clearError,
  } = useUIStore(
    (s) => ({
      sessions: s.sessions,
      activeSessionId: s.activeSessionId,
      sessionsLoading: s.sessionsLoading,
      mode: s.mode,
      runtimeReady: s.runtimeReady,
      generating: s.generating,
      setMode: s.setMode,
      createSession: s.createSession,
      selectSession: s.selectSession,
      forkSession: s.forkSession,
      deleteSession: s.deleteSession,
      renameSession: s.renameSession,
      setView: s.setView,
      view: s.view,
      approvals: s.approvals,
      runtimeKind: s.runtimeKind,
      lastError: s.lastError,
      clearError: s.clearError,
    }),
    shallow,
  );
  const [switching, setSwitching] = useState<string | null>(null);

  const switchingNow = switching !== null;
  const runModeBusy = switchingNow || generating || !runtimeReady;

  async function handleModeChange(nextMode: RuntimeMode) {
    if (mode === nextMode || switchingNow) return;
    setSwitching(nextMode);
    try {
      await setMode(nextMode);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      useUIStore.setState({ lastError: `切换运行模式失败：${msg}` });
      void lastError; void clearError;
    } finally {
      setSwitching(null);
    }
  }

  return (
    <aside className="w-72 flex flex-col relative overflow-hidden">
      {/* Aurora-tinted glass backdrop */}
      <div className="absolute inset-0" aria-hidden>
        <div className="absolute inset-0 bg-white/[0.03] backdrop-blur-2xl" />
        <div
          className="absolute inset-0 opacity-70"
          style={{
            background:
              "linear-gradient(180deg, rgba(108,140,255,0.08), rgba(108,140,255,0) 40%),linear-gradient(0deg, rgba(147,51,234,0.08), rgba(147,51,234,0) 40%)",
          }}
        />
        <div className="absolute inset-y-0 right-0 w-px bg-gradient-to-b from-transparent via-white/10 to-transparent" />
      </div>

      <div className="relative z-10 p-3.5 border-b border-white/[0.07] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-dsh-accent via-indigo-500 to-dsh-accent2 grid place-items-center text-sm font-bold text-white shadow-[0_8px_24px_-6px_rgba(108,140,255,0.6),0_4px_10px_-4px_rgba(54,211,153,0.4),0_0_0_1px_rgba(255,255,255,0.1)_inset]">
              D
            </div>
            <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-dsh-accent2 shadow-[0_0_0_2px_rgba(10,12,20,1)] animate-pulse" />
          </div>
          <div>
            <div className="text-[13.5px] font-semibold leading-tight tracking-tight text-white">
              DSH Desktop
            </div>
            <div className="text-[10.5px] leading-tight text-slate-400 flex items-center gap-1.5 mt-0.5">
              <span className="inline-block w-1 h-1 rounded-full bg-slate-500" />
              harness · {runtimeKind === "mock" ? "demo mock" : "sdk"}
            </div>
          </div>
        </div>
        <div
          className="px-2.5 py-1 rounded-full text-[10.5px] font-medium backdrop-blur-md border"
          title="运行模式"
          style={{
            background:
              "linear-gradient(135deg, rgba(108,140,255,0.16), rgba(147,51,234,0.12))",
            borderColor: "rgba(255,255,255,0.1)",
            color: "#c7d2fe",
            boxShadow: "0 0 0 1px rgba(255,255,255,0.04) inset",
          }}
        >
          {mode}
        </div>
      </div>

      <div className="relative z-10 px-3.5 pt-3.5">
        <button className="dsh-btn-primary w-full !py-2.5 group" onClick={() => createSession(mode)}>
          <span className="text-base leading-none group-hover:rotate-90 transition-transform duration-300">
            ＋
          </span>
          <span>新会话</span>
        </button>
      </div>

      <div className="relative z-10 px-3.5 pt-4">
        <div className="dsh-label flex items-center justify-between">
          <span>运行模式</span>
          {runModeBusy && !runtimeReady && (
            <span className="text-dsh-warn text-[10px] font-medium">
              {switchingNow ? `切换中… ${RUNTIME_MODES.find(m=>m.id===switching)?.label ?? ""}` : (generating ? "模型生成中" : "启动中")}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 p-1.5 rounded-2xl bg-white/[0.03] border border-white/[0.06] backdrop-blur-md">
          {RUNTIME_MODES.map((m) => {
            const active = mode === m.id;
            const isSwitchingTo = switchingNow && switching === m.id;
            const canClick = !runModeBusy && !active;
            const baseBg = active
              ? {
                  background:
                "linear-gradient(135deg, rgba(108,140,255,0.95), rgba(147,51,234,0.9))",
                  boxShadow:
                    "0 0 0 1px rgba(255,255,255,0.14) inset, 0 10px 24px -12px rgba(108,140,255,0.7)",
                }
              : isSwitchingTo
              ? {
                  background:
                    "linear-gradient(135deg, rgba(108,140,255,0.35), rgba(147,51,234,0.25))",
                  boxShadow:
                    "0 0 0 1px rgba(108,140,255,0.3) inset, 0 0 18px rgba(108,140,255,0.25)",
                }
              : undefined;
            let titleStr = m.description;
            if (runModeBusy) {
              const why = generating
                ? "生成中"
                : switchingNow
                  ? "切模式中"
                  : "启动中";
              titleStr += `（${why}，临时禁用）`;
            }
            return (
              <button
                key={m.id}
                type="button"
                title={titleStr}
                disabled={!canClick}
                onClick={() => handleModeChange(m.id as RuntimeMode)}
                style={baseBg}
                className={
                  "text-[12px] px-3 py-2.5 rounded-xl font-semibold transition-all duration-200 text-left w-full " +
                  (active
                    ? "text-white cursor-default"
                    : isSwitchingTo
                    ? "text-white cursor-wait animate-pulse"
                    : "text-slate-300 hover:text-white hover:bg-white/5 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:bg-transparent")
                }
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="tracking-tight leading-tight">
                    {m.label}
                    {active && <span className="ml-1.5 text-[9px] opacity-80">· 当前</span>}
                  </span>
                  {isSwitchingTo && (
                    <span className="inline-flex gap-0.5">
                      <span className="w-1 h-1 rounded-full bg-white animate-bounce [animation-delay:-0.2s]" />
                      <span className="w-1 h-1 rounded-full bg-white animate-bounce [animation-delay:-0.1s]" />
                      <span className="w-1 h-1 rounded-full bg-white animate-bounce" />
                    </span>
                  )}
                </div>
                <div className="text-[10px] leading-tight mt-1 opacity-75 line-clamp-1">
                  {m.description}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="dsh-divider mx-3.5 relative z-10" />

      <div className="relative z-10 px-3.5 flex items-center justify-between">
        <div className="text-[11.5px] text-slate-400 font-medium tracking-wide uppercase">
          会话{sessions.length ? ` · ${sessions.length}` : ""}
        </div>
        {approvals.length > 0 && (
          <span
            className="px-2.5 py-1 rounded-full text-[10.5px] font-semibold animate-pulse"
            style={{
              background:
                "linear-gradient(135deg, rgba(245,158,11,0.25), rgba(239,68,68,0.2))",
              color: "#ffd38a",
              boxShadow:
                "0 0 0 1px rgba(245,158,11,0.3) inset, 0 6px 16px -8px rgba(245,158,11,0.6)",
            }}
          >
            待审批 {approvals.length}
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2.5 py-2.5 space-y-1.5 relative z-10">
        {sessionsLoading && sessions.length === 0 && (
          <div className="text-xs text-slate-500 px-2 py-3">加载中…</div>
        )}
        {!sessionsLoading && sessions.length === 0 && (
          <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] p-5 text-center space-y-2">
            <div className="text-2xl">💬</div>
            <div className="text-[12.5px] text-slate-300 font-medium">还没有会话</div>
            <div className="text-[11px] text-slate-500 leading-relaxed">
              点上方「新会话」开始第一段对话吧～
            </div>
          </div>
        )}
        {sessions.map((s) => (
          <SessionItem
            key={s.id}
            session={s}
            active={activeSessionId === s.id}
          />
        ))}
      </div>

      <div
        className="relative z-10 border-t border-white/[0.07] p-2.5 grid grid-cols-3 gap-1"
        style={{
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0))",
        }}
      >
        {(
          [
            { id: "chat", icon: "💬", label: "会话" },
            { id: "plugins", icon: "🧩", label: "插件" },
            { id: "settings", icon: "⚙️", label: "设置" },
          ] as const
        ).map((t) => {
          const active = view === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setView(t.id as typeof view)}
              style={
                active
                  ? {
                      background:
                        "linear-gradient(135deg, rgba(108,140,255,0.25), rgba(147,51,234,0.18))",
                      boxShadow:
                        "0 0 0 1px rgba(255,255,255,0.1) inset, 0 6px 18px -10px rgba(108,140,255,0.6)",
                    }
                  : undefined
              }
              className={
                "relative flex flex-col items-center gap-0.5 py-2 rounded-xl text-[10.5px] font-medium transition-all duration-200 " +
                (active
                  ? "text-white"
                  : "text-slate-400 hover:text-slate-200 hover:bg-white/5")
              }
            >
              <span className="text-base leading-none">{t.icon}</span>
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

/* ------------------------- Individual session card ------------------------- */

const SessionItem = memo(function SessionItem({
  session,
  active,
}: {
  session: SessionSummary;
  active: boolean;
}) {
  const selectSession = useUIStore((s) => s.selectSession);
  const forkSession = useUIStore((s) => s.forkSession);
  const deleteSession = useUIStore((s) => s.deleteSession);
  const renameSession = useUIStore((s) => s.renameSession);
  const updatedAtLabel = new Date(session.updatedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const outerStyle = active
    ? {
        background:
          "linear-gradient(135deg, rgba(108,140,255,0.2), rgba(147,51,234,0.12))",
        boxShadow:
          "0 0 0 1px rgba(108,140,255,0.35) inset, 0 1px 0 rgba(255,255,255,0.06) inset, 0 10px 30px -14px rgba(108,140,255,0.7)",
      }
    : undefined;

  return (
    <div
      onClick={() => selectSession(session.id)}
      style={outerStyle}
      className={
        "group relative rounded-2xl px-3 py-2.5 cursor-pointer border transition-all duration-200 " +
        (active
          ? "text-white"
          : "border-transparent text-slate-300 hover:bg-white/5 hover:border-white/10")
      }
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span
            className={
              "inline-block w-1.5 h-1.5 rounded-full transition-colors " +
              (active
                ? "bg-white shadow-[0_0_8px_rgba(255,255,255,0.6)]"
                : "bg-slate-600")
            }
          />
          <input
            value={session.title}
            onChange={(e) => renameSession(session.id, e.target.value)}
            onClick={(e) => e.stopPropagation()}
            className="bg-transparent outline-none text-[12.5px] font-medium w-full truncate"
          />
        </div>
        <div className="hidden group-hover:flex items-center gap-1">
          <button
            title="分叉会话"
            onClick={(e) => {
              e.stopPropagation();
              forkSession(session.id);
            }}
            className="w-6 h-6 rounded-lg grid place-items-center text-slate-400 hover:text-white hover:bg-white/10 transition-colors text-[11px]"
          >
            ⎇
          </button>
          <button
            title="删除"
            onClick={(e) => {
              e.stopPropagation();
              deleteSession(session.id);
            }}
            className="w-6 h-6 rounded-lg grid place-items-center text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors text-[11px]"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between mt-2">
        <span
          className="px-2 py-0.5 rounded-full text-[10px] font-medium border backdrop-blur-md"
          style={{
            background: "rgba(255,255,255,0.05)",
            borderColor: "rgba(255,255,255,0.09)",
            color: "#b6c0d4",
          }}
        >
          {session.mode}
        </span>
        <span className="text-[10.5px] text-slate-500 flex items-center gap-1">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" opacity="0.6" />
            <path
              d="M12 7v5l3 2"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              opacity="0.8"
            />
          </svg>
          {updatedAtLabel}
        </span>
      </div>
    </div>
  );
});
