/**
 * Shared types for the stitch PDF feature.
 */

export interface StitchTile {
  id: string;
  sourcePdfBytes: Uint8Array;
  sourcePageIndex: number;
  /** Original filename when added (for training export). */
  sourceFileName?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Rotation in degrees (0–360). */
  rotation?: number;
  imageDataUrl?: string;
  /** When true, tile cannot be moved, resized, or rotated until unlocked. */
  locked?: boolean;
}

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Snapshot of state for undo/redo (tiles are shallow-copied; refs for blobs/urls kept). */
export interface StitchUndoSnapshot {
  tiles: StitchTile[];
  canvasWidth: number;
  canvasHeight: number;
  cropRect: CropRect | null;
}
