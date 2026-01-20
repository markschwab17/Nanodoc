/**
 * Document Settings Store
 * 
 * Manages document canvas settings, rulers, and measurement units.
 */

import { create } from "zustand";

export interface CanvasSettings {
  width: number; // in points (72 points = 1 inch)
  height: number; // in points
  orientation: "portrait" | "landscape";
}

export type RenderQuality = "low" | "medium" | "high" | "ultra";

export interface DocumentSettingsState {
  showRulers: boolean;
  rulerUnits: "inches" | "cm" | "points";
  documentCanvasSettings: Map<string, CanvasSettings>;
  renderQuality: RenderQuality;

  // Actions
  setShowRulers: (show: boolean) => void;
  toggleRulers: () => void;
  setRulerUnits: (units: "inches" | "cm" | "points") => void;
  setDocumentCanvasSettings: (documentId: string, settings: CanvasSettings) => void;
  getDocumentCanvasSettings: (documentId: string) => CanvasSettings | undefined;
  clearDocumentSettings: (documentId: string) => void;
  setRenderQuality: (quality: RenderQuality) => void;
}

// Common page size presets in points (72 points = 1 inch)
export const PAGE_PRESETS = {
  letter: { width: 612, height: 792, name: "Letter (8.5\" × 11\")" },
  legal: { width: 612, height: 1008, name: "Legal (8.5\" × 14\")" },
  a4: { width: 595, height: 842, name: "A4 (8.27\" × 11.69\")" },
  tabloid: { width: 792, height: 1224, name: "Tabloid (11\" × 17\")" },
} as const;

// Conversion utilities
export const POINTS_PER_INCH = 72;
export const POINTS_PER_CM = 28.346;

export function pointsToInches(points: number): number {
  return points / POINTS_PER_INCH;
}

export function inchesToPoints(inches: number): number {
  return inches * POINTS_PER_INCH;
}

export function pointsToCm(points: number): number {
  return points / POINTS_PER_CM;
}

export function cmToPoints(cm: number): number {
  return cm * POINTS_PER_CM;
}

// Render quality scale multipliers
export const RENDER_QUALITY_SCALES: Record<RenderQuality, number> = {
  low: 1.0,    // 1x (device pixel ratio only)
  medium: 1.5, // 1.5x for balanced quality/performance
  high: 2.0,   // 2x for crisp text and good quality
  ultra: 3.0,  // 3x for maximum quality (may be slower)
};

export function getRenderQualityScale(quality: RenderQuality): number {
  return RENDER_QUALITY_SCALES[quality];
}

export const useDocumentSettingsStore = create<DocumentSettingsState>((set, get) => ({
  showRulers: false,
  rulerUnits: "inches",
  documentCanvasSettings: new Map(),
  renderQuality: "high", // Default to high quality for better text readability

  setShowRulers: (show) => set({ showRulers: show }),

  toggleRulers: () => set((state) => ({ showRulers: !state.showRulers })),

  setRulerUnits: (units) => set({ rulerUnits: units }),

  setDocumentCanvasSettings: (documentId, settings) =>
    set((state) => {
      const newSettings = new Map(state.documentCanvasSettings);
      newSettings.set(documentId, settings);
      return { documentCanvasSettings: newSettings };
    }),

  getDocumentCanvasSettings: (documentId) => {
    const state = get();
    return state.documentCanvasSettings.get(documentId);
  },

  clearDocumentSettings: (documentId) =>
    set((state) => {
      const newSettings = new Map(state.documentCanvasSettings);
      newSettings.delete(documentId);
      return { documentCanvasSettings: newSettings };
    }),

  setRenderQuality: (quality) => set({ renderQuality: quality }),
}));

















