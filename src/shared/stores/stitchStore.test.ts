/**
 * Stitch store behaviors that have bitten us: crop-to-content must account for
 * center-based tile rotation, and batch removal must be one undo step.
 */

import { beforeEach, describe, expect, test } from "vitest";
import { useStitchStore } from "./stitchStore";
import type { StitchTile } from "@/features/stitch/stitchTypes";

function makeTile(partial: Partial<StitchTile>): StitchTile {
  return {
    id: `t_${Math.random().toString(36).slice(2)}`,
    sourcePdfBytes: new Uint8Array(0),
    sourcePageIndex: 0,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    ...partial,
  };
}

beforeEach(() => {
  useStitchStore.getState().reset();
});

describe("setCropToContent", () => {
  test("covers the rotated footprint of a rotated tile", () => {
    // 100x50 at (100,100) rotated 90° about center (150,125)
    // occupies x∈[125,175], y∈[75,175].
    useStitchStore.setState({ tiles: [makeTile({ x: 100, y: 100, rotation: 90 })] });
    useStitchStore.getState().setCropToContent(0);
    const crop = useStitchStore.getState().cropRect!;
    expect(crop.x).toBeCloseTo(125, 6);
    expect(crop.y).toBeCloseTo(75, 6);
    expect(crop.w).toBeCloseTo(50, 6);
    expect(crop.h).toBeCloseTo(100, 6);
  });

  test("crop right/bottom edges are clamped to the canvas, not just the width", () => {
    const { canvasWidth } = useStitchStore.getState();
    // Tile hangs off the right edge of the canvas.
    useStitchStore.setState({ tiles: [makeTile({ x: canvasWidth - 40 })] });
    useStitchStore.getState().setCropToContent(0);
    const crop = useStitchStore.getState().cropRect!;
    expect(crop.x + crop.w).toBeLessThanOrEqual(canvasWidth);
  });
});

describe("removeTiles", () => {
  test("removes multiple tiles as a single undo step", () => {
    const a = makeTile({});
    const b = makeTile({});
    const c = makeTile({});
    useStitchStore.setState({ tiles: [a, b, c], undoStack: [], redoStack: [] });
    useStitchStore.getState().removeTiles([a.id, c.id]);
    const state = useStitchStore.getState();
    expect(state.tiles.map((t) => t.id)).toEqual([b.id]);
    expect(state.undoStack.length).toBe(1);
    state.undo();
    expect(useStitchStore.getState().tiles.length).toBe(3);
  });

  test("clears removed ids from the selection", () => {
    const a = makeTile({});
    const b = makeTile({});
    useStitchStore.setState({ tiles: [a, b], selectedTileIds: [a.id, b.id] });
    useStitchStore.getState().removeTiles([a.id]);
    expect(useStitchStore.getState().selectedTileIds).toEqual([b.id]);
  });
});
