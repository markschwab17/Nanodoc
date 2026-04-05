import type { FileSystemInterface } from "./FileSystemInterface";
import { isTauri } from "@/shared/utils/environment";
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
  if (isTauri) {
    return new TauriFileSystem();
  }

  return new BrowserFileSystem();
}

