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

/** Captured geometry plus a per-path bounding box, so a search is a bbox scan. */
export interface SnapIndex {
  paths: readonly SnapPath[];
  /** minX, minY, maxX, maxY per path, 4 floats each. */
  bboxes: Float32Array;
}

export type SnapKind = "endpoint" | "intersection";
export interface SnapHit {
  x: number;
  y: number;
  kind: SnapKind;
}

export function buildSnapIndex(paths: readonly SnapPath[]): SnapIndex {
  const bboxes = new Float32Array(paths.length * 4);
  for (let i = 0; i < paths.length; i++) {
    const pts = paths[i].pts;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k + 1 < pts.length; k += 2) {
      const x = pts[k], y = pts[k + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    bboxes[i * 4] = minX;
    bboxes[i * 4 + 1] = minY;
    bboxes[i * 4 + 2] = maxX;
    bboxes[i * 4 + 3] = maxY;
  }
  return { paths, bboxes };
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
 * Endpoints win ties at equal distance — the end of a matchline is a far more
 * deliberate thing to click than the place two strokes happen to cross — and only
 * segments whose path bbox reaches the search window are considered, which is what
 * keeps this cheap on a sheet with 60 000 captured paths.
 */
export function findSnapPoint(
  index: SnapIndex,
  at: CanvasPoint,
  radius: number
): SnapHit | null {
  if (!(radius > 0)) return null;
  const r2 = radius * radius;
  let best: SnapHit | null = null;
  let bestScore = Infinity;

  /** Endpoints beat intersections at the same distance. */
  const consider = (x: number, y: number, kind: SnapKind) => {
    const d2 = (x - at.x) * (x - at.x) + (y - at.y) * (y - at.y);
    if (d2 > r2) return;
    const score = d2 + (kind === "intersection" ? 1e-6 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = { x, y, kind };
    }
  };

  // Segments near the cursor, collected once and reused for the intersection pass.
  const near: number[] = [];
  for (let i = 0; i < index.paths.length; i++) {
    const b = i * 4;
    if (
      index.bboxes[b] - radius > at.x ||
      index.bboxes[b + 2] + radius < at.x ||
      index.bboxes[b + 1] - radius > at.y ||
      index.bboxes[b + 3] + radius < at.y
    ) {
      continue;
    }
    const pts = index.paths[i].pts;
    if (pts.length < 4) continue;
    consider(pts[0], pts[1], "endpoint");
    consider(pts[pts.length - 2], pts[pts.length - 1], "endpoint");
    for (let k = 0; k + 3 < pts.length; k += 2) {
      const x1 = pts[k], y1 = pts[k + 1], x2 = pts[k + 2], y2 = pts[k + 3];
      // Keep only segments whose own bbox reaches the window.
      if (Math.min(x1, x2) - radius > at.x || Math.max(x1, x2) + radius < at.x) continue;
      if (Math.min(y1, y2) - radius > at.y || Math.max(y1, y2) + radius < at.y) continue;
      near.push(x1, y1, x2, y2);
    }
  }

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
