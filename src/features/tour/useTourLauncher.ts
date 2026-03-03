/**
 * useTourLauncher – auto-starts a tour on first visit and provides restart.
 */

import { useEffect } from "react";
import { useTourStore } from "@/shared/stores/tourStore";

/**
 * Auto-starts the given tour if the user hasn't completed it yet.
 * Call this once per view (Editor / StitchView).
 */
export function useTourLauncher(tourId: string) {
  useEffect(() => {
    const { completedTours, activeTourId, startTour } = useTourStore.getState();
    if (!completedTours.includes(tourId) && activeTourId == null) {
      // Small delay to let the UI settle before starting
      const timer = setTimeout(() => {
        // Re-check in case something changed during the delay
        const current = useTourStore.getState();
        if (!current.completedTours.includes(tourId) && current.activeTourId == null) {
          startTour(tourId);
        }
      }, 800);
      return () => clearTimeout(timer);
    }
  }, [tourId]);
}

/**
 * Restart a tour (removes from completedTours and starts it).
 */
export function restartTour(tourId: string) {
  const store = useTourStore.getState();
  store.resetTour(tourId);
  // Start after a tick so the reset takes effect
  setTimeout(() => {
    useTourStore.getState().startTour(tourId);
  }, 50);
}
