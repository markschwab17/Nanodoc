/**
 * Tour Store – tracks in-app guided tour state.
 * Persists completed tour IDs to localStorage so first-time tours only show once.
 */

import { create } from "zustand";

const STORAGE_KEY = "completedTours";

function loadCompleted(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveCompleted(ids: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch { /* quota exceeded or private mode */ }
}

interface TourState {
  activeTourId: string | null;
  currentStepIndex: number;
  completedTourIds: Set<string>;

  startTour: (id: string) => void;
  nextStep: () => void;
  prevStep: () => void;
  skipTour: () => void;
  completeTour: () => void;
  hasCompletedTour: (id: string) => boolean;
}

export const useTourStore = create<TourState>()((set, get) => ({
  activeTourId: null,
  currentStepIndex: 0,
  completedTourIds: loadCompleted(),

  startTour: (id) => set({ activeTourId: id, currentStepIndex: 0 }),

  nextStep: () =>
    set((s) => ({ currentStepIndex: s.currentStepIndex + 1 })),

  prevStep: () =>
    set((s) => ({ currentStepIndex: Math.max(0, s.currentStepIndex - 1) })),

  skipTour: () => {
    const tourId = get().activeTourId;
    const completed = new Set(get().completedTourIds);
    if (tourId) completed.add(tourId);
    saveCompleted(completed);
    set({ activeTourId: null, currentStepIndex: 0, completedTourIds: completed });
  },

  completeTour: () => {
    const tourId = get().activeTourId;
    const completed = new Set(get().completedTourIds);
    if (tourId) completed.add(tourId);
    saveCompleted(completed);
    set({ activeTourId: null, currentStepIndex: 0, completedTourIds: completed });
  },

  hasCompletedTour: (id) => get().completedTourIds.has(id),
}));
