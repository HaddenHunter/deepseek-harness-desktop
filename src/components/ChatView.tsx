import { memo, useEffect, useMemo, useRef } from "react";
import { shallow, useUIStore } from "@/store/ui";
import EventBubble from "./EventBubble";
import TrajectoryPanel from "./TrajectoryPanel";
import RightPanelToggle from "./RightPanelToggle";

export default function ChatView() {
  const { activeSessionId, sessions, rightPanel } = useUIStore(
    (s) => ({
      activeSessionId: s.activeSessionId,
      sessions: s.sessions,
      rightPanel: s.rightPanel,
    }),
    shallow,
  );
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId),
    [sessions, activeSessionId],
  );

  return (
    <div className="flex-1 min-h-0 flex">
      <div className="flex-1 min-w-0 flex flex-col">
        {/* ------------ Chat Header (glass) ------------ */}
        <header
          className="h-14 flex items-center px-4 gap-3 relative overflow-hidden"
          style={{
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))",
            backdropFilter: "blur(20px) saturate(1.2)",
          }}
        >
          <div
            className="pointer-events-none absolute inset-0 opacity-70"
            aria-hidden
            style={{
              background:
                "radial-gradient(500px 120px at 10% -10%, rgba(108,140,255,0.15), transparent 70%)",
            }}
          />
          <button
            onClick={() => toggleSidebar()}
            className="relative z-10 w-9 h-9 rounded-xl grid place-items-center text-slate-300 hover:text-white hover:bg-white/10 transition-all"
            title="切换侧边栏"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 7h16M4 12h10M4 17h16"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <div className="relative z-10 text-[13.5px] font-semibold truncate flex-1 flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-gradient-to-br from-dsh-accent to-dsh-accent2 shadow-[0_0_8px_rgba(108,140,255,0.6)]" />
            <span className="tracking-tight">{activeSession?.title ?? "未选择会话"}</span>
            {activeSession && (
              <span
                className="px-2 py-0.5 rounded-full text-[10px] font-medium"
                style={{
                  background: "rgba(255,255,255,0.05)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  color: "#a5b4d2",
                }}
              >
                {activeSession.mode}
              </span>
            )}
          </div>
          <div className="relative z-10">
            <RightPanelToggle />
          </div>
        </header>

        <ChatMessageList activeSessionId={activeSessionId} mode={activeSession?.mode ?? null} />
        <ChatComposer />
      </div>
      {rightPanel === "trajectory" && <TrajectoryPanel />}
    </div>
  );
}

/* ---------------- ChatMessageList: only re-renders on events/generating ---------------- */

