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
  settings: Map<string, PrintSettings>; // documentId -> settings
  
  // Actions
  getSettings: (documentId: string) => PrintSettings;
  setOrientation: (documentId: string, orientation: PageOrientation) => void;
  setPageSize: (documentId: string, pageSize: PageSize) => void;
  setCustomPageSize: (documentId: string, dimensions: PageSizeDimensions) => void;
  setPagesPerSheet: (documentId: string, pages: PagesPerSheet) => void;
  setPageOrder: (documentId: string, order: PageOrder) => void;
  setMarginPreset: (documentId: string, preset: MarginPreset) => void;
  setCustomMargins: (documentId: string, margins: MarginSettings) => void;
  setScalingMode: (documentId: string, mode: ScalingMode) => void;
  setCustomScale: (documentId: string, scale: number) => void;
  setPrintRange: (documentId: string, range: PrintRange) => void;
  setCustomRange: (documentId: string, range: string) => void;
  resetToDefaults: (documentId: string) => void;
  updateSettings: (documentId: string, partial: Partial<PrintSettings>) => void;
  removeDocumentSettings: (documentId: string) => void;
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
export const DEFAULT_SETTINGS: PrintSettings = {
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
    (set, get) => ({
      settings: new Map(),

      getSettings: (documentId) => {
        const state = get();
        if (!state.settings.has(documentId)) {
          // Initialize with defaults if not exists
          const newSettings = { ...DEFAULT_SETTINGS };
          state.settings.set(documentId, newSettings);
          set({ settings: new Map(state.settings) });
          return newSettings;
        }
        return state.settings.get(documentId)!;
      },

      setOrientation: (documentId, orientation) =>
        set((state) => {
          const newSettings = new Map(state.settings);
          const current = newSettings.get(documentId) || { ...DEFAULT_SETTINGS };
          newSettings.set(documentId, { ...current, orientation });
          return { settings: newSettings };
        }),

      setPageSize: (documentId, pageSize) =>
        set((state) => {
          const newSettings = new Map(state.settings);
          const current = newSettings.get(documentId) || { ...DEFAULT_SETTINGS };
          newSettings.set(documentId, {
            ...current,
            pageSize,
            customPageSize: PAGE_SIZES[pageSize],
          });
          return { settings: newSettings };
        }),

      setCustomPageSize: (documentId, dimensions) =>
        set((state) => {
          const newSettings = new Map(state.settings);
          const current = newSettings.get(documentId) || { ...DEFAULT_SETTINGS };
          newSettings.set(documentId, {
            ...current,
            pageSize: "custom",
            customPageSize: dimensions,
          });
          return { settings: newSettings };
        }),

      setPagesPerSheet: (documentId, pages) =>
        set((state) => {
          const newSettings = new Map(state.settings);
          const current = newSettings.get(documentId) || { ...DEFAULT_SETTINGS };
          newSettings.set(documentId, { ...current, pagesPerSheet: pages });
          return { settings: newSettings };
        }),

      setPageOrder: (documentId, order) =>
        set((state) => {
          const newSettings = new Map(state.settings);
          const current = newSettings.get(documentId) || { ...DEFAULT_SETTINGS };
          newSettings.set(documentId, { ...current, pageOrder: order });
          return { settings: newSettings };
        }),

      setMarginPreset: (documentId, preset) =>
        set((state) => {
          const newSettings = new Map(state.settings);
          const current = newSettings.get(documentId) || { ...DEFAULT_SETTINGS };
          newSettings.set(documentId, {
            ...current,
            marginPreset: preset,
            customMargins: MARGIN_PRESETS[preset],
          });
          return { settings: newSettings };
        }),

      setCustomMargins: (documentId, margins) =>
        set((state) => {
          const newSettings = new Map(state.settings);
          const current = newSettings.get(documentId) || { ...DEFAULT_SETTINGS };
          newSettings.set(documentId, {
            ...current,
            marginPreset: "custom",
            customMargins: margins,
          });
          return { settings: newSettings };
        }),

      setScalingMode: (documentId, mode) =>
        set((state) => {
          const newSettings = new Map(state.settings);
          const current = newSettings.get(documentId) || { ...DEFAULT_SETTINGS };
          newSettings.set(documentId, { ...current, scalingMode: mode });
          return { settings: newSettings };
        }),

      setCustomScale: (documentId, scale) =>
        set((state) => {
          const newSettings = new Map(state.settings);
          const current = newSettings.get(documentId) || { ...DEFAULT_SETTINGS };
          newSettings.set(documentId, {
            ...current,
            scalingMode: "custom",
            customScale: Math.max(25, Math.min(400, scale)),
          });
          return { settings: newSettings };
        }),

      setPrintRange: (documentId, range) =>
        set((state) => {
          const newSettings = new Map(state.settings);
          const current = newSettings.get(documentId) || { ...DEFAULT_SETTINGS };
          newSettings.set(documentId, { ...current, printRange: range });
          return { settings: newSettings };
        }),

      setCustomRange: (documentId, range) =>
        set((state) => {
          const newSettings = new Map(state.settings);
          const current = newSettings.get(documentId) || { ...DEFAULT_SETTINGS };
          newSettings.set(documentId, {
            ...current,
            printRange: "custom",
            customRange: range,
          });
          return { settings: newSettings };
        }),

      resetToDefaults: (documentId) =>
        set((state) => {
          const newSettings = new Map(state.settings);
          newSettings.set(documentId, { ...DEFAULT_SETTINGS });
          return { settings: newSettings };
        }),

      updateSettings: (documentId, partial) =>
        set((state) => {
          const newSettings = new Map(state.settings);
          const current = newSettings.get(documentId) || { ...DEFAULT_SETTINGS };
          newSettings.set(documentId, { ...current, ...partial });
          return { settings: newSettings };
        }),

      removeDocumentSettings: (documentId) =>
        set((state) => {
          const newSettings = new Map(state.settings);
          newSettings.delete(documentId);
          return { settings: newSettings };
        }),
    }),
    {
      name: "civil-pdf-print-settings",
      version: 2,
      // Custom serialization for Map
      serialize: (state) => {
        const serialized: any = {};
        state.settings.forEach((value, key) => {
          serialized[key] = value;
        });
        return JSON.stringify({ settings: serialized });
      },
      deserialize: (str) => {
        const parsed = JSON.parse(str);
        const settingsMap = new Map<string, PrintSettings>();
        if (parsed.settings) {
          Object.entries(parsed.settings).forEach(([key, value]) => {
            settingsMap.set(key, value as PrintSettings);
          });
        }
        return { settings: settingsMap };
      },
    }
  )
);


