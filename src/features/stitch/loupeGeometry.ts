/**
 * Pure maths for the align loupe: where the crop lives in page space, how big a
 * bitmap to ask mupdf for, where to park the magnifier so it never hides the
 * cursor, and which captured line feature a click should snap to.
 *
 * All of it is deliberately free of React, mupdf and the DOM — the loupe is the
 * part of "Align to neighbour" that has to be *right* (a half-pixel error here is
 * a foot on a 36x24 sheet at 1" = 20'), so it is the part that gets tested.
 *
 * Two coordinate frames are in play:
 *   • canvas units — the stitch canvas's own points (72 per inch of paper), the
 *     frame `CanvasPoint`, tile.x/y/width/height and the zoom all live in;
 *   • page points — mupdf's page space for the tile's source page.
 * A tile is a linear (possibly rotated, possibly rescaled) placement of its page,
 * so `tile.width / pageWidthPt` converts one to the other and `canvasToTileLocal`
 * takes the rotation out.
 */

import { canvasToTileLocal, tileLocalToCanvas, type CanvasPoint, type TilePose } from "./stitchGeometry";

/** Diameter of the magnifier, in screen pixels. */
export const LOUPE_SIZE_PX = 220;
/** Target render resolution for the crop. */
export const LOUPE_DPI = 300;
/** Never ask mupdf for a bitmap bigger than this on a side (memory budget). */
export const LOUPE_MAX_CROP_PX = 1024;
/** Click-to-line snap radius, in screen pixels. */
export const SNAP_RADIUS_PX = 6;

/** A rectangle in page points. */
export interface PageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The page's own size, in points. */
export interface PageSize {
  widthPt: number;
  heightPt: number;
}

/**
 * Canvas units per page point for a tile. Uniform in practice (tiles are sized
 * from the page's aspect), but averaged so a hand-resized tile still lands close.
 */
export function tileScaleFromPage(tile: TilePose, page: PageSize): number {
  if (!(page.widthPt > 0) || !(page.heightPt > 0)) return 1;
  return (tile.width / page.widthPt + tile.height / page.heightPt) / 2;
}

/**
 * A canvas-space point → the point on the tile's SOURCE PAGE, in page points.
 * Rotation is removed by `canvasToTileLocal`, so this works on aligned tiles too.
 */
export function canvasToPagePoint(
  point: CanvasPoint,
  tile: TilePose,
  page: PageSize
): CanvasPoint | null {
  const local = canvasToTileLocal(point, tile);
  if (!local) return null;
  if (!(tile.width > 0) || !(tile.height > 0)) return null;
  return {
    x: (local.u / tile.width) * page.widthPt,
    y: (local.v / tile.height) * page.heightPt,
  };
}

/**
 * How much the loupe magnifies, in screen px per canvas unit.
 *
 * Tied to the current zoom rather than fixed: at a fit-the-set zoom of 0.2 a fixed
 * 4x would still be a postage stamp, and at a zoomed-right-in 3x it would be no
 * magnification at all. 4x whatever the canvas is showing, floored so it is always
 * worth opening and ceilinged so the crop stays small.
 */
export function loupeMagnification(zoom: number): number {
  const wanted = (Number.isFinite(zoom) && zoom > 0 ? zoom : 1) * 4;
  return Math.min(16, Math.max(3, wanted));
}

/** The square of page the loupe shows, centred on the cursor. */
export function loupeCropRect(
  centrePagePt: CanvasPoint,
  tile: TilePose,
  page: PageSize,
  magnification: number,
  loupePx = LOUPE_SIZE_PX
): PageRect {
  const k = tileScaleFromPage(tile, page); // canvas units per page pt
  // loupePx / magnification = canvas units across the loupe; / k = page points.
  const sidePt = loupePx / Math.max(0.001, magnification) / Math.max(1e-6, k);
  return {
    x: centrePagePt.x - sidePt / 2,
    y: centrePagePt.y - sidePt / 2,
    width: sidePt,
    height: sidePt,
  };
}

/** What `PDFRenderer.renderPageCrop` needs: a page→device matrix and a device bbox. */
export interface CropRenderPlan {
  /** fz matrix [a,b,c,d,e,f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
  matrix: [number, number, number, number, number, number];
  /** Device-space rect to rasterise, always anchored at the origin. */
  bbox: [number, number, number, number];
  width: number;
  height: number;
  /** The dpi actually used — lowered from `dpi` when the cap bit. */
  dpi: number;
  /** Device pixels per page point (= dpi / 72). */
  pixelsPerPoint: number;
}

