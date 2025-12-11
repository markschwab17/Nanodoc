import type { FileSystemInterface } from "./FileSystemInterface";
import { BrowserFileSystem } from "./BrowserFileSystem";
import { TauriFileSystem } from "./TauriFileSystem";

export type { FileSystemInterface } from "./FileSystemInterface";
export { BrowserFileSystem } from "./BrowserFileSystem";
export { TauriFileSystem } from "./TauriFileSystem";

/**
 * Factory function to create the appropriate file system implementation
 * based on the current environment.
 */
export function createFileSystem(): FileSystemInterface {
  // Check if we're running in Tauri
  if (typeof window !== "undefined" && (window as any).__TAURI__) {
    return new TauriFileSystem();
  }

  // Check for Tauri environment variable
  if (import.meta.env.TAURI_PLATFORM) {
    return new TauriFileSystem();
  }

  // Default to browser implementation
  return new BrowserFileSystem();
}

