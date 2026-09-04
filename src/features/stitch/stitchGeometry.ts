/**
 * Geometry helpers for stitch canvas (bounds, etc.).
 * Point-alignment uses center-based rotation to match StitchTile (transformOrigin: center center).
 */

import type { StitchTile } from "./stitchTypes";
import { ABSOLUTE_MIN_ZOOM, FIT_VIEWPORT_MARGIN, MIN_ZOOM, PT_PER_INCH } from "./stitchConstants";

/** Canvas point (e.g. from clientToCanvas). */
export interface CanvasPoint {
  x: number;
  y: number;
}

/** Minimal tile pose required by the geometry helpers. */
export type TilePose = Pick<StitchTile, "x" | "y" | "width" | "height" | "rotation">;

/**
 * Map a canvas-space point to a tile's local coordinates (origin top-left, same as tile width/height).
 * Uses rotation around tile center to match DOM transformOrigin: center center.
 */
export function canvasToTileLocal(
  canvasPoint: CanvasPoint,
  tile: TilePose
): { u: number; v: number } | null {
  const w = tile.width;
  const h = tile.height;
  const cx = tile.x + w / 2;
  const cy = tile.y + h / 2;
  const dx = canvasPoint.x - cx;
  const dy = canvasPoint.y - cy;
  const R = ((tile.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(R);
  const sin = Math.sin(R);
  const newDx = dx * cos + dy * sin;
  const newDy = -dx * sin + dy * cos;
  const u = w / 2 + newDx;
  const v = h / 2 + newDy;
  return { u, v };
}

/**
 * Map a tile-local point (u, v) to canvas space for a tile with given pose.
 * Uses rotation around tile center.
 */
export function tileLocalToCanvas(
  u: number,
  v: number,
  tile: TilePose
): CanvasPoint {
  const w = tile.width;
  const h = tile.height;
  const cx = tile.x + w / 2;
  const cy = tile.y + h / 2;
  const relU = u - w / 2;
  const relV = v - h / 2;
  const R = ((tile.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(R);
  const sin = Math.sin(R);
  return {
    x: cx + relU * cos - relV * sin,
    y: cy + relU * sin + relV * cos,
  };
}

/**
 * Hit-test: find the first tile (in reverse draw order = top-most first) that contains the canvas point.
 * Returns tile and canvas point, or null if no tile hit.
 */
export function hitTestTileAtPoint(
  canvasPoint: CanvasPoint,
  tiles: StitchTile[],
  /** If true, iterate tiles in reverse order (top-most first). Default true. */
  topMostFirst = true
): { tile: StitchTile; point: CanvasPoint } | null {
  const order = topMostFirst ? [...tiles].reverse() : tiles;
  for (const tile of order) {
    const local = canvasToTileLocal(canvasPoint, tile);
    if (!local) continue;
    const { u, v } = local;
    if (u >= 0 && u <= tile.width && v >= 0 && v <= tile.height) {
      return { tile, point: canvasPoint };
    }
  }
  return null;
}

/**
 * Compute new (x, y, rotation) for the target tile so that two point pairs align:
 * target's local points (at B1, B2 in current pose) map to reference canvas points A1, A2.
 * Uses center-based rotation.
 */
export function computeTwoPointAlignment(
  referencePoints: [CanvasPoint, CanvasPoint],
  targetTile: StitchTile,
  targetPointsCanvas: [CanvasPoint, CanvasPoint]
): { x: number; y: number; rotation: number } {
  const [A1, A2] = referencePoints;
  const [B1, B2] = targetPointsCanvas;
  const local1 = canvasToTileLocal(B1, targetTile);
  const local2 = canvasToTileLocal(B2, targetTile);
  if (!local1 || !local2) {
    return { x: targetTile.x, y: targetTile.y, rotation: targetTile.rotation ?? 0 };
  }
  const { u: u1, v: v1 } = local1;
  const { u: u2, v: v2 } = local2;
  const w = targetTile.width;
  const h = targetTile.height;

  const dxA = A2.x - A1.x;
  const dyA = A2.y - A1.y;
  const du = u2 - u1;
  const dv = v2 - v1;
  const R_rad = Math.atan2(dyA, dxA) - Math.atan2(dv, du);
  let R_deg = (R_rad * 180) / Math.PI;
  R_deg = ((R_deg % 360) + 360) % 360;
  if (R_deg > 180) R_deg -= 360;

  const cos = Math.cos(R_rad);
  const sin = Math.sin(R_rad);
  const relU1 = u1 - w / 2;
  const relV1 = v1 - h / 2;
  const centerX = A1.x - (relU1 * cos - relV1 * sin);
  const centerY = A1.y - (relU1 * sin + relV1 * cos);
  const x = centerX - w / 2;
  const y = centerY - h / 2;

  return { x, y, rotation: R_deg };
}

/**
 * "Align to neighbour": the moving tile's two clicked points are carried onto the two
 * points clicked on the fixed sheet.
 *
 * Same two-point maths as `computeTwoPointAlignment` (the moving tile is the target and
 * the fixed sheet's points are the reference), with ONE addition: when `matchScale` is
 * on the tile is also scaled uniformly so the two distances match. Scale is a real
 * decision — a sheet plotted at a different scale must be resized, a sheet plotted at
 * the same scale must NOT be — so it is a toggle, off by default, and with it off this
 * returns exactly what `computeTwoPointAlignment` returns plus the unchanged size.
 *
 * Derivation: the tile maps local (u,v) to canvas as
 *   canvas = centre + R·(s·(u - w0/2), s·(v - h0/2))
 * with s the uniform scale (1 when `matchScale` is off) — the rotation is unchanged by
 * a uniform scale, so R comes from the two directions exactly as before, and the centre
 * falls out of pinning the first point.
 */
export function computeAlignToNeighbour(
  movingTile: TilePose,
  movingPointsCanvas: [CanvasPoint, CanvasPoint],
  fixedPointsCanvas: [CanvasPoint, CanvasPoint],
  matchScale = false
): { x: number; y: number; width: number; height: number; rotation: number } {
  const w0 = movingTile.width;
  const h0 = movingTile.height;
  const unchanged = {
    x: movingTile.x,
    y: movingTile.y,
    width: w0,
    height: h0,
    rotation: movingTile.rotation ?? 0,
  };

  const local1 = canvasToTileLocal(movingPointsCanvas[0], movingTile);
  const local2 = canvasToTileLocal(movingPointsCanvas[1], movingTile);
  if (!local1 || !local2) return unchanged;
  const du = local2.u - local1.u;
  const dv = local2.v - local1.v;
  const localLen = Math.hypot(du, dv);
  const [B1, B2] = fixedPointsCanvas;
  const refLen = Math.hypot(B2.x - B1.x, B2.y - B1.y);
  // Two coincident clicks say nothing about rotation or scale — leave the tile alone
  // rather than divide by zero and fling it off the canvas.
  if (localLen <= 0 || refLen <= 0) return unchanged;

  const scale = matchScale ? refLen / localLen : 1;
  const R_rad = Math.atan2(B2.y - B1.y, B2.x - B1.x) - Math.atan2(dv, du);
  let R_deg = (R_rad * 180) / Math.PI;
  R_deg = ((R_deg % 360) + 360) % 360;
  if (R_deg > 180) R_deg -= 360;

  const width = w0 * scale;
  const height = h0 * scale;
  const cos = Math.cos(R_rad);
  const sin = Math.sin(R_rad);
  const relU = (local1.u - w0 / 2) * scale;
  const relV = (local1.v - h0 / 2) * scale;
  const centerX = B1.x - (relU * cos - relV * sin);
  const centerY = B1.y - (relU * sin + relV * cos);

  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
    rotation: R_deg,
  };
}

/**
 * How far the SECOND point misses, in feet, after an "Align to neighbour" move.
 *
 * The first point lands exactly (the transform pins it), and the rotation makes the
 * two spans parallel — so everything the move could not reconcile shows up as the
 * difference in LENGTH between the span the user drew on the moving sheet and the span
 * they drew on the fixed one. That is a measurement of THIS interaction, taken after
 * the move, not a stale figure from whatever the auto-aligner last thought about the
 * pair.
 *
 * Canvas units are points and a canvas inch is `feetPerInch` feet of ground (every
 * tile is sized to the composition's reference scale at commit), so the conversion is
 * one division.
 *
 * Meaningless when **Match scale** is on: the scale is then chosen to make the two
 * spans equal, so this is 0 by construction and the caller must not show it.
 */
export function seamMissFt(
  movingPoints: [CanvasPoint, CanvasPoint],
  fixedPoints: [CanvasPoint, CanvasPoint],
  feetPerInch: number
): number {
  const moved = distance(movingPoints[0], movingPoints[1]);
  const target = distance(fixedPoints[0], fixedPoints[1]);
  return (Math.abs(moved - target) / PT_PER_INCH) * feetPerInch;
}

/**
 * Distance between two canvas points.
 */
export function distance(a: CanvasPoint, b: CanvasPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.hypot(dx, dy);
}

/**
 * Compute new (x, y, width, height) for the target tile so that the distance between
 * the two target points matches the reference length. Scale is applied from the tile center.
 */
export function computeScaleAlignment(
  referenceLength: number,
  targetTile: StitchTile,
  targetPointsCanvas: [CanvasPoint, CanvasPoint]
): { x: number; y: number; width: number; height: number } {
  const [B1, B2] = targetPointsCanvas;
  const currentLength = distance(B1, B2);
  if (currentLength <= 0) {
    return {
      x: targetTile.x,
      y: targetTile.y,
      width: targetTile.width,
      height: targetTile.height,
    };
  }
  const scale = referenceLength / currentLength;
  const newWidth = targetTile.width * scale;
  const newHeight = targetTile.height * scale;
  const cx = targetTile.x + targetTile.width / 2;
  const cy = targetTile.y + targetTile.height / 2;
  return {
    x: cx - newWidth / 2,
    y: cy - newHeight / 2,
    width: newWidth,
    height: newHeight,
  };
}

/**
 * Axis-aligned bounding box of a tile in canvas space, accounting for
 * center-based rotation (matches DOM transformOrigin: center center).
 */
export function getTileAABB(
  tile: TilePose
): { x: number; y: number; width: number; height: number } {
  const corners = [
    tileLocalToCanvas(0, 0, tile),
    tileLocalToCanvas(tile.width, 0, tile),
    tileLocalToCanvas(tile.width, tile.height, tile),
    tileLocalToCanvas(0, tile.height, tile),
  ];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const c of corners) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x);
    maxY = Math.max(maxY, c.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export interface ResizeStart {
  /** Handle direction: n, e, s, w, ne, nw, se, sw. */
  dir: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  aspectRatio: number;
}

/**
 * Compute the new tile pose for a resize drag, rotation-aware.
 *
 * Pointer deltas are mapped into tile-local axes (so the "e" handle always
 * responds to motion along the direction it points), and the corner opposite
 * the handle stays fixed in CANVAS space. At rotation 0 this matches the
 * historical axis-aligned behavior exactly.
 */
export function computeResizedPose(
  start: ResizeStart,
  dxCanvas: number,
  dyCanvas: number,
  minSize = 20
): { x: number; y: number; width: number; height: number } {
  const { dir, width: w0, height: h0, aspectRatio: ar } = start;
  const rotation = start.rotation ?? 0;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  // Pointer delta in tile-local axes (inverse rotation)
  const localDx = dxCanvas * cos + dyCanvas * sin;
  const localDy = -dxCanvas * sin + dyCanvas * cos;

  let width: number;
  let height: number;
  if (dir === "e" || dir === "w") {
    width = dir === "e" ? Math.max(minSize, w0 + localDx) : Math.max(minSize, w0 - localDx);
    height = width / ar;
    if (height < minSize) {
      height = minSize;
      width = height * ar;
    }
  } else if (dir === "n" || dir === "s") {
    height = dir === "s" ? Math.max(minSize, h0 + localDy) : Math.max(minSize, h0 - localDy);
    width = height * ar;
    if (width < minSize) {
      width = minSize;
      height = width / ar;
    }
  } else {
    const scaleX = dir.includes("e") ? (w0 + localDx) / w0 : (w0 - localDx) / w0;
    const scaleY = dir.includes("s") ? (h0 + localDy) / h0 : (h0 - localDy) / h0;
    const minScale = Math.max(minSize / w0, minSize / h0);
    const s = Math.max(minScale, Math.min(scaleX, scaleY));
    width = w0 * s;
    height = h0 * s;
  }

  // The corner opposite the handle is the anchor; it must not move on canvas.
  const anchorU0 = dir.includes("w") ? w0 : 0;
  const anchorV0 = dir.includes("n") ? h0 : 0;
  const anchorCanvas = tileLocalToCanvas(anchorU0, anchorV0, start);

  const anchorU1 = dir.includes("w") ? width : 0;
  const anchorV1 = dir.includes("n") ? height : 0;
  const relU = anchorU1 - width / 2;
  const relV = anchorV1 - height / 2;
  const centerX = anchorCanvas.x - (relU * cos - relV * sin);
  const centerY = anchorCanvas.y - (relU * sin + relV * cos);

  return {
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
  };
}

export function getGroupBounds(
  tiles: StitchTile[]
): { x: number; y: number; width: number; height: number } {
  if (tiles.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const t of tiles) {
    const aabb = getTileAABB(t);
    minX = Math.min(minX, aabb.x);
    minY = Math.min(minY, aabb.y);
    maxX = Math.max(maxX, aabb.x + aabb.width);
    maxY = Math.max(maxY, aabb.y + aabb.height);
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/** A rectangle in canvas space. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Everything the user should be able to see: the canvas page rect UNION every
 * tile's AABB (rotation included). Tiles routinely sit outside the page — a
 * plan set auto-aligned onto an 8.5×11 default spills far past it — and a view
 * that only ever fits the page would hide them.
 *
 * Deliberately NOT the same as `contentExportBounds` in stitchExport.ts: this is
 * about what the viewport shows, export semantics are their own thing.
 */
export function contentBounds(
  tiles: TilePose[],
  canvasWidth: number,
  canvasHeight: number
): Bounds {
  let minX = 0;
  let minY = 0;
  let maxX = canvasWidth;
  let maxY = canvasHeight;
  for (const t of tiles) {
    const aabb = getTileAABB(t);
    minX = Math.min(minX, aabb.x);
    minY = Math.min(minY, aabb.y);
    maxX = Math.max(maxX, aabb.x + aabb.width);
    maxY = Math.max(maxY, aabb.y + aabb.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * The zoom at which `bounds` exactly fits a viewport, leaving `margin` (a
 * fraction of the viewport, split between the two sides) as slack.
 *
 * Returns MIN_ZOOM when there is nothing measurable to fit against — an
 * unmeasured viewport (width/height 0 before layout) or degenerate bounds — so
 * callers get the everyday floor rather than 0 or Infinity.
 */
export function fitZoomFor(
  bounds: Bounds,
  viewportWidth: number,
  viewportHeight: number,
  margin: number = FIT_VIEWPORT_MARGIN
): number {
  if (!(viewportWidth > 0) || !(viewportHeight > 0)) return MIN_ZOOM;
  if (!(bounds.width > 0) || !(bounds.height > 0)) return MIN_ZOOM;
  const availableWidth = viewportWidth * (1 - margin);
  const availableHeight = viewportHeight * (1 - margin);
  const zoom = Math.min(availableWidth / bounds.width, availableHeight / bounds.height);
  return Number.isFinite(zoom) && zoom > 0 ? zoom : MIN_ZOOM;
}

/**
 * The lower zoom bound the UI should enforce right now.
 *
 * MIN_ZOOM (0.25) is fine for a single page, but Mark's complaint was that with
 * a set of huge plan sheets placed you "cannot zoom far enough out to see all
 * the pages" — 0.25 is nowhere near enough. So the floor drops to HALF the
 * fit-the-whole-composition zoom (half, so you can always pull back visibly
 * further than a plain fit), never rising above MIN_ZOOM and never falling
 * below ABSOLUTE_MIN_ZOOM.
 */
export function effectiveMinZoomFor(
  bounds: Bounds,
  viewportWidth: number,
  viewportHeight: number,
  margin: number = FIT_VIEWPORT_MARGIN
): number {
  if (!(viewportWidth > 0) || !(viewportHeight > 0)) return MIN_ZOOM;
  const fit = fitZoomFor(bounds, viewportWidth, viewportHeight, margin);
  return Math.min(MIN_ZOOM, Math.max(ABSOLUTE_MIN_ZOOM, fit * 0.5));
}
