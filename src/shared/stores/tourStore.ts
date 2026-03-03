/**
 * Tour Store – tracks in-app guided tour state.
 * Persists completedTours to localStorage so tours auto-start only on first visit.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface TourState {
  completedTours: string[];
  activeTourId: string | null;
  currentStepIndex: number;

  startTour: (id: string) => void;
  nextStep: () => void;
  prevStep: () => void;
  skipTour: () => void;
  completeTour: () => void;
  resetTour: (id: string) => void;
}

export const useTourStore = create<TourState>()(
  persist(
    (set, get) => ({
      completedTours: [],
      activeTourId: null,
      currentStepIndex: 0,

      startTour: (id) =>
        set({ activeTourId: id, currentStepIndex: 0 }),

      nextStep: () =>
        set((s) => ({ currentStepIndex: s.currentStepIndex + 1 })),

      prevStep: () =>
        set((s) => ({ currentStepIndex: Math.max(0, s.currentStepIndex - 1) })),

      skipTour: () => {
        const { activeTourId, completedTours } = get();
        set({
          activeTourId: null,
          currentStepIndex: 0,
          completedTours: activeTourId && !completedTours.includes(activeTourId)
            ? [...completedTours, activeTourId]
            : completedTours,
        });
      },

      completeTour: () => {
        const { activeTourId, completedTours } = get();
        set({
          activeTourId: null,
          currentStepIndex: 0,
          completedTours: activeTourId && !completedTours.includes(activeTourId)
            ? [...completedTours, activeTourId]
            : completedTours,
        });
      },

      resetTour: (id) =>
        set((s) => ({
          completedTours: s.completedTours.filter((t) => t !== id),
          activeTourId: null,
          currentStepIndex: 0,
        })),
    }),
    {
      name: "nanodoc-tour-storage",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ completedTours: state.completedTours }),
    }
  )
);