/**
 * Plan a crop render: scale to `dpi`, rotate by the tile's rotation so the loupe
 * shows the linework the same way up as the canvas does, and translate so ONLY the
 * crop rasterises (the bbox is the whole pixmap, so mupdf never touches the rest of
 * a 36x24 sheet — a full-page 300 dpi pixmap would be 311 MB).
 *
 * `maxPx` is the memory guard: a big crop drops its dpi rather than its coverage.
 */
export function planCropRender(
  crop: PageRect,
  dpi = LOUPE_DPI,
  rotationDeg = 0,
  maxPx = LOUPE_MAX_CROP_PX
): CropRenderPlan {
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // Axis-aligned extent of the rotated crop, in page points.
  const spanX = Math.abs(crop.width * cos) + Math.abs(crop.height * sin);
  const spanY = Math.abs(crop.width * sin) + Math.abs(crop.height * cos);
  const longestPt = Math.max(spanX, spanY, 1e-6);

  let scale = dpi / 72;
  if (longestPt * scale > maxPx) scale = maxPx / longestPt;
  const width = Math.max(1, Math.round(spanX * scale));
  const height = Math.max(1, Math.round(spanY * scale));

  const a = scale * cos;
  const b = scale * sin;
  const c = -scale * sin;
  const d = scale * cos;
  const cx = crop.x + crop.width / 2;
  const cy = crop.y + crop.height / 2;
  // Put the crop's centre at the pixmap's centre.
  const e = width / 2 - (a * cx + c * cy);
  const f = height / 2 - (b * cx + d * cy);

  return {
    matrix: [a, b, c, d, e, f],
    bbox: [0, 0, width, height],
    width,
    height,
    dpi: scale * 72,
    pixelsPerPoint: scale,
  };
}

