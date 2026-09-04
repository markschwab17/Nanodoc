/**
 * Stitch store – in-memory state for the PDF stitch canvas.
 * Canvas size, tiles, crop rect, selection, and optional pan/zoom.
 */

import { create } from "zustand";
import type { StitchTile, CropRect, RelocatedRegion, StitchUndoSnapshot } from "@/features/stitch/stitchTypes";
import { CANVAS_PRESETS, FIT_MARGIN_PT, UNDO_MAX_SIZE } from "@/features/stitch/stitchConstants";
import { contentBounds, effectiveMinZoomFor, getTileAABB } from "@/features/stitch/stitchGeometry";
import {
  addToGroupIn,
  createGroupIn,
  detachFromGroupIn,
  mergeGroupsFor,
  pruneGroups,
  ungroupIn,
  type TileGroups,
} from "@/features/stitch/groups";

export type { StitchTile, CropRect, RelocatedRegion, StitchUndoSnapshot };
export { CANVAS_PRESETS };

const defaultSize = CANVAS_PRESETS[0];

function snapshotState(state: {
  tiles: StitchTile[];
  canvasWidth: number;
  canvasHeight: number;
  cropRect: CropRect | null;
  groups: TileGroups;
}): StitchUndoSnapshot {
  return {
    tiles: state.tiles.map((t) => ({ ...t })),
    canvasWidth: state.canvasWidth,
    canvasHeight: state.canvasHeight,
    cropRect: state.cropRect ? { ...state.cropRect } : null,
    // Membership rides on the tiles above; this is the names and colours, so undoing an
    // "Ungroup" restores the group the user knew rather than a fresh one.
    groups: { ...state.groups },
  };
}

