import { useUIStore } from "@/store/ui";
import type { PluginInfo } from "@/runtime/types";

const CATEGORY_LABEL: Record<PluginInfo["category"], string> = {
  model: "模型",
  tool: "工具",
  skill: "技能",
  session: "会话",
  sandbox: "沙箱",
  storage: "存储",
  "agent-loop": "Agent Loop",
  scheduler: "调度",
  ui: "UI",
  other: "其他",
};

const CATEGORY_ORDER: PluginInfo["category"][] = [
  "model", "tool", "skill", "agent-loop", "scheduler",
  "sandbox", "storage", "session", "ui", "other",
];

function Switch({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div
      className={"dsh-switch " + (disabled ? "opacity-40 pointer-events-none" : "")}
      data-on={on}
      onClick={() => !disabled && onChange(!on)}
    >
      <span className="dsh-switch-knob" />
    </div>
  );
}

export default function PluginsView() {
  const plugins = useUIStore((s) => s.plugins);
  const toggle = useUIStore((s) => s.togglePlugin);
  const hotReload = useUIStore((s) => s.hotReloadPlugin);
  const mode = useUIStore((s) => s.mode);

  const byCategory = new Map<PluginInfo["category"], PluginInfo[]>();
  for (const p of plugins) {
    if (!byCategory.has(p.category)) byCategory.set(p.category, []);
    byCategory.get(p.category)!.push(p);
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <header className="h-12 border-b border-dsh-border flex items-center px-6 text-sm font-semibold justify-between">
        <div>插件管理 · Plugins</div>
        <div className="dsh-chip">{plugins.filter((p) => p.enabled).length} / {plugins.length} enabled</div>
      </header>

      <div className="max-w-4xl mx-auto py-6 px-6 space-y-6 text-sm">
        <div className="dsh-panel p-4 text-xs text-slate-400 leading-relaxed">
          当前运行模式：<b className="text-slate-200">{mode}</b>。
          DeepSeek Harness 各层能力均由 Cordis 插件提供，模型 / 工具 / 技能 / 会话 / 沙箱 / 存储 / Agent Loop / 调度 / UI 均可替换，无需修改 Harness 源码。
        </div>

        {CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((cat) => (
          <section key={cat}>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2 flex items-center gap-2">
              <span>{CATEGORY_LABEL[cat]}</span>
              <span className="text-slate-600">({byCategory.get(cat)!.length})</span>
              <span className="flex-1 h-px bg-dsh-border" />
            </h2>
            <div className="space-y-2">
              {byCategory.get(cat)!.map((p) => (
                <div key={p.id} className="dsh-panel p-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{p.name}</span>
                        <span className="dsh-chip">v{p.version}</span>
                        {p.provides?.map((s) => (
                          <span key={s} className="dsh-chip !bg-dsh-accent/10 !text-dsh-accent !border-dsh-accent/30">
                            provides: {s}
                          </span>
                        ))}
                      </div>
                      {p.description && (
                        <div className="text-xs text-slate-400 mt-1">{p.description}</div>
                      )}
                      {p.dependsOn && p.dependsOn.length > 0 && (
                        <div className="text-[11px] text-slate-500 mt-1">
                          depends: <code className="text-slate-400">{p.dependsOn.join(", ")}</code>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <button
                        className="dsh-btn text-xs !py-1"
                        onClick={() => hotReload(p.id)}
                        disabled={!p.enabled}
                      >
                        ⟳ 热重载
                      </button>
                      <Switch on={p.enabled} onChange={(v) => toggle(p.id, v)} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
