import { useEffect, useMemo, useState } from "react";
import { useUIStore } from "@/store/ui";
import { secureDelete, secureGet, secureSet } from "@/hooks/tauriNative";
import { PROVIDER_PROFILES } from "@/runtime/dsh/DshRuntime";
import type { ModelConfig, UserSettings } from "@/runtime/types";

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="dsh-switch" data-on={on} onClick={() => onChange(!on)}>
      <span className="dsh-switch-knob" />
    </div>
  );
}

type Draft = Partial<ModelConfig>;

const EMPTY_DRAFT: Draft = {
  provider: "deepseek-official",
  displayName: "",
  modelId: "",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  baseUrl: "https://api.deepseek.com/v1",
  maxContext: 128000,
  enabled: true,
};

function modelKey(m: { provider: string; modelId: string }) {
  return `${m.provider}/${m.modelId}`;
}

export default function SettingsView() {
  const settings = useUIStore((s) => s.settings);
  const saveSettings = useUIStore((s) => s.saveSettings);
  const setApiKeyMask = useUIStore((s) => s.setApiKeyMask);

  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [apiKeySaved, setApiKeySaved] = useState<Record<string, boolean>>({});

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [creating, setCreating] = useState(false);
  const [newDraft, setNewDraft] = useState<Draft>({ ...EMPTY_DRAFT });

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

  const profileById = useMemo(() => {
    const map: Record<string, (typeof PROVIDER_PROFILES)[number]> = {};
    for (const p of PROVIDER_PROFILES) map[p.id] = p;
    return map;
  }, []);

  if (!settings) {
    return <div className="flex-1 grid place-items-center text-slate-400 text-sm">加载设置…</div>;
  }

  const resetNewDraft = (providerId?: string) => {
    const p = providerId ? profileById[providerId] : profileById["deepseek-official"];
    setNewDraft({
      provider: p.id,
      displayName: p.recommendedModels[0]?.displayName ?? "",
      modelId: p.recommendedModels[0]?.id ?? "",
      apiKeyEnv: p.defaultApiKeyEnv,
      baseUrl: p.defaultBaseUrl,
      maxContext: p.recommendedModels[0]?.maxContext ?? 128000,
      enabled: true,
    });
  };

  const startEdit = (m: ModelConfig) => {
    setEditingKey(modelKey(m));
    setDrafts((d) => ({ ...d, [modelKey(m)]: { ...m } }));
  };

  const cancelEdit = (m: ModelConfig) => {
    setEditingKey(null);
    setDrafts((d) => {
      const n = { ...d };
      delete n[modelKey(m)];
      return n;
    });
  };

  const applyDraftToModel = (m: ModelConfig, draft: Draft): ModelConfig => {
    const patched: ModelConfig = {
      provider: draft.provider ?? m.provider,
      modelId: (draft.modelId ?? m.modelId).trim(),
      displayName: (draft.displayName ?? m.displayName).trim() || (draft.modelId ?? m.modelId),
      apiKeyEnv: (draft.apiKeyEnv ?? m.apiKeyEnv).trim() || m.apiKeyEnv,
      baseUrl: draft.baseUrl ? draft.baseUrl.trim() || undefined : m.baseUrl,
      maxContext:
        typeof draft.maxContext === "number" ? Math.max(1024, draft.maxContext) : m.maxContext,
      enabled: typeof draft.enabled === "boolean" ? draft.enabled : m.enabled,
    };
    return patched;
  };

  const saveEdit = async (m: ModelConfig) => {
    const draft = drafts[modelKey(m)] ?? {};
    const patched = applyDraftToModel(m, draft);
    const oldKey = modelKey(m);
    const newKey = modelKey(patched);
    const wasActive = settings.activeModel === oldKey;
    saveSettings({
      models: settings.models.map((x) => (modelKey(x) === oldKey ? patched : x)),
      ...(wasActive ? { activeModel: newKey } : {}),
    });
    // ----- 写 Keychain：优先用"draft 里填的 input"，否则用 apiKeyInputs[env]
    const env = patched.apiKeyEnv;
    const inputFromDraft =
      typeof (draft as Draft & { apiKey?: string }).apiKey === "string"
        ? (draft as Draft & { apiKey?: string }).apiKey
        : undefined;
    const raw = inputFromDraft ?? apiKeyInputs[env];
    if (typeof raw === "string" && raw.trim()) {
      try {
        await secureSet(env, raw.trim());
        setApiKeyMask(env, true);
        setApiKeySaved((p) => ({ ...p, [env]: true }));
      } catch (e) {
        console.error("[settings] secureSet failed (edit)", env, e);
      }
    }
    cancelEdit(m);
  };

  const saveOneKey = async (env: string) => {
    const raw = apiKeyInputs[env];
    if (typeof raw !== "string" || !raw.trim()) return;
    try {
      await secureSet(env, raw.trim());
      setApiKeyMask(env, true);
      setApiKeySaved((p) => ({ ...p, [env]: true }));
    } catch (e) {
      console.error("[settings] secureSet (saveOneKey) failed", env, e);
    }
  };

  const deleteModel = (m: ModelConfig) => {
    const k = modelKey(m);
    const remaining = settings.models.filter((x) => modelKey(x) !== k);
    if (remaining.length === 0) return; // 至少留一个
    const patch: Partial<typeof settings> = { models: remaining };
    if (settings.activeModel === k) {
      patch.activeModel = modelKey(remaining[0]);
    }
    saveSettings(patch);
    if (editingKey === k) setEditingKey(null);
    // 顺手清掉对应的 keychain 条目（非关键路径静默）
    void secureDelete(m.apiKeyEnv).catch(() => {});
  };

  const saveNew = async () => {
    const draft = newDraft;
    if (!draft.provider || !draft.modelId?.trim() || !draft.displayName?.trim()) return;
    const patched = applyDraftToModel(
      {
        provider: "deepseek-official",
        modelId: "",
        displayName: "",
        apiKeyEnv: "",
        enabled: true,
      },
      draft,
    );
    const k = modelKey(patched);
    const already = settings.models.find((x) => modelKey(x) === k);
    if (already) {
      saveSettings({
        models: settings.models.map((x) => (modelKey(x) === k ? patched : x)),
        activeModel: k,
      });
    } else {
      saveSettings({
        models: [...settings.models, patched],
        activeModel: k,
      });
    }
    // ----- 写 Keychain：优先 draft 里 apiKey，否则读 apiKeyInputs[env]
    const env = patched.apiKeyEnv;
    const rawApiKey =
      typeof (draft as Draft & { apiKey?: string }).apiKey === "string"
        ? (draft as Draft & { apiKey?: string }).apiKey
        : apiKeyInputs[env];
    if (typeof rawApiKey === "string" && rawApiKey.trim()) {
      try {
        await secureSet(env, rawApiKey.trim());
        setApiKeyMask(env, true);
        setApiKeySaved((p) => ({ ...p, [env]: true }));
      } catch (e) {
        console.error("[settings] secureSet failed (new)", env, e);
      }
    }
    setCreating(false);
    setNewDraft({ ...EMPTY_DRAFT });
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <header
        className="h-14 flex items-center px-6 relative overflow-hidden"
        style={{
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))",
          backdropFilter: "blur(20px) saturate(1.2)",
        }}
      >
        <div
          className="pointer-events-none absolute inset-0 opacity-70"
          aria-hidden
          style={{
            background:
              "radial-gradient(520px 120px at 10% -10%, rgba(108,140,255,0.16), transparent 70%),radial-gradient(420px 120px at 100% 10%, rgba(147,51,234,0.14), transparent 70%)",
          }}
        />
        <div className="relative z-10 flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-xl grid place-items-center text-sm shadow-[0_8px_22px_-10px_rgba(108,140,255,0.7)]"
            style={{
              background:
                "linear-gradient(135deg, rgba(108,140,255,0.95), rgba(147,51,234,0.95))",
            }}
          >
            ⚙
          </div>
          <div>
            <div className="text-[14px] font-bold tracking-tight text-white">设置</div>
            <div className="text-[11px] text-slate-400 leading-none mt-0.5">
              Settings · 模型、外观、Runtime、桌面宠物
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-4xl mx-auto py-8 px-5 sm:px-8 space-y-7">
        {/* ------------ 模型配置 ------------ */}
        <section>
          <div className="flex items-center justify-between mb-3.5">
            <h2 className="dsh-section-title">模型配置</h2>
            <button
              className="dsh-btn-primary text-[12px] !py-1.5"
              onClick={() => {
                setCreating(true);
                resetNewDraft();
              }}
              disabled={creating}
            >
              + 新增自定义模型
            </button>
          </div>

          {/* 活动模型下拉 */}
          <div className="dsh-card mb-4">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex-1 min-w-[260px]">
                <div className="dsh-label">当前活动模型（启动 DSH Runtime 时使用）</div>
                <select
                  className="dsh-input text-xs w-full"
                  value={settings.activeModel}
                  onChange={(e) => saveSettings({ activeModel: e.target.value })}
                >
                  {settings.models.map((m) => {
                    const saved = apiKeySaved[m.apiKeyEnv];
                    return (
                      <option key={modelKey(m)} value={modelKey(m)}>
                        {m.displayName} · {m.provider}/{m.modelId}
                        {saved ? " · ✅ 已配 Key" : " · ⚠️ 未配 Key"}
                        {!m.enabled ? " (已禁用)" : ""}
                      </option>
                    );
                  })}
                </select>
                <div className="text-[11px] text-slate-500 mt-1">
                  启动时会将「活动模型」的 provider / modelId / baseUrl / API Key 注入 SDK 侧
                  initialize handshake；若未在 Settings 页保存 Key，则回退使用进程环境变量（如
                  DEEPSEEK_API_KEY）。
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            {settings.models.map((m) => {
              const k = modelKey(m);
              const isEditing = editingKey === k;
              const draft = drafts[k] ?? {};
              const view = isEditing ? draft : m;
              const profile = profileById[view.provider ?? ""];
              return (
                <div key={k} className="dsh-card">
                  {/* 头部：名称 / provider / 上下文 / enabled / actions */}
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">
                          {view.displayName ?? m.displayName}
                        </span>
                        <span className="dsh-chip">{view.provider ?? m.provider}</span>
                        {(view.maxContext ?? m.maxContext) && (
                          <span className="dsh-chip">
                            {((view.maxContext ?? m.maxContext)! / 1000).toFixed(0)}K
                          </span>
                        )}
                        {settings.activeModel === k && (
                          <span className="dsh-chip !bg-dsh-accent/15 !text-dsh-accent !border-dsh-accent/30">
                            活动模型
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        model_id:{" "}
                        <code className="text-slate-400">{view.modelId ?? m.modelId}</code>
                        {" · "}env:{" "}
                        <code className="text-slate-400">{view.apiKeyEnv ?? m.apiKeyEnv}</code>
                        {(view.baseUrl ?? m.baseUrl) && (
                          <>
                            {" · "}baseUrl:{" "}
                            <code className="text-slate-400">{view.baseUrl ?? m.baseUrl}</code>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <div className="flex items-center gap-2 text-xs">
                        <span className={apiKeySaved[m.apiKeyEnv] ? "text-dsh-accent2" : "text-dsh-warn"}>
                          {apiKeySaved[m.apiKeyEnv] ? "✓ Key 已存" : "⚠️ 未配 Key"}
                        </span>
                      </div>
                      <Switch
                        on={!!(view.enabled ?? m.enabled)}
                        onChange={(v) =>
                          isEditing
                            ? setDrafts((d) => ({ ...d, [k]: { ...(drafts[k] ?? {}), enabled: v } }))
                            : saveSettings({
                                models: settings.models.map((x) =>
                                  modelKey(x) === k ? { ...x, enabled: v } : x,
                                ),
                              })
                        }
                      />
                      {!isEditing ? (
                        <>
                          <button
                            className="dsh-btn text-xs !py-1"
                            onClick={() => startEdit(m)}
                          >
                            编辑
                          </button>
                          <button
                            className="dsh-btn-danger text-xs !py-1"
                            disabled={settings.models.length <= 1}
                            onClick={() => {
                              if (confirm(`确定删除模型 ${m.displayName}？`)) deleteModel(m);
                            }}
                          >
                            删除
                          </button>
                        </>
                      ) : (
                        <>
                          <button className="dsh-btn text-xs !py-1" onClick={() => cancelEdit(m)}>
                            取消
                          </button>
                          <button
                            className="dsh-btn-primary text-xs !py-1"
                            onClick={() => saveEdit(m)}
                            disabled={!draft.modelId?.trim() || !draft.displayName?.trim()}
                          >
                            保存
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* 编辑态：内联表单 */}
                  {isEditing && (
                    <div className="mt-4 pt-4 border-t border-white/10 space-y-3 text-xs">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <div className="dsh-label">Provider</div>
                          <select
                            className="dsh-input text-xs w-full"
                            value={draft.provider ?? m.provider}
                            onChange={(e) => {
                              const pid = e.target.value;
                              const prof = profileById[pid];
                              setDrafts((d) => ({
                                ...d,
                                [k]: {
                                  ...(drafts[k] ?? {}),
                                  provider: pid,
                                  baseUrl: prof?.defaultBaseUrl,
                                  apiKeyEnv: prof?.defaultApiKeyEnv,
                                  modelId:
                                    prof?.recommendedModels[0]?.id ??
                                    (drafts[k]?.modelId ?? m.modelId),
                                  displayName:
                                    prof?.recommendedModels[0]?.displayName ??
                                    (drafts[k]?.displayName ?? m.displayName),
                                  maxContext:
                                    prof?.recommendedModels[0]?.maxContext ??
                                    (drafts[k]?.maxContext ?? m.maxContext),
                                },
                              }));
                            }}
                          >
                            {PROVIDER_PROFILES.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.label}
                              </option>
                            ))}
                            <option value="custom">自定义 Provider（不在列表内）</option>
                          </select>
                        </div>
                        <div>
                          <div className="dsh-label">显示名</div>
                          <input
                            className="dsh-input text-xs w-full"
                            value={draft.displayName ?? m.displayName}
                            onChange={(e) =>
                              setDrafts((d) => ({
                                ...d,
                                [k]: { ...(drafts[k] ?? {}), displayName: e.target.value },
                              }))
                            }
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <div className="dsh-label">
                            Model ID{" "}
                            <span className="text-slate-500 font-normal">
                              （可从推荐选，也可自定义）
                            </span>
                          </div>
                          <select
                            className="dsh-input text-xs w-full"
                            value={draft.modelId ?? m.modelId}
                            onChange={(e) => {
                              const mid = e.target.value;
                              const prof = profile;
                              const rec = prof?.recommendedModels.find((r) => r.id === mid);
                              setDrafts((d) => ({
                                ...d,
                                [k]: {
                                  ...(drafts[k] ?? {}),
                                  modelId: mid,
                                  ...(rec
                                    ? {
                                        displayName: rec.displayName,
                                        maxContext: rec.maxContext ?? d[k]?.maxContext,
                                      }
                                    : {}),
                                },
                              }));
                            }}
                          >
                            {profile?.recommendedModels.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.displayName} ({r.id})
                              </option>
                            ))}
                            <option value={draft.modelId ?? m.modelId}>
                              — 当前值（自定义）：{draft.modelId ?? m.modelId} —
                            </option>
                          </select>
                          {!profile && (
                            <input
                              className="dsh-input text-xs w-full mt-2"
                              placeholder="或直接输入 model ID（自定义 provider 时）"
                              value={draft.modelId ?? m.modelId}
                              onChange={(e) =>
                                setDrafts((d) => ({
                                  ...d,
                                  [k]: { ...(drafts[k] ?? {}), modelId: e.target.value },
                                }))
                              }
                            />
                          )}
                        </div>
                        <div>
                          <div className="dsh-label">
                            最大上下文 <span className="text-slate-500 font-normal">(token)</span>
                          </div>
                          <input
                            type="number"
                            min={1024}
                            step={1024}
                            className="dsh-input text-xs w-full"
                            value={draft.maxContext ?? m.maxContext ?? 128000}
                            onChange={(e) =>
                              setDrafts((d) => ({
                                ...d,
                                [k]: {
                                  ...(drafts[k] ?? {}),
                                  maxContext: Math.max(1024, +e.target.value || 1024),
                                },
                              }))
                            }
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <div className="dsh-label">Base URL</div>
                          <input
                            className="dsh-input text-xs w-full"
                            placeholder="https://.../v1（留空使用 SDK 默认 / 进程环境）"
                            value={draft.baseUrl ?? m.baseUrl ?? ""}
                            onChange={(e) =>
                              setDrafts((d) => ({
                                ...d,
                                [k]: { ...(drafts[k] ?? {}), baseUrl: e.target.value },
                              }))
                            }
                          />
                        </div>
                        <div>
                          <div className="dsh-label">
                            API Key 环境变量名{" "}
                            <span className="text-slate-500 font-normal">（Keychain 存 key）</span>
                          </div>
                          <input
                            className="dsh-input text-xs w-full"
                            value={draft.apiKeyEnv ?? m.apiKeyEnv}
                            onChange={(e) =>
                              setDrafts((d) => ({
                                ...d,
                                [k]: { ...(drafts[k] ?? {}), apiKeyEnv: e.target.value },
                              }))
                            }
                          />
                        </div>
                        <div className="col-span-2">
                          <div className="dsh-label">
                            API Key 明文{" "}
                            <span className="text-slate-500 font-normal">
                              （点击「保存」写入 Keychain；可直接粘贴密钥，无需先通过下方「保存 Key」）
                            </span>
                          </div>
                          <input
                            type="password"
                            className="dsh-input text-xs w-full"
                            placeholder={
                              (draft.apiKeyEnv ?? m.apiKeyEnv)
                                ? `粘贴 ${draft.apiKeyEnv ?? m.apiKeyEnv} 对应的密钥…`
                                : "粘贴 API Key（仅本地 Keychain 保存，不写入 json）"
                            }
                            value={(draft as Draft & { apiKey?: string }).apiKey ?? ""}
                            onChange={(e) =>
                              setDrafts((d) => ({
                                ...d,
                                [k]: {
                                  ...(drafts[k] ?? {}),
                                  apiKey: e.target.value,
                                } as Draft & { apiKey?: string },
                              }))
                            }
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* API Key 操作行 */}
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
                      保存 Key
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
                  {settings.activeModel !== k && !isEditing && (
                    <button
                      className="mt-2 text-xs text-slate-400 hover:text-dsh-accent"
                      onClick={() => saveSettings({ activeModel: k })}
                    >
                      设为活动模型 →
                    </button>
                  )}
                </div>
              );
            })}

            {/* 新增模型卡片 */}
            {creating && (
              <div
                className="dsh-card"
                style={{
                  borderColor: "rgba(108,140,255,0.35)",
                  background:
                    "linear-gradient(180deg, rgba(108,140,255,0.12), rgba(147,51,234,0.04))",
                  boxShadow:
                    "0 0 0 1px rgba(108,140,255,0.15) inset, 0 20px 40px -24px rgba(108,140,255,0.45)",
                }}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-dsh-accent">+ 新模型</span>
                      <span className="dsh-chip">{newDraft.provider}</span>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      完成以下字段后点「保存创建」即加入模型列表，并自动设为活动模型。
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button className="dsh-btn text-xs !py-1" onClick={() => setCreating(false)}>
                      取消
                    </button>
                    <button
                      className="dsh-btn-primary text-xs !py-1"
                      disabled={!newDraft.modelId?.trim() || !newDraft.displayName?.trim()}
                      onClick={saveNew}
                    >
                      保存创建
                    </button>
                  </div>
                </div>
                <div className="mt-4 pt-4 border-t border-white/10 space-y-3 text-xs">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="dsh-label">Provider</div>
                      <select
                        className="dsh-input text-xs w-full"
                        value={newDraft.provider}
                        onChange={(e) => resetNewDraft(e.target.value)}
                      >
                        {PROVIDER_PROFILES.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                        <option value="custom">自定义 Provider</option>
                      </select>
                    </div>
                    <div>
                      <div className="dsh-label">显示名</div>
                      <input
                        className="dsh-input text-xs w-full"
                        value={newDraft.displayName ?? ""}
                        onChange={(e) =>
                          setNewDraft((d) => ({ ...d, displayName: e.target.value }))
                        }
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="dsh-label">Model ID（可自定义）</div>
                      {profileById[newDraft.provider ?? ""] ? (
                        <select
                          className="dsh-input text-xs w-full"
                          value={newDraft.modelId ?? ""}
                          onChange={(e) => {
                            const mid = e.target.value;
                            const prof = profileById[newDraft.provider ?? ""];
                            const rec = prof?.recommendedModels.find((r) => r.id === mid);
                            setNewDraft((d) => ({
                              ...d,
                              modelId: mid,
                              ...(rec
                                ? {
                                    displayName: rec.displayName,
                                    maxContext: rec.maxContext ?? d.maxContext,
                                  }
                                : {}),
                            }));
                          }}
                        >
                          {profileById[newDraft.provider ?? ""]?.recommendedModels.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.displayName} ({r.id})
                            </option>
                          ))}
                          <option value={newDraft.modelId ?? ""}>
                            — 自定义：{newDraft.modelId ?? "(空)"} —
                          </option>
                        </select>
                      ) : (
                        <input
                          className="dsh-input text-xs w-full"
                          placeholder="输入 model ID（自定义 provider）"
                          value={newDraft.modelId ?? ""}
                          onChange={(e) =>
                            setNewDraft((d) => ({ ...d, modelId: e.target.value }))
                          }
                        />
                      )}
                    </div>
                    <div>
                      <div className="dsh-label">最大上下文 (token)</div>
                      <input
                        type="number"
                        min={1024}
                        step={1024}
                        className="dsh-input text-xs w-full"
                        value={newDraft.maxContext ?? 128000}
                        onChange={(e) =>
                          setNewDraft((d) => ({
                            ...d,
                            maxContext: Math.max(1024, +e.target.value || 1024),
                          }))
                        }
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="dsh-label">Base URL</div>
                      <input
                        className="dsh-input text-xs w-full"
                        placeholder="https://.../v1"
                        value={newDraft.baseUrl ?? ""}
                        onChange={(e) =>
                          setNewDraft((d) => ({ ...d, baseUrl: e.target.value }))
                        }
                      />
                    </div>
                    <div>
                      <div className="dsh-label">API Key 环境变量名</div>
                      <input
                        className="dsh-input text-xs w-full"
                        value={newDraft.apiKeyEnv ?? ""}
                        onChange={(e) =>
                          setNewDraft((d) => ({ ...d, apiKeyEnv: e.target.value }))
                        }
                      />
                    </div>
                    <div className="col-span-2">
                      <div className="dsh-label">
                        API Key 明文{" "}
                        <span className="text-slate-500 font-normal">
                          （保存创建后立即写入 Keychain）
                        </span>
                      </div>
                      <input
                        type="password"
                        className="dsh-input text-xs w-full"
                        placeholder={
                          newDraft.apiKeyEnv
                            ? `粘贴 ${newDraft.apiKeyEnv} 对应的密钥…`
                            : "粘贴 API Key（仅本地 Keychain 保存，不写入 json）"
                        }
                        value={
                          (newDraft as Draft & { apiKey?: string }).apiKey ?? ""
                        }
                        onChange={(e) =>
                          setNewDraft((d) =>
                            ({
                              ...d,
                              apiKey: e.target.value,
                            }) as Draft & { apiKey?: string },
                          )
                        }
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ------------ 推理参数 ------------ */}
        <section>
          <h2 className="dsh-section-title mb-3">推理参数</h2>
          <div className="dsh-card space-y-5">
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

        {/* ------------ 工具审批 ------------ */}
        <section>
          <h2 className="dsh-section-title mb-3">工具审批策略</h2>
          <div className="dsh-card space-y-5 text-[12.5px]">
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

        {/* ------------ 外观 / 皮肤 ------------ */}
        <section>
          <h2 className="dsh-section-title mb-3">外观 · 皮肤（预留）</h2>
          <div className="dsh-card space-y-5 text-[12.5px]">
            <div className="flex items-center justify-between p-3.5 rounded-xl bg-white/[0.03] border border-white/[0.06]">
              <div>
                <div className="font-semibold text-slate-100">主题模式</div>
                <div className="text-slate-500 text-[11.5px] mt-0.5">当前：{settings.theme}</div>
              </div>
              <select
                className="dsh-input !w-auto text-xs !py-1.5"
                value={settings.theme}
                onChange={(e) => saveSettings({ theme: e.target.value as "dark" | "light" | "system" })}
              >
                <option value="dark">深色</option>
                <option value="light">浅色</option>
                <option value="system">跟随系统</option>
              </select>
            </div>

            <div>
              <div className="dsh-label">配色皮肤（预设：后续开放自定义皮肤包导入）</div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-2">
                {(
                  [
                    { id: "default", label: "默认（深海蓝）", swatch: "linear-gradient(135deg,#1e293b,#6366f1)" },
                    { id: "catppuccin-mocha", label: "Catppuccin Mocha", swatch: "linear-gradient(135deg,#1e1e2e,#f5c2e7)" },
                    { id: "dracula", label: "Dracula", swatch: "linear-gradient(135deg,#282a36,#ff79c6)" },
                    { id: "rose-pine", label: "Rosé Pine", swatch: "linear-gradient(135deg,#191724,#ebbcba)" },
                    { id: "nord", label: "Nord", swatch: "linear-gradient(135deg,#2e3440,#88c0d0)" },
                    { id: "solarized-light", label: "Solarized Light", swatch: "linear-gradient(135deg,#fdf6e3,#b58900)" },
                  ] as const
                ).map((s) => (
                  <button
                    key={s.id}
                    onClick={() => saveSettings({ appearance: { ...settings.appearance, skin: s.id } })}
                    className={`group rounded-2xl border text-left overflow-hidden transition-all duration-200 hover:-translate-y-0.5 ${
                      settings.appearance.skin === s.id
                        ? "ring-2"
                        : "hover:border-white/20"
                    }`}
                    style={{
                      borderColor:
                        settings.appearance.skin === s.id
                          ? "rgba(108,140,255,0.6)"
                          : "rgba(255,255,255,0.08)",
                      boxShadow:
                        settings.appearance.skin === s.id
                          ? "0 0 0 1px rgba(108,140,255,0.2) inset, 0 12px 28px -14px rgba(108,140,255,0.55)"
                          : undefined,
                    }}
                    title={`${s.label}（预设）`}
                  >
                    <div className="h-16 w-full relative">
                      <div
                        className="absolute inset-0"
                        style={{ backgroundImage: s.swatch }}
                      />
                      <div className="absolute inset-0"
                        style={{
                          background:
                            "linear-gradient(180deg, rgba(255,255,255,0.08), rgba(0,0,0,0) 60%)",
                        }}
                      />
                    </div>
                    <div className="p-2.5 text-[11.5px] flex items-center justify-between bg-white/[0.02] border-t border-white/[0.05]">
                      <span className="font-medium text-slate-200">{s.label}</span>
                      {settings.appearance.skin === s.id && (
                        <span
                          className="w-5 h-5 rounded-full grid place-items-center text-[10px]"
                          style={{
                            background:
                              "linear-gradient(135deg, rgba(108,140,255,0.9), rgba(147,51,234,0.9))",
                            color: "#fff",
                            boxShadow: "0 2px 6px rgba(108,140,255,0.5)",
                          }}
                        >
                          ✓
                        </span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
              <div className="text-[11px] text-slate-500 mt-2">
                💡 预留扩展点：未来皮肤包会开放「自定义 CSS 变量 + 背景图 + 字体包 + 打包导入（zip/tar）」。
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="dsh-label flex justify-between">
                  <span>强调色</span>
                  <span className="text-slate-300">{settings.appearance.accentColor}</span>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <input
                    type="color"
                    value={settings.appearance.accentColor}
                    onChange={(e) =>
                      saveSettings({ appearance: { ...settings.appearance, accentColor: e.target.value } })
                    }
                    className="h-8 w-12 rounded bg-transparent border border-dsh-border cursor-pointer"
                  />
                  <input
                    type="text"
                    className="dsh-input text-xs !py-1 flex-1"
                    value={settings.appearance.accentColor}
                    onChange={(e) =>
                      saveSettings({ appearance: { ...settings.appearance, accentColor: e.target.value } })
                    }
                  />
                </div>
              </div>
              <div>
                <div className="dsh-label">侧边栏密度</div>
                <select
                  className="dsh-input text-xs w-full mt-1"
                  value={settings.appearance.sidebarDensity}
                  onChange={(e) =>
                    saveSettings({
                      appearance: {
                        ...settings.appearance,
                        sidebarDensity: e.target.value as "compact" | "normal" | "relaxed",
                      },
                    })
                  }
                >
                  <option value="compact">紧凑</option>
                  <option value="normal">正常</option>
                  <option value="relaxed">宽松</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="dsh-label flex justify-between">
                  <span>字体缩放</span>
                  <span className="text-slate-300">×{settings.appearance.fontScale.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0.8}
                  max={1.4}
                  step={0.02}
                  value={settings.appearance.fontScale}
                  onChange={(e) =>
                    saveSettings({
                      appearance: { ...settings.appearance, fontScale: +e.target.value },
                    })
                  }
                  className="w-full"
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">消息气泡风格</div>
                  <div className="text-slate-500">关闭则改为紧凑行风格</div>
                </div>
                <Switch
                  on={settings.appearance.messageBubbles}
                  onChange={(v) =>
                    saveSettings({ appearance: { ...settings.appearance, messageBubbles: v } })
                  }
                />
              </div>
            </div>
          </div>
        </section>

        {/* ------------ 桌面宠物（预留） ------------ */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <span className="text-dsh-accent">●</span> 桌面宠物（预留）
            </h2>
            <Switch
              on={settings.desktopPet.enabled}
              onChange={(v) => {
                saveSettings({ desktopPet: { ...settings.desktopPet, enabled: v } });
                if (v) {
                  // 占位：真·桌面宠物接入（WebView / canvas / Lottie 表情包机）时再启用；
                  // 当前只保留状态持久化，便于后续增量开发。
                  setTimeout(() => {
                    alert("🐾 桌面宠物 Coming Soon — 已为你保存设置，后续版本将解锁：可拖动、表情动画、事件通知气泡、技能动作。");
                  }, 50);
                }
              }}
            />
          </div>
          <div className="dsh-panel p-4 space-y-4 text-xs">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="dsh-label">形象（后续开放自定义上传 SVG/PNG/GIF）</div>
                <div className="flex gap-2 mt-2 flex-wrap">
                  {(["fox", "cat", "dog", "raccoon", "custom"] as const).map((av) => (
                    <button
                      key={av}
                      onClick={() => saveSettings({ desktopPet: { ...settings.desktopPet, avatar: av } })}
                      className={`px-3 py-2 rounded-md border text-xs transition ${
                        settings.desktopPet.avatar === av
                          ? "border-dsh-accent text-dsh-accent bg-dsh-accent/10"
                          : "border-dsh-border hover:border-dsh-accent/50"
                      }`}
                    >
                      {av === "fox" && "🦊 小狐狸"}
                      {av === "cat" && "🐱 猫咪"}
                      {av === "dog" && "🐶 狗狗"}
                      {av === "raccoon" && "🦝 浣熊"}
                      {av === "custom" && "✨ 自定义"}
                    </button>
                  ))}
                </div>
                {settings.desktopPet.avatar === "custom" && (
                  <div className="mt-2 space-y-1">
                    <div className="dsh-label">自定义形象 URL（预留：导入本地图片文件）</div>
                    <input
                      className="dsh-input text-xs w-full"
                      placeholder="https:// 或 file:// 路径"
                      value={settings.desktopPet.customAvatarUrl ?? ""}
                      onChange={(e) =>
                        saveSettings({
                          desktopPet: { ...settings.desktopPet, customAvatarUrl: e.target.value },
                        })
                      }
                    />
                  </div>
                )}
              </div>
              <div>
                <div className="dsh-label">停靠位置</div>
                <select
                  className="dsh-input text-xs w-full mt-1"
                  value={settings.desktopPet.anchor}
                  onChange={(e) =>
                    saveSettings({
                      desktopPet: {
                        ...settings.desktopPet,
                        anchor: e.target.value as UserSettings["desktopPet"]["anchor"],
                      },
                    })
                  }
                >
                  <option value="bottom-right">右下角</option>
                  <option value="bottom-left">左下角</option>
                  <option value="top-right">右上角</option>
                  <option value="top-left">左上角</option>
                  <option value="floating">自由拖动（记住位置）</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <div className="dsh-label flex justify-between">
                  <span>大小</span>
                  <span className="text-slate-300">{settings.desktopPet.size}px</span>
                </div>
                <input
                  type="range"
                  min={64}
                  max={280}
                  step={4}
                  value={settings.desktopPet.size}
                  onChange={(e) =>
                    saveSettings({
                      desktopPet: { ...settings.desktopPet, size: +e.target.value },
                    })
                  }
                  className="w-full"
                />
              </div>
              <div>
                <div className="dsh-label flex justify-between">
                  <span>不透明度</span>
                  <span className="text-slate-300">{Math.round(settings.desktopPet.opacity * 100)}%</span>
                </div>
                <input
                  type="range"
                  min={0.3}
                  max={1}
                  step={0.02}
                  value={settings.desktopPet.opacity}
                  onChange={(e) =>
                    saveSettings({
                      desktopPet: { ...settings.desktopPet, opacity: +e.target.value },
                    })
                  }
                  className="w-full"
                />
              </div>
              <div>
                <div className="dsh-label">默认心情</div>
                <select
                  className="dsh-input text-xs w-full mt-1"
                  value={settings.desktopPet.mood}
                  onChange={(e) =>
                    saveSettings({
                      desktopPet: {
                        ...settings.desktopPet,
                        mood: e.target.value as UserSettings["desktopPet"]["mood"],
                      },
                    })
                  }
                >
                  <option value="idle">😴 待机</option>
                  <option value="curious">🤔 好奇</option>
                  <option value="working">💪 搬砖</option>
                  <option value="happy">🥳 开心</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4 items-center pt-2 border-t border-dsh-border">
              <div className="flex items-center justify-between col-span-1">
                <div>
                  <div className="font-medium">可交互</div>
                  <div className="text-slate-500">点击 / 拖拽 / 右键菜单</div>
                </div>
                <Switch
                  on={settings.desktopPet.interactive}
                  onChange={(v) =>
                    saveSettings({ desktopPet: { ...settings.desktopPet, interactive: v } })
                  }
                />
              </div>
              <div className="flex items-center justify-between col-span-1">
                <div>
                  <div className="font-medium">事件气泡</div>
                  <div className="text-slate-500">工具执行、错误时宠物弹窗</div>
                </div>
                <Switch
                  on={settings.desktopPet.notifyOnEvents}
                  onChange={(v) =>
                    saveSettings({ desktopPet: { ...settings.desktopPet, notifyOnEvents: v } })
                  }
                />
              </div>
              <div>
                <div className="dsh-label flex justify-between">
                  <span>闲置自动休眠</span>
                  <span className="text-slate-300">
                    {settings.desktopPet.autoIdleHibernateMs === 0
                      ? "关闭"
                      : `${Math.round(settings.desktopPet.autoIdleHibernateMs / 60000)} 分钟`}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={30 * 60 * 1000}
                  step={60_000}
                  value={settings.desktopPet.autoIdleHibernateMs}
                  onChange={(e) =>
                    saveSettings({
                      desktopPet: { ...settings.desktopPet, autoIdleHibernateMs: +e.target.value },
                    })
                  }
                  className="w-full"
                />
              </div>
            </div>

            <div className="rounded-md bg-dsh-accent/10 border border-dsh-accent/20 p-3 text-[11px] text-slate-300 leading-relaxed">
              🐾 桌面宠物当前为「骨架占位」：已保存全部状态字段。后续真·接入时可直接在{" "}
              <code className="text-dsh-accent">DesktopPetHost.tsx</code> 实现三件事：
              <ol className="list-decimal pl-5 mt-1 space-y-0.5">
                <li>
                  <b>Widget 渲染层</b>：Lottie/CSS 动画 + 表情机（idle → blink → yawn → reaction）；
                </li>
                <li>
                  <b>交互层</b>：拖拽 + 停靠吸附 + 右键菜单（当前设置 / 换形象 / 隐藏）；
                </li>
                <li>
                  <b>事件桥接</b>：订阅 <code>runtime.onEvent</code>，把 tool_call / error / milestone 变成宠物气泡动画。
                </li>
              </ol>
            </div>
          </div>
        </section>

        {/* ------------ 遥测 ------------ */}
        <section>
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <span className="text-dsh-accent">●</span> 遥测
          </h2>
          <div className="dsh-panel p-4 space-y-3 text-xs">
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
