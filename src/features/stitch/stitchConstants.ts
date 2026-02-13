/**
 * Shared constants for the stitch PDF feature.
 */

const PT_PER_INCH = 72;

export const CANVAS_PRESETS = [
  { label: "8.5 × 11\"", width: 8.5 * PT_PER_INCH, height: 11 * PT_PER_INCH },
  { label: "11 × 17\"", width: 11 * PT_PER_INCH, height: 17 * PT_PER_INCH },
  { label: "17 × 22\"", width: 17 * PT_PER_INCH, height: 22 * PT_PER_INCH },
  { label: "24 × 36\"", width: 24 * PT_PER_INCH, height: 36 * PT_PER_INCH },
] as const;

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 10;
export const ZOOM_STEP = 0.25;
export const ZOOM_DELTA = 1.05;
export const SCROLL_SENSITIVITY = 1.0;

export const HANDLE_SIZE = 18;
export const RESIZE_CURSORS: Record<string, string> = {
  nw: "nwse-resize",
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize",
};

export const MIN_ERASE_SIZE = 5;
/** Min distance (canvas px) between points when recording stroke. */
export const STROKE_POINT_MIN_DIST = 2;

export const DELETE_ELEMENT_COLOR_TOLERANCE = 125;
/** Offsets (canvas px) so we hit thin lines/SVG paths that pass between path points. */
export const STROKE_BRUSH_OFFSETS: Array<[number, number]> = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export const UNDO_MAX_SIZE = 50;
