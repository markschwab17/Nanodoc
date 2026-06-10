/**
 * Tiles rotate about their CENTER (DOM transformOrigin: center center).
 * All bounds math must use center-based rotation to match what's on screen.
 */

import { describe, expect, test } from "vitest";
import {
  canvasToTileLocal,
  computeResizedPose,
  getGroupBounds,
  getTileAABB,
  tileLocalToCanvas,
} from "./stitchGeometry";
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
