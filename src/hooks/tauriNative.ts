/**
 * Tauri 原生能力封装。
 * 在非 Tauri 环境（如纯浏览器 vite dev）下自动回退到 localStorage / 空实现，
 * 保证桌面端和纯 Web 调试均可运行。
 */
import { invoke } from "@tauri-apps/api/core";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface StartupConfig {
  mock_runtime: boolean;
  log_level: string;
}

export async function getStartupConfig(): Promise<StartupConfig> {
  if (!inTauri()) {
    return {
      mock_runtime: location.search.includes("mock=1") || import.meta.env.VITE_MOCK_RUNTIME === "1",
      log_level: import.meta.env.VITE_DSH_LOG_LEVEL ?? "info",
    };
  }
  return invoke<StartupConfig>("get_startup_config");
}

const KEYCHAIN_FALLBACK_KEY = "dsh-desktop:secure-fallback:";

/** 读取敏感值（优先系统 Keychain，回退 localStorage） */
export async function secureGet(key: string): Promise<string | null> {
  if (!inTauri()) {
    const v = localStorage.getItem(KEYCHAIN_FALLBACK_KEY + key);
    return v ?? null;
  }
  return invoke<string | null>("secure_get", { key });
}

/** 写入敏感值（优先系统 Keychain，回退 localStorage） */
export async function secureSet(key: string, value: string): Promise<void> {
  if (!inTauri()) {
    localStorage.setItem(KEYCHAIN_FALLBACK_KEY + key, value);
    return;
  }
  await invoke("secure_set", { key, value });
}

/** 删除敏感值 */
export async function secureDelete(key: string): Promise<void> {
  if (!inTauri()) {
    localStorage.removeItem(KEYCHAIN_FALLBACK_KEY + key);
    return;
  }
  await invoke("secure_delete", { key });
}

export async function notify(title: string, body?: string): Promise<void> {
  if (!inTauri()) {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body });
    }
    return;
  }
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import(
      "@tauri-apps/plugin-notification"
    );
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    /* 通知失败静默处理，非关键路径 */
  }
}

export { inTauri };
