/**
 * Civiltakeoff context when Nanodoc was opened from CTO (project, doc, token, api_origin).
 * Used to save the PDF and extraction back to CTO when the user saves.
 */

import { create } from "zustand";

export interface CiviltakeoffContext {
  project: string;
  doc: string;
  token: string;
  api_origin: string;
}

interface CiviltakeoffContextState {
  context: CiviltakeoffContext | null;
  setContext: (ctx: CiviltakeoffContext | null) => void;
  getContext: () => CiviltakeoffContext | null;
}

export const useCiviltakeoffContextStore = create<CiviltakeoffContextState>((set, get) => ({
  context: null,
  setContext: (ctx) => set({ context: ctx }),
  getContext: () => get().context,
}));
