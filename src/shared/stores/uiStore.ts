/**
 * UI Store
 * 
 * Manages UI state: zoom level, active tool, view mode, etc.
 */

import { create } from "zustand";

export type ToolType = "select" | "text" | "highlight" | "note" | "pan" | "callout";
export type ViewMode = "single" | "spread" | "thumbnails";

export interface UIState {
  zoomLevel: number;
  fitMode: "width" | "page" | "custom";
  activeTool: ToolType;
  viewMode: ViewMode;
  showThumbnails: boolean;
  showToolbar: boolean;
  zoomToCenterCallback: ((newZoom: number) => void) | null;
  readMode: boolean;
  
  // Actions
  setZoomLevel: (level: number) => void;
  setFitMode: (mode: "width" | "page" | "custom") => void;
  setActiveTool: (tool: ToolType) => void;
  setViewMode: (mode: ViewMode) => void;
  toggleThumbnails: () => void;
  toggleToolbar: () => void;
  resetZoom: () => void;
  setZoomToCenterCallback: (callback: ((newZoom: number) => void) | null) => void;
  zoomToCenter: (newZoom: number) => void;
  setReadMode: (enabled: boolean) => void;
  toggleReadMode: () => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  zoomLevel: 1.0,
  fitMode: "page", // Default to fit page
  activeTool: "select",
  viewMode: "single",
  showThumbnails: true,
  showToolbar: true,
  zoomToCenterCallback: null,
  readMode: false,

  setZoomLevel: (level) =>
    set({ zoomLevel: Math.max(0.25, Math.min(5.0, level)), fitMode: "custom" }),

  setFitMode: (mode) => set({ fitMode: mode }),

  setActiveTool: (tool) => set({ activeTool: tool }),

  setViewMode: (mode) => set({ viewMode: mode }),

  toggleThumbnails: () =>
    set((state) => ({ showThumbnails: !state.showThumbnails })),

  toggleToolbar: () =>
    set((state) => ({ showToolbar: !state.showToolbar })),

  resetZoom: () => set({ zoomLevel: 1.0, fitMode: "width" }),

  setZoomToCenterCallback: (callback) => set({ zoomToCenterCallback: callback }),

  zoomToCenter: (newZoom) => {
    const callback = get().zoomToCenterCallback;
    if (callback) {
      callback(newZoom);
    } else {
      // Fallback to regular zoom if callback not set
      set({ zoomLevel: Math.max(0.25, Math.min(5.0, newZoom)), fitMode: "custom" });
    }
  },

  setReadMode: (enabled) => set({ readMode: enabled }),

  toggleReadMode: () => set((state) => ({ readMode: !state.readMode })),
}));

