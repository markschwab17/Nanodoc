/**
 * useUndoRedo Hook
 * 
 * Provides convenient access to undo/redo operations.
 */

import { useUndoRedoStore } from "@/shared/stores/undoRedoStore";

export function useUndoRedo() {
  const {
    undo,
    redo,
    canUndo,
    canRedo,
    getUndoLabel,
    getRedoLabel,
    pushAction,
    clearHistory,
  } = useUndoRedoStore();

  return {
    undo,
    redo,
    canUndo: canUndo(),
    canRedo: canRedo(),
    undoLabel: getUndoLabel(),
    redoLabel: getRedoLabel(),
    pushAction,
    clearHistory,
  };
}




















