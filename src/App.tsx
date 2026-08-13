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

export default function App() {
  const boot = useUIStore((s) => s.boot);
  const runtimeReady = useUIStore((s) => s.runtimeReady);
  const runtimeError = useUIStore((s) => s.runtimeError);
  const view = useUIStore((s) => s.view);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);

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
      {!runtimeReady && <BootOverlay error={runtimeError} />}
    </div>
  );
}