/** Where to draw the crop bitmap inside the loupe, in screen px. */
export interface LoupeDrawPlan {
  /** Screen px per bitmap px. */
  drawScale: number;
  /** Top-left of the bitmap, relative to the loupe's top-left. */
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The crop's centre is the cursor and the bitmap's centre, so drawing is just
 * "centre the bitmap in the circle at the scale that makes `crop.width` fill it".
 */
export function loupeDrawPlan(
  crop: PageRect,
  plan: Pick<CropRenderPlan, "width" | "height" | "pixelsPerPoint">,
  loupePx = LOUPE_SIZE_PX
): LoupeDrawPlan {
  const cropPx = Math.max(1e-6, crop.width * plan.pixelsPerPoint);
  const drawScale = loupePx / cropPx;
  const width = plan.width * drawScale;
  const height = plan.height * drawScale;
  return {
    drawScale,
    left: loupePx / 2 - width / 2,
    top: loupePx / 2 - height / 2,
    width,
    height,
  };
}

export interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Park the loupe up and to the right of the cursor, flipping to the other side
 * whenever that would push it off the viewport — the one thing it must never do is
 * sit ON the cursor, because the cursor is what the user is aiming.
 */
export function placeLoupe(
  cursor: { x: number; y: number },
  viewport: Viewport,
  size = LOUPE_SIZE_PX,
  gap = 18
): { left: number; top: number } {
  const right = viewport.left + viewport.width;
  const bottom = viewport.top + viewport.height;

  let left = cursor.x + gap;
  if (left + size > right) left = cursor.x - gap - size;
  let top = cursor.y - gap - size;
  if (top < viewport.top) top = cursor.y + gap;

  // Still off the edge on a tiny viewport: clamp, but never back over the cursor.
  left = Math.min(Math.max(left, viewport.left), Math.max(viewport.left, right - size));
  top = Math.min(Math.max(top, viewport.top), Math.max(viewport.top, bottom - size));
  return { left, top };
}

// ─── Line snapping ──────────────────────────────────────────────────────────

/** One captured polyline: flat x,y pairs in page points (see `captureDevice`). */
export interface SnapPath {
  pts: Float32Array;
}

/**
 * Captured geometry in a uniform grid.
 *
 * A dense civil sheet keeps ~60 000 polylines. Scanning all of them on every cursor
 * sample — which is what the first cut did — is 60 000 bbox tests per mouse move, and
 * the pairwise intersection pass on top. The grid makes a query cost the cells the
 * 6 px window touches (one or two) plus the handful of segments in them, whatever the
 * sheet's size.
 *
 * Segments live in one flat array; each cell holds indices into it (CSR). A segment
 * whose bbox covers a silly number of cells — a full-width border, a match line — goes
 * into `oversize` instead of being written into every cell it crosses.
 */
export interface SnapIndex {
  /** x1,y1,x2,y2 per segment. */
  segs: Float32Array;
  /** Bit 1: the segment's start vertex is a polyline END. Bit 2: its end vertex is. */
  ends: Uint8Array;
  cell: number;
  minX: number;
  minY: number;
  cols: number;
  rows: number;
  /** CSR: cellStart[c]…cellStart[c+1] index into cellItems. */
  cellStart: Int32Array;
  cellItems: Int32Array;
  /** Segments too long to bucket; always considered. */
  oversize: Int32Array;
  /** Per-segment stamp, so a query dedupes without allocating a Set. */
  stamp: Int32Array;
  /** Bumped per query (a mutable box: the index is a plain object, not a class). */
  queryId: { v: number };
}

/** A segment covering more cells than this is treated as oversize. */
const MAX_CELLS_PER_SEGMENT = 64;
/** Target grid resolution on the long side of the page. */
const GRID_DIVISIONS = 128;

export function buildSnapIndex(paths: readonly SnapPath[]): SnapIndex {
  let segCount = 0;
  for (const p of paths) segCount += Math.max(0, p.pts.length / 2 - 1);

  const segs = new Float32Array(segCount * 4);
  const ends = new Uint8Array(segCount);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let n = 0;
  for (const p of paths) {
    const pts = p.pts;
    const last = pts.length / 2 - 1;
    for (let v = 0; v < last; v++) {
      const x1 = pts[v * 2], y1 = pts[v * 2 + 1], x2 = pts[v * 2 + 2], y2 = pts[v * 2 + 3];
      const at = n * 4;
      segs[at] = x1; segs[at + 1] = y1; segs[at + 2] = x2; segs[at + 3] = y2;
      ends[n] = (v === 0 ? 1 : 0) | (v === last - 1 ? 2 : 0);
      if (x1 < minX) minX = x1;
      if (x2 < minX) minX = x2;
      if (x1 > maxX) maxX = x1;
      if (x2 > maxX) maxX = x2;
      if (y1 < minY) minY = y1;
      if (y2 < minY) minY = y2;
      if (y1 > maxY) maxY = y1;
      if (y2 > maxY) maxY = y2;
      n++;
    }
  }
  if (n === 0) {
    return {
      segs, ends, cell: 1, minX: 0, minY: 0, cols: 1, rows: 1,
      cellStart: new Int32Array(2), cellItems: new Int32Array(0),
      oversize: new Int32Array(0), stamp: new Int32Array(0), queryId: { v: 0 },
    };
  }

  const cell = Math.max(1e-3, Math.max(maxX - minX, maxY - minY) / GRID_DIVISIONS);
  const cols = Math.max(1, Math.floor((maxX - minX) / cell) + 1);
  const rows = Math.max(1, Math.floor((maxY - minY) / cell) + 1);

  const cellOf = (v: number, min: number, count: number) =>
    Math.min(count - 1, Math.max(0, Math.floor((v - min) / cell)));

  // Pass 1: how many entries per cell, and which segments are oversize.
  const counts = new Int32Array(cols * rows + 1);
  const oversizeList: number[] = [];
  const spans = new Int32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const at = i * 4;
    const c0 = cellOf(Math.min(segs[at], segs[at + 2]), minX, cols);
    const c1 = cellOf(Math.max(segs[at], segs[at + 2]), minX, cols);
    const r0 = cellOf(Math.min(segs[at + 1], segs[at + 3]), minY, rows);
    const r1 = cellOf(Math.max(segs[at + 1], segs[at + 3]), minY, rows);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_CELLS_PER_SEGMENT) {
      oversizeList.push(i);
      spans[at] = -1;
      continue;
    }
    spans[at] = c0; spans[at + 1] = c1; spans[at + 2] = r0; spans[at + 3] = r1;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) counts[r * cols + c]++;
  }

  const cellStart = new Int32Array(cols * rows + 1);
  let running = 0;
  for (let i = 0; i < cols * rows; i++) {
    cellStart[i] = running;
    running += counts[i];
  }
  cellStart[cols * rows] = running;

  const fill = cellStart.slice();
  const cellItems = new Int32Array(running);
  for (let i = 0; i < n; i++) {
    const at = i * 4;
    if (spans[at] === -1) continue;
    for (let r = spans[at + 2]; r <= spans[at + 3]; r++) {
      for (let c = spans[at]; c <= spans[at + 1]; c++) cellItems[fill[r * cols + c]++] = i;
    }
  }

  return {
    segs, ends, cell, minX, minY, cols, rows, cellStart, cellItems,
    oversize: Int32Array.from(oversizeList),
    stamp: new Int32Array(n),
    queryId: { v: 0 },
  };
}