interface StitchState {
  canvasWidth: number;
  canvasHeight: number;
  /** True once the USER has chosen a canvas size themselves. While false the canvas is still
   *  the untouched default and commits are free to resize it to fit the sheets. */
  canvasSizeTouched: boolean;
  /** Live size (CSS px) of the pan/zoom viewport, reported by StitchCanvas. 0 until measured.
   *  Lives here rather than in a ref so the zoom floor is one store selector every consumer
   *  reads — the wheel handler, the toolbar buttons and recenter must agree. */
  viewportWidth: number;
  viewportHeight: number;
  tiles: StitchTile[];
  /** tile id -> `blob:` URL of that tile's committed sheet raster. NOT part of
   *  the undo snapshots (see the `tileRasters` notes above `pruneTileRasters`). */
  tileRasters: Record<string, string>;
  panOffset: { x: number; y: number };
  zoomLevel: number;
  /** Multi-select: when non-empty, these tiles are selected. Last item is "primary" for UI. */
  selectedTileIds: string[];
  /** Persistent sheet groups, by id. Membership is `tile.groupId`; this holds each
   *  group's name and colour. See `features/stitch/groups.ts`. */
  groups: TileGroups;
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
  /** Set the page size. Marks the canvas as user-touched unless told otherwise (the
   *  fit-to-sheets path sizes the canvas FOR the user and must not count as a choice). */
  setCanvasSize: (width: number, height: number, options?: { touched?: boolean }) => void;
  setViewportSize: (width: number, height: number) => void;
  /** Set the zoom while holding the point under the VIEWPORT CENTRE fixed (what the toolbar
   *  +/- buttons want; the wheel anchors on the cursor instead). */
  zoomAboutViewportCenter: (nextZoom: number) => void;
  /** Grow the page so it covers every tile with FIT_MARGIN_PT of paper around them.
   *  See the implementation for what it does about tiles at negative coordinates. */
  fitCanvasToTiles: () => void;
  /** Append tiles. `rasterBlob` (the committed sheet PNG) is not stored on the
   *  tile: it becomes an object URL in `tileRasters` under the generated id, so
   *  two placements of one page get their OWN revocable URL. */
  addTiles: (tiles: Array<Omit<StitchTile, "id"> & { rasterBlob?: Blob }>) => void;
  updateTile: (id: string, patch: Partial<Pick<StitchTile, "x" | "y" | "width" | "height" | "rotation" | "imageDataUrl" | "locked" | "sourceFileName" | "isScaleStamp" | "scaleStampFeetPerInch" | "imageModified" | "hiddenRegions" | "relocatedRegions">>) => void;
  /** Apply patches to multiple tiles in one update (one undo step). */
  updateTiles: (updates: Array<{ id: string; patch: Partial<Pick<StitchTile, "x" | "y" | "width" | "height" | "rotation" | "locked" | "imageDataUrl" | "imageModified">> }>) => void;
  setHiddenRegions: (id: string, regions: CropRect[]) => void;
  /** Set both hide + relocate regions for a tile in one undo step (Clean-Composite Apply). */
  setCleanupRegions: (id: string, hidden: CropRect[], relocated: RelocatedRegion[]) => void;
  /** Clean-Composite Apply that promotes relocated regions to standalone tiles:
   *  set each source tile's hiddenRegions and append the new crop tiles, in one
   *  undo step. The new tiles are selected so their move/resize handles show. */
  applyCleanupPromotion: (
    updates: { id: string; hiddenRegions: CropRect[] }[],
    newTiles: Omit<StitchTile, "id">[]
  ) => void;
  removeTile: (id: string) => void;
  /** Remove multiple tiles in one update (one undo step). */
  removeTiles: (ids: string[]) => void;
  /** Swap one set of tiles for another in ONE undo step: `removeIds` go, `newTiles`
   *  are appended. Two calls would make the swap two steps, so the first undo after
   *  an auto-align would leave the grid AND the composite on the canvas at once. */
  replaceTiles: (
    removeIds: string[],
    newTiles: Array<Omit<StitchTile, "id"> & { rasterBlob?: Blob }>,
  ) => void;
  /** Move tile(s) to the back (lowest layer). Pass one id or multiple. */
  sendTileToBack: (id: string) => void;
  sendTilesToBack: (ids: string[]) => void;
  /** Move tile(s) to the front (top layer). Pass one id or multiple. */
  bringTileToFront: (id: string) => void;
  bringTilesToFront: (ids: string[]) => void;
  /** Put these sheets in a new group and select it. No-op for fewer than two. */
  createGroup: (tileIds: string[]) => string | null;
  /** Add sheets to an existing group (they leave whatever group they were in). */
  addToGroup: (groupId: string, tileIds: string[]) => void;
  /** Take sheets out of their group; a group left with one member dissolves. */
  detachFromGroup: (tileIds: string[]) => void;
  /** Dissolve a whole group. */
  ungroup: (groupId: string) => void;
  /** Merge every group these sheets belong to (plus the sheets themselves) into one —
   *  what a completed align pair does. */
  mergeGroups: (tileIds: string[]) => string | null;
  /** ONE undo step for a completed "Align to neighbour" pair: move the sheets that
   *  moved AND merge the two sides into one group. Two calls would make a single
   *  alignment two undos, and the first would leave the sheets moved but ungrouped. */
  applyAlignedPair: (
    updates: Array<{ id: string; patch: Partial<Pick<StitchTile, "x" | "y" | "width" | "height" | "rotation">> }>,
    mergeTileIds: string[],
  ) => void;
  setSelectedTileId: (id: string | null) => void;
  setSelectedTileIds: (ids: string[]) => void;
  /** Toggle a tile in selection (for shift-click). Adds if not selected, removes if selected. */
  toggleTileInSelection: (id: string) => void;
  setPanOffset: (offset: { x: number; y: number }) => void;
  setZoomLevel: (level: number) => void;
  setCropRect: (rect: CropRect | null) => void;
  setCropToContent: (margin?: number) => void;
  /** Update a tile WITHOUT pushing an undo snapshot — use during continuous drag/resize. */
  updateTileNoUndo: (id: string, patch: Partial<Pick<StitchTile, "x" | "y" | "width" | "height" | "rotation" | "imageDataUrl" | "locked" | "sourceFileName" | "isScaleStamp" | "scaleStampFeetPerInch" | "imageModified" | "hiddenRegions" | "relocatedRegions">>) => void;
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

// ── tile rasters ────────────────────────────────────────────────────────────
//
// A committed sheet's raster is a Blob object URL kept in `tileRasters`, keyed
// by tile id, DELIBERATELY outside the tiles themselves and outside every undo
// snapshot: a snapshot is a shallow `{...t}` per tile, so a URL living on the
// tile would be copied into up to 50 snapshots and there would be no honest
// moment at which to revoke it.
//
// `tile.imageDataUrl` still exists and WINS when set. The two are not two
// copies of one thing — they are different things:
//   tileRasters[id]     the sheet as committed (blob:, revocable, not undone)
//   tile.imageDataUrl   an OVERRIDE — an erase result, a scale stamp, a cleanup
//                       crop, or a legacy tile — which lives on the tile
//                       precisely so undo restores it and reveals the original
//                       underneath again.
// Read both through `tileRasterUrl` (or the store selector in StitchTile);
// nothing should reach for either field on its own.

function createRasterUrl(blob: Blob): string | null {
  try {
    return URL.createObjectURL(blob);
  } catch {
    return null; // no object-URL support (jsdom, ancient webviews)
  }
}

function revokeRasterUrl(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* best-effort */
  }
}

