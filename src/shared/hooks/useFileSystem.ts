import { useMemo } from "react";
import type { FileSystemInterface } from "@/core/fs";
import { createFileSystem } from "@/core/fs";

/**
 * Hook that provides the appropriate file system implementation
 * based on the current environment (Tauri or Browser).
 * 
 * @returns The file system interface for the current environment
 */
export function useFileSystem(): FileSystemInterface {
  const fileSystem = useMemo(() => {
    return createFileSystem();
  }, []);

  return fileSystem;
}











