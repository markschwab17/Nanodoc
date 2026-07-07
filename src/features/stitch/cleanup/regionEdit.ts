/**
 * Pure fraction-rect geometry for editing Clean-up hide-regions in the review.
 * Rects are FRACTIONS (0..1) of the tile — resize/scale-invariant, matching how
 * regions are stored and applied. No DOM/canvas here so it is unit-testable; the
 * pointer wiring in CleanupReview converts canvas deltas → fraction deltas and
 * calls these.
 */
export interface FRect { x: number; y: number; w: number; h: number; }
export type ResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** Clamp a fraction rect fully inside [0,1], flooring each axis to a minimum size. */
export function clampRegion(r: FRect, minW: number, minH: number): FRect {
  const w = Math.min(1, Math.max(minW, r.w));
  const h = Math.min(1, Math.max(minH, r.h));
  const x = Math.min(Math.max(0, r.x), 1 - w);
  const y = Math.min(Math.max(0, r.y), 1 - h);
  return { x, y, w, h };
}

/** Translate by a fraction delta; size preserved, position clamped inside the tile. */
export function moveRegion(r: FRect, dx: number, dy: number): FRect {
  return clampRegion({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }, r.w, r.h);
}

/** Resize by dragging `handle` a fraction delta (dx,dy). Opposite edge(s) fixed,
 *  min size enforced on the dragged edge, all edges clamped to [0,1]. */
export function resizeRegion(r: FRect, handle: ResizeHandle, dx: number, dy: number, minW: number, minH: number): FRect {
  let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
  const west = handle.includes("w"), east = handle.includes("e");
  const north = handle.includes("n"), south = handle.includes("s");
  if (west) x0 = Math.max(0, r.x + dx);
  if (east) x1 = Math.min(1, r.x + r.w + dx);
  if (north) y0 = Math.max(0, r.y + dy);
  if (south) y1 = Math.min(1, r.y + r.h + dy);
  if (x1 - x0 < minW) { if (west) x0 = x1 - minW; else if (east) x1 = x0 + minW; }
  if (y1 - y0 < minH) { if (north) y0 = y1 - minH; else if (south) y1 = y0 + minH; }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Immutably remove the region at `index`. */
export function deleteAt<T>(regions: T[], index: number): T[] {
  return regions.filter((_, i) => i !== index);
}

/** Clamp a relocation offset (fractions) so `rect` shifted by it stays fully
 *  inside the tile: x0+dx ∈ [0, 1−w], y0+dy ∈ [0, 1−h]. */
export function clampOffset(r: FRect, dx: number, dy: number): { dx: number; dy: number } {
  return {
    dx: Math.min(Math.max(dx, -r.x), 1 - r.w - r.x),
    dy: Math.min(Math.max(dy, -r.y), 1 - r.h - r.y),
  };
}