/**
 * Drop (and revoke) every raster no live tile can reach.
 *
 * "Reachable" includes the undo and redo stacks: deleting a sheet and undoing
 * has to bring its image back, so a raster is only dead once no snapshot
 * mentions its tile either. A snapshot aging off the end of UNDO_MAX_SIZE can
 * therefore strand a URL until the next sweep, which is bounded and harmless.
 */
function pruneTileRasters(next: {
  tiles: StitchTile[];
  undoStack: StitchUndoSnapshot[];
  redoStack: StitchUndoSnapshot[];
  tileRasters: Record<string, string>;
}): Record<string, string> {
  const live = new Set<string>();
  for (const t of next.tiles) live.add(t.id);
  for (const snap of next.undoStack) for (const t of snap.tiles) live.add(t.id);
  for (const snap of next.redoStack) for (const t of snap.tiles) live.add(t.id);
  let dropped = false;
  const kept: Record<string, string> = {};
  for (const id of Object.keys(next.tileRasters)) {
    if (live.has(id)) kept[id] = next.tileRasters[id];
    else { revokeRasterUrl(next.tileRasters[id]); dropped = true; }
  }
  return dropped ? kept : next.tileRasters;
}

/**
 * The image a tile should draw: its own override if it has one, else the
 * committed sheet raster. Non-reactive (reads `getState`) — React components
 * that must re-render when a raster arrives should select `tileRasters[id]`
 * from the store instead.
 */
