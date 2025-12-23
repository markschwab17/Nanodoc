/**
 * UI Store
 * 
 * Manages UI state: zoom level, active tool, view mode, etc.
 */

import { create } from "zustand";

export type ToolType = "select" | "text" | "highlight" | "note" | "pan" | "callout" | "redact" | "selectText" | "form" | "draw" | "shape" | "stamp";
export type ViewMode = "single" | "spread" | "thumbnails";

export interface UIState {
  zoomLevel: number; // Current active zoom level (switches between modes)
  readModeZoomLevel: number; // Separate zoom level for read mode
  normalModeZoomLevel: number; // Separate zoom level for normal mode
  isZooming: boolean; // Flag to indicate active zoom operation
  fitMode: "width" | "page" | "custom";
  activeTool: ToolType;
  viewMode: ViewMode;
  showThumbnails: boolean;
  showToolbar: boolean;
  zoomToCenterCallback: ((newZoom: number) => void) | null;
  readMode: boolean;
  renderQuality: 'low' | 'normal' | 'high' | 'ultra';
  qualityOverride: 'low' | 'normal' | 'high' | 'ultra' | null; // Manual quality override (null = auto)

  // Highlight tool settings
  highlightColor: string;
  highlightStrokeWidth: number;
  highlightOpacity: number;
  
  // Drawing tool settings
  drawingStyle: "marker" | "pencil" | "pen";
  drawingColor: string;
  drawingStrokeWidth: number;
  drawingOpacity: number;
  
  // Shape tool settings
  currentShapeType: "arrow" | "rectangle" | "circle";
  shapeStrokeColor: string;
  shapeStrokeWidth: number;
  shapeFillColor: string;
  shapeFillOpacity: number;
  arrowHeadSize: number;
  
  // Form tool settings
  currentFieldType: "text" | "checkbox" | "radio" | "dropdown" | "date";
  
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
  setRenderQuality: (quality: 'low' | 'normal' | 'high' | 'ultra') => void;
  setQualityOverride: (quality: 'low' | 'normal' | 'high' | 'ultra' | null) => void;
  getEffectiveRenderQuality: () => 'low' | 'normal' | 'high' | 'ultra';
  setHighlightColor: (color: string) => void;
  setHighlightStrokeWidth: (width: number) => void;
  setHighlightOpacity: (opacity: number) => void;
  setDrawingStyle: (style: "marker" | "pencil" | "pen") => void;
  setDrawingColor: (color: string) => void;
  setDrawingStrokeWidth: (width: number) => void;
  setDrawingOpacity: (opacity: number) => void;
  setCurrentShapeType: (type: "arrow" | "rectangle" | "circle") => void;
  setShapeStrokeColor: (color: string) => void;
  setShapeStrokeWidth: (width: number) => void;
  setShapeFillColor: (color: string) => void;
  setShapeFillOpacity: (opacity: number) => void;
  setArrowHeadSize: (size: number) => void;
  setCurrentFieldType: (type: "text" | "checkbox" | "radio" | "dropdown" | "date") => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  zoomLevel: 1.0,
  readModeZoomLevel: 1.0, // Separate zoom level for read mode, starts at base fit scale
  normalModeZoomLevel: 1.0, // Separate zoom level for normal mode
  fitMode: "page", // Default to fit page
  activeTool: "select",
  viewMode: "single",
  showThumbnails: true,
  showToolbar: true,
  zoomToCenterCallback: null,
  readMode: false,
  renderQuality: 'normal', // Default to normal quality for good balance of quality and performance
  qualityOverride: null, // null = auto quality based on zoom
  isZooming: false,
  
  // Highlight tool settings
  highlightColor: "#FFFF00",
  highlightStrokeWidth: 15,
  highlightOpacity: 0.5,
  
  // Drawing tool settings
  drawingStyle: "pencil",
  drawingColor: "#000000",
  drawingStrokeWidth: 3,
  drawingOpacity: 1.0,
  
  // Shape tool settings
  currentShapeType: "rectangle",
  shapeStrokeColor: "#000000",
  shapeStrokeWidth: 2,
  shapeFillColor: "#FFFFFF",
  shapeFillOpacity: 0,
  arrowHeadSize: 10,
  
  // Form tool settings
  currentFieldType: "text",

