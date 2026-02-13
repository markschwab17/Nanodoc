/**
 * Geometry helpers for stitch canvas (bounds, etc.).
 * Point-alignment uses center-based rotation to match StitchTile (transformOrigin: center center).
 */

import type { StitchTile } from "./stitchTypes";

/** Canvas point (e.g. from clientToCanvas). */
export interface CanvasPoint {
  x: number;
  y: number;
}

/**
 * Map a canvas-space point to a tile's local coordinates (origin top-left, same as tile width/height).
 * Uses rotation around tile center to match DOM transformOrigin: center center.
 */
export function canvasToTileLocal(
  canvasPoint: CanvasPoint,
  tile: StitchTile
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
  tile: StitchTile
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

export function getGroupBounds(
  tiles: StitchTile[]
): { x: number; y: number; width: number; height: number } {
  if (tiles.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const t of tiles) {
    const r = (t.rotation ?? 0) * (Math.PI / 180);
    const c = Math.cos(r),
      s = Math.sin(r);
    const w = t.width,
      h = t.height;
    const corners = [
      [t.x, t.y],
      [t.x + w * c, t.y + w * s],
      [t.x + w * c - h * s, t.y + w * s + h * c],
      [t.x - h * s, t.y + h * c],
    ];
    for (const [px, py] of corners) {
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}
