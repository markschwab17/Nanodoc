/**
 * The exported PDF must look exactly like the editor canvas.
 * Invariant: for any tile pose and any tile-local point (u, v), the point's
 * position in PDF page space (computed from the export pose, pdf-lib
 * semantics: translate → rotate CCW → draw with y-up local coords) must equal
 * the y-flip of its canvas-space position (CSS semantics: rotate CW about
 * tile center, y-down).
 */

import { describe, expect, test } from "vitest";
import { pdfPoseForTile, tileIntersectsCrop } from "./stitchExport";
import { tileLocalToCanvas } from "./stitchGeometry";
import type { StitchTile } from "./stitchTypes";

type Pose = { x: number; y: number; rotationDeg: number };

/** Where pdf-lib puts tile-local point (u, v) when drawing with this pose. */
function pdfPointForLocal(
  pose: Pose,
  tile: Pick<StitchTile, "width" | "height">,
  u: number,
  v: number
): { x: number; y: number } {
  const rad = (pose.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // pdf-lib draws page content with y-up local coords
  const lu = u;
  const lv = tile.height - v;
  return {
    x: pose.x + lu * cos - lv * sin,
    y: pose.y + lu * sin + lv * cos,
  };
}

/** Where the editor shows tile-local point (u, v), flipped into PDF page coords. */
function expectedPdfPoint(
  tile: StitchTile,
  u: number,
  v: number,
  cropX: number,
  cropY: number,
  cropH: number
): { x: number; y: number } {
  const c = tileLocalToCanvas(u, v, tile);
  return { x: c.x - cropX, y: cropH - (c.y - cropY) };
}

function makeTile(partial: Partial<StitchTile>): StitchTile {
  return {
    id: "t1",
    sourcePdfBytes: new Uint8Array(0),
    sourcePageIndex: 0,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    ...partial,
  };
}

const SAMPLE_POINTS: Array<[number, number]> = [
  [0, 0], // top-left
  [100, 0], // top-right
  [0, 50], // bottom-left
  [20, 10], // arbitrary interior
];

describe("pdfPoseForTile", () => {
  test("unrotated tile maps local points to flipped canvas points", () => {
    const tile = makeTile({ x: 30, y: 40 });
    const pose = pdfPoseForTile(tile, 0, 0, 200);
    for (const [u, v] of SAMPLE_POINTS) {
      const actual = pdfPointForLocal(pose, tile, u, v);
      const expected = expectedPdfPoint(tile, u, v, 0, 0, 200);
      expect(actual.x).toBeCloseTo(expected.x, 6);
      expect(actual.y).toBeCloseTo(expected.y, 6);
    }
  });

  test("tile rotated 30° exports with the same apparent rotation as the editor", () => {
    const tile = makeTile({ x: 30, y: 40, rotation: 30 });
    const pose = pdfPoseForTile(tile, 0, 0, 200);
    for (const [u, v] of SAMPLE_POINTS) {
      const actual = pdfPointForLocal(pose, tile, u, v);
      const expected = expectedPdfPoint(tile, u, v, 0, 0, 200);
      expect(actual.x).toBeCloseTo(expected.x, 6);
      expect(actual.y).toBeCloseTo(expected.y, 6);
    }
  });

  test("tile rotated 90° exports with the same apparent rotation as the editor", () => {
    const tile = makeTile({ rotation: 90 });
    const pose = pdfPoseForTile(tile, 0, 0, 200);
    for (const [u, v] of SAMPLE_POINTS) {
      const actual = pdfPointForLocal(pose, tile, u, v);
      const expected = expectedPdfPoint(tile, u, v, 0, 0, 200);
      expect(actual.x).toBeCloseTo(expected.x, 6);
      expect(actual.y).toBeCloseTo(expected.y, 6);
    }
  });

  test("rotated tile overlapping the crop only via its rotated footprint is included", () => {
    // 100x50 at origin rotated 90° about center occupies x∈[25,75], y∈[-25,75].
    // This crop overlaps that footprint but NOT the unrotated rect (y∈[0,50]).
    const tile = makeTile({ rotation: 90 });
    expect(tileIntersectsCrop(tile, 0, -20, 80, 10)).toBe(true);
    // And a crop overlapping the unrotated rect but not the rotated footprint is excluded.
    expect(tileIntersectsCrop(tile, 80, 0, 15, 50)).toBe(false);
  });

  test("rotation mapping holds under a crop offset", () => {
    const tile = makeTile({ x: 120, y: 80, rotation: 215 });
    const [cropX, cropY, cropH] = [50, 60, 300];
    const pose = pdfPoseForTile(tile, cropX, cropY, cropH);
    for (const [u, v] of SAMPLE_POINTS) {
      const actual = pdfPointForLocal(pose, tile, u, v);
      const expected = expectedPdfPoint(tile, u, v, cropX, cropY, cropH);
      expect(actual.x).toBeCloseTo(expected.x, 6);
      expect(actual.y).toBeCloseTo(expected.y, 6);
    }
  });
});
