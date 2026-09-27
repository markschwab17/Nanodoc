/**
 * The erase mask: which pixels of a sheet the user erased, recovered from the
 * tile's stored raster alone — no erase history needed, so it covers sheets
 * erased before this code existed and survives undo/redo and saves unchanged.
 *
 * The stored raster is the page rendered at `tileRenderScale` with the erase
 * tools' result baked in as alpha 0. Alpha 0 on its own is ambiguous (with
 * "remove white background" every blank pixel is alpha 0 too), so the mask is
 * built against a fresh REFERENCE render of the untouched source page on the
 * same pixel grid:
 *
 *   NONE    (0)  the reference has no ink here (blank, white, clipped away)
 *   KEPT    (1)  ink in the reference, still visible in the stored raster
 *   ERASED  (2)  ink in the reference, alpha 0 in the stored raster
 *
 * Only ERASED pixels can remove vector content, and a path is judged only on
 * the samples that land on ink — so linework hidden under a wipeout or clipped
 * out by a CAD viewport is never mistaken for erased.
 *
 * Pure. Exported for tests.
 */

export const STATE_NONE = 0;
export const STATE_KEPT = 1;
export const STATE_ERASED = 2;

/** A channel below this is "ink" (matches the white-removal threshold, 248). */
export const INK_THRESHOLD = 248;

/** Side, in pixels, of the coarse cells used to reject untouched regions fast. */
export const CELL_PX = 16;

export interface EraseMask {
  width: number;
  height: number;
  /** One STATE_* per pixel, row-major. */
  state: Uint8Array;
  erasedCount: number;
  keptCount: number;
  cellsX: number;
  cellsY: number;
  /** ERASED pixels per CELL_PX×CELL_PX cell. */
  cellErased: Uint32Array;
  /** Bounding box of every ERASED pixel (inclusive); empty when erasedCount is 0. */
  erasedBox: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Build the mask. `stored` is RGBA (width×height); `ref` is the reference render
 * with `refComps` components per pixel (3 = RGB, 4 = RGBA, 1 = gray) at
 * refW×refH — normally the same grid, but a one-pixel rounding difference
 * between renderers is absorbed by nearest-neighbour sampling.
 */
export function buildEraseMask(
  stored: ArrayLike<number>,
  width: number,
  height: number,
  ref: ArrayLike<number>,
  refW: number,
  refH: number,
  refComps: number
): EraseMask {
  const state = new Uint8Array(width * height);
  const cellsX = Math.ceil(width / CELL_PX);
  const cellsY = Math.ceil(height / CELL_PX);
  const cellErased = new Uint32Array(cellsX * cellsY);
  let erasedCount = 0;
  let keptCount = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const colorComps = refComps >= 3 ? 3 : 1;
  for (let y = 0; y < height; y++) {
    const ry = refH === height ? y : Math.min(refH - 1, Math.floor(((y + 0.5) * refH) / height));
    for (let x = 0; x < width; x++) {
      const rx = refW === width ? x : Math.min(refW - 1, Math.floor(((x + 0.5) * refW) / width));
      const ri = (ry * refW + rx) * refComps;
      let ink = false;
      for (let k = 0; k < colorComps; k++) if (ref[ri + k] < INK_THRESHOLD) { ink = true; break; }
      if (ink && refComps === 4 && ref[ri + 3] === 0) ink = false;
      if (!ink) continue;
      const p = y * width + x;
      if (stored[p * 4 + 3] === 0) {
        state[p] = STATE_ERASED;
        erasedCount++;
        cellErased[Math.floor(y / CELL_PX) * cellsX + Math.floor(x / CELL_PX)]++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      } else {
        state[p] = STATE_KEPT;
        keptCount++;
      }
    }
  }
  return {
    width, height, state, erasedCount, keptCount, cellsX, cellsY, cellErased,
    erasedBox: { x0, y0, x1, y1 },
  };
}

/** True when any ERASED pixel may lie in the pixel box (inclusive, clamped). */
export function anyErasedIn(mask: EraseMask, bx0: number, by0: number, bx1: number, by1: number): boolean {
  if (mask.erasedCount === 0) return false;
  const eb = mask.erasedBox;
  if (bx1 < eb.x0 || bx0 > eb.x1 || by1 < eb.y0 || by0 > eb.y1) return false;
  const cx0 = Math.max(0, Math.floor(bx0 / CELL_PX));
  const cy0 = Math.max(0, Math.floor(by0 / CELL_PX));
  const cx1 = Math.min(mask.cellsX - 1, Math.floor(bx1 / CELL_PX));
  const cy1 = Math.min(mask.cellsY - 1, Math.floor(by1 / CELL_PX));
  for (let cy = cy0; cy <= cy1; cy++) {
    const row = cy * mask.cellsX;
    for (let cx = cx0; cx <= cx1; cx++) if (mask.cellErased[row + cx] > 0) return true;
  }
  return false;
}

/**
 * State under a point in pixel space. The pixel containing the point decides;
 * when it has no ink (a hairline between pixel centres, a renderer rounding
 * the other way), the 4-neighbourhood votes, ties going to KEPT so doubt never
 * deletes anything.
 */
export function sampleState(mask: EraseMask, x: number, y: number): number {
  const px = Math.floor(x);
  const py = Math.floor(y);
  const w = mask.width;
  const h = mask.height;
  if (px < 0 || py < 0 || px >= w || py >= h) return STATE_NONE;
  const s = mask.state[py * w + px];
  if (s !== STATE_NONE) return s;
  let kept = 0, erased = 0;
  if (px > 0) { const v = mask.state[py * w + px - 1]; if (v === 1) kept++; else if (v === 2) erased++; }
  if (px + 1 < w) { const v = mask.state[py * w + px + 1]; if (v === 1) kept++; else if (v === 2) erased++; }
  if (py > 0) { const v = mask.state[(py - 1) * w + px]; if (v === 1) kept++; else if (v === 2) erased++; }
  if (py + 1 < h) { const v = mask.state[(py + 1) * w + px]; if (v === 1) kept++; else if (v === 2) erased++; }
  if (erased > kept) return STATE_ERASED;
  if (kept > 0) return STATE_KEPT;
  return STATE_NONE;
}
