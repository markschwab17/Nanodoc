/**
 * Stitch store behaviors that have bitten us: crop-to-content must account for
 * center-based tile rotation, and batch removal must be one undo step.
 */

import { beforeEach, describe, expect, test } from "vitest";
import { useStitchStore, selectEffectiveMinZoom } from "./stitchStore";
import { CANVAS_PRESETS, FIT_MARGIN_PT, MIN_ZOOM } from "@/features/stitch/stitchConstants";
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

describe("canvasSizeTouched", () => {
  test("starts false and is set by a size the user picks", () => {
    expect(useStitchStore.getState().canvasSizeTouched).toBe(false);
    useStitchStore.getState().setCanvasSize(1224, 1584);
    expect(useStitchStore.getState().canvasSizeTouched).toBe(true);
  });

  test("a size set FOR the user does not count as a choice", () => {
    useStitchStore.getState().setCanvasSize(1224, 1584, { touched: false });
    expect(useStitchStore.getState().canvasSizeTouched).toBe(false);
  });

  test("reset clears it", () => {
    useStitchStore.getState().setCanvasSize(1224, 1584);
    useStitchStore.getState().reset();
    expect(useStitchStore.getState().canvasSizeTouched).toBe(false);
  });
});

describe("fitCanvasToTiles", () => {
  test("no tiles: no-op", () => {
    const before = useStitchStore.getState();
    useStitchStore.getState().fitCanvasToTiles();
    const after = useStitchStore.getState();
    expect(after.canvasWidth).toBe(before.canvasWidth);
    expect(after.canvasHeight).toBe(before.canvasHeight);
    expect(after.undoStack).toHaveLength(0);
  });

  test("grows the page to wrap the sheets with a margin each side", () => {
    useStitchStore.getState().addTiles([
      makeTile({ x: 100, y: 100, width: 2000, height: 1500 }),
    ]);
    useStitchStore.getState().fitCanvasToTiles();
    const s = useStitchStore.getState();
    // Content already starts past the margin, so nothing moves.
    expect(s.tiles[0].x).toBe(100);
    expect(s.canvasWidth).toBe(2100 + FIT_MARGIN_PT);
    expect(s.canvasHeight).toBe(1600 + FIT_MARGIN_PT);
  });

  test("shifts tiles off negative coordinates instead of giving the page an origin", () => {
    useStitchStore.getState().addTiles([
      makeTile({ x: -500, y: -200, width: 1000, height: 800 }),
      makeTile({ x: 0, y: 0, width: 1000, height: 800 }),
    ]);
    useStitchStore.getState().fitCanvasToTiles();
    const s = useStitchStore.getState();
    // dx = 36 - (-500) = 536, dy = 36 - (-200) = 236
    expect(s.tiles[0].x).toBe(FIT_MARGIN_PT);
    expect(s.tiles[0].y).toBe(FIT_MARGIN_PT);
    expect(s.tiles[1].x).toBe(536);
    expect(s.tiles[1].y).toBe(236);
    // Relative geometry is untouched.
    expect(s.tiles[1].x - s.tiles[0].x).toBe(500);
    expect(s.canvasWidth).toBe(536 + 1000 + FIT_MARGIN_PT);
    expect(s.canvasHeight).toBe(236 + 800 + FIT_MARGIN_PT);
  });

  test("never smaller than the 8.5x11 default", () => {
    useStitchStore.getState().addTiles([makeTile({ x: 100, y: 100, width: 10, height: 10 })]);
    useStitchStore.getState().fitCanvasToTiles();
    const s = useStitchStore.getState();
    expect(s.canvasWidth).toBe(CANVAS_PRESETS[0].width);
    expect(s.canvasHeight).toBe(CANVAS_PRESETS[0].height);
  });

  test("shift + resize is ONE undo step", () => {
    useStitchStore.getState().addTiles([makeTile({ x: -500, y: -200, width: 1000, height: 800 })]);
    const undoDepth = useStitchStore.getState().undoStack.length;
    useStitchStore.getState().fitCanvasToTiles();
    expect(useStitchStore.getState().undoStack).toHaveLength(undoDepth + 1);
    useStitchStore.getState().undo();
    const s = useStitchStore.getState();
    expect(s.tiles[0].x).toBe(-500);
    expect(s.canvasWidth).toBe(CANVAS_PRESETS[0].width);
  });

  test("is idempotent — a second call changes nothing and adds no undo step", () => {
    useStitchStore.getState().addTiles([makeTile({ x: -500, y: -200, width: 1000, height: 800 })]);
    useStitchStore.getState().fitCanvasToTiles();
    const depth = useStitchStore.getState().undoStack.length;
    const width = useStitchStore.getState().canvasWidth;
    const x = useStitchStore.getState().tiles[0].x;
    useStitchStore.getState().fitCanvasToTiles();
    expect(useStitchStore.getState().undoStack).toHaveLength(depth);
    expect(useStitchStore.getState().canvasWidth).toBe(width);
    expect(useStitchStore.getState().tiles[0].x).toBe(x);
  });
});

describe("selectEffectiveMinZoom", () => {
  test("an unmeasured viewport keeps the everyday floor", () => {
    expect(selectEffectiveMinZoom(useStitchStore.getState())).toBe(MIN_ZOOM);
  });

  test("sheets far outside the page drop the floor below MIN_ZOOM", () => {
    useStitchStore.getState().setViewportSize(900, 600);
    expect(selectEffectiveMinZoom(useStitchStore.getState())).toBe(MIN_ZOOM);
    useStitchStore.getState().addTiles([makeTile({ x: 0, y: 0, width: 20000, height: 15000 })]);
    const floor = selectEffectiveMinZoom(useStitchStore.getState());
    expect(floor).toBeLessThan(MIN_ZOOM);
    expect(floor).toBeGreaterThanOrEqual(0.02);
  });
});
