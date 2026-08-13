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

const KIND_STYLE: Record<RuntimeEvent["kind"], string> = {
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

export default function EventBubble({ ev }: Props) {
  const [expanded, setExpanded] = useState(
    ev.kind === "user_message" || ev.kind === "assistant_message",
  );
  const label = KIND_LABEL[ev.kind];
  const layout = KIND_STYLE[ev.kind];

  const bubble = (() => {
    switch (ev.kind) {
      case "user_message":
        return (
          <div className="max-w-[78%] bg-dsh-accent text-white rounded-2xl rounded-br-md px-4 py-2.5 text-sm whitespace-pre-wrap break-words">
            {ev.content}
          </div>
        );
      case "assistant_message":
        return (
          <div className="max-w-[85%] bg-dsh-panel border border-dsh-border rounded-2xl rounded-tl-md px-4 py-2.5 text-sm whitespace-pre-wrap break-words text-slate-100">
            {ev.content}
          </div>
        );
      case "assistant_thinking":
        return (
          <div className="max-w-[70%] text-xs text-slate-400 italic pl-1 border-l-2 border-dsh-border">
            {ev.content}
          </div>
        );
      case "tool_call":
      case "tool_result":
      case "context_inject":
      case "system_prompt":
      case "agent_spawn":
      case "agent_fork":
      case "workflow":
        return (
          <details
            open={expanded}
            onToggle={(e) => setExpanded((e.currentTarget as HTMLDetailsElement).open)}
            className="max-w-[85%] dsh-panel text-sm"
          >
            <summary className="cursor-pointer list-none px-3 py-2 flex items-center justify-between gap-2 hover:bg-dsh-panel2/60 rounded-t-md select-none">
              <div className="flex items-center gap-2">
                <span
                  className={
                    "w-1.5 h-1.5 rounded-full " +
                    (ev.kind === "tool_call"
                      ? "bg-dsh-warn"
                      : ev.kind === "tool_result"
                        ? "bg-dsh-accent2"
                        : "bg-dsh-accent")
                  }
                />
                <span className="font-medium text-slate-300">{label}</span>
                {!!ev.metadata?.toolName && (
                  <span className="dsh-chip">{String(ev.metadata.toolName)}</span>
                )}
              </div>
              <span className="text-[10px] text-slate-500">
                {expanded ? "收起" : "展开"} · {(ev.content ?? "").length} chars
              </span>
            </summary>
            <pre className="p-3 pt-1 text-xs font-mono text-slate-300 overflow-x-auto max-h-72 overflow-y-auto">
              {ev.content ?? "(empty)"}
            </pre>
            {ev.metadata && (
              <pre className="px-3 pb-2 text-[10px] font-mono text-slate-500 overflow-x-auto">
                {JSON.stringify(ev.metadata, null, 2)}
              </pre>
            )}
          </details>
        );
      case "session_created":
      case "session_ended":
        return (
          <div className="text-[11px] text-slate-500 dsh-chip">
            {label} · {new Date(ev.ts).toLocaleTimeString()}
          </div>
        );
      case "error":
        return (
          <div className="max-w-[80%] text-xs px-3 py-2 rounded-md border border-red-500/40 bg-red-500/10 text-red-300 whitespace-pre-wrap">
            ⚠️ {ev.content}
          </div>
        );
    }
  })();

  return (
    <div className={"flex w-full " + layout}>{bubble}</div>
  );
}
