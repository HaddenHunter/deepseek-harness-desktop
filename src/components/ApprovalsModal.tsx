import { useState } from "react";
import { useUIStore } from "@/store/ui";

export default function ApprovalsModal() {
  const approvals = useUIStore((s) => s.approvals);
  const approveTool = useUIStore((s) => s.approveTool);
  const denyTool = useUIStore((s) => s.denyTool);
  const selectSession = useUIStore((s) => s.selectSession);
  const activeId = useUIStore((s) => s.activeSessionId);

  const [denyReason, setDenyReason] = useState<Record<string, string>>({});

  if (approvals.length === 0) return null;

  const first = approvals[0];
  const isActive = first.sessionId === activeId;

  return (
    <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm grid place-items-center p-6">
      <div className="dsh-panel w-full max-w-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-dsh-border flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-dsh-warn animate-pulse" />
              工具调用审批（{approvals.length}）
            </div>
            <div className="text-xs text-slate-400 mt-0.5">
              来自会话 · 模式 {first.sessionId.slice(0, 12)}
            </div>
          </div>
          {!isActive && (
            <button className="dsh-btn text-xs" onClick={() => selectSession(first.sessionId)}>
              跳转会话
            </button>
          )}
        </div>

        <div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto">
          {approvals.map((a) => (
            <div key={a.id} className="dsh-panel !bg-dsh-bg p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="dsh-chip">{a.toolName}</span>
                  <span
                    className={
                      "dsh-chip " +
                      (a.risk === "high"
                        ? "!bg-red-500/15 !text-red-400 !border-red-500/40"
                        : a.risk === "medium"
                          ? "!bg-dsh-warn/15 !text-dsh-warn !border-dsh-warn/40"
                          : "!bg-dsh-accent2/15 !text-dsh-accent2 !border-dsh-accent2/40")
                    }
                  >
                    risk: {a.risk}
                  </span>
                </div>
                <span className="text-[11px] text-slate-500">
                  {new Date(a.requestedAt).toLocaleTimeString()}
                </span>
              </div>
              <pre className="text-xs font-mono text-slate-300 bg-black/30 rounded border border-dsh-border p-3 max-h-40 overflow-auto whitespace-pre-wrap">
                {a.preview || "(无参数)"}
              </pre>

              <div className="mt-3 flex items-center gap-2">
                <input
                  value={denyReason[a.id] ?? ""}
                  onChange={(e) => setDenyReason((m) => ({ ...m, [a.id]: e.target.value }))}
                  placeholder="拒绝原因（可选）"
                  className="dsh-input text-xs !py-1.5"
                />
                <button className="dsh-btn-danger" onClick={() => denyTool(a.toolCallId, denyReason[a.id])}>
                  拒绝
                </button>
                <button className="dsh-btn-primary" onClick={() => approveTool(a.toolCallId)}>
                  ✓ 批准执行
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
