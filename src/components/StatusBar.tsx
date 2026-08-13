import { useEffect, useState } from "react";
import { useUIStore } from "@/store/ui";
import { RUNTIME_MODES } from "@/runtime/types";

function fmtUptime(ms: number): string {
  if (!ms) return "-";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export default function StatusBar() {
  const stats = useUIStore((s) => s.stats);
  const runtimeKind = useUIStore((s) => s.runtimeKind);
  const mode = useUIStore((s) => s.mode);
  const ready = useUIStore((s) => s.runtimeReady);
  const refresh = useUIStore((s) => s.refreshStats);
  const pluginsEnabled = useUIStore((s) => s.plugins.filter((p) => p.enabled).length);
  const pluginsTotal = useUIStore((s) => s.plugins.length);
  const approvals = useUIStore((s) => s.approvals.length);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setTick((t) => t + 1);
      refresh();
    }, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  const modeLabel = RUNTIME_MODES.find((m) => m.id === mode)?.label ?? mode;

  return (
    <div
      key={tick}
      className="h-7 px-3 border-t border-dsh-border bg-dsh-panel/60 flex items-center justify-between text-[11px] text-slate-400 select-none"
    >
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1.5">
          <span className={"w-1.5 h-1.5 rounded-full " + (ready ? "bg-dsh-accent2" : "bg-dsh-warn animate-pulse")} />
          {ready ? "Runtime Online" : "Booting…"}
        </span>
        <span>{modeLabel}</span>
        <span>
          plugins {pluginsEnabled}/{pluginsTotal}
        </span>
        <span>sessions {stats?.sessionsActive ?? "-"}</span>
        <span>events {stats?.eventsTotal ?? "-"}</span>
        <span>tools {stats?.toolsExecuted ?? "-"}</span>
        <span>uptime {fmtUptime(stats?.uptimeMs ?? 0)}</span>
      </div>
      <div className="flex items-center gap-4">
        {approvals > 0 && (
          <span className="text-dsh-warn font-medium">
            ⚠ 工具待审批 {approvals}
          </span>
        )}
        <span className="dsh-chip !py-0">{runtimeKind}</span>
      </div>
    </div>
  );
}
