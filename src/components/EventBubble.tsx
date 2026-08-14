import { useState } from "react";
import type { RuntimeEvent } from "@/runtime/types";

interface Props {
  ev: RuntimeEvent;
}

const KIND_LABEL: Record<RuntimeEvent["kind"], string> = {
  user_message: "你",
  assistant_message: "助手",
  assistant_thinking: "思考",
  tool_call: "工具调用",
  tool_result: "工具结果",
  context_inject: "上下文注入",
  system_prompt: "系统提示",
  agent_spawn: "Spawn 子 Agent",
  agent_fork: "Fork 会话",
  workflow: "工作流",
  session_created: "会话创建",
  session_ended: "会话结束",
  error: "错误",
};

const KIND_LAYOUT: Record<RuntimeEvent["kind"], "justify-end" | "justify-start" | "justify-center"> = {
  user_message: "justify-end",
  assistant_message: "justify-start",
  assistant_thinking: "justify-start",
  tool_call: "justify-start",
  tool_result: "justify-start",
  context_inject: "justify-start",
  system_prompt: "justify-start",
  agent_spawn: "justify-start",
  agent_fork: "justify-start",
  workflow: "justify-start",
  session_created: "justify-center",
  session_ended: "justify-center",
  error: "justify-center",
};

const ACCENT_BY_KIND: Partial<Record<RuntimeEvent["kind"], string>> = {
  tool_call: "#f59e0b",
  tool_result: "#36d399",
  context_inject: "#60a5fa",
  system_prompt: "#a78bfa",
  agent_spawn: "#f472b6",
  agent_fork: "#f472b6",
  workflow: "#22d3ee",
};

function Avatar({
  name,
  gradient,
  emoji,
}: {
  name: string;
  gradient: string;
  emoji?: string;
}) {
  return (
    <div
      className="w-8 h-8 rounded-xl shrink-0 grid place-items-center text-[11px] font-bold text-white shadow"
      style={{
        background: gradient,
        boxShadow:
          "0 1px 0 rgba(255,255,255,0.15) inset, 0 6px 16px -8px rgba(0,0,0,0.9)",
      }}
      title={name}
    >
      {emoji ?? name.slice(0, 1).toUpperCase()}
    </div>
  );
}

function Timestamp({ ts }: { ts: number }) {
  return (
    <span
      className="text-[10.5px] text-slate-500 flex items-center gap-1 select-none"
      title={new Date(ts).toLocaleString()}
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none">
        <circle
          cx="12"
          cy="12"
          r="8"
          stroke="currentColor"
          strokeWidth="1.6"
          opacity="0.6"
        />
        <path
          d="M12 7v5l2 1.6"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          opacity="0.8"
        />
      </svg>
      {new Date(ts).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}
    </span>
  );
}

