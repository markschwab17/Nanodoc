/**
 * The tile-raster size cap. Two properties matter and both are load-bearing:
 * the long edge never exceeds TILE_LONG_EDGE_PX (memory), and NO side ever
 * reaches WebKit's 4096-px canvas ceiling, past which `toDataURL` returns the
 * string "data:," and the tile silently renders blank.
 */
import { describe, it, expect } from "vitest";
import {
  tileRenderScale,
  TILE_RENDER_SCALE,
  TILE_LONG_EDGE_PX,
  CANVAS_MAX_SIDE_PX,
} from "./rasterEncode";

/** Common architectural / civil sheet sizes, in points (72 pt = 1 in). */
const SHEETS: Array<[string, number, number]> = [
  ["letter 8.5x11", 612, 792],
  ["tabloid 11x17", 792, 1224],
  ["ARCH C 18x24", 1296, 1728],
  ["ARCH D 24x36", 1728, 2592],
  ["36x24 landscape", 2592, 1728],
  ["ARCH E 30x42", 2160, 3024],
  ["ARCH E1 30x42 landscape", 3024, 2160],
  ["oversize 48x60", 3456, 4320],
];

describe("tileRenderScale", () => {
  it("leaves small pages at the full 1.5x", () => {
    expect(tileRenderScale(612, 792)).toBe(TILE_RENDER_SCALE);
    expect(tileRenderScale(792, 1224)).toBe(TILE_RENDER_SCALE);
  });

  it("caps a 36x24 in sheet's long edge at 3072 px", () => {
    const s = tileRenderScale(2592, 1728);
    expect(s).toBeCloseTo(3072 / 2592, 6);
    expect(2592 * s).toBeCloseTo(TILE_LONG_EDGE_PX, 6);
    expect(1728 * s).toBeCloseTo(2048, 6);
  });

  it("never lets any side reach the WebKit 4096-px canvas ceiling", () => {
    for (const [, w, h] of SHEETS) {
      const s = tileRenderScale(w, h);
      expect(Math.max(w, h) * s).toBeLessThanOrEqual(TILE_LONG_EDGE_PX + 1e-9);
      expect(w * s).toBeLessThan(CANVAS_MAX_SIDE_PX);
      expect(h * s).toBeLessThan(CANVAS_MAX_SIDE_PX);
    }
  });

  it("puts a 30x42 in sheet back under the ceiling it used to cross at 1.5x", () => {
    // 3024 pt * 1.5 = 4536 px — over the 4096 side limit, where WebKit returns
    // an empty image with no error at all.
    expect(3024 * TILE_RENDER_SCALE).toBeGreaterThan(CANVAS_MAX_SIDE_PX);
    expect(3024 * tileRenderScale(2160, 3024)).toBeLessThanOrEqual(TILE_LONG_EDGE_PX + 1e-9);
  });

  it("falls back to 1.5x on a degenerate page size rather than dividing by zero", () => {
    expect(tileRenderScale(0, 0)).toBe(TILE_RENDER_SCALE);
    expect(tileRenderScale(Number.NaN, Number.NaN)).toBe(TILE_RENDER_SCALE);
  });
});
