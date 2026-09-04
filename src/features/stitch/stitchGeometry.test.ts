/**
 * Tiles rotate about their CENTER (DOM transformOrigin: center center).
 * All bounds math must use center-based rotation to match what's on screen.
 */

import { describe, expect, test } from "vitest";
import {
  canvasToTileLocal,
  computeAlignToNeighbour,
  computeResizedPose,
  computeTwoPointAlignment,
  contentBounds,
  effectiveMinZoomFor,
  fitZoomFor,
  getGroupBounds,
  getTileAABB,
  tileLocalToCanvas,
} from "./stitchGeometry";
import { ABSOLUTE_MIN_ZOOM, MIN_ZOOM } from "./stitchConstants";
import type { StitchTile } from "./stitchTypes";

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

describe("getTileAABB", () => {
  test("unrotated tile: AABB equals the tile rect", () => {
    const aabb = getTileAABB(makeTile({ x: 10, y: 20 }));
    expect(aabb).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  test("100x50 tile at origin rotated 90° about center occupies x∈[25,75], y∈[-25,75]", () => {
    const aabb = getTileAABB(makeTile({ rotation: 90 }));
    expect(aabb.x).toBeCloseTo(25, 6);
    expect(aabb.y).toBeCloseTo(-25, 6);
    expect(aabb.width).toBeCloseTo(50, 6);
    expect(aabb.height).toBeCloseTo(100, 6);
  });

  test("AABB contains all four corners mapped via tileLocalToCanvas", () => {
    const tile = makeTile({ x: 40, y: 30, rotation: 33 });
    const aabb = getTileAABB(tile);
    const corners = [
      tileLocalToCanvas(0, 0, tile),
      tileLocalToCanvas(tile.width, 0, tile),
      tileLocalToCanvas(tile.width, tile.height, tile),
      tileLocalToCanvas(0, tile.height, tile),
    ];
    for (const c of corners) {
      expect(c.x).toBeGreaterThanOrEqual(aabb.x - 1e-6);
      expect(c.x).toBeLessThanOrEqual(aabb.x + aabb.width + 1e-6);
      expect(c.y).toBeGreaterThanOrEqual(aabb.y - 1e-6);
      expect(c.y).toBeLessThanOrEqual(aabb.y + aabb.height + 1e-6);
    }
  });
});

describe("getGroupBounds", () => {
  test("rotated tile bounds use center-based rotation (matches the DOM)", () => {
    const bounds = getGroupBounds([makeTile({ rotation: 90 })]);
    expect(bounds.x).toBeCloseTo(25, 6);
    expect(bounds.y).toBeCloseTo(-25, 6);
    expect(bounds.width).toBeCloseTo(50, 6);
    expect(bounds.height).toBeCloseTo(100, 6);
  });

  test("union of a rotated and an unrotated tile", () => {
    const bounds = getGroupBounds([
      makeTile({ x: 0, y: 0 }),
      makeTile({ id: "t2", x: 200, y: 0, rotation: 90 }),
    ]);
    // unrotated: [0,100]x[0,50]; rotated about center (250,25): [225,275]x[-25,75]
    expect(bounds.x).toBeCloseTo(0, 6);
    expect(bounds.y).toBeCloseTo(-25, 6);
    expect(bounds.width).toBeCloseTo(275, 6);
    expect(bounds.height).toBeCloseTo(100, 6);
  });
});

describe("computeResizedPose", () => {
  const START = { width: 100, height: 50, x: 10, y: 20, rotation: 0, aspectRatio: 2 };

  test("rotation 0: east handle grows width, aspect-locked height, top-left fixed", () => {
    const pose = computeResizedPose({ ...START, dir: "e" }, 30, 0);
    expect(pose.width).toBeCloseTo(130, 6);
    expect(pose.height).toBeCloseTo(65, 6);
    expect(pose.x).toBeCloseTo(10, 6);
    expect(pose.y).toBeCloseTo(20, 6);
  });

  test("rotation 0: west handle keeps the right edge fixed", () => {
    const pose = computeResizedPose({ ...START, dir: "w" }, -10, 0);
    expect(pose.width).toBeCloseTo(110, 6);
    expect(pose.x + pose.width).toBeCloseTo(110, 6); // right edge was x+w = 110
    expect(pose.y).toBeCloseTo(20, 6);
  });

  test("rotation 0: corner uses the conservative min-axis uniform scale", () => {
    // Old behavior: scaleX = 1.3, scaleY = 1.1 → s = 1.1
    const pose = computeResizedPose({ ...START, dir: "se" }, 30, 5);
    expect(pose.width).toBeCloseTo(110, 6);
    expect(pose.height).toBeCloseTo(55, 6);
    expect(pose.x).toBeCloseTo(10, 6);
    expect(pose.y).toBeCloseTo(20, 6);
  });

  test("90° tile: east handle responds to the direction it points (canvas down)", () => {
    // CSS rotate(90) maps local +x to canvas +y, so the east handle points down.
    const start = { ...START, x: 0, y: 0, rotation: 90, dir: "e" };
    const pose = computeResizedPose(start, 0, 10); // drag straight down
    expect(pose.width).toBeCloseTo(110, 6);
    expect(pose.height).toBeCloseTo(55, 6);
  });

  test("rotated tile: the anchor corner stays fixed in canvas space", () => {
    const startTile = { x: 40, y: 30, width: 100, height: 50, rotation: 33 };
    const anchorBefore = tileLocalToCanvas(0, 0, startTile); // anchor for "se"
    const pose = computeResizedPose(
      { ...startTile, aspectRatio: 2, dir: "se" },
      17,
      9
    );
    const anchorAfter = tileLocalToCanvas(0, 0, { ...pose, rotation: 33 });
    expect(anchorAfter.x).toBeCloseTo(anchorBefore.x, 6);
    expect(anchorAfter.y).toBeCloseTo(anchorBefore.y, 6);
  });

  test("clamps to the minimum size, preserving aspect", () => {
    const pose = computeResizedPose({ ...START, dir: "e" }, -500, 0, 20);
    expect(pose.width).toBeGreaterThanOrEqual(20);
    expect(pose.height).toBeGreaterThanOrEqual(20);
    expect(pose.width / pose.height).toBeCloseTo(2, 6);
  });
});

describe("canvasToTileLocal / tileLocalToCanvas", () => {
  test("round-trip is identity for a rotated tile", () => {
    const tile = makeTile({ x: 12, y: 34, rotation: 217 });
    for (const [u, v] of [
      [0, 0],
      [100, 50],
      [37, 13],
    ]) {
      const c = tileLocalToCanvas(u, v, tile);
      const back = canvasToTileLocal(c, tile)!;
      expect(back.u).toBeCloseTo(u, 6);
      expect(back.v).toBeCloseTo(v, 6);
    }
  });
});

describe("contentBounds", () => {
  test("with no tiles it is exactly the canvas rect", () => {
    expect(contentBounds([], 612, 792)).toEqual({ x: 0, y: 0, width: 612, height: 792 });
  });

  test("a tile inside the canvas does not shrink the bounds", () => {
    const inside = makeTile({ x: 100, y: 100, width: 50, height: 50 });
    expect(contentBounds([inside], 612, 792)).toEqual({ x: 0, y: 0, width: 612, height: 792 });
  });

  test("tiles outside the canvas extend it in both directions", () => {
    const left = makeTile({ x: -200, y: -50, width: 100, height: 100 });
    const right = makeTile({ x: 900, y: 1000, width: 100, height: 100 });
    expect(contentBounds([left, right], 612, 792)).toEqual({
      x: -200,
      y: -50,
      width: 1200, // -200 → 1000
      height: 1150, // -50 → 1100
    });
  });

  test("rotation counts: the union uses the rotated AABB", () => {
    // 100x50 at (0,0) rotated 90° about its centre (50,25) occupies x∈[25,75], y∈[-0,50]
    const rotated = makeTile({ x: 0, y: 0, width: 100, height: 50, rotation: 90 });
    const aabb = getTileAABB(rotated);
    const bounds = contentBounds([rotated], 10, 10);
    expect(bounds.y).toBeCloseTo(Math.min(0, aabb.y), 6);
    expect(bounds.height).toBeCloseTo(Math.max(10, aabb.y + aabb.height) - bounds.y, 6);
  });
});

describe("fitZoomFor", () => {
  test("landscape content in a square viewport is limited by width", () => {
    // 1000x100 into 500x500 with 5% slack → 475/1000
    expect(fitZoomFor({ x: 0, y: 0, width: 1000, height: 100 }, 500, 500)).toBeCloseTo(0.475, 6);
  });

  test("portrait content in a square viewport is limited by height", () => {
    expect(fitZoomFor({ x: 0, y: 0, width: 100, height: 1000 }, 500, 500)).toBeCloseTo(0.475, 6);
  });

  test("the margin is slack on the viewport, not the content", () => {
    expect(fitZoomFor({ x: 0, y: 0, width: 100, height: 100 }, 200, 200, 0)).toBeCloseTo(2, 6);
    expect(fitZoomFor({ x: 0, y: 0, width: 100, height: 100 }, 200, 200, 0.5)).toBeCloseTo(1, 6);
  });

  test("an unmeasured viewport or degenerate bounds falls back to MIN_ZOOM", () => {
    expect(fitZoomFor({ x: 0, y: 0, width: 100, height: 100 }, 0, 0)).toBe(MIN_ZOOM);
    expect(fitZoomFor({ x: 0, y: 0, width: 0, height: 0 }, 500, 500)).toBe(MIN_ZOOM);
  });
});

describe("effectiveMinZoomFor", () => {
  test("small content never raises the floor above MIN_ZOOM", () => {
    // A tiny composition fits at zoom 4.75; half of that is still way above MIN_ZOOM.
    expect(effectiveMinZoomFor({ x: 0, y: 0, width: 100, height: 100 }, 500, 500)).toBe(MIN_ZOOM);
  });

  test("big content drops the floor to half the fit zoom", () => {
    // 10000x10000 into 500x500 → fit 0.0475, half = 0.02375 (above the absolute floor).
    expect(effectiveMinZoomFor({ x: 0, y: 0, width: 10000, height: 10000 }, 500, 500)).toBeCloseTo(
      0.02375,
      6
    );
  });

  test("never below ABSOLUTE_MIN_ZOOM, however huge the composition", () => {
    expect(effectiveMinZoomFor({ x: 0, y: 0, width: 5e6, height: 5e6 }, 500, 500)).toBe(
      ABSOLUTE_MIN_ZOOM
    );
  });

  test("an unmeasured viewport keeps the everyday floor", () => {
    expect(effectiveMinZoomFor({ x: 0, y: 0, width: 10000, height: 10000 }, 0, 0)).toBe(MIN_ZOOM);
  });
});

describe("computeAlignToNeighbour", () => {
  const moving = makeTile({ id: "m", x: 0, y: 0, width: 200, height: 100 });

  test("with Match scale off it is the existing two-point alignment, size untouched", () => {
    const movingPoints: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 20, y: 30 },
      { x: 160, y: 70 },
    ];
    const fixedPoints: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 500, y: 400 },
      { x: 610, y: 500 },
    ];
    const pose = computeAlignToNeighbour(moving, movingPoints, fixedPoints, false);
    const legacy = computeTwoPointAlignment(fixedPoints, moving, movingPoints);
    expect(pose.x).toBeCloseTo(legacy.x, 9);
    expect(pose.y).toBeCloseTo(legacy.y, 9);
    expect(pose.rotation).toBeCloseTo(legacy.rotation, 9);
    expect(pose.width).toBe(moving.width);
    expect(pose.height).toBe(moving.height);
  });

  test("lands the two clicked points exactly on the two target points", () => {
    const movingPoints: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 20, y: 30 },
      { x: 160, y: 70 },
    ];
    const fixedPoints: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 500, y: 400 },
      { x: 500 + Math.hypot(140, 40), y: 400 },
    ];
    const pose = computeAlignToNeighbour(moving, movingPoints, fixedPoints, false);
    const placed = { ...moving, ...pose };
    // A1 must sit on B1 …
    const local1 = canvasToTileLocal(movingPoints[0], moving)!;
    const at1 = tileLocalToCanvas(local1.u, local1.v, placed);
    expect(at1.x).toBeCloseTo(fixedPoints[0].x, 6);
    expect(at1.y).toBeCloseTo(fixedPoints[0].y, 6);
    // … and A2 on B2, because the two spans are the same length here.
    const local2 = canvasToTileLocal(movingPoints[1], moving)!;
    const at2 = tileLocalToCanvas(local2.u, local2.v, placed);
    expect(at2.x).toBeCloseTo(fixedPoints[1].x, 6);
    expect(at2.y).toBeCloseTo(fixedPoints[1].y, 6);
  });

  test("Match scale resizes uniformly so both points land", () => {
    const movingPoints: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 50, y: 50 },
      { x: 150, y: 50 },
    ];
    // Target span is 200 — twice the 100 clicked on the moving sheet.
    const fixedPoints: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 400, y: 300 },
      { x: 600, y: 300 },
    ];
    const pose = computeAlignToNeighbour(moving, movingPoints, fixedPoints, true);
    expect(pose.width).toBeCloseTo(400, 6);
    expect(pose.height).toBeCloseTo(200, 6);
    const placed = { ...moving, ...pose };
    const l1 = canvasToTileLocal(movingPoints[0], moving)!;
    const at1 = tileLocalToCanvas(l1.u * 2, l1.v * 2, placed);
    expect(at1.x).toBeCloseTo(400, 6);
    expect(at1.y).toBeCloseTo(300, 6);
    const l2 = canvasToTileLocal(movingPoints[1], moving)!;
    const at2 = tileLocalToCanvas(l2.u * 2, l2.v * 2, placed);
    expect(at2.x).toBeCloseTo(600, 6);
    expect(at2.y).toBeCloseTo(300, 6);
  });

  test("works from an already rotated tile", () => {
    const rotated = makeTile({ id: "r", x: 10, y: 20, width: 200, height: 100, rotation: 37 });
    const movingPoints: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 40, y: 60 },
      { x: 120, y: 90 },
    ];
    const fixedPoints: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 900, y: 100 },
      { x: 900 + Math.hypot(80, 30), y: 100 },
    ];
    const pose = computeAlignToNeighbour(rotated, movingPoints, fixedPoints, false);
    const placed = { ...rotated, ...pose };
    const l1 = canvasToTileLocal(movingPoints[0], rotated)!;
    const at1 = tileLocalToCanvas(l1.u, l1.v, placed);
    expect(at1.x).toBeCloseTo(900, 6);
    expect(at1.y).toBeCloseTo(100, 6);
  });

  test("two coincident clicks leave the tile exactly where it was", () => {
    const pose = computeAlignToNeighbour(
      moving,
      [{ x: 10, y: 10 }, { x: 10, y: 10 }],
      [{ x: 500, y: 500 }, { x: 600, y: 500 }],
      true
    );
    expect(pose).toEqual({ x: 0, y: 0, width: 200, height: 100, rotation: 0 });
  });
});
