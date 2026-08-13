/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MOCK_RUNTIME?: "1" | "";
  readonly VITE_DSH_LOG_LEVEL?: "debug" | "info" | "warn" | "error";
  readonly TAURI_DEBUG?: string;
  readonly TAURI_PLATFORM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
