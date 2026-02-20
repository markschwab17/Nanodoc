/**
 * Holds the initial PDF (bytes + filename) when CTO opens Nanodoc in stitch mode.
 * StitchView consumes this on mount and clears it after adding tiles.
 */

import { create } from "zustand";

export interface CtoStitchInitialPdf {
  pdfBytes: Uint8Array;
  fileName: string;
}

interface CtoStitchInitialState {
  initial: CtoStitchInitialPdf | null;
  setInitial: (pdf: CtoStitchInitialPdf | null) => void;
  takeInitial: () => CtoStitchInitialPdf | null;
}

export const useCtoStitchInitialStore = create<CtoStitchInitialState>((set, get) => ({
  initial: null,
  setInitial: (pdf) => set({ initial: pdf }),
  /** Returns current initial PDF and clears it so it is only consumed once. */
  takeInitial: () => {
    const value = get().initial;
    set({ initial: null });
    return value;
  },
}));