  setZoomLevel: (level) => {
    const state = get();
    const clampedLevel = Math.max(0.25, Math.min(5.0, level));
    if (state.readMode) {
      // Save to read mode zoom level
      set({ readModeZoomLevel: clampedLevel, zoomLevel: clampedLevel, fitMode: "custom" });
    } else {
      // Save to normal mode zoom level
      set({ normalModeZoomLevel: clampedLevel, zoomLevel: clampedLevel, fitMode: "custom" });
    }
  },

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
      const state = get();
      const clampedLevel = Math.max(0.25, Math.min(5.0, newZoom));
      if (state.readMode) {
        set({ readModeZoomLevel: clampedLevel, zoomLevel: clampedLevel, fitMode: "custom" });
      } else {
        set({ normalModeZoomLevel: clampedLevel, zoomLevel: clampedLevel, fitMode: "custom" });
      }
    }
  },

  setRenderQuality: (quality) => set({ renderQuality: quality, qualityOverride: quality }),
  setQualityOverride: (quality) => set({ qualityOverride: quality }),

  getEffectiveRenderQuality: () => {
    const state = get();
    const zoom = state.readMode ? state.readModeZoomLevel : state.zoomLevel;

    // Check for manual quality override first
    if (state.qualityOverride !== null) {
      return state.qualityOverride;
    }

    // Automatic quality based on zoom level for optimal performance
    // Ultra quality triggers at 250% zoom and above for detailed work
    let quality: 'low' | 'normal' | 'high' | 'ultra';
    if (zoom >= 2.5) {
      quality = 'ultra'; // High zoom - maximum quality for detail work
    } else if (zoom >= 1.8) {
      quality = 'high'; // Medium-high zoom - good quality
    } else if (zoom >= 1.2) {
      quality = 'normal'; // Medium zoom - balanced quality
    } else {
      quality = 'low'; // Low zoom - fast rendering
    }

    return quality;
  },

  setReadMode: (enabled) => {
    const state = get();
    if (enabled && !state.readMode) {
      // Entering read mode: save current zoom to normalModeZoomLevel and reset to base fit scale (1.0)
      set({
        readMode: true,
        normalModeZoomLevel: state.zoomLevel, // Save current zoom
        zoomLevel: 1.0, // Always reset to base fit scale when entering read mode
        readModeZoomLevel: 1.0, // Reset read mode zoom
        fitMode: "width"
      });
    } else if (!enabled && state.readMode) {
      // Exiting read mode: save current zoom to readModeZoomLevel and reset to full view (fit to page)
      set({
        readMode: false,
        readModeZoomLevel: state.zoomLevel, // Save current read mode zoom
        zoomLevel: 1.0, // Reset to base zoom (will be recalculated to fit page)
        fitMode: "page" // Reset to fit page for full view
      });
    } else {
      set({ readMode: enabled });
    }
  },

  toggleReadMode: () => {
    const state = get();
    if (!state.readMode) {
      // Entering read mode: save current zoom to normalModeZoomLevel and reset to base fit scale (1.0)
      set({ 
        readMode: true, 
        normalModeZoomLevel: state.zoomLevel, // Save current zoom
        zoomLevel: 1.0, // Always reset to base fit scale when entering read mode
        readModeZoomLevel: 1.0, // Reset read mode zoom
        fitMode: "width" 
      });
    } else {
      // Exiting read mode: save current zoom to readModeZoomLevel and reset to full view (fit to page)
      set({ 
        readMode: false,
        readModeZoomLevel: state.zoomLevel, // Save current read mode zoom
        zoomLevel: 1.0, // Reset to base zoom (will be recalculated to fit page)
        fitMode: "page" // Reset to fit page for full view
      });
    }
  },

  setHighlightColor: (color) => set({ highlightColor: color }),
  
  setHighlightStrokeWidth: (width) => {
    const clampedWidth = Math.max(5, Math.min(50, width));
    set({ highlightStrokeWidth: clampedWidth });
  },
  
  setHighlightOpacity: (opacity) => {
    const clampedOpacity = Math.max(0.1, Math.min(1.0, opacity));
    set({ highlightOpacity: clampedOpacity });
  },
  
  setDrawingStyle: (style) => set({ drawingStyle: style }),
  setDrawingColor: (color) => set({ drawingColor: color }),
  setDrawingStrokeWidth: (width) => {
    const clampedWidth = Math.max(1, Math.min(50, width));
    set({ drawingStrokeWidth: clampedWidth });
  },
  setDrawingOpacity: (opacity) => {
    const clampedOpacity = Math.max(0, Math.min(1, opacity));
    set({ drawingOpacity: clampedOpacity });
  },
  
  setCurrentShapeType: (type) => set({ currentShapeType: type }),
  setShapeStrokeColor: (color) => set({ shapeStrokeColor: color }),
  setShapeStrokeWidth: (width) => {
    const clampedWidth = Math.max(1, Math.min(20, width));
    set({ shapeStrokeWidth: clampedWidth });
  },
  setShapeFillColor: (color) => set({ shapeFillColor: color }),
  setShapeFillOpacity: (opacity) => {
    const clampedOpacity = Math.max(0, Math.min(1.0, opacity));
    set({ shapeFillOpacity: clampedOpacity });
  },
  setArrowHeadSize: (size) => {
    const clampedSize = Math.max(5, Math.min(30, size));
    set({ arrowHeadSize: clampedSize });
  },
  
  setCurrentFieldType: (type) => set({ currentFieldType: type }),
}));

