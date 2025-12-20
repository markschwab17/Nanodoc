/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly TAURI_PLATFORM?: string;
  readonly TAURI_ARCH?: string;
  readonly TAURI_FAMILY?: string;
  readonly TAURI_PLUGIN_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}





















