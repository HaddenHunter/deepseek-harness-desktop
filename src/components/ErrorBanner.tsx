import { useUIStore } from "@/store/ui";

export default function ErrorBanner() {
  const err = useUIStore((s) => s.lastError);
  const clear = useUIStore((s) => s.clearError);
  if (!err) return null;
  return (
    <div className="flex items-center justify-between px-4 py-2 text-xs bg-red-500/10 border-b border-red-500/30 text-red-300">
      <span className="truncate">⚠ {err}</span>
      <button
        onClick={clear}
        className="px-2 py-0.5 hover:bg-red-500/20 rounded ml-2 shrink-0"
      >
        关闭
      </button>
    </div>
  );
}
