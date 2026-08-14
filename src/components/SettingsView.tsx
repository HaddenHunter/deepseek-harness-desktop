import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useUIStore } from "@/store/ui";
import { secureDelete, secureGet, secureSet } from "@/hooks/tauriNative";
import { PROVIDER_PROFILES } from "@/runtime/dsh/DshRuntime";
import type { ModelConfig, RuntimeMode, UserSettings } from "@/runtime/types";
import ModalShell from "./ui/Modal";
import { Divider, KeyValueRow, SectionCard } from "./ui/Cards";

/* =========================================================================
 * Settings shell — layout mirrors the CodeX GUI reference shell
 * (deepseek-harness/packages/client/ui-settings-general SettingsRoot):
 *   - Left rail: nav icons + labels ("sections")
 *   - Right: header (title/description + close slot-equivalent) + content area
 *   - Models tab: inline list; add/edit opens a centered Modal
 * =======================================================================*/

type SectionId = "models" | "appearance" | "pet" | "telemetry" | "advanced" | "about";

const SECTIONS: readonly {
  id: SectionId;
  label: string;
  hint: string;
  icon: string;
}[] = [
  { id: "models", label: "LLM 配置", hint: "模型 / API Key / 活动模型", icon: "🧠" },
  { id: "appearance", label: "皮肤", hint: "主题 / 强调色 / 密度", icon: "🎨" },
  { id: "pet", label: "桌面宠物", hint: "形象 / 通知气泡", icon: "🦊" },
  { id: "telemetry", label: "遥测", hint: "匿名使用统计 / 崩溃上报", icon: "📡" },
  { id: "advanced", label: "高级", hint: "推理参数 / 工具审批", icon: "⚡" },
  { id: "about", label: "关于", hint: "版本 / 许可协议 / 链接", icon: "ℹ️" },
];

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="dsh-switch" data-on={on} onClick={() => onChange(!on)}>
      <span className="dsh-switch-knob" />
    </div>
  );
}

type Draft = Partial<ModelConfig> & { apiKey?: string };

const EMPTY_DRAFT: Draft = {
  provider: "deepseek-official",
  displayName: "",
  modelId: "",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  baseUrl: "https://api.deepseek.com/v1",
  maxContext: 128000,
  enabled: true,
  apiKey: "",
};

function modelKey(m: { provider: string; modelId: string }) {
  return `${m.provider}/${m.modelId}`;
}

