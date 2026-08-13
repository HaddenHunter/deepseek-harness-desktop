import { useUIStore } from "@/store/ui";

export default function RightPanelToggle() {
  const rightPanel = useUIStore((s) => s.rightPanel);
  const setRightPanel = useUIStore((s) => s.setRightPanel);
  return (
    <div className="flex items-center gap-1 text-xs">
      <button
        onClick={() => setRightPanel(rightPanel === "trajectory" ? null : "trajectory")}
        className={
          "px-2 py-1 rounded border transition-colors " +
          (rightPanel === "trajectory"
            ? "bg-dsh-accent/15 border-dsh-accent/40 text-dsh-accent"
            : "border-dsh-border text-slate-400 hover:text-slate-200")
        }
      >
        Trajectory
      </button>
    </div>
  );
}
