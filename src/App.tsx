import { useEffect } from "react";
import { createRuntime } from "@/runtime";
import { useUIStore } from "@/store/ui";
import { getStartupConfig } from "@/hooks/tauriNative";
import Sidebar from "@/components/Sidebar";
import ChatView from "@/components/ChatView";
import SettingsView from "@/components/SettingsView";
import PluginsView from "@/components/PluginsView";
import ApprovalsModal from "@/components/ApprovalsModal";
import StatusBar from "@/components/StatusBar";
import BootOverlay from "@/components/BootOverlay";
import ErrorBanner from "@/components/ErrorBanner";
import DesktopPetHost from "@/components/DesktopPetHost";

// ----- Skin / theme token map.
// NOTE: this is the *extension point* for future skin packs. Each skin id maps
// to a set of CSS custom properties that get stamped on <html data-skin="…">.
// When a user picks a new skin in Settings → Appearance, we update the attr
// below and the entire app re-skins because Tailwind tokens consume those vars
// (see index.css for the --dsh-* token declarations). The `skin` object is
// intentionally structured so we can later add:
//   1. arbitrary token overrides (bg texture, custom fonts)
//   2. runtime import of zip skin packs (unzip → merge here)
//   3. per-OS overrides (mac traffic lights offset, window frame color tint)
const SKIN_TOKENS: Record<NonNullable<import("@/runtime/types").UserSettings["appearance"]["skin"]>, Record<string, string>> = {
  "default": {
    "--dsh-bg": "#0b1020",
    "--dsh-surface": "#0f172a",
    "--dsh-border": "#1e293b",
    "--dsh-accent": "#6366f1",
    "--dsh-accent-2": "#22d3ee",
    "--dsh-text": "#e2e8f0",
    "--dsh-text-dim": "#64748b",
  },
  "catppuccin-mocha": {
    "--dsh-bg": "#1e1e2e",
    "--dsh-surface": "#313244",
    "--dsh-border": "#45475a",
    "--dsh-accent": "#cba6f7",
    "--dsh-accent-2": "#f5c2e7",
    "--dsh-text": "#cdd6f4",
    "--dsh-text-dim": "#7f849c",
  },
  "dracula": {
    "--dsh-bg": "#282a36",
    "--dsh-surface": "#343746",
    "--dsh-border": "#44475a",
    "--dsh-accent": "#ff79c6",
    "--dsh-accent-2": "#8be9fd",
    "--dsh-text": "#f8f8f2",
    "--dsh-text-dim": "#6272a4",
  },
  "rose-pine": {
    "--dsh-bg": "#191724",
    "--dsh-surface": "#1f1d2e",
    "--dsh-border": "#26233a",
    "--dsh-accent": "#ebbcba",
    "--dsh-accent-2": "#9ccfd8",
    "--dsh-text": "#e0def4",
    "--dsh-text-dim": "#908caa",
  },
  "nord": {
    "--dsh-bg": "#2e3440",
    "--dsh-surface": "#3b4252",
    "--dsh-border": "#434c5e",
    "--dsh-accent": "#88c0d0",
    "--dsh-accent-2": "#81a1c1",
    "--dsh-text": "#d8dee9",
    "--dsh-text-dim": "#6b7280",
  },
  "solarized-light": {
    "--dsh-bg": "#fdf6e3",
    "--dsh-surface": "#eee8d5",
    "--dsh-border": "#d6cfbd",
    "--dsh-accent": "#b58900",
    "--dsh-accent-2": "#268bd2",
    "--dsh-text": "#073642",
    "--dsh-text-dim": "#839496",
  },
};

export default function App() {
  const boot = useUIStore((s) => s.boot);
  const runtimeReady = useUIStore((s) => s.runtimeReady);
  const runtimeError = useUIStore((s) => s.runtimeError);
  const view = useUIStore((s) => s.view);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const theme = useUIStore((s) => s.settings?.theme);
  const accent = useUIStore((s) => s.settings?.appearance.accentColor);
  const skin = useUIStore((s) => s.settings?.appearance.skin);
  const fontScale = useUIStore((s) => s.settings?.appearance.fontScale);
  const fontFamily = useUIStore((s) => s.settings?.appearance.fontFamily);
  const density = useUIStore((s) => s.settings?.appearance.sidebarDensity);
  const bubbles = useUIStore((s) => s.settings?.appearance.messageBubbles);

  // Apply theme / skin tokens to the root so the entire app re-flows whenever
  // the user changes appearance settings (keeps layout thrash minimal because
  // we only mutate CSS custom properties, never re-mount the tree).
  useEffect(() => {
    const root = document.documentElement;
    if (theme) root.dataset.theme = theme;
    if (skin) root.dataset.skin = skin;
    const tokens = skin ? SKIN_TOKENS[skin] ?? SKIN_TOKENS["default"] : SKIN_TOKENS["default"];
    const style = root.style;
    for (const [k, v] of Object.entries(tokens)) style.setProperty(k, v);
    if (accent) style.setProperty("--dsh-accent", accent);
    if (fontScale) style.setProperty("--dsh-font-scale", String(fontScale));
    if (fontFamily) style.setProperty("--dsh-font-family", fontFamily);
    if (density) root.setAttribute("data-sidebar-density", density);
    root.setAttribute("data-message-bubbles", bubbles ? "1" : "0");
  }, [theme, accent, skin, fontScale, fontFamily, density, bubbles]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const cfg = await getStartupConfig();
      const kind = cfg.mock_runtime ? "mock" : "dsh";
      const runtime = createRuntime({ forceMock: cfg.mock_runtime, kind });
      if (mounted) await boot(runtime, kind);
    })();
    return () => {
      mounted = false;
    };
  }, [boot]);

  return (
    <div className="h-full flex flex-col bg-dsh-bg text-slate-100">
      <ErrorBanner />
      <div className="flex-1 min-h-0 flex">
        {sidebarOpen && <Sidebar />}
        <main className="flex-1 min-w-0 flex flex-col">
          {view === "chat" && <ChatView />}
          {view === "settings" && <SettingsView />}
          {view === "plugins" && <PluginsView />}
          {view === "about" && (
            <div className="flex-1 flex items-center justify-center text-slate-400 p-8">
              <div className="max-w-md text-center space-y-2">
                <h1 className="text-xl text-slate-100">DSH Desktop</h1>
                <p>基于 DeepSeek Harness（MIT 协议）的桌面客户端。</p>
                <p className="text-xs mt-4">所有 Agent 能力由 Cordis 插件系统提供，插件边界覆盖：模型 / 工具 / 技能 / 会话 / 沙箱 / 存储 / Agent Loop / 调度 / UI。</p>
              </div>
            </div>
          )}
          <StatusBar />
        </main>
      </div>
      <ApprovalsModal />
      {/* Entry point for the future floating desktop pet. Renders nothing
          until settings.desktopPet.enabled is toggled on in Settings. */}
      <DesktopPetHost />
      {!runtimeReady && <BootOverlay error={runtimeError} />}
    </div>
  );
}