export default function SettingsView() {
  const settings = useUIStore((s) => s.settings);
  const saveSettings = useUIStore((s) => s.saveSettings);
  const setApiKeyMask = useUIStore((s) => s.setApiKeyMask);

  const [activeId, setActiveId] = useState<SectionId>("models");

  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [apiKeySaved, setApiKeySaved] = useState<Record<string, boolean>>({});

  // ----- model modal state -----
  const [modalKind, setModalKind] = useState<null | "add" | { editKey: string }>(null);
  const [draft, setDraft] = useState<Draft>({ ...EMPTY_DRAFT });
  const [saving, setSaving] = useState(false);

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
    return (
      <div className="flex-1 grid place-items-center text-slate-400 text-sm">加载设置…</div>
    );
  }

  /* ----------------------------- Shell layout ----------------------------- */

  return (
    <div className="flex-1 min-h-0 flex">
      {/* ---------- Left nav rail (mirrors SettingsPanel.nav in CodeX shell) ---------- */}
      <aside
        className="w-[220px] shrink-0 relative overflow-hidden"
        style={{
          borderRight: "1px solid rgba(255,255,255,0.07)",
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))",
        }}
      >
        <div
          className="pointer-events-none absolute inset-0"
          aria-hidden
          style={{
            background:
              "radial-gradient(360px 120px at 10% -10%, rgba(108,140,255,0.18), transparent 70%)",
          }}
        />
        <div className="relative z-10 px-3 py-5 h-full flex flex-col gap-1">
          <div className="px-2 pb-3 mb-1"
            style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
            <div className="flex items-center gap-2">
              <div
                className="w-8 h-8 rounded-xl grid place-items-center text-sm"
                style={{
                  background:
                    "linear-gradient(135deg, rgba(108,140,255,0.95), rgba(147,51,234,0.95))",
                  boxShadow: "0 8px 22px -10px rgba(108,140,255,0.7)",
                }}
              >
                ⚙
              </div>
              <div>
                <div className="text-[13px] font-bold tracking-tight text-white leading-none">
                  设置
                </div>
                <div className="text-[10.5px] text-slate-500 mt-1">Settings</div>
              </div>
            </div>
          </div>
          <nav className="flex-1 min-h-0 overflow-y-auto">
            <ul className="flex flex-col gap-0.5">
              {SECTIONS.map((row) => {
                const active = activeId === row.id;
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => setActiveId(row.id)}
                      className={
                        "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-left transition-all duration-150 " +
                        (active
                          ? "text-white"
                          : "text-slate-300 hover:text-white hover:bg-white/5")
                      }
                      style={
                        active
                          ? {
                              background:
                                "linear-gradient(135deg, rgba(108,140,255,0.22), rgba(147,51,234,0.14))",
                              boxShadow:
                                "0 0 0 1px rgba(255,255,255,0.08) inset, 0 8px 20px -12px rgba(108,140,255,0.6)",
                            }
                          : undefined
                      }
                      aria-current={active ? "true" : undefined}
                    >
                      <span className="text-[15px] w-5 grid place-items-center">{row.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] font-semibold leading-none">
                          {row.label}
                        </div>
                        <div className="text-[10.5px] text-slate-500 mt-1 truncate">
                          {row.hint}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="pt-3 px-2 border-t border-white/[0.06] text-[10.5px] text-slate-500">
            DSH Desktop v{import.meta.env.PACKAGE_VERSION ?? "0.1.0"}
          </div>
        </div>
      </aside>

      {/* ---------- Right content (mirrors SettingsPanel.content in CodeX shell) ---------- */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div
          className="h-14 shrink-0 flex items-center px-6 relative overflow-hidden"
          style={{
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))",
            backdropFilter: "blur(20px) saturate(1.2)",
          }}
        >
          <div
            className="pointer-events-none absolute inset-0 opacity-80"
            aria-hidden
            style={{
              background:
                "radial-gradient(520px 120px at 10% -10%, rgba(108,140,255,0.16), transparent 70%),radial-gradient(420px 120px at 100% 10%, rgba(147,51,234,0.14), transparent 70%)",
            }}
          />
          <div className="relative z-10 flex-1 min-w-0">
            <div className="text-[14px] font-bold tracking-tight text-white">
              {SECTIONS.find((r) => r.id === activeId)?.label}
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5 leading-none">
              {SECTIONS.find((r) => r.id === activeId)?.hint}
            </div>
          </div>
          <div className="relative z-10 shrink-0">
            {activeId === "models" && (
              <button
                className="dsh-btn-primary text-[12px] !py-1.5"
                onClick={() => {
                  setDraft({ ...EMPTY_DRAFT });
                  setModalKind("add");
                }}
              >
                + 新增模型
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-4xl mx-auto py-7 px-5 sm:px-8 space-y-7">
            {activeId === "models" && (
              <ModelsSection
                settings={settings}
                apiKeySaved={apiKeySaved}
                apiKeyInputs={apiKeyInputs}
                setApiKeyInputs={setApiKeyInputs}
                saveSettings={saveSettings}
                setApiKeyMask={setApiKeyMask}
                setApiKeySaved={setApiKeySaved}
                onStartEdit={(m) => {
                  setDraft({ ...m, apiKey: "" });
                  setModalKind({ editKey: modelKey(m) });
                }}
              />
            )}
            {activeId === "appearance" && <AppearanceSection settings={settings} saveSettings={saveSettings} />}
            {activeId === "pet" && <PetSection settings={settings} saveSettings={saveSettings} />}
            {activeId === "telemetry" && <TelemetrySection settings={settings} saveSettings={saveSettings} />}
            {activeId === "advanced" && <AdvancedSection settings={settings} saveSettings={saveSettings} />}
            {activeId === "about" && <AboutSection />}
          </div>
        </div>
      </div>

      {/* ---------- Model modal (add / edit) ---------- */}
      {modalKind !== null && (
        <ModelModal
          kind={modalKind}
          draft={draft}
          setDraft={setDraft}
          profileById={profileById}
          settings={settings}
          onClose={() => {
            setModalKind(null);
            setSaving(false);
          }}
          onSave={async () => {
            setSaving(true);
            try {
              if (modalKind === "add") {
                await commitNew(settings, saveSettings, setApiKeyMask, setApiKeySaved, draft);
              } else {
                const orig = settings.models.find((m) => modelKey(m) === modalKind.editKey);
                if (orig) await commitEdit(settings, saveSettings, setApiKeyMask, setApiKeySaved, orig, draft);
              }
              setModalKind(null);
            } finally {
              setSaving(false);
            }
          }}
          saving={saving}
        />
      )}
    </div>
  );
}

/* =========================================================================
 * 1. Models (LLM 配置)
 * =======================================================================*/

function ModelsSection({
  settings,
  apiKeySaved,
  apiKeyInputs,
  setApiKeyInputs,
  saveSettings,
  setApiKeyMask,
  setApiKeySaved,
  onStartEdit,
}: {
  settings: UserSettings;
  apiKeySaved: Record<string, boolean>;
  apiKeyInputs: Record<string, string>;
  setApiKeyInputs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  saveSettings: (patch: Partial<UserSettings>) => Promise<void> | void;
  setApiKeyMask: (envName: string, hasKey: boolean) => void;
  setApiKeySaved: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onStartEdit: (m: ModelConfig) => void;
}) {
  return (
    <>
      <SectionCard
        title="活动模型"
        subtitle="Runtime 启动时使用的模型；若 Key 未保存在 Settings 页，回退使用进程环境变量（如 DEEPSEEK_API_KEY）。"
      >
        <KeyValueRow
          label="当前活动模型"
          hint="启动 DSH Runtime 时注入 SDK 侧 initialize handshake；切换立即生效。"
        >
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
        </KeyValueRow>
      </SectionCard>

      <SectionCard
        title="模型列表"
        subtitle={`共 ${settings.models.length} 个模型，点击「编辑」修改配置或 API Key；新增/编辑时会弹窗。`}
      >
        <div className="divide-y divide-white/[0.06] -mx-2 -my-1">
          {settings.models.map((m) => {
            const k = modelKey(m);
            const active = settings.activeModel === k;
            return (
              <div key={k} className="flex items-center justify-between gap-4 py-3 px-3 rounded-2xl hover:bg-white/[0.025] transition-colors">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div
                    className="w-10 h-10 shrink-0 rounded-xl grid place-items-center text-[17px] shadow-[0_8px_20px_-14px_rgba(108,140,255,0.6)]"
                    style={{
                      background:
                        "linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))",
                      border: "1px solid rgba(255,255,255,0.07)",
                    }}
                  >
                    🧠
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] font-semibold text-slate-100 truncate">
                        {m.displayName}
                      </span>
                      <span className="dsh-chip">{m.provider}</span>
                      <span className="dsh-chip">{Math.round((m.maxContext ?? 0) / 1000)}K</span>
                      {active && (
                        <span className="dsh-chip !bg-dsh-accent/15 !text-dsh-accent !border-dsh-accent/30">
                          活动
                        </span>
                      )}
                      {!m.enabled && <span className="dsh-chip !bg-white/5 !text-slate-400">已禁用</span>}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-1 truncate">
                      model: <code className="text-slate-400">{m.modelId}</code>
                      {" · "}env: <code className="text-slate-400">{m.apiKeyEnv}</code>
                      {m.baseUrl && (
                        <>
                          {" · "}base: <code className="text-slate-400">{m.baseUrl}</code>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="hidden sm:flex items-center gap-3 shrink-0">
                    <span
                      className={
                        "text-[11px] font-medium flex items-center gap-1 " +
                        (apiKeySaved[m.apiKeyEnv] ? "text-dsh-accent2" : "text-dsh-warn")
                      }
                    >
                      <span
                        className={
                          "inline-block w-1.5 h-1.5 rounded-full " +
                          (apiKeySaved[m.apiKeyEnv] ? "bg-dsh-accent2 shadow-[0_0_8px_rgba(16,185,129,0.7)]" : "bg-dsh-warn shadow-[0_0_8px_rgba(245,158,11,0.7)]")
                        }
                      />
                      {apiKeySaved[m.apiKeyEnv] ? "Key 已存" : "未配 Key"}
                    </span>
                    <Switch
                      on={!!m.enabled}
                      onChange={(v) =>
                        saveSettings({
                          models: settings.models.map((x) =>
                            modelKey(x) === k ? { ...x, enabled: v } : x,
                          ),
                        })
                      }
                    />
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button className="dsh-btn text-xs !py-1" onClick={() => onStartEdit(m)}>
                      编辑
                    </button>
                    <button
                      className="dsh-btn text-xs !py-1 sm:!hidden"
                      title="查看 / 编辑 Key"
                      onClick={() => {
                        const input = window.prompt(
                          `${m.apiKeyEnv}（空 = 清除，填写即保存）`,
                          apiKeyInputs[m.apiKeyEnv] ?? "",
                        );
                        if (input === null) return;
                        if (input.trim() === "") {
                          void secureDelete(m.apiKeyEnv).then(() => {
                            setApiKeySaved((p) => ({ ...p, [m.apiKeyEnv]: false }));
                            setApiKeyMask(m.apiKeyEnv, false);
                          });
                        } else {
                          void secureSet(m.apiKeyEnv, input.trim()).then(() => {
                            setApiKeySaved((p) => ({ ...p, [m.apiKeyEnv]: true }));
                            setApiKeyMask(m.apiKeyEnv, true);
                          });
                        }
                      }}
                    >
                      Key
                    </button>
                    <button
                      className="dsh-btn-danger text-xs !py-1"
                      disabled={settings.models.length <= 1}
                      onClick={() => {
                        if (confirm(`确定删除模型 ${m.displayName}？`)) {
                          const remaining = settings.models.filter((x) => modelKey(x) !== k);
                          const patch: Partial<UserSettings> = { models: remaining };
                          if (settings.activeModel === k) {
                            patch.activeModel = modelKey(remaining[0]);
                          }
                          saveSettings(patch);
                          void secureDelete(m.apiKeyEnv).catch(() => {});
                        }
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </SectionCard>
    </>
  );
}

/* =========================================================================
 * 2. Model modal (add / edit)
 * =======================================================================*/

function ModelModal({
  kind,
  draft,
  setDraft,
  profileById,
  settings,
  onClose,
  onSave,
  saving,
}: {
  kind: "add" | { editKey: string };
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  profileById: Record<string, (typeof PROVIDER_PROFILES)[number]>;
  settings: UserSettings;
  onClose: () => void;
  onSave: () => Promise<void>;
  saving: boolean;
}) {
  const isAdd = kind === "add";
  const profile = profileById[draft.provider ?? ""];
  return (
    <ModalShell
      title={isAdd ? "新增模型配置" : "编辑模型配置"}
      onClose={onClose}
      width={680}
      footer={
        <>
          <button className="dsh-btn text-xs !py-1.5" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button
            className="dsh-btn-primary text-xs !py-1.5"
            onClick={() => void onSave()}
            disabled={saving || !draft.modelId?.trim() || !draft.displayName?.trim()}
          >
            {saving ? "保存中…" : isAdd ? "保存创建" : "保存修改"}
          </button>
        </>
      }
    >
      <div className="space-y-4 text-xs">
        <div className="grid grid-cols-2 gap-3.5">
          <div>
            <div className="dsh-label">Provider</div>
            <select
              className="dsh-input text-xs w-full"
              value={draft.provider ?? EMPTY_DRAFT.provider}
              onChange={(e) => {
                const pid = e.target.value;
                const p = profileById[pid];
                if (p) {
                  setDraft((d) => ({
                    ...d,
                    provider: pid,
                    baseUrl: p.defaultBaseUrl,
                    apiKeyEnv: p.defaultApiKeyEnv,
                    modelId: p.recommendedModels[0]?.id ?? d.modelId,
                    displayName: p.recommendedModels[0]?.displayName ?? d.displayName,
                    maxContext: p.recommendedModels[0]?.maxContext ?? d.maxContext,
                  }));
                } else {
                  setDraft((d) => ({ ...d, provider: pid }));
                }
              }}
            >
              {PROVIDER_PROFILES.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
              <option value="custom">自定义 Provider</option>
            </select>
          </div>
          <div>
            <div className="dsh-label">显示名</div>
            <input
              className="dsh-input text-xs w-full"
              value={draft.displayName ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, displayName: e.target.value }))}
              placeholder="给这个模型一个易识别的名字"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3.5">
          <div>
            <div className="dsh-label">Model ID（可从推荐选，也可自定义）</div>
            {profile ? (
              <select
                className="dsh-input text-xs w-full"
                value={draft.modelId ?? ""}
                onChange={(e) => {
                  const mid = e.target.value;
                  const rec = profile.recommendedModels.find((r) => r.id === mid);
                  setDraft((d) => ({
                    ...d,
                    modelId: mid,
                    ...(rec ? { displayName: rec.displayName, maxContext: rec.maxContext ?? d.maxContext } : {}),
                  }));
                }}
              >
                {profile.recommendedModels.map((r) => (
                  <option key={r.id} value={r.id}>{r.displayName} ({r.id})</option>
                ))}
                {draft.modelId && !profile.recommendedModels.find((r) => r.id === draft.modelId) && (
                  <option value={draft.modelId}>自定义：{draft.modelId}</option>
                )}
              </select>
            ) : (
              <input
                className="dsh-input text-xs w-full"
                placeholder="输入 model ID"
                value={draft.modelId ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, modelId: e.target.value }))}
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
              value={draft.maxContext ?? 128000}
              onChange={(e) =>
                setDraft((d) => ({ ...d, maxContext: Math.max(1024, +e.target.value || 1024) }))
              }
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3.5">
          <div>
            <div className="dsh-label">Base URL</div>
            <input
              className="dsh-input text-xs w-full"
              placeholder="留空则使用 SDK 默认 / 进程环境变量"
              value={draft.baseUrl ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
            />
          </div>
          <div>
            <div className="dsh-label">API Key 环境变量名（Keychain 存明文 Key）</div>
            <input
              className="dsh-input text-xs w-full"
              value={draft.apiKeyEnv ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, apiKeyEnv: e.target.value }))}
            />
          </div>
        </div>

        <div>
          <div className="dsh-label">
            API Key 明文{" "}
            <span className="text-slate-500 font-normal">
              （保存后立即写入本地 Keychain，绝不写入 JSON 配置文件）
            </span>
          </div>
          <input
            type="password"
            className="dsh-input text-xs w-full"
            placeholder={
              draft.apiKeyEnv
                ? `粘贴 ${draft.apiKeyEnv} 对应的密钥，或留空沿用已保存 Key…`
                : "粘贴 API Key（仅本地 Keychain）"
            }
            value={draft.apiKey ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
          />
          {!isAdd && (
            <div className="text-[11px] text-slate-500 mt-1.5">
              留空则不修改已保存的 Key；要清除请关闭弹窗后使用模型卡片的 Key 操作。
            </div>
          )}
        </div>

        <Divider />

        <div className="flex items-center justify-between p-3.5 rounded-xl bg-white/[0.03] border border-white/[0.06]">
          <div>
            <div className="font-semibold text-slate-100 text-[12.5px]">保存后启用 / 设为活动</div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              {isAdd ? "新增模型默认即启用，并自动设为活动模型" : "保存修改即刻生效"}
            </div>
          </div>
          <Switch
            on={!!draft.enabled}
            onChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
          />
        </div>
      </div>
      <div className="hidden">{settings.models.length}</div>
    </ModalShell>
  );
}

function applyDraftToModel(orig: ModelConfig, d: Draft): ModelConfig {
  const patched: ModelConfig = {
    provider: d.provider ?? orig.provider,
    modelId: (d.modelId ?? orig.modelId).trim(),
    displayName: (d.displayName ?? orig.displayName).trim() || (d.modelId ?? orig.modelId),
    apiKeyEnv: (d.apiKeyEnv ?? orig.apiKeyEnv).trim() || orig.apiKeyEnv,
    baseUrl: d.baseUrl ? d.baseUrl.trim() || undefined : orig.baseUrl,
    maxContext: typeof d.maxContext === "number" ? Math.max(1024, d.maxContext) : orig.maxContext,
    enabled: typeof d.enabled === "boolean" ? d.enabled : orig.enabled,
  };
  return patched;
}

async function commitEdit(
  settings: UserSettings,
  saveSettings: (patch: Partial<UserSettings>) => Promise<void> | void,
  setApiKeyMask: (env: string, has: boolean) => void,
  setApiKeySaved: React.Dispatch<React.SetStateAction<Record<string, boolean>>>,
  orig: ModelConfig,
  draft: Draft,
) {
  const patched = applyDraftToModel(orig, draft);
  const oldKey = modelKey(orig);
  const newKey = modelKey(patched);
  const wasActive = settings.activeModel === oldKey;
  saveSettings({
    models: settings.models.map((x) => (modelKey(x) === oldKey ? patched : x)),
    ...(wasActive ? { activeModel: newKey } : {}),
  });
  if (typeof draft.apiKey === "string" && draft.apiKey.trim()) {
    const env = patched.apiKeyEnv;
    try {
      await secureSet(env, draft.apiKey.trim());
      setApiKeyMask(env, true);
      setApiKeySaved((p) => ({ ...p, [env]: true }));
    } catch (e) {
      console.error("[settings] secureSet failed (edit)", env, e);
    }
  }
}

async function commitNew(
  settings: UserSettings,
  saveSettings: (patch: Partial<UserSettings>) => Promise<void> | void,
  setApiKeyMask: (env: string, has: boolean) => void,
  setApiKeySaved: React.Dispatch<React.SetStateAction<Record<string, boolean>>>,
  draft: Draft,
) {
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
  if (typeof draft.apiKey === "string" && draft.apiKey.trim()) {
    try {
      await secureSet(patched.apiKeyEnv, draft.apiKey.trim());
      setApiKeyMask(patched.apiKeyEnv, true);
      setApiKeySaved((p) => ({ ...p, [patched.apiKeyEnv]: true }));
    } catch (e) {
      console.error("[settings] secureSet failed (new)", patched.apiKeyEnv, e);
    }
  }
}

/* =========================================================================
 * 3. Appearance (皮肤)
 * =======================================================================*/

const SKIN_PRESETS: readonly {
  id: RuntimeMode | (string & NonNullable<unknown>);
  label: string;
  swatch: string;
}[] = [
  { id: "default", label: "默认（深海蓝）", swatch: "linear-gradient(135deg,#1e293b,#6366f1)" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha", swatch: "linear-gradient(135deg,#1e1e2e,#f5c2e7)" },
  { id: "dracula", label: "Dracula", swatch: "linear-gradient(135deg,#282a36,#ff79c6)" },
  { id: "rose-pine", label: "Rosé Pine", swatch: "linear-gradient(135deg,#191724,#ebbcba)" },
  { id: "nord", label: "Nord", swatch: "linear-gradient(135deg,#2e3440,#88c0d0)" },
  { id: "solarized-light", label: "Solarized Light", swatch: "linear-gradient(135deg,#fdf6e3,#b58900)" },
];

function AppearanceSection({
  settings,
  saveSettings,
}: {
  settings: UserSettings;
  saveSettings: (patch: Partial<UserSettings>) => Promise<void> | void;
}) {
  return (
    <>
      <SectionCard title="主题与配色" subtitle="整体 UI 的基调；皮肤预设、强调色、密度全部即时生效。">
        <KeyValueRow label="主题模式" hint="选择深/浅色或跟随系统；重启不丢失。">
          <select
            className="dsh-input !w-auto text-xs !py-1.5"
            value={settings.theme}
            onChange={(e) => saveSettings({ theme: e.target.value as "dark" | "light" | "system" })}
          >
            <option value="dark">深色</option>
            <option value="light">浅色</option>
            <option value="system">跟随系统</option>
          </select>
        </KeyValueRow>

        <Divider />

        <KeyValueRow label="配色皮肤" hint="选择一个预设皮肤（后续开放自定义皮肤包导入）。">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {SKIN_PRESETS.map((s) => {
              const active = settings.appearance.skin === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => saveSettings({ appearance: { ...settings.appearance, skin: s.id as UserSettings["appearance"]["skin"] } })}
                  className={
                    "group rounded-2xl border text-left overflow-hidden transition-all duration-200 hover:-translate-y-0.5"
                  }
                  style={{
                    borderColor: active ? "rgba(108,140,255,0.6)" : "rgba(255,255,255,0.08)",
                    boxShadow: active
                      ? "0 0 0 1px rgba(108,140,255,0.2) inset, 0 12px 28px -14px rgba(108,140,255,0.55)"
                      : undefined,
                  }}
                >
                  <div className="h-16 w-full relative">
                    <div className="absolute inset-0" style={{ backgroundImage: s.swatch }} />
                    <div
                      className="absolute inset-0"
                      style={{ background: "linear-gradient(180deg, rgba(255,255,255,0.08), rgba(0,0,0,0) 60%)" }}
                    />
                    {active && (
                      <div
                        className="absolute top-2 right-2 w-5 h-5 rounded-full grid place-items-center text-[10px]"
                        style={{
                          background: "linear-gradient(135deg, rgba(108,140,255,0.9), rgba(147,51,234,0.9))",
                          color: "#fff",
                          boxShadow: "0 2px 6px rgba(108,140,255,0.5)",
                        }}
                      >
                        ✓
                      </div>
                    )}
                  </div>
                  <div
                    className="p-2.5 text-[11.5px] flex items-center justify-between"
                    style={{
                      background: "rgba(255,255,255,0.02)",
                      borderTop: "1px solid rgba(255,255,255,0.05)",
                    }}
                  >
                    <span className="font-medium text-slate-200">{s.label}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </KeyValueRow>

        <Divider />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-0">
          <KeyValueRow label="强调色" hint="全局 accent（按钮/链接/高光）。">
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={settings.appearance.accentColor}
                onChange={(e) =>
                  saveSettings({ appearance: { ...settings.appearance, accentColor: e.target.value } })
                }
                className="h-9 w-12 rounded bg-transparent border border-dsh-border cursor-pointer"
              />
              <input
                type="text"
                className="dsh-input text-xs !py-1.5 flex-1"
                value={settings.appearance.accentColor}
                onChange={(e) =>
                  saveSettings({ appearance: { ...settings.appearance, accentColor: e.target.value } })
                }
              />
            </div>
          </KeyValueRow>
          <KeyValueRow label="侧边栏密度" hint="紧凑 / 正常 / 宽松；会影响会话卡片与导航间距。">
            <select
              className="dsh-input text-xs w-full"
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
          </KeyValueRow>
        </div>

        <Divider />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-0">
          <KeyValueRow label="字体缩放" hint="整体 UI 与消息气泡的字号倍率。">
            <div>
              <div className="text-[11.5px] text-slate-300 mb-1">
                ×{settings.appearance.fontScale.toFixed(2)}
              </div>
              <input
                type="range"
                min={0.8} max={1.4} step={0.02}
                value={settings.appearance.fontScale}
                onChange={(e) =>
                  saveSettings({ appearance: { ...settings.appearance, fontScale: +e.target.value } })
                }
                className="w-full"
              />
            </div>
          </KeyValueRow>
          <KeyValueRow label="消息气泡风格" hint="关闭后使用紧凑行风格（类似编辑器 diff）。">
            <Switch
              on={settings.appearance.messageBubbles}
              onChange={(v) => saveSettings({ appearance: { ...settings.appearance, messageBubbles: v } })}
            />
          </KeyValueRow>
        </div>
      </SectionCard>
    </>
  );
}

/* =========================================================================
 * 4. Desktop pet (桌面宠物)
 * =======================================================================*/

const PET_PRESETS: readonly {
  id: "fox" | "cat" | "dog" | "raccoon" | "custom";
  label: string;
  emoji: string;
}[] = [
  { id: "fox", label: "狐狸", emoji: "🦊" },
  { id: "cat", label: "猫咪", emoji: "🐱" },
  { id: "dog", label: "柴犬", emoji: "🐶" },
  { id: "raccoon", label: "浣熊", emoji: "🦝" },
  { id: "custom", label: "自定义", emoji: "🎨" },
];

function PetSection({
  settings,
  saveSettings,
}: {
  settings: UserSettings;
  saveSettings: (patch: Partial<UserSettings>) => Promise<void> | void;
}) {
  const pet = settings.desktopPet;
  return (
    <>
      <SectionCard title="桌面宠物" subtitle="开启后会在聊天窗口右下角显示；支持通知气泡、拖拽移动。（MVP：开关与形象已占位，表情/动画逐版本解锁）">
        <KeyValueRow label="启用桌面宠物" hint="关闭则彻底隐藏右下角宠物层。">
          <Switch
            on={pet.enabled}
            onChange={(v) => saveSettings({ desktopPet: { ...pet, enabled: v } })}
          />
        </KeyValueRow>
        <Divider />
        <KeyValueRow label="形象" hint="选一个预设形象，或自定义（后续开放 SVG 上传）。">
          <div className="flex gap-2 flex-wrap">
            {PET_PRESETS.map((av) => {
              const active = pet.avatar === av.id;
              return (
                <button
                  key={av.id}
                  type="button"
                  onClick={() => saveSettings({ desktopPet: { ...pet, avatar: av.id } })}
                  className={
                    "w-14 h-14 rounded-2xl grid place-items-center text-[24px] border transition-all duration-200 hover:-translate-y-0.5"
                  }
                  style={{
                    background: active
                      ? "linear-gradient(135deg, rgba(108,140,255,0.2), rgba(147,51,234,0.12))"
                      : "rgba(255,255,255,0.03)",
                    borderColor: active ? "rgba(108,140,255,0.6)" : "rgba(255,255,255,0.07)",
                    boxShadow: active
                      ? "0 0 0 1px rgba(108,140,255,0.2) inset, 0 10px 22px -14px rgba(108,140,255,0.6)"
                      : undefined,
                  }}
                  title={av.label}
                >
                  {av.emoji}
                </button>
              );
            })}
          </div>
        </KeyValueRow>
        <Divider />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-0">
          <KeyValueRow label="事件通知气泡" hint="推理状态、工具审批请求等会在宠物头顶冒泡展示；关闭则保持静默。">
            <Switch
              on={pet.notifyOnEvents}
              onChange={(v) => saveSettings({ desktopPet: { ...pet, notifyOnEvents: v } })}
            />
          </KeyValueRow>
          <KeyValueRow label="交互模式" hint="开启后可点击、拖拽、触发心情动画；关闭则固定展示形象。">
            <Switch
              on={pet.interactive}
              onChange={(v) => saveSettings({ desktopPet: { ...pet, interactive: v } })}
            />
          </KeyValueRow>
        </div>
        <Divider />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-0">
          <KeyValueRow label="停靠位置" hint="默认在聊天窗口右下角。">
            <select
              className="dsh-input text-xs w-full"
              value={pet.anchor}
              onChange={(e) => saveSettings({ desktopPet: { ...pet, anchor: e.target.value as UserSettings["desktopPet"]["anchor"] } })}
            >
              <option value="bottom-right">右下</option>
              <option value="bottom-left">左下</option>
              <option value="top-right">右上</option>
              <option value="top-left">左上</option>
              <option value="floating">悬浮（自由拖拽）</option>
            </select>
          </KeyValueRow>
          <KeyValueRow label="初始心情" hint="空闲状态下的默认表情/姿态。">
            <select
              className="dsh-input text-xs w-full"
              value={pet.mood}
              onChange={(e) => saveSettings({ desktopPet: { ...pet, mood: e.target.value as UserSettings["desktopPet"]["mood"] } })}
            >
              <option value="idle">空闲（默认）</option>
              <option value="curious">好奇</option>
              <option value="working">专注工作</option>
              <option value="happy">开心</option>
            </select>
          </KeyValueRow>
        </div>
        <Divider />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-0">
          <KeyValueRow label="体积 (px)" hint="宠物形象在屏幕上的占位大小。">
            <div>
              <div className="text-[11.5px] text-slate-300 mb-1">{pet.size}px</div>
              <input
                type="range"
                min={48} max={160} step={2}
                value={pet.size}
                onChange={(e) => saveSettings({ desktopPet: { ...pet, size: +e.target.value } })}
                className="w-full"
              />
            </div>
          </KeyValueRow>
          <KeyValueRow label="透明度" hint="1.0 = 完全不透明；低于 0.5 适合常驻角落。">
            <div>
              <div className="text-[11.5px] text-slate-300 mb-1">×{pet.opacity.toFixed(2)}</div>
              <input
                type="range"
                min={0.2} max={1.0} step={0.05}
                value={pet.opacity}
                onChange={(e) => saveSettings({ desktopPet: { ...pet, opacity: +e.target.value } })}
                className="w-full"
              />
            </div>
          </KeyValueRow>
        </div>
        <Divider />
        <KeyValueRow label="空闲休眠" hint="多久没事件就把宠物动画降到最低频（省电）。">
          <select
            className="dsh-input text-xs w-full sm:!w-auto"
            value={String(pet.autoIdleHibernateMs)}
            onChange={(e) => saveSettings({ desktopPet: { ...pet, autoIdleHibernateMs: +e.target.value } })}
          >
            <option value="0">从不休眠</option>
            <option value={String(60 * 1000)}>1 分钟</option>
            <option value={String(5 * 60 * 1000)}>5 分钟</option>
            <option value={String(15 * 60 * 1000)}>15 分钟</option>
            <option value={String(30 * 60 * 1000)}>30 分钟</option>
          </select>
        </KeyValueRow>
      </SectionCard>
    </>
  );
}

/* =========================================================================
 * 5. Telemetry (遥测)
 * =======================================================================*/

function TelemetrySection({
  settings,
  saveSettings,
}: {
  settings: UserSettings;
  saveSettings: (patch: Partial<UserSettings>) => Promise<void> | void;
}) {
  const t = settings.telemetry;
  return (
    <>
      <SectionCard
        title="匿名遥测"
        subtitle="DSH 仅在本地运行，遥测默认关闭；开启后只会上报不含身份信息的使用统计与崩溃栈，便于版本优先级决策。"
      >
        <KeyValueRow label="启用匿名使用统计" hint="包含：运行模式切换次数、模型调用成功率、工具审批次数。">
          <Switch on={t.usage} onChange={(v) => saveSettings({ telemetry: { ...t, usage: v } })} />
        </KeyValueRow>
        <Divider />
        <KeyValueRow label="启用崩溃报告" hint="发生未捕获异常 / panic 时上传匿名 minidump，不包含密钥或聊天正文。">
          <Switch on={t.crash} onChange={(v) => saveSettings({ telemetry: { ...t, crash: v } })} />
        </KeyValueRow>
        <Divider />
        <KeyValueRow label="发送周期" hint="多久把本地缓冲的遥测事件发一次到远端。">
          <select
            className="dsh-input text-xs w-full sm:!w-auto"
            value={String(t.intervalSec)}
            onChange={(e) => saveSettings({ telemetry: { ...t, intervalSec: +e.target.value } })}
          >
            <option value="60">每 1 分钟</option>
            <option value="300">每 5 分钟</option>
            <option value="900">每 15 分钟</option>
            <option value="3600">每小时</option>
          </select>
        </KeyValueRow>
      </SectionCard>

      <SectionCard title="我们到底会采集什么？" subtitle="开启后你能看到的所有字段都列在下面，任何新增字段都会先在这里公示。">
        <ul className="divide-y divide-white/[0.06]">
          {(
            [
              ["Runtime 启动", "mode、首次启动成功与否、spawn 耗时（毫秒）"],
              ["模型调用", "provider 代号、响应耗时 bin（不含请求体/响应体）"],
              ["工具调用", "工具名、是否审批、审批/拒绝对数（不含参数）"],
              ["崩溃信息", "minidump、发生时的 dsh-desktop 版本号 / OS 版本"],
              ["UI 操作", "页面切换计数（Setting section / Sidebar view）"],
            ] as const
          ).map(([k, v]) => (
            <li key={k} className="py-2.5 flex items-start gap-4">
              <span className="mt-1 inline-block w-1.5 h-1.5 rounded-full bg-dsh-accent shadow-[0_0_8px_rgba(108,140,255,0.7)]" />
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] font-semibold text-slate-100">{k}</div>
                <div className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">{v}</div>
              </div>
            </li>
          ))}
        </ul>
      </SectionCard>
    </>
  );
}

/* =========================================================================
 * 6. Advanced (推理参数 / 工具审批)
 * =======================================================================*/

function AdvancedSection({
  settings,
  saveSettings,
}: {
  settings: UserSettings;
  saveSettings: (patch: Partial<UserSettings>) => Promise<void> | void;
}) {
  return (
    <>
      <SectionCard
        title="推理参数"
        subtitle="活动模型通用的采样参数；覆盖所有会话，切换即时生效（下一条请求使用新参数）。"
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
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
            <div className="text-[10.5px] text-slate-500 mt-1">越高越发散，越低越确定。</div>
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
      </SectionCard>

      <SectionCard
        title="工具审批策略"
        subtitle="逗号分隔；匹配「工具名」（不含参数字符串）。通过策略的先后：自动拒绝 → 自动允许 → 其余要用户手动批。"
      >
        <KeyValueRow
          label="自动允许列表"
          hint="命中直接跳过审批，通常用于只读命令（cat/ls/grep）。"
        >
          <input
            className="dsh-input text-xs"
            value={settings.toolApprovalAutoAllow.join(", ")}
            onChange={(e) =>
              saveSettings({
                toolApprovalAutoAllow: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
              })
            }
          />
        </KeyValueRow>
        <Divider />
        <KeyValueRow label="自动拒绝列表" hint="命中直接拒绝，用于阻止高风险动作（rm -rf / sudo / apt install 等）。">
          <input
            className="dsh-input text-xs"
            value={settings.toolApprovalAutoDeny.join(", ")}
            onChange={(e) =>
              saveSettings({
                toolApprovalAutoDeny: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
              })
            }
          />
        </KeyValueRow>
        <Divider />
        <div className="text-[11px] text-slate-500 leading-relaxed">
          💡 建议通过「跨工具抑制 · 时间窗口抑制 · 方向抑制」三层策略降低误报，而不是单纯降低审批频率。
        </div>
      </SectionCard>
    </>
  );
}

/* =========================================================================
 * 7. About (关于)
 * =======================================================================*/

function AboutSection() {
  const version = (import.meta.env.PACKAGE_VERSION as string) ?? "0.1.0";
  const buildDate = (import.meta.env.BUILD_DATE as string | undefined) ?? "开发构建";
  return (
    <>
      <SectionCard title="关于 DSH Desktop" subtitle="DeepSeek Harness — 本地运行的 Agent 工作台，支持多模型、多模式、桌面宠物。">
        <KeyValueRow label="版本" hint="当前本地安装包版本号（tagged release 时与 Release 页一致）。">
          <span className="dsh-chip !py-1.5 !px-3 !text-[11.5px]">v{version}</span>
        </KeyValueRow>
        <Divider />
        <KeyValueRow label="构建日期" hint="该安装包的构建时间（UTC）。">
          <span className="text-[12.5px] text-slate-200">{buildDate}</span>
        </KeyValueRow>
        <Divider />
        <KeyValueRow label="官方仓库" hint="源码、Issue、Release 下载页面。">
          <a
            href="https://github.com/HaddenHunter/deepseek-harness-desktop"
            target="_blank"
            rel="noreferrer noopener"
            className="text-[12.5px] text-dsh-accent hover:text-dsh-accent2 transition-colors"
          >
            github.com/HaddenHunter/deepseek-harness-desktop →
          </a>
        </KeyValueRow>
      </SectionCard>

      <SectionCard
        title="检查更新"
        subtitle="Release 页发布新 tag 后，可以在这里一键跳去下载最新 dmg。"
        actions={
          <a
            className="dsh-btn text-xs !py-1.5"
            href="https://github.com/HaddenHunter/deepseek-harness-desktop/releases/latest"
            target="_blank"
            rel="noreferrer noopener"
          >
            前往 Release →
          </a>
        }
      >
        <div className="flex items-center justify-between p-3.5 rounded-xl bg-white/[0.03] border border-white/[0.06]">
          <div>
            <div className="font-semibold text-[12.5px] text-slate-100">自动更新</div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              自动下载并安装更新（需要系统管理员权限；MVP 暂未实现）。
            </div>
          </div>
          <Switch on={false} onChange={() => {}} />
        </div>
      </SectionCard>

      <SectionCard title="开源与许可" subtitle="核心组件来自以下开源项目，感谢社区贡献。">
        <ul className="divide-y divide-white/[0.06] -mx-1">
          {(
            [
              ["Tauri 2.x", "MIT / Apache-2.0", "https://tauri.app"],
              ["React 19", "MIT", "https://react.dev"],
              ["Zustand", "MIT", "https://github.com/pmndrs/zustand"],
              ["DeepSeek Harness (upstream)", "Apache-2.0", "https://github.com/deepseek-ai/deepseek-harness"],
            ] as const
          ).map(([name, lic, url]) => (
            <li key={name} className="py-2.5 flex items-center justify-between gap-4 px-2 rounded-xl hover:bg-white/[0.025] transition-colors">
              <div>
                <div className="text-[12.5px] font-semibold text-slate-100">{name}</div>
                <div className="text-[10.5px] text-slate-500 mt-0.5">License: {lic}</div>
              </div>
              <a
                href={url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-[11px] text-dsh-accent hover:text-dsh-accent2 transition-colors"
              >
                官网 →
              </a>
            </li>
          ))}
        </ul>
      </SectionCard>
    </>
  );
}
