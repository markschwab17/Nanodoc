/**
 * Clipboard Store
 * 
 * Manages clipboard for copying and pasting PDF pages between documents.
 */

import { create } from "zustand";
import type { Annotation } from "@/core/pdf/PDFEditor";

export interface CopiedPage {
  pageIndex: number;
  annotations: Annotation[];
}

export interface ClipboardData {
  sourceDocumentId: string;
  sourceDocumentName: string;
  pages: CopiedPage[];
  timestamp: number;
}

export interface ClipboardStoreState {
  clipboard: ClipboardData | null;

  // Actions
  copyPages: (
    sourceDocumentId: string,
    sourceDocumentName: string,
    pageIndices: number[],
    annotations: Annotation[]
  ) => void;
  pastePages: () => ClipboardData | null;
  hasPages: () => boolean;
  clear: () => void;
  getSourceInfo: () => { documentId: string; documentName: string } | null;
}

export const useClipboardStore = create<ClipboardStoreState>((set, get) => ({
  clipboard: null,

  copyPages: (sourceDocumentId, sourceDocumentName, pageIndices, annotations) => {
    // Group annotations by page
    const pages: CopiedPage[] = pageIndices.map((pageIndex) => ({
      pageIndex,
      annotations: annotations.filter((ann) => ann.pageNumber === pageIndex),
    }));

    set({
      clipboard: {
        sourceDocumentId,
        sourceDocumentName,
        pages,
        timestamp: Date.now(),
      },
    });
  },

  pastePages: () => {
    const state = get();
    return state.clipboard;
  },

  hasPages: () => {
    const state = get();
    return state.clipboard !== null && state.clipboard.pages.length > 0;
  },

  clear: () => {
    set({ clipboard: null });
  },

  getSourceInfo: () => {
    const state = get();
    if (!state.clipboard) return null;
    return {
      documentId: state.clipboard.sourceDocumentId,
      documentName: state.clipboard.sourceDocumentName,
    };
  },
}));





