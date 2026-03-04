/**
 * startTour – launches a guided tour from the Help dialog.
 */

import { useTourStore } from "@/shared/stores/tourStore";

/**
 * Start a tour by ID (primary launch mechanism from Help dialog).
 */
export function startTour(tourId: string) {
  useTourStore.getState().startTour(tourId);
}

/** @deprecated Use startTour instead. */
export const restartTour = startTour;
