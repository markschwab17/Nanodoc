/**
 * Stitch store – in-memory state for the PDF stitch canvas.
 * Canvas size, tiles, crop rect, selection, and optional pan/zoom.
 */

import { create } from "zustand";
import type { StitchTile, CropRect, StitchUndoSnapshot } from "@/features/stitch/stitchTypes";
import { CANVAS_PRESETS, UNDO_MAX_SIZE } from "@/features/stitch/stitchConstants";
import { getTileAABB } from "@/features/stitch/stitchGeometry";

export type { StitchTile, CropRect, StitchUndoSnapshot };
export { CANVAS_PRESETS };

const defaultSize = CANVAS_PRESETS[0];

function snapshotState(state: {
  tiles: StitchTile[];
  canvasWidth: number;
  canvasHeight: number;
  cropRect: CropRect | null;
}): StitchUndoSnapshot {
  return {
    tiles: state.tiles.map((t) => ({ ...t })),
    canvasWidth: state.canvasWidth,
    canvasHeight: state.canvasHeight,
    cropRect: state.cropRect ? { ...state.cropRect } : null,
  };
}

interface StitchState {
  canvasWidth: number;
  canvasHeight: number;
  tiles: StitchTile[];
  panOffset: { x: number; y: number };
  zoomLevel: number;
  /** Multi-select: when non-empty, these tiles are selected. Last item is "primary" for UI. */
  selectedTileIds: string[];
  cropRect: CropRect | null;
  /** When true, tiles snap to other tiles' edges and canvas edges when dragging/resizing. */
  snapToEdges: boolean;
  /** When true, tiles cannot be resized or rotated (move only). Toggle to allow resize/rotate. */
  resizeLocked: boolean;
  /** Drawing scale: 1 inch = this many feet (e.g. 20 for 1"=20'). null = not set. */
  referenceScaleFeetPerInch: number | null;
  /** Composition scale factor (1 = no shrink; 0.25 = shrunk 4x). Effective scale = referenceScaleFeetPerInch / compositionScaleFactor. */
  compositionScaleFactor: number;
  undoStack: StitchUndoSnapshot[];
  redoStack: StitchUndoSnapshot[];
  setCanvasSize: (width: number, height: number) => void;
  addTiles: (tiles: Omit<StitchTile, "id">[]) => void;
  updateTile: (id: string, patch: Partial<Pick<StitchTile, "x" | "y" | "width" | "height" | "rotation" | "imageDataUrl" | "locked" | "sourceFileName" | "isScaleStamp" | "scaleStampFeetPerInch" | "imageModified" | "hiddenRegions">>) => void;
  /** Apply patches to multiple tiles in one update (one undo step). */
  updateTiles: (updates: Array<{ id: string; patch: Partial<Pick<StitchTile, "x" | "y" | "width" | "height" | "rotation" | "locked" | "imageDataUrl" | "imageModified">> }>) => void;
  setHiddenRegions: (id: string, regions: CropRect[]) => void;
  removeTile: (id: string) => void;
  /** Remove multiple tiles in one update (one undo step). */
  removeTiles: (ids: string[]) => void;
  /** Move tile(s) to the back (lowest layer). Pass one id or multiple. */
  sendTileToBack: (id: string) => void;
  sendTilesToBack: (ids: string[]) => void;
  /** Move tile(s) to the front (top layer). Pass one id or multiple. */
  bringTileToFront: (id: string) => void;
  bringTilesToFront: (ids: string[]) => void;
  setSelectedTileId: (id: string | null) => void;
  setSelectedTileIds: (ids: string[]) => void;
  /** Toggle a tile in selection (for shift-click). Adds if not selected, removes if selected. */
  toggleTileInSelection: (id: string) => void;
  setPanOffset: (offset: { x: number; y: number }) => void;
  setZoomLevel: (level: number) => void;
  setCropRect: (rect: CropRect | null) => void;
  setCropToContent: (margin?: number) => void;
  /** Update a tile WITHOUT pushing an undo snapshot — use during continuous drag/resize. */
  updateTileNoUndo: (id: string, patch: Partial<Pick<StitchTile, "x" | "y" | "width" | "height" | "rotation" | "imageDataUrl" | "locked" | "sourceFileName" | "isScaleStamp" | "scaleStampFeetPerInch" | "imageModified" | "hiddenRegions">>) => void;
  /** Update multiple tiles WITHOUT pushing an undo snapshot — use during continuous group drag/resize/rotate. */
  updateTilesNoUndo: (updates: Array<{ id: string; patch: Partial<Pick<StitchTile, "x" | "y" | "width" | "height" | "rotation" | "locked" | "imageDataUrl" | "imageModified">> }>) => void;
  /** Manually push the current state as an undo snapshot. Call before starting a drag/resize operation. */
  pushUndoSnapshot: () => void;
  setSnapToEdges: (enabled: boolean) => void;
  setResizeLocked: (locked: boolean) => void;
  setReferenceScaleFeetPerInch: (value: number | null) => void;
  setCompositionScaleFactor: (factor: number) => void;
  /** Scale all tiles uniformly around origin (undoable). */
  scaleComposition: (factor: number, originX: number, originY: number) => void;
  reset: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

function generateTileId(): string {
  return `tile_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function pushUndoAndSet(
  set: (partial: Partial<StitchState> | ((s: StitchState) => Partial<StitchState>)) => void,
  get: () => StitchState,
  mutation: Partial<StitchState>
) {
  const state = get();
  const snap = snapshotState(state);
  set({
    ...mutation,
    undoStack: [...state.undoStack, snap].slice(-UNDO_MAX_SIZE),
    redoStack: [],
  });
}

export const useStitchStore = create<StitchState>((set, get) => ({
  canvasWidth: defaultSize.width,
  canvasHeight: defaultSize.height,
  tiles: [],
  panOffset: { x: 0, y: 0 },
  zoomLevel: 1,
  selectedTileIds: [],
  cropRect: null,
  snapToEdges: false,
  resizeLocked: true,
  referenceScaleFeetPerInch: null,
  compositionScaleFactor: 1,
  undoStack: [],
  redoStack: [],

  setCanvasSize: (width, height) =>
    pushUndoAndSet(set, get, { canvasWidth: width, canvasHeight: height }),

  addTiles: (newTiles) =>
    set((state) => {
      const snap = snapshotState(state);
      const tiles = [
        ...state.tiles,
        ...newTiles.map((t) => ({ ...t, id: generateTileId() })),
      ];
      return {
        tiles,
        selectedTileIds: [],
        undoStack: [...state.undoStack, snap].slice(-UNDO_MAX_SIZE),
        redoStack: [],
      };
    }),

  updateTile: (id, patch) =>
    set((state) => {
      const snap = snapshotState(state);
      const tiles = state.tiles.map((t) =>
        t.id === id ? { ...t, ...patch } : t
      );
      return {
        tiles,
        undoStack: [...state.undoStack, snap].slice(-UNDO_MAX_SIZE),
        redoStack: [],
      };
    }),

  setHiddenRegions: (id, regions) =>
    pushUndoAndSet(set, get, {
      tiles: get().tiles.map((t) => (t.id === id ? { ...t, hiddenRegions: regions } : t)),
    }),

  updateTiles: (updates) =>
    set((state) => {
      const snap = snapshotState(state);
      const byId = new Map(updates.map((u) => [u.id, u.patch]));
      const tiles = state.tiles.map((t) => {
        const patch = byId.get(t.id);
        return patch ? { ...t, ...patch } : t;
      });
      return {
        tiles,
        undoStack: [...state.undoStack, snap].slice(-UNDO_MAX_SIZE),
        redoStack: [],
      };
    }),

  updateTileNoUndo: (id, patch) =>
    set((state) => ({
      tiles: state.tiles.map((t) =>
        t.id === id ? { ...t, ...patch } : t
      ),
    })),

  updateTilesNoUndo: (updates) =>
    set((state) => {
      const byId = new Map(updates.map((u) => [u.id, u.patch]));
      return {
        tiles: state.tiles.map((t) => {
          const patch = byId.get(t.id);
          return patch ? { ...t, ...patch } : t;
        }),
      };
    }),

  pushUndoSnapshot: () =>
    set((state) => ({
      undoStack: [...state.undoStack, snapshotState(state)].slice(-UNDO_MAX_SIZE),
      redoStack: [],
    })),

  removeTile: (id) =>
    set((state) => {
      const snap = snapshotState(state);
      return {
        tiles: state.tiles.filter((t) => t.id !== id),
        selectedTileIds: state.selectedTileIds.filter((i) => i !== id),
        undoStack: [...state.undoStack, snap].slice(-UNDO_MAX_SIZE),
        redoStack: [],
      };
    }),

  removeTiles: (ids) =>
    set((state) => {
      if (ids.length === 0) return state;
      const snap = snapshotState(state);
      const remove = new Set(ids);
      return {
        tiles: state.tiles.filter((t) => !remove.has(t.id)),
        selectedTileIds: state.selectedTileIds.filter((i) => !remove.has(i)),
        undoStack: [...state.undoStack, snap].slice(-UNDO_MAX_SIZE),
        redoStack: [],
      };
    }),

  sendTileToBack: (id) =>
    set((state) => {
      const idx = state.tiles.findIndex((t) => t.id === id);
      if (idx <= 0) return state;
      const snap = snapshotState(state);
      const tiles = [...state.tiles];
      const [tile] = tiles.splice(idx, 1);
      tiles.unshift(tile);
      return {
        tiles,
        undoStack: [...state.undoStack, snap].slice(-UNDO_MAX_SIZE),
        redoStack: [],
      };
    }),

  sendTilesToBack: (ids) =>
    set((state) => {
      if (ids.length === 0) return state;
      const snap = snapshotState(state);
      const tiles = [...state.tiles];
      const toMove = tiles.filter((t) => ids.includes(t.id));
      const rest = tiles.filter((t) => !ids.includes(t.id));
      return {
        tiles: [...toMove, ...rest],
        undoStack: [...state.undoStack, snap].slice(-UNDO_MAX_SIZE),
        redoStack: [],
      };
    }),

  bringTileToFront: (id) =>
    set((state) => {
      const idx = state.tiles.findIndex((t) => t.id === id);
      if (idx < 0 || idx === state.tiles.length - 1) return state;
      const snap = snapshotState(state);
      const tiles = [...state.tiles];
      const [tile] = tiles.splice(idx, 1);
      tiles.push(tile);
      return {
        tiles,
        undoStack: [...state.undoStack, snap].slice(-UNDO_MAX_SIZE),
        redoStack: [],
      };
    }),

  bringTilesToFront: (ids) =>
    set((state) => {
      if (ids.length === 0) return state;
      const snap = snapshotState(state);
      const tiles = [...state.tiles];
      const toMove = tiles.filter((t) => ids.includes(t.id));
      const rest = tiles.filter((t) => !ids.includes(t.id));
      return {
        tiles: [...rest, ...toMove],
        undoStack: [...state.undoStack, snap].slice(-UNDO_MAX_SIZE),
        redoStack: [],
      };
    }),

  setSelectedTileId: (id) =>
    set({ selectedTileIds: id != null ? [id] : [] }),

  setSelectedTileIds: (ids) => set({ selectedTileIds: ids }),

  toggleTileInSelection: (id) =>
    set((state) => {
      const idx = state.selectedTileIds.indexOf(id);
      const selectedTileIds =
        idx >= 0
          ? state.selectedTileIds.filter((i) => i !== id)
          : [...state.selectedTileIds, id];
      return { selectedTileIds };
    }),

  setPanOffset: (panOffset) => set({ panOffset }),

  setZoomLevel: (zoomLevel) => set({ zoomLevel }),

  setCropRect: (cropRect) =>
    set((state) => ({
      ...state,
      cropRect,
      undoStack: [...state.undoStack, snapshotState(state)].slice(-UNDO_MAX_SIZE),
      redoStack: [],
    })),

  setSnapToEdges: (snapToEdges) => set({ snapToEdges }),

  setResizeLocked: (resizeLocked) => set({ resizeLocked }),

  setReferenceScaleFeetPerInch: (referenceScaleFeetPerInch) => set({ referenceScaleFeetPerInch }),

  setCompositionScaleFactor: (compositionScaleFactor) => set({ compositionScaleFactor }),

  scaleComposition: (factor, originX, originY) =>
    set((state) => {
      const snap = snapshotState(state);
      const updates = state.tiles.map((t) => {
        const newX = originX + (t.x - originX) * factor;
        const newY = originY + (t.y - originY) * factor;
        const newWidth = t.width * factor;
        const newHeight = t.height * factor;
        return { id: t.id, patch: { x: newX, y: newY, width: newWidth, height: newHeight } };
      });
      const byId = new Map(updates.map((u) => [u.id, u.patch]));
      const tiles = state.tiles.map((t) => {
        const patch = byId.get(t.id);
        return patch ? { ...t, ...patch } : t;
      });
      return {
        tiles,
        compositionScaleFactor: state.compositionScaleFactor * factor,
        undoStack: [...state.undoStack, snap].slice(-UNDO_MAX_SIZE),
        redoStack: [],
      };
    }),

  setCropToContent: (margin = 0) =>
    set((state) => {
      if (state.tiles.length === 0) return { cropRect: null };
      const snap = snapshotState(state);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const t of state.tiles) {
        const aabb = getTileAABB(t);
        x0 = Math.min(x0, aabb.x);
        y0 = Math.min(y0, aabb.y);
        x1 = Math.max(x1, aabb.x + aabb.width);
        y1 = Math.max(y1, aabb.y + aabb.height);
      }
      const cx0 = Math.max(0, x0 - margin);
      const cy0 = Math.max(0, y0 - margin);
      const cx1 = Math.min(state.canvasWidth, x1 + margin);
      const cy1 = Math.min(state.canvasHeight, y1 + margin);
      return {
        cropRect: {
          x: cx0,
          y: cy0,
          w: Math.max(0, cx1 - cx0),
          h: Math.max(0, cy1 - cy0),
        },
        undoStack: [...state.undoStack, snap].slice(-UNDO_MAX_SIZE),
        redoStack: [],
      };
    }),

  undo: () =>
    set((state) => {
      if (state.undoStack.length === 0) return state;
      const snap = state.undoStack[state.undoStack.length - 1];
      const currentSnap = snapshotState(state);
      return {
        ...snap,
        selectedTileIds: [],
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [...state.redoStack, currentSnap],
      };
    }),

  redo: () =>
    set((state) => {
      if (state.redoStack.length === 0) return state;
      const snap = state.redoStack[state.redoStack.length - 1];
      const currentSnap = snapshotState(state);
      return {
        ...snap,
        selectedTileIds: [],
        undoStack: [...state.undoStack, currentSnap].slice(-UNDO_MAX_SIZE),
        redoStack: state.redoStack.slice(0, -1),
      };
    }),

  canUndo: () => get().undoStack.length > 0,
  canRedo: () => get().redoStack.length > 0,

  reset: () =>
    set({
      canvasWidth: defaultSize.width,
      canvasHeight: defaultSize.height,
      tiles: [],
      panOffset: { x: 0, y: 0 },
      zoomLevel: 1,
      selectedTileIds: [],
      cropRect: null,
      snapToEdges: false,
      resizeLocked: true,
      referenceScaleFeetPerInch: null,
      compositionScaleFactor: 1,
      undoStack: [],
      redoStack: [],
    }),
}));
