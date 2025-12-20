/**
 * Undo/Redo Store
 * 
 * Manages undo/redo history for all state-changing operations using command pattern.
 */

import { create } from "zustand";
import type { PDFDocument } from "@/core/pdf/PDFDocument";
import type { Annotation } from "@/core/pdf/PDFEditor";

export type UndoableActionType =
  | "addAnnotation"
  | "removeAnnotation"
  | "updateAnnotation"
  | "deletePages"
  | "insertPages"
  | "reorderPages"
  | "pastePages"
  | "rotatePages";

export interface UndoableAction {
  id: string;
  type: UndoableActionType;
  documentId: string;
  timestamp: number;
  // State snapshots
  beforeState: {
    documents?: Map<string, PDFDocument>;
    annotations?: Map<string, Annotation[]>;
    currentPage?: number;
    currentDocumentId?: string | null;
  };
  afterState: {
    documents?: Map<string, PDFDocument>;
    annotations?: Map<string, Annotation[]>;
    currentPage?: number;
    currentDocumentId?: string | null;
  };
  // Action-specific data
  actionData?: {
    pageIndices?: number[];
    annotationId?: string;
    annotation?: Annotation;
    targetIndex?: number;
    sourceDocumentId?: string;
  };
  // Functions to execute undo/redo
  undo: () => Promise<void> | void;
  redo: () => Promise<void> | void;
}

export interface UndoRedoStoreState {
  history: UndoableAction[];
  currentIndex: number;
  maxHistorySize: number;

  // Actions
  pushAction: (action: Omit<UndoableAction, "id" | "timestamp">) => void;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: () => boolean;
  canRedo: () => boolean;
  clearHistory: () => void;
}

export const useUndoRedoStore = create<UndoRedoStoreState>((set, get) => ({
  history: [],
  currentIndex: -1,
  maxHistorySize: 50,

  pushAction: (action) => {
    const state = get();
    const newAction: UndoableAction = {
      ...action,
      id: `action_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
    };

    // Remove any actions after current index (when undoing and then doing new action)
    const newHistory = state.history.slice(0, state.currentIndex + 1);
    
    // Add new action
    newHistory.push(newAction);

    // Limit history size
    if (newHistory.length > state.maxHistorySize) {
      newHistory.shift();
    }

    set({
      history: newHistory,
      currentIndex: newHistory.length - 1,
    });
  },

  undo: async () => {
    const state = get();
    if (!state.canUndo()) return;

    const action = state.history[state.currentIndex];
    try {
      await action.undo();
      set({ currentIndex: state.currentIndex - 1 });
    } catch (error) {
      console.error("Error undoing action:", error);
    }
  },

  redo: async () => {
    const state = get();
    if (!state.canRedo()) return;

    const nextIndex = state.currentIndex + 1;
    const action = state.history[nextIndex];
    try {
      await action.redo();
      set({ currentIndex: nextIndex });
    } catch (error) {
      console.error("Error redoing action:", error);
    }
  },

  canUndo: () => {
    const state = get();
    return state.currentIndex >= 0;
  },

  canRedo: () => {
    const state = get();
    return state.currentIndex < state.history.length - 1;
  },

  clearHistory: () => {
    set({ history: [], currentIndex: -1 });
  },
}));




