export function tileRasterUrl(tile: { id: string; imageDataUrl?: string }): string | undefined {
  return tile.imageDataUrl ?? useStitchStore.getState().tileRasters[tile.id];
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
  canvasSizeTouched: false,
  viewportWidth: 0,
  viewportHeight: 0,
  tileRasters: {},
  tiles: [],
  groups: {},
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

  setCanvasSize: (width, height, options) =>
    pushUndoAndSet(set, get, {
      canvasWidth: width,
      canvasHeight: height,
      canvasSizeTouched: options?.touched ?? true,
    }),

  // A pure measurement of the DOM, not document state: no undo snapshot, and a no-op write
  // is skipped so a ResizeObserver firing with the same size doesn't re-render the tree.
  setViewportSize: (width, height) =>
    set((state) =>
      state.viewportWidth === width && state.viewportHeight === height
        ? state
        : { viewportWidth: width, viewportHeight: height }
    ),

  // Screen position of a point is `panOffset + inner * zoom`, so holding a screen point S
  // fixed is pan' = S - (S - pan) * next/current. The ruler gutter is part of `inner` and
  // cancels out, which is why none of this needs to know about it.
  zoomAboutViewportCenter: (nextZoom) =>
    set((state) => {
      if (!(state.zoomLevel > 0) || !(nextZoom > 0)) return state;
      if (nextZoom === state.zoomLevel) return state;
      const sx = state.viewportWidth / 2;
      const sy = state.viewportHeight / 2;
      const ratio = nextZoom / state.zoomLevel;
      return {
        zoomLevel: nextZoom,
        panOffset: {
          x: sx - (sx - state.panOffset.x) * ratio,
          y: sy - (sy - state.panOffset.y) * ratio,
        },
      };
    }),

  /**
   * Size the page to the sheets: FIT_MARGIN_PT of paper on every side of the tiles' union
   * AABB, never smaller than the 8.5×11 default.
   *
   * The page rect is always drawn from (0, 0) — that is also how export treats it — so a
   * canvas alone cannot cover tiles at negative coordinates, and auto-align routinely
   * produces them. Rather than teach the page an origin, this SHIFTS every tile by
   * (−minX + margin, −minY + margin) when the content starts left of / above the margin,
   * then sizes the page to the shifted bounds. The composition is unchanged relatively;
   * only its offset from the paper origin moves. Tiles + canvas size + cropRect all move in
   * ONE undoable step, so a single undo puts everything back.
   */
  fitCanvasToTiles: () =>
    set((state) => {
      if (state.tiles.length === 0) return state;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const t of state.tiles) {
        const aabb = getTileAABB(t);
        minX = Math.min(minX, aabb.x);
        minY = Math.min(minY, aabb.y);
        maxX = Math.max(maxX, aabb.x + aabb.width);
        maxY = Math.max(maxY, aabb.y + aabb.height);
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY)) return state;

      const dx = minX < FIT_MARGIN_PT ? FIT_MARGIN_PT - minX : 0;
      const dy = minY < FIT_MARGIN_PT ? FIT_MARGIN_PT - minY : 0;
      const canvasWidth = Math.max(defaultSize.width, maxX + dx + FIT_MARGIN_PT);
      const canvasHeight = Math.max(defaultSize.height, maxY + dy + FIT_MARGIN_PT);

      const unchanged =
        dx === 0 &&
        dy === 0 &&
        canvasWidth === state.canvasWidth &&
        canvasHeight === state.canvasHeight;
      if (unchanged) return state;

      const snap = snapshotState(state);
      const tiles =
        dx === 0 && dy === 0
          ? state.tiles
          : state.tiles.map((t) => ({ ...t, x: t.x + dx, y: t.y + dy }));
      const cropRect =
        state.cropRect && (dx !== 0 || dy !== 0)
          ? { ...state.cropRect, x: state.cropRect.x + dx, y: state.cropRect.y + dy }
          : state.cropRect;
      return {
        tiles,
        cropRect,
        canvasWidth,
        canvasHeight,
        undoStack: [...state.undoStack, snap].slice(-UNDO_MAX_SIZE),
        redoStack: [],
      };
    }),

  addTiles: (newTiles) =>
    set((state) => {
      const snap = snapshotState(state);
      const rasters = { ...state.tileRasters };
      const added: StitchTile[] = [];
      for (const t of newTiles) {
        const { rasterBlob, ...tile } = t;
        const id = generateTileId();
        if (rasterBlob) {
          const url = createRasterUrl(rasterBlob);
          if (url) rasters[id] = url;
        }
        added.push({ ...tile, id });
      }
      return {
        tiles: [...state.tiles, ...added],
        tileRasters: rasters,
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

  setCleanupRegions: (id, hidden, relocated) =>
    pushUndoAndSet(set, get, {
      tiles: get().tiles.map((t) =>
        t.id === id ? { ...t, hiddenRegions: hidden, relocatedRegions: relocated } : t
      ),
    }),

  applyCleanupPromotion: (updates, newTiles) => {
    const created = newTiles.map((t) => ({ ...t, id: generateTileId() }));
    pushUndoAndSet(set, get, {
      tiles: [
        ...get().tiles.map((t) => {
          const u = updates.find((x) => x.id === t.id);
          // Promoted regions leave the source; clear any relocatedRegions there.
          return u ? { ...t, hiddenRegions: u.hiddenRegions, relocatedRegions: [] } : t;
        }),
        ...created,
      ],
      selectedTileIds: created.map((t) => t.id),
    });
  },

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
      // A group whose second sheet was just deleted is a group of one — dissolve it.
      const pruned = pruneGroups(state.tiles.filter((t) => t.id !== id), state.groups);
      const next = {
        tiles: pruned.tiles,
        groups: pruned.groups,
        selectedTileIds: state.selectedTileIds.filter((i) => i !== id),
        undoStack: [...state.undoStack, snap].slice(-UNDO_MAX_SIZE),
        redoStack: [],
      };
      return { ...next, tileRasters: pruneTileRasters({ ...next, tileRasters: state.tileRasters }) };
    }),

  removeTiles: (ids) =>
    set((state) => {
      if (ids.length === 0) return state;
      const snap = snapshotState(state);
      const remove = new Set(ids);
      const pruned = pruneGroups(state.tiles.filter((t) => !remove.has(t.id)), state.groups);
      const next = {
        tiles: pruned.tiles,
        groups: pruned.groups,
        selectedTileIds: state.selectedTileIds.filter((i) => !remove.has(i)),
        undoStack: [...state.undoStack, snap].slice(-UNDO_MAX_SIZE),
        redoStack: [],
      };
      return { ...next, tileRasters: pruneTileRasters({ ...next, tileRasters: state.tileRasters }) };
    }),

  /**
   * Remove + add as ONE undoable step. The removed tiles' rasters survive as long as
   * the snapshot that mentions them does — `pruneTileRasters` treats the undo stack as
   * reachable — so undoing the swap brings the grid back with its images.
   */
  replaceTiles: (removeIds, newTiles) =>
    set((state) => {
      const snap = snapshotState(state);
      const remove = new Set(removeIds);
      const rasters = { ...state.tileRasters };
      const added: StitchTile[] = [];
      for (const t of newTiles) {
        const { rasterBlob, ...tile } = t;
        const id = generateTileId();
        if (rasterBlob) {
          const url = createRasterUrl(rasterBlob);
          if (url) rasters[id] = url;
        }
        added.push({ ...tile, id });
      }
      const next = {
        tiles: [...state.tiles.filter((t) => !remove.has(t.id)), ...added],
        selectedTileIds: [],
        undoStack: [...state.undoStack, snap].slice(-UNDO_MAX_SIZE),
        redoStack: [],
      };
      return { ...next, tileRasters: pruneTileRasters({ ...next, tileRasters: rasters }) };
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

  createGroup: (tileIds) => {
    const state = get();
    const result = createGroupIn(state.tiles, state.groups, tileIds);
    if (!result.groupId) return null;
    pushUndoAndSet(set, get, {
      tiles: result.tiles,
      groups: result.groups,
      // Selecting the group it just made is the confirmation that it worked.
      selectedTileIds: result.tiles.filter((t) => t.groupId === result.groupId).map((t) => t.id),
    });
    return result.groupId;
  },

  addToGroup: (groupId, tileIds) => {
    const state = get();
    const result = addToGroupIn(state.tiles, state.groups, groupId, tileIds);
    pushUndoAndSet(set, get, {
      tiles: result.tiles,
      groups: result.groups,
      selectedTileIds: result.tiles.filter((t) => t.groupId === groupId).map((t) => t.id),
    });
  },

  detachFromGroup: (tileIds) => {
    const state = get();
    const result = detachFromGroupIn(state.tiles, state.groups, tileIds);
    pushUndoAndSet(set, get, { tiles: result.tiles, groups: result.groups });
  },

  ungroup: (groupId) => {
    const state = get();
    if (!state.groups[groupId]) return;
    const result = ungroupIn(state.tiles, state.groups, groupId);
    pushUndoAndSet(set, get, { tiles: result.tiles, groups: result.groups });
  },

  mergeGroups: (tileIds) => {
    const state = get();
    const result = mergeGroupsFor(state.tiles, state.groups, tileIds);
    if (!result.groupId) return null;
    pushUndoAndSet(set, get, { tiles: result.tiles, groups: result.groups });
    return result.groupId;
  },

  applyAlignedPair: (updates, mergeTileIds) => {
    const state = get();
    const byId = new Map(updates.map((u) => [u.id, u.patch]));
    const moved = state.tiles.map((t) => {
      const patch = byId.get(t.id);
      return patch ? { ...t, ...patch } : t;
    });
    const merged = mergeGroupsFor(moved, state.groups, mergeTileIds);
    pushUndoAndSet(set, get, { tiles: merged.tiles, groups: merged.groups });
  },

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
      const next = {
        ...snap,
        groups: snap.groups ?? {},
        selectedTileIds: [],
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [...state.redoStack, currentSnap],
      };
      return { ...next, tileRasters: pruneTileRasters({ ...next, tileRasters: state.tileRasters }) };
    }),

  redo: () =>
    set((state) => {
      if (state.redoStack.length === 0) return state;
      const snap = state.redoStack[state.redoStack.length - 1];
      const currentSnap = snapshotState(state);
      const next = {
        ...snap,
        groups: snap.groups ?? {},
        selectedTileIds: [],
        undoStack: [...state.undoStack, currentSnap].slice(-UNDO_MAX_SIZE),
        redoStack: state.redoStack.slice(0, -1),
      };
      return { ...next, tileRasters: pruneTileRasters({ ...next, tileRasters: state.tileRasters }) };
    }),

  canUndo: () => get().undoStack.length > 0,
  canRedo: () => get().redoStack.length > 0,

  reset: () =>
    set((state) => {
      for (const url of Object.values(state.tileRasters)) revokeRasterUrl(url);
      return resetState();
    }),
}));

/** The state a fresh stitch session starts from (see `reset`). */
function resetState(): Partial<StitchState> {
  return {
    canvasWidth: defaultSize.width,
    canvasHeight: defaultSize.height,
    canvasSizeTouched: false,
    tiles: [],
    tileRasters: {},
    groups: {},
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
  };
}

/**
 * The zoom floor every user-facing zoom-out must clamp to — the wheel handler, the toolbar's
 * zoom-out button and zoom-to-fit recenter. ONE definition on purpose: when they disagreed,
 * one of them would refuse to go where the others could.
 *
 * Derived, not stored, so it tracks the tiles and the viewport with no extra bookkeeping.
 */
export function selectEffectiveMinZoom(state: {
  tiles: StitchTile[];
  canvasWidth: number;
  canvasHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}): number {
  return effectiveMinZoomFor(
    contentBounds(state.tiles, state.canvasWidth, state.canvasHeight),
    state.viewportWidth,
    state.viewportHeight
  );
}