export type SnapKind = "endpoint" | "intersection";
export interface SnapHit {
  x: number;
  y: number;
  kind: SnapKind;
}

/** Segment (p1→p2) × (p3→p4) intersection, endpoints included. Null when parallel. */
function segmentIntersection(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number
): { x: number; y: number } | null {
  const d1x = x2 - x1, d1y = y2 - y1;
  const d2x = x4 - x3, d2y = y4 - y3;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-9) return null; // parallel or degenerate
  const t = ((x3 - x1) * d2y - (y3 - y1) * d2x) / den;
  const u = ((x3 - x1) * d1y - (y3 - y1) * d1x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: x1 + t * d1x, y: y1 + t * d1y };
}

/**
 * The line feature nearest `at` within `radius` (page points), or null.
 *
 * Only the grid cells the search window touches are visited, and intersections are
 * only computed between the segments those cells hold — so a click in an empty corner
 * of a 60 000-path sheet costs a handful of array reads.
 *
 * Endpoints win ties at equal distance: the end of a matchline is a far more
 * deliberate thing to click than the place two strokes happen to cross.
 */
export function findSnapPoint(
  index: SnapIndex,
  at: CanvasPoint,
  radius: number
): SnapHit | null {
  if (!(radius > 0) || index.stamp.length === 0) return null;
  const r2 = radius * radius;
  let best: SnapHit | null = null;
  let bestScore = Infinity;

  const consider = (x: number, y: number, kind: SnapKind) => {
    const d2 = (x - at.x) * (x - at.x) + (y - at.y) * (y - at.y);
    if (d2 > r2) return;
    const score = d2 + (kind === "intersection" ? 1e-6 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = { x, y, kind };
    }
  };

  const q = ++index.queryId.v;
  const near: number[] = [];
  const gather = (i: number) => {
    if (index.stamp[i] === q) return;
    index.stamp[i] = q;
    const a = i * 4;
    const x1 = index.segs[a], y1 = index.segs[a + 1], x2 = index.segs[a + 2], y2 = index.segs[a + 3];
    if (Math.min(x1, x2) - radius > at.x || Math.max(x1, x2) + radius < at.x) return;
    if (Math.min(y1, y2) - radius > at.y || Math.max(y1, y2) + radius < at.y) return;
    if (index.ends[i] & 1) consider(x1, y1, "endpoint");
    if (index.ends[i] & 2) consider(x2, y2, "endpoint");
    near.push(x1, y1, x2, y2);
  };

  const c0 = Math.max(0, Math.floor((at.x - radius - index.minX) / index.cell));
  const c1 = Math.min(index.cols - 1, Math.floor((at.x + radius - index.minX) / index.cell));
  const r0 = Math.max(0, Math.floor((at.y - radius - index.minY) / index.cell));
  const r1 = Math.min(index.rows - 1, Math.floor((at.y + radius - index.minY) / index.cell));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cellIndex = r * index.cols + c;
      for (let k = index.cellStart[cellIndex]; k < index.cellStart[cellIndex + 1]; k++) {
        gather(index.cellItems[k]);
      }
    }
  }
  for (let k = 0; k < index.oversize.length; k++) gather(index.oversize[k]);

  for (let i = 0; i + 3 < near.length; i += 4) {
    for (let j = i + 4; j + 3 < near.length; j += 4) {
      const hit = segmentIntersection(
        near[i], near[i + 1], near[i + 2], near[i + 3],
        near[j], near[j + 1], near[j + 2], near[j + 3]
      );
      if (hit) consider(hit.x, hit.y, "intersection");
    }
  }

  return best;
}

/** Snap radius in page points for a tile at the current zoom. */
export function snapRadiusPagePt(
  tile: TilePose,
  page: PageSize,
  zoom: number,
  radiusPx = SNAP_RADIUS_PX
): number {
  const k = tileScaleFromPage(tile, page);
  const screenPxPerPagePt = Math.max(1e-6, zoom * k);
  return radiusPx / screenPxPerPagePt;
}

/** A page point back to canvas space, for painting a snapped click. */
export function pagePointToCanvas(
  pagePoint: CanvasPoint,
  tile: TilePose,
  page: PageSize
): CanvasPoint {
  const u = (pagePoint.x / Math.max(1e-6, page.widthPt)) * tile.width;
  const v = (pagePoint.y / Math.max(1e-6, page.heightPt)) * tile.height;
  return tileLocalToCanvas(u, v, tile);
}
