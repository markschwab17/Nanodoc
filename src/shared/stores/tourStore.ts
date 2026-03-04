/**
 * Tour Store – tracks in-app guided tour state.
 */

import { create } from "zustand";

interface TourState {
  activeTourId: string | null;
  currentStepIndex: number;

  startTour: (id: string) => void;
  nextStep: () => void;
  prevStep: () => void;
  skipTour: () => void;
  completeTour: () => void;
}

export const useTourStore = create<TourState>()((set) => ({
  activeTourId: null,
  currentStepIndex: 0,

  startTour: (id) => set({ activeTourId: id, currentStepIndex: 0 }),

  nextStep: () =>
    set((s) => ({ currentStepIndex: s.currentStepIndex + 1 })),

  prevStep: () =>
    set((s) => ({ currentStepIndex: Math.max(0, s.currentStepIndex - 1) })),

  skipTour: () =>
    set({ activeTourId: null, currentStepIndex: 0 }),

  completeTour: () =>
    set({ activeTourId: null, currentStepIndex: 0 }),
}));