const ChatMessageList = memo(function ChatMessageList({
  activeSessionId,
  mode,
}: {
  activeSessionId: string | null;
  mode: string | null;
}) {
  const { events, generating } = useUIStore(
    (s) => ({ events: s.events, generating: s.generating }),
    shallow,
  );
  const setInput = useUIStore((s) => s.setInput);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events.length, generating]);

  const suggestions = [
    { icon: "💡", label: "帮我解释一段代码" },
    { icon: "🧭", label: "总结当前工作目录的项目结构" },
    { icon: "🛠", label: "写一个小工具并执行它" },
    { icon: "🌐", label: "搜一下今日科技新闻，总结 3 条" },
  ];

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto px-5 py-8"
      style={{
        background:
          "radial-gradient(700px 400px at 50% -5%, rgba(108,140,255,0.06), transparent 60%)",
      }}
    >
      <div className="mx-auto max-w-3xl space-y-5">
        {!activeSessionId && (
          <EmptyHint
            icon="🚪"
            title="选一个会话，或开始新的一段"
            subtitle="在左侧选择会话历史，或点 ➕ 新会话开始你的 Agent。"
          />
        )}
        {activeSessionId && events.length === 0 && (
          <div className="py-10 space-y-8">
            <div className="text-center space-y-3">
              <div className="mx-auto w-16 h-16 rounded-3xl grid place-items-center text-3xl shadow-[0_18px_40px_-12px_rgba(108,140,255,0.55)]"
                style={{
                  background:
                    "linear-gradient(135deg, rgba(108,140,255,0.9), rgba(147,51,234,0.9))",
                }}
              >
                ✨
              </div>
              <div
                className="text-3xl font-bold tracking-tight bg-clip-text text-transparent"
                style={{
                  backgroundImage:
                    "linear-gradient(135deg, #fff, #cfd6ff 40%, #9fe6c9)",
                }}
              >
                准备就绪
              </div>
              <div className="text-[13px] text-slate-400">
                当前是 <b className="text-slate-200">{mode ?? "standard"}</b> 模式。
                输入问题或任务描述，按 Enter 发送，Shift + Enter 换行。
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {suggestions.map((s) => (
                <button
                  key={s.label}
                  onClick={() => setInput(s.label)}
                  className="group text-left p-3.5 rounded-2xl border backdrop-blur-md transition-all duration-200 hover:-translate-y-0.5"
                  style={{
                    background:
                      "linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.015))",
                    borderColor: "rgba(255,255,255,0.07)",
                    boxShadow:
                      "0 1px 0 rgba(255,255,255,0.05) inset, 0 14px 30px -20px rgba(0,0,0,0.9)",
                  }}
                  onMouseEnter={(e) => {
                    const t = e.currentTarget;
                    t.style.borderColor = "rgba(108,140,255,0.35)";
                    t.style.background =
                      "linear-gradient(180deg, rgba(108,140,255,0.12), rgba(147,51,234,0.05))";
                  }}
                  onMouseLeave={(e) => {
                    const t = e.currentTarget;
                    t.style.borderColor = "rgba(255,255,255,0.07)";
                    t.style.background =
                      "linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.015))";
                  }}
                >
                  <div className="flex items-start gap-3">
                    <div className="text-xl leading-none">{s.icon}</div>
                    <div className="flex-1 text-[12.5px] font-medium text-slate-200 group-hover:text-white">
                      {s.label}
                    </div>
                    <span className="text-slate-500 group-hover:text-dsh-accent transition-colors">
                      →
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
        {events.map((ev) => (
          <EventBubble key={ev.id} ev={ev} />
        ))}
        {generating && (
          <div className="pl-2 flex items-center gap-3 text-[12px] text-slate-400">
            <span className="relative inline-flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-dsh-accent opacity-60" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-dsh-accent shadow-[0_0_10px_rgba(108,140,255,0.7)]" />
            </span>
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-slate-300">正在思考</span>
              <span className="inline-flex gap-0.5">
                <span className="w-1 h-1 rounded-full bg-slate-400 animate-bounce [animation-delay:-0.3s]" />
                <span className="w-1 h-1 rounded-full bg-slate-400 animate-bounce [animation-delay:-0.15s]" />
                <span className="w-1 h-1 rounded-full bg-slate-400 animate-bounce" />
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

/* ---------------- ChatComposer: syncs input with store only on send / blur / idle ---------------- */

const ChatComposer = memo(function ChatComposer() {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const rafRef = useRef<ReturnType<typeof requestAnimationFrame> | 0>(0);
  const idleRef = useRef<ReturnType<typeof setTimeout> | 0>(0);

  // pull initial value + keep track of current store input externally
  // (we do NOT subscribe to input here to avoid per-keystroke re-render of composer)
  const inputSnapshot = useUIStore.getState().input;
  useEffect(() => {
    if (taRef.current && taRef.current.value !== inputSnapshot) {
      taRef.current.value = inputSnapshot;
    }
    // keep in sync when external setInput happens (e.g. suggestion click or
    // switching sessions). subscribe to input directly via on-store-change once:
    let prev = useUIStore.getState().input;
    const unsub = useUIStore.subscribe((st) => {
      const v = st.input;
      if (v === prev) return;
      prev = v;
      if (taRef.current && taRef.current.value !== v) {
        taRef.current.value = v;
      }
    });
    return () => {
      unsub();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (idleRef.current) clearTimeout(idleRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const generating = useUIStore((s) => s.generating);
  const sendMessage = useUIStore((s) => s.sendMessage);
  const cancelGeneration = useUIStore((s) => s.cancelGeneration);
  const setInput = useUIStore((s) => s.setInput);

  const flushInputToStore = () => {
    if (!taRef.current) return;
    const v = taRef.current.value;
    if (useUIStore.getState().input !== v) setInput(v);
  };

  const autosize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  };
  useEffect(() => {
    autosize();
  }, [inputSnapshot]);

  return (
    <footer
      className="relative p-3 sm:p-4"
      style={{
        borderTop: "1px solid rgba(255,255,255,0.06)",
        background:
          "linear-gradient(0deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))",
        backdropFilter: "blur(20px) saturate(1.2)",
      }}
    >
      <div
        className="pointer-events-none absolute -top-10 left-1/2 -translate-x-1/2 w-[60%] h-20"
        aria-hidden
        style={{
          background:
            "radial-gradient(closest-side, rgba(108,140,255,0.18), transparent 70%)",
        }}
      />
      <div className="mx-auto max-w-3xl">
        <div
          className="relative rounded-2xl p-2 flex gap-2 items-end transition-all duration-200"
          style={{
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.015))",
            border: "1px solid rgba(255,255,255,0.08)",
            boxShadow:
              "0 1px 0 rgba(255,255,255,0.06) inset, 0 20px 60px -24px rgba(0,0,0,0.9)",
            backdropFilter: "blur(16px)",
          }}
        >
          <div className="relative z-10 w-full flex gap-2 items-end">
            <textarea
              ref={taRef}
              rows={2}
              defaultValue={inputSnapshot}
              onChange={(e) => {
                // Only locally — defer commit to store (idle + blur + send)
                // + schedule one RAF autosize per frame.
                if (!rafRef.current) {
                  rafRef.current = requestAnimationFrame(() => {
                    rafRef.current = 0;
                    autosize();
                  });
                }
                if (idleRef.current) clearTimeout(idleRef.current);
                idleRef.current = setTimeout(() => {
                  idleRef.current = 0;
                  flushInputToStore();
                }, 250);
              }}
              onBlur={flushInputToStore}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  flushInputToStore();
                  sendMessage();
                }
              }}
              placeholder="说点什么…  ✦ Enter 发送，Shift+Enter 换行"
              className="flex-1 bg-transparent outline-none resize-none text-[13.5px] leading-6 px-3 py-1.5 placeholder:text-slate-500/80"
            />
          </div>
          <div className="relative z-10 flex items-center gap-2 pr-1 pb-1">
            {generating ? (
              <button
                onClick={() => cancelGeneration()}
                className="h-9 px-4 rounded-xl font-semibold text-[12.5px] transition-all text-white"
                style={{
                  background:
                    "linear-gradient(135deg, rgba(239,68,68,0.95), rgba(239,68,68,0.75))",
                  boxShadow:
                    "0 10px 24px -12px rgba(239,68,68,0.7), 0 0 0 1px rgba(255,255,255,0.1) inset",
                }}
              >
                ⏹ 停止
              </button>
            ) : (
              <button
                onClick={() => {
                  flushInputToStore();
                  sendMessage();
                }}
                className="h-9 px-4 rounded-xl font-semibold text-[12.5px] text-white transition-all"
                style={{
                  background:
                    "linear-gradient(135deg, rgba(108,140,255,0.95), rgba(147,51,234,0.9))",
                  boxShadow:
                    "0 10px 24px -12px rgba(108,140,255,0.7), 0 0 0 1px rgba(255,255,255,0.12) inset",
                }}
              >
                发送 ⏎
              </button>
            )}
          </div>
        </div>
      </div>
    </footer>
  );
});

function EmptyHint({
  icon,
  title,
  subtitle,
}: {
  icon: string;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="py-16 grid place-items-center">
      <div className="max-w-md text-center space-y-3">
        <div
          className="mx-auto w-14 h-14 rounded-2xl grid place-items-center text-2xl"
          style={{
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))",
            border: "1px solid rgba(255,255,255,0.08)",
            boxShadow: "0 14px 30px -18px rgba(0,0,0,0.9)",
          }}
        >
          {icon}
        </div>
        <div className="text-[15px] font-semibold text-slate-100">{title}</div>
        <div className="text-[12.5px] text-slate-400 leading-relaxed">{subtitle}</div>
      </div>
    </div>
  );
}
