/**
 * Print Store
 * 
 * Manages print configuration settings and preferences.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type PageOrientation = "portrait" | "landscape" | "auto";
export type PageSize = "letter" | "a4" | "legal" | "tabloid" | "custom";
export type MarginPreset = "none" | "narrow" | "normal" | "wide" | "custom";
export type ScalingMode = "fit" | "actual" | "custom";
export type PagesPerSheet = 1 | 2 | 4 | 6 | 9 | 16;
export type PageOrder = "horizontal" | "vertical";
export type PrintRange = "all" | "current" | "custom";

export interface PageSizeDimensions {
  width: number; // in inches
  height: number; // in inches
}

export interface MarginSettings {
  top: number; // in inches
  right: number; // in inches
  bottom: number; // in inches
  left: number; // in inches
}

export interface PrintSettings {
  // Page Setup
  orientation: PageOrientation;
  pageSize: PageSize;
  customPageSize: PageSizeDimensions;
  
  // Layout
  pagesPerSheet: PagesPerSheet;
  pageOrder: PageOrder;
  
  // Margins
  marginPreset: MarginPreset;
  customMargins: MarginSettings;
  
  // Scaling
  scalingMode: ScalingMode;
  customScale: number; // percentage (25-400)
  
  // Print Range
  printRange: PrintRange;
  customRange: string; // e.g., "1-5, 8, 11-13"
}

export interface PrintStore {
  settings: PrintSettings;
  
  // Actions
  setOrientation: (orientation: PageOrientation) => void;
  setPageSize: (pageSize: PageSize) => void;
  setCustomPageSize: (dimensions: PageSizeDimensions) => void;
  setPagesPerSheet: (pages: PagesPerSheet) => void;
  setPageOrder: (order: PageOrder) => void;
  setMarginPreset: (preset: MarginPreset) => void;
  setCustomMargins: (margins: MarginSettings) => void;
  setScalingMode: (mode: ScalingMode) => void;
  setCustomScale: (scale: number) => void;
  setPrintRange: (range: PrintRange) => void;
  setCustomRange: (range: string) => void;
  resetToDefaults: () => void;
  updateSettings: (partial: Partial<PrintSettings>) => void;
}

// Standard page sizes in inches
export const PAGE_SIZES: Record<PageSize, PageSizeDimensions> = {
  letter: { width: 8.5, height: 11 },
  a4: { width: 8.27, height: 11.69 },
  legal: { width: 8.5, height: 14 },
  tabloid: { width: 11, height: 17 },
  custom: { width: 8.5, height: 11 }, // default for custom
};

// Standard margin presets in inches
export const MARGIN_PRESETS: Record<MarginPreset, MarginSettings> = {
  none: { top: 0, right: 0, bottom: 0, left: 0 },
  narrow: { top: 0.25, right: 0.25, bottom: 0.25, left: 0.25 },
  normal: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 },
  wide: { top: 1, right: 1, bottom: 1, left: 1 },
  custom: { top: 0.5, right: 0.5, bottom: 0.5, left: 0.5 }, // default for custom
};

// Default settings
const DEFAULT_SETTINGS: PrintSettings = {
  orientation: "auto",
  pageSize: "letter",
  customPageSize: PAGE_SIZES.letter,
  pagesPerSheet: 1,
  pageOrder: "horizontal",
  marginPreset: "none",
  customMargins: MARGIN_PRESETS.none,
  scalingMode: "fit",
  customScale: 100,
  printRange: "all",
  customRange: "",
};

export const usePrintStore = create<PrintStore>()(
  persist(
    (set) => ({
      settings: DEFAULT_SETTINGS,

      setOrientation: (orientation) =>
        set((state) => ({
          settings: { ...state.settings, orientation },
        })),

      setPageSize: (pageSize) =>
        set((state) => ({
          settings: {
            ...state.settings,
            pageSize,
            customPageSize: PAGE_SIZES[pageSize],
          },
        })),

      setCustomPageSize: (dimensions) =>
        set((state) => ({
          settings: {
            ...state.settings,
            pageSize: "custom",
            customPageSize: dimensions,
          },
        })),

      setPagesPerSheet: (pages) =>
        set((state) => ({
          settings: { ...state.settings, pagesPerSheet: pages },
        })),

      setPageOrder: (order) =>
        set((state) => ({
          settings: { ...state.settings, pageOrder: order },
        })),

      setMarginPreset: (preset) =>
        set((state) => ({
          settings: {
            ...state.settings,
            marginPreset: preset,
            customMargins: MARGIN_PRESETS[preset],
          },
        })),

      setCustomMargins: (margins) =>
        set((state) => ({
          settings: {
            ...state.settings,
            marginPreset: "custom",
            customMargins: margins,
          },
        })),

      setScalingMode: (mode) =>
        set((state) => ({
          settings: { ...state.settings, scalingMode: mode },
        })),

      setCustomScale: (scale) =>
        set((state) => ({
          settings: {
            ...state.settings,
            scalingMode: "custom",
            customScale: Math.max(25, Math.min(400, scale)),
          },
        })),

      setPrintRange: (range) =>
        set((state) => ({
          settings: { ...state.settings, printRange: range },
        })),

      setCustomRange: (range) =>
        set((state) => ({
          settings: {
            ...state.settings,
            printRange: "custom",
            customRange: range,
          },
        })),

      resetToDefaults: () => set({ settings: DEFAULT_SETTINGS }),

      updateSettings: (partial) =>
        set((state) => ({
          settings: { ...state.settings, ...partial },
        })),
    }),
    {
      name: "civil-pdf-print-settings",
      version: 1,
    }
  )
);


