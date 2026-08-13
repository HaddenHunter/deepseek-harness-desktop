import { useEffect, useRef } from "react";
import { useUIStore } from "@/store/ui";
import EventBubble from "./EventBubble";
import TrajectoryPanel from "./TrajectoryPanel";
import RightPanelToggle from "./RightPanelToggle";

export default function ChatView() {
  const input = useUIStore((s) => s.input);
  const setInput = useUIStore((s) => s.setInput);
  const sendMessage = useUIStore((s) => s.sendMessage);
  const cancelGeneration = useUIStore((s) => s.cancelGeneration);
  const generating = useUIStore((s) => s.generating);
  const events = useUIStore((s) => s.events);
  const activeSessionId = useUIStore((s) => s.activeSessionId);
  const sessions = useUIStore((s) => s.sessions);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const rightPanel = useUIStore((s) => s.rightPanel);
  const activeSession = sessions.find((s) => s.id === activeSessionId);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events.length, generating]);

  return (
    <div className="flex-1 min-h-0 flex">
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-12 border-b border-dsh-border flex items-center px-4 gap-3">
          <button
            onClick={() => toggleSidebar()}
            className="text-slate-400 hover:text-slate-200 text-sm px-2 py-1 rounded hover:bg-dsh-panel2"
            title="切换侧边栏"
          >
            ☰
          </button>
          <div className="text-sm font-medium truncate flex-1">
            {activeSession?.title ?? "未选择会话"}
          </div>
          <RightPanelToggle />
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
          {!activeSessionId && (
            <div className="h-full grid place-items-center text-slate-500 text-sm">
              左侧选择或创建一个会话开始
            </div>
          )}
          {activeSessionId && events.length === 0 && (
            <div className="h-full grid place-items-center">
              <div className="text-center space-y-2 max-w-md">
                <div className="text-2xl font-semibold bg-gradient-to-r from-dsh-accent to-dsh-accent2 bg-clip-text text-transparent">
                  准备就绪
                </div>
                <div className="text-sm text-slate-400">
                  当前是 <b>{activeSession?.mode}</b> 模式。输入问题或任务描述，按 Enter 发送，Shift+Enter 换行。
                </div>
              </div>
            </div>
          )}
          {events.map((ev) => (
            <EventBubble key={ev.id} ev={ev} />
          ))}
          {generating && (
            <div className="text-xs text-slate-500 pl-2 flex items-center gap-2">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-dsh-accent animate-pulse" />
              推理中…
            </div>
          )}
        </div>

        <footer className="border-t border-dsh-border p-3">
          <div className="dsh-panel p-2 flex gap-2 items-end">
            <textarea
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
              className="flex-1 bg-transparent outline-none resize-none text-sm leading-6 px-2 py-1 placeholder:text-slate-500"
            />
            {generating ? (
              <button className="dsh-btn-danger" onClick={cancelGeneration}>
                ⏹ 取消
              </button>
            ) : (
              <button
                className="dsh-btn-primary"
                onClick={sendMessage}
                disabled={!input.trim() || !activeSessionId}
              >
                发送 ⏎
              </button>
            )}
          </div>
        </footer>
      </div>

      {rightPanel && (
        <div className="w-96 border-l border-dsh-border flex flex-col bg-dsh-panel/40">
          {rightPanel === "trajectory" && <TrajectoryPanel />}
        </div>
      )}
    </div>
  );
}
