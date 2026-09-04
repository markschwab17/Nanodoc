/**
 * Holds the initial PDF (bytes + filename) when CTO opens Nanodoc in stitch mode.
 * StitchView consumes this on mount and clears it after adding tiles.
 */

import { create } from "zustand";

export interface CtoStitchInitialPdf {
  pdfBytes: Uint8Array;
  fileName: string;
  /** Raw `stitchPlan` from CTO's `/api/nanodoc/pdf`, when that build sends one.
   *  Kept unparsed here on purpose: it is validated against the REAL page count
   *  of the opened document (see `parseStitchPlan`), which only StitchView knows
   *  — and typing it here would drag the stitch feature's types onto the plain
   *  viewer's boot path. */
  plan?: unknown;
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
