import { useUIStore } from "@/store/ui";

export default function TrajectoryPanel() {
  const events = useUIStore((s) => s.events);
  const activeSession = useUIStore((s) =>
    s.sessions.find((x) => x.id === s.activeSessionId),
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="h-12 border-b border-dsh-border flex items-center px-4">
        <div className="text-sm font-semibold">Trajectory</div>
        <span className="dsh-chip ml-2">{events.length} events</span>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-1 text-xs font-mono">
        {events.length === 0 && (
          <div className="text-slate-500 py-6 text-center">
            暂无事件。Append-only 事件流将在此处完整呈现所有系统提示词、推理、工具调用、子 Agent 调度等。
          </div>
        )}
        {events.map((e, i) => (
          <div
            key={e.id}
            className="grid grid-cols-[2rem_1fr] gap-2 px-2 py-1.5 rounded hover:bg-dsh-panel2/60 border border-transparent hover:border-dsh-border"
            title={e.id}
          >
            <span className="text-slate-600 text-right pr-1 select-none">{i + 1}</span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span
                  className={
                    "inline-block w-2 h-2 rounded-full " +
                    (e.kind === "user_message"
                      ? "bg-dsh-accent"
                      : e.kind === "assistant_message"
                        ? "bg-dsh-accent2"
                        : e.kind === "error"
                          ? "bg-red-500"
                          : e.kind.startsWith("tool")
                            ? "bg-dsh-warn"
                            : "bg-slate-500")
                  }
                />
                <span className="font-semibold text-slate-300">{e.kind}</span>
                <span className="text-slate-600 ml-auto">
                  {new Date(e.ts).toLocaleTimeString()}
                </span>
              </div>
              <div className="text-[11px] text-slate-400 truncate mt-0.5">
                {e.content?.slice(0, 120) ?? "(no body)"}
                {e.content && e.content.length > 120 ? "…" : ""}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-dsh-border p-3 text-[11px] text-slate-500 space-y-1">
        <div>会话：{activeSession?.id}</div>
        <div>统一事件流用于：调试 / 回放 / 分叉 / 评估对比。</div>
      </div>
    </div>
  );
}
