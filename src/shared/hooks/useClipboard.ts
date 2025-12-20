/**
 * useClipboard Hook
 * 
 * Provides convenient access to clipboard operations for page copying.
 */

import { useClipboardStore } from "@/shared/stores/clipboardStore";

export function useClipboard() {
  const {
    copyPages,
    pastePages,
    hasPages,
    clear,
    getSourceInfo,
  } = useClipboardStore();

  return {
    copyPages,
    pastePages,
    hasPages: hasPages(),
    clear,
    getSourceInfo,
  };
}


















