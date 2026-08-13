interface Props {
  error: string | null;
}

export default function BootOverlay({ error }: Props) {
  return (
    <div className="fixed inset-0 z-50 bg-dsh-bg/95 backdrop-blur grid place-items-center">
      <div className="text-center space-y-4 max-w-md">
        <div className="w-20 h-20 mx-auto rounded-2xl bg-gradient-to-br from-dsh-accent to-dsh-accent2 grid place-items-center text-3xl font-bold text-white shadow-2xl shadow-dsh-accent/20">
          D
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">DSH Desktop 正在启动</h1>
          <p className="text-sm text-slate-400 mt-1">
            {error ? "启动失败" : "正在初始化 Cordis 插件系统与运行时…"}
          </p>
        </div>
        {error ? (
          <div className="text-left bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-xs text-red-300 whitespace-pre-wrap">
            {error}
          </div>
        ) : (
          <div className="flex justify-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-dsh-accent animate-bounce [animation-delay:-0.3s]" />
            <span className="w-2 h-2 rounded-full bg-dsh-accent animate-bounce [animation-delay:-0.15s]" />
            <span className="w-2 h-2 rounded-full bg-dsh-accent animate-bounce" />
          </div>
        )}
      </div>
    </div>
  );
}