export default function EventBubble({ ev }: Props) {
  const [expanded, setExpanded] = useState(
    ev.kind === "user_message" ||
      ev.kind === "assistant_message" ||
      ev.kind === "error",
  );
  const label = KIND_LABEL[ev.kind];
  const layout = KIND_LAYOUT[ev.kind];

  const isUser = ev.kind === "user_message";
  const isAssistant = ev.kind === "assistant_message";
  const isDetail =
    ev.kind === "tool_call" ||
    ev.kind === "tool_result" ||
    ev.kind === "context_inject" ||
    ev.kind === "system_prompt" ||
    ev.kind === "agent_spawn" ||
    ev.kind === "agent_fork" ||
    ev.kind === "workflow";
  const isBare = ev.kind === "session_created" || ev.kind === "session_ended";
  const isThinking = ev.kind === "assistant_thinking";

  return (
    <div className={"flex w-full " + layout}>
      {isBare && (
        <div className="flex items-center gap-2 text-[11px] text-slate-500 py-1">
          <span className="h-px w-8 bg-gradient-to-r from-transparent to-white/10" />
          <span className="px-2 py-0.5 rounded-full border backdrop-blur-md"
            style={{
              background: "rgba(255,255,255,0.035)",
              borderColor: "rgba(255,255,255,0.07)",
            }}
          >
            {label} · {new Date(ev.ts).toLocaleTimeString()}
          </span>
          <span className="h-px w-8 bg-gradient-to-l from-transparent to-white/10" />
        </div>
      )}

      {isUser && (
        <div className="flex flex-col items-end gap-1.5 max-w-[82%]">
          <div className="flex items-center gap-2">
            <Timestamp ts={ev.ts} />
            <span className="text-[11px] text-slate-400 font-medium">{label}</span>
          </div>
          <div className="bubble-user px-4 py-3 text-[13.5px] whitespace-pre-wrap break-words leading-relaxed">
            {ev.content}
          </div>
        </div>
      )}

      {isAssistant && (
        <div className="flex gap-3 max-w-[88%]">
          <Avatar
            name="AI"
            gradient="linear-gradient(135deg, rgba(108,140,255,0.95), rgba(147,51,234,0.95))"
            emoji="✦"
          />
          <div className="flex flex-col gap-1.5 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-300 font-semibold tracking-wide">
                {label}
              </span>
              <Timestamp ts={ev.ts} />
            </div>
            <div className="bubble-assistant px-4 py-3 text-[13.5px] whitespace-pre-wrap break-words leading-relaxed text-slate-100">
              {ev.content}
            </div>
          </div>
        </div>
      )}

      {isThinking && (
        <div className="flex flex-col gap-1 max-w-[72%] pl-11">
          <div className="flex items-center gap-2">
            <span className="text-[10.5px] text-slate-500 font-medium tracking-wider uppercase">
              Thinking
            </span>
            <span className="w-6 h-px bg-gradient-to-r from-dsh-accent/40 to-transparent" />
          </div>
          <div
            className="rounded-xl border backdrop-blur px-3 py-2 text-[12px] italic text-slate-300/90 leading-relaxed"
            style={{
              background:
                "linear-gradient(135deg, rgba(108,140,255,0.08), rgba(147,51,234,0.05))",
              borderColor: "rgba(108,140,255,0.18)",
              borderLeft: "2px solid rgba(108,140,255,0.5)",
            }}
          >
            {ev.content}
          </div>
        </div>
      )}

      {isDetail && (
        <div className="w-[92%] pl-1">
          <details
            open={expanded}
            onToggle={(e) =>
              setExpanded((e.currentTarget as HTMLDetailsElement).open)
            }
            className="group"
          >
            <summary
              className="cursor-pointer list-none rounded-2xl border backdrop-blur-xl transition-all duration-200 hover:-translate-y-0.5"
              style={{
                background:
                  "linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.01))",
                borderColor: "rgba(255,255,255,0.08)",
                boxShadow:
                  "0 1px 0 rgba(255,255,255,0.05) inset, 0 16px 40px -22px rgba(0,0,0,0.9)",
              }}
            >
              <div className="px-3.5 py-2.5 flex items-center justify-between gap-3 select-none">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{
                      background: ACCENT_BY_KIND[ev.kind] ?? "#6c8cff",
                      boxShadow: `0 0 10px ${ACCENT_BY_KIND[ev.kind] ?? "#6c8cff"}66`,
                    }}
                  />
                  <span className="text-[12.5px] font-semibold text-slate-200">
                    {label}
                  </span>
                  {!!ev.metadata?.toolName && (
                    <span
                      className="px-2 py-0.5 rounded-full text-[10.5px] font-medium border"
                      style={{
                        background:
                          "linear-gradient(135deg, rgba(245,158,11,0.16), rgba(245,158,11,0.08))",
                        borderColor: "rgba(245,158,11,0.3)",
                        color: "#ffd38a",
                      }}
                    >
                      {String(ev.metadata.toolName)}
                    </span>
                  )}
                  {!!ev.metadata?.status && (
                    <span className="dsh-chip">{String(ev.metadata.status)}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Timestamp ts={ev.ts} />
                  <span
                    className="text-[10.5px] text-slate-500 w-16 text-right hidden sm:block"
                  >
                    {(ev.content ?? "").length || 0} chars
                  </span>
                  <span
                    className="w-6 h-6 rounded-lg grid place-items-center text-slate-400 group-hover:bg-white/10 transition-colors"
                    style={{
                      transform: expanded ? "rotate(180deg)" : "none",
                      transition: "transform .2s",
                    }}
                  >
                    ▾
                  </span>
                </div>
              </div>
            </summary>
            <div className="mt-2 rounded-2xl overflow-hidden"
              style={{
                border: "1px solid rgba(255,255,255,0.06)",
                background: "rgba(0,0,0,0.22)",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
              }}
            >
              <pre className="p-4 text-[12px] leading-relaxed font-mono text-slate-200 overflow-x-auto max-h-80 overflow-y-auto">
                {ev.content ?? "(empty)"}
              </pre>
              {ev.metadata && (
                <div
                  className="px-4 pb-3"
                  style={{
                    borderTop: "1px dashed rgba(255,255,255,0.07)",
                  }}
                >
                  <div className="pt-2 text-[10px] font-semibold text-slate-500 uppercase tracking-widest mb-1">
                    Meta
                  </div>
                  <pre className="text-[11px] font-mono text-slate-400 overflow-x-auto whitespace-pre-wrap break-words">
{JSON.stringify(ev.metadata, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </details>
        </div>
      )}

      {ev.kind === "error" && (
        <div
          className="max-w-[82%] rounded-2xl px-4 py-3 text-[12.5px] whitespace-pre-wrap leading-relaxed backdrop-blur-xl"
          style={{
            background:
              "linear-gradient(180deg, rgba(239,68,68,0.16), rgba(239,68,68,0.04))",
            border: "1px solid rgba(239,68,68,0.35)",
            color: "#fecaca",
            boxShadow:
              "0 1px 0 rgba(255,255,255,0.08) inset, 0 12px 30px -16px rgba(239,68,68,0.7)",
          }}
        >
          <div className="flex items-start gap-2.5">
            <div
              className="w-7 h-7 rounded-xl grid place-items-center text-sm shrink-0"
              style={{
                background: "linear-gradient(135deg, #ef4444, #b91c1c)",
                boxShadow:
                  "0 1px 0 rgba(255,255,255,0.2) inset, 0 6px 16px -6px rgba(239,68,68,0.7)",
              }}
            >
              ⚠️
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[11px] font-semibold tracking-wide text-red-200/90 uppercase">
                  {label}
                </span>
                <Timestamp ts={ev.ts} />
              </div>
              <div className="text-red-100/95">{ev.content}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
