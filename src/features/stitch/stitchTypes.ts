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
  /** True for generated scale bar stamps (no PDF source). */
  isScaleStamp?: boolean;
  /** Scale bar only: 1" = this many feet (e.g. 20). Used to render stamp at canonical size so bar is exactly 1". */
  scaleStampFeetPerInch?: number;
  /** Set to true when content-delete has modified this tile's image. Export will use raster instead of vector source. */
  imageModified?: boolean;
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
