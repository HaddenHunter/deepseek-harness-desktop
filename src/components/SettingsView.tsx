import { useEffect, useState } from "react";
import { useUIStore } from "@/store/ui";
import { secureDelete, secureGet, secureSet } from "@/hooks/tauriNative";

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="dsh-switch" data-on={on} onClick={() => onChange(!on)}>
      <span className="dsh-switch-knob" />
    </div>
  );
}

export default function SettingsView() {
  const settings = useUIStore((s) => s.settings);
  const saveSettings = useUIStore((s) => s.saveSettings);
  const setApiKeyMask = useUIStore((s) => s.setApiKeyMask);

  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [apiKeySaved, setApiKeySaved] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!settings) return;
    (async () => {
      const next: Record<string, boolean> = {};
      for (const m of settings.models) {
        const v = await secureGet(m.apiKeyEnv);
        next[m.apiKeyEnv] = !!v;
        setApiKeyMask(m.apiKeyEnv, !!v);
      }
      setApiKeySaved(next);
    })();
  }, [settings, setApiKeyMask]);

  if (!settings) {
    return <div className="flex-1 grid place-items-center text-slate-400 text-sm">加载设置…</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <header className="h-12 border-b border-dsh-border flex items-center px-6 text-sm font-semibold">
        设置 · Settings
      </header>

      <div className="max-w-3xl mx-auto py-6 px-6 space-y-8">
        <section>
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <span className="text-dsh-accent">●</span> 模型配置
          </h2>
          <div className="space-y-3">
            {settings.models.map((m) => (
              <div key={m.modelId} className="dsh-panel p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{m.displayName}</span>
                      <span className="dsh-chip">{m.provider}</span>
                      {m.maxContext && <span className="dsh-chip">{(m.maxContext / 1000).toFixed(0)}K</span>}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      env: <code className="text-slate-400">{m.apiKeyEnv}</code>
                      {m.baseUrl && <> · baseUrl: <code className="text-slate-400">{m.baseUrl}</code></>}
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-xs">
                      {apiKeySaved[m.apiKeyEnv] ? (
                        <span className="text-dsh-accent2">✓ 已保存</span>
                      ) : (
                        <span className="text-dsh-warn">⚠ 未配置</span>
                      )}
                    </span>
                    <Switch
                      on={m.enabled}
                      onChange={(v) =>
                        saveSettings({
                          models: settings.models.map((x) =>
                            x.modelId === m.modelId ? { ...x, enabled: v } : x,
                          ),
                        })
                      }
                    />
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <input
                    type="password"
                    placeholder={`输入 ${m.apiKeyEnv}（敏感信息仅存入系统 Keychain / localStorage fallback）`}
                    value={apiKeyInputs[m.apiKeyEnv] ?? ""}
                    onChange={(e) =>
                      setApiKeyInputs((p) => ({ ...p, [m.apiKeyEnv]: e.target.value }))
                    }
                    className="dsh-input text-xs !py-1.5"
                  />
                  <button
                    className="dsh-btn-primary text-xs !py-1.5"
                    disabled={!apiKeyInputs[m.apiKeyEnv]?.trim()}
                    onClick={async () => {
                      await secureSet(m.apiKeyEnv, apiKeyInputs[m.apiKeyEnv].trim());
                      setApiKeySaved((p) => ({ ...p, [m.apiKeyEnv]: true }));
                      setApiKeyMask(m.apiKeyEnv, true);
                      setApiKeyInputs((p) => ({ ...p, [m.apiKeyEnv]: "" }));
                    }}
                  >
                    保存
                  </button>
                  <button
                    className="dsh-btn text-xs !py-1.5"
                    onClick={async () => {
                      const v = await secureGet(m.apiKeyEnv);
                      if (v) {
                        setApiKeyInputs((p) => ({ ...p, [m.apiKeyEnv]: v }));
                      }
                    }}
                  >
                    查看
                  </button>
                  <button
                    className="dsh-btn-danger text-xs !py-1.5"
                    onClick={async () => {
                      await secureDelete(m.apiKeyEnv);
                      setApiKeySaved((p) => ({ ...p, [m.apiKeyEnv]: false }));
                      setApiKeyMask(m.apiKeyEnv, false);
                    }}
                  >
                    清除
                  </button>
                </div>
                {settings.activeModel === m.modelId ? (
                  <div className="mt-2 text-xs text-dsh-accent">当前启用模型</div>
                ) : (
                  <button
                    className="mt-2 text-xs text-slate-400 hover:text-dsh-accent"
                    onClick={() => saveSettings({ activeModel: m.modelId })}
                  >
                    设为活动模型 →
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <span className="text-dsh-accent">●</span> 推理参数
          </h2>
          <div className="dsh-panel p-4 space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <div className="dsh-label flex justify-between">
                  <span>temperature</span>
                  <span className="text-slate-300">{settings.temperature.toFixed(2)}</span>
                </div>
                <input
                  type="range" min={0} max={2} step={0.01}
                  value={settings.temperature}
                  onChange={(e) => saveSettings({ temperature: +e.target.value })}
                  className="w-full"
                />
              </div>
              <div>
                <div className="dsh-label flex justify-between">
                  <span>top_p</span>
                  <span className="text-slate-300">{settings.topP.toFixed(2)}</span>
                </div>
                <input
                  type="range" min={0} max={1} step={0.01}
                  value={settings.topP}
                  onChange={(e) => saveSettings({ topP: +e.target.value })}
                  className="w-full"
                />
              </div>
              <div>
                <div className="dsh-label flex justify-between">
                  <span>max_tokens</span>
                  <span className="text-slate-300">{settings.maxTokens}</span>
                </div>
                <input
                  type="number"
                  value={settings.maxTokens}
                  onChange={(e) => saveSettings({ maxTokens: Math.max(1, +e.target.value || 0) })}
                  className="dsh-input text-xs !py-1.5"
                />
              </div>
            </div>
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <span className="text-dsh-accent">●</span> 工具审批策略
          </h2>
          <div className="dsh-panel p-4 space-y-4 text-xs">
            <div>
              <div className="dsh-label">自动允许（命中工具名即跳过审批，逗号分隔）</div>
              <input
                className="dsh-input text-xs"
                value={settings.toolApprovalAutoAllow.join(", ")}
                onChange={(e) =>
                  saveSettings({
                    toolApprovalAutoAllow: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                  })
                }
              />
            </div>
            <div>
              <div className="dsh-label">自动拒绝（命中工具名即拒绝，逗号分隔）</div>
              <input
                className="dsh-input text-xs"
                value={settings.toolApprovalAutoDeny.join(", ")}
                onChange={(e) =>
                  saveSettings({
                    toolApprovalAutoDeny: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                  })
                }
              />
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              建议通过跨工具抑制、时间窗口抑制、方向抑制等策略降低误报，而非单纯通过缩小阈值规避。
            </p>
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <span className="text-dsh-accent">●</span> 外观 / 遥测
          </h2>
          <div className="dsh-panel p-4 space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">主题</div>
                <div className="text-slate-500">当前：{settings.theme}</div>
              </div>
              <select
                className="dsh-input !w-auto text-xs"
                value={settings.theme}
                onChange={(e) => saveSettings({ theme: e.target.value as "dark" | "light" | "system" })}
              >
                <option value="dark">深色</option>
                <option value="light">浅色</option>
                <option value="system">跟随系统</option>
              </select>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">匿名遥测</div>
                <div className="text-slate-500">仅帮助改进，不发送会话内容</div>
              </div>
              <Switch on={settings.telemetry} onChange={(v) => saveSettings({ telemetry: v })} />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
