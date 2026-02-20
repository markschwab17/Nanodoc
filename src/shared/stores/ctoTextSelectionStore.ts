/**
 * Current text selection for CTO "Add to table" (split-screen embed).
 * When user selects text with the selectText tool and CTO embed params are present,
 * we store { page, quote } here so the split-screen UI can send nanodoc-text-selection to the parent.
 * Page is 0-based per CTO contract.
 */

import { create } from "zustand";

export interface CtoTextSelection {
  page: number;
  quote: string;
}

interface CtoTextSelectionState {
  selection: CtoTextSelection | null;
  setSelection: (page: number, quote: string) => void;
  clearSelection: () => void;
}

export const useCtoTextSelectionStore = create<CtoTextSelectionState>((set) => ({
  selection: null,
  setSelection: (page, quote) => set({ selection: { page, quote } }),
  clearSelection: () => set({ selection: null }),
}));
