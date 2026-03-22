import { create } from "zustand";

interface RedlineStoreState {
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  focusedRedlineId: string | null;
  setFocusedRedlineId: (id: string | null) => void;
  /** Risk score from CTO contract analysis (1-10). */
  riskScore: number | null;
  setRiskScore: (score: number | null) => void;
}

export const useRedlineStore = create<RedlineStoreState>((set) => ({
  panelOpen: false,
  setPanelOpen: (open) => set({ panelOpen: open }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  focusedRedlineId: null,
  setFocusedRedlineId: (id) => set({ focusedRedlineId: id }),
  riskScore: null,
  setRiskScore: (score) => set({ riskScore: score }),
}));
