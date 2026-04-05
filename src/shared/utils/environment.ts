/**
 * Environment detection utilities.
 *
 * Single source of truth for checking whether the app is running
 * inside Tauri (native desktop) vs a regular browser tab.
 */

export const isTauri: boolean =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
