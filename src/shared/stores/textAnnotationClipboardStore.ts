/**
 * Text Annotation Clipboard Store
 * 
 * Manages clipboard for copying and pasting text box annotations.
 */

import { create } from "zustand";
import type { Annotation } from "@/core/pdf/PDFEditor";

export interface TextAnnotationClipboardData {
  annotation: Annotation;
}

export interface TextAnnotationClipboardStoreState {
  clipboard: TextAnnotationClipboardData | null;
  copyTextAnnotation: (annotation: Annotation) => void;
  pasteTextAnnotation: () => TextAnnotationClipboardData | null;
  hasTextAnnotation: () => boolean;
  clear: () => void;
}

export const useTextAnnotationClipboardStore = create<TextAnnotationClipboardStoreState>((set, get) => ({
  clipboard: null,

  copyTextAnnotation: (annotation) => {
    // Deep clone the annotation to avoid reference issues
    const clonedAnnotation: Annotation = {
      ...annotation,
      id: `${annotation.id}_copy_${Date.now()}`, // Generate new ID for paste
    };
    set({
      clipboard: {
        annotation: clonedAnnotation,
      },
    });
    const state = get();
  },

  pasteTextAnnotation: () => {
    const state = get();
    return state.clipboard;
  },

  hasTextAnnotation: () => {
    const state = get();
    const result = state.clipboard !== null;
    return result;
  },

  clear: () => {
    set({ clipboard: null });
  },
}));

