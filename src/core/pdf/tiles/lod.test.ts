import { describe, expect, it } from "vitest";
import { TILE_SIZE, type PageDims, type PdfRect } from "./types";
import {
  lodForZoom,
  tileGridSize,
  tilePdfRect,
  tilePointSize,
  visibleTileKeys,
} from "./lod";

const SQUARE: PageDims = { widthPt: 512, heightPt: 512 };
const LETTER: PageDims = { widthPt: 612, heightPt: 792 };
const SHEET: PageDims = { widthPt: 36 * 72, heightPt: 48 * 72 }; // 36"x48"

describe("tilePointSize", () => {
  it("is the long-side length at LOD 0", () => {
    expect(tilePointSize(LETTER, 0)).toBe(792);
    expect(tilePointSize(SHEET, 0)).toBe(48 * 72);
  });

  it("halves with each LOD", () => {
    expect(tilePointSize(LETTER, 1)).toBe(396);
    expect(tilePointSize(LETTER, 2)).toBe(198);
    expect(tilePointSize(LETTER, 3)).toBe(99);
  });
});

describe("tileGridSize", () => {
  it("is 1x1 at LOD 0 for a square page", () => {
    expect(tileGridSize(SQUARE, 0)).toEqual({ cols: 1, rows: 1 });
  });

  it("is 2x2 at LOD 1 for a square page", () => {
    expect(tileGridSize(SQUARE, 1)).toEqual({ cols: 2, rows: 2 });
  });

  it("uses ceil for the short side of non-square pages", () => {
    // Letter at LOD 1: tilePt = 396. cols = ceil(612/396) = 2, rows = ceil(792/396) = 2
    expect(tileGridSize(LETTER, 1)).toEqual({ cols: 2, rows: 2 });
    // Letter at LOD 2: tilePt = 198. cols = ceil(612/198) = 4, rows = ceil(792/198) = 4
    expect(tileGridSize(LETTER, 2)).toEqual({ cols: 4, rows: 4 });
  });
});

describe("lodForZoom", () => {
  it("is 0 when one tile pixel covers >= one screen pixel", () => {
    // SHEET pageMax = 3456 pt. At displayPxPerPoint = 0.1 → screenPx = 345.6 < 512 → LOD 0
    expect(lodForZoom(SHEET, 0.1)).toBe(0);
  });

  it("grows by 1 each time zoom doubles", () => {
    // SHEET pageMax = 3456. At displayPxPerPoint = 1.0 → screenPx = 3456 → log2(3456/512) ≈ 2.755 → ceil = 3
    expect(lodForZoom(SHEET, 1.0)).toBe(3);
    // Doubling: 2.0 → screenPx = 6912 → log2(6912/512) ≈ 3.755 → ceil = 4
    expect(lodForZoom(SHEET, 2.0)).toBe(4);
    // Doubling: 4.0 → 5
    expect(lodForZoom(SHEET, 4.0)).toBe(5);
  });

  it("never returns negative LODs", () => {
    expect(lodForZoom(SHEET, 0.001)).toBe(0);
  });

  it("upshifts immediately when zooming in past a threshold", () => {
    // SHEET pageMax = 3456. At 1.0, LOD 3. At 2.0, LOD 4. Hysteresis only
    // applies on downshifts — zooming IN snaps to the higher LOD.
    const previousLod = 3;
    expect(lodForZoom(SHEET, 2.0, previousLod)).toBe(4);
  });

  it("sticks at the current LOD on small downward zoom dithers", () => {
    // At zoom 2.0, SHEET hits LOD 4 (screenPx = 6912). LOD 4's lower exit
    // boundary with 25% hysteresis is screenPx = 512 * 8 / 1.25 = 3276.8.
    // Dropping zoom from 2.0 to 1.0 → screenPx = 3456, still above 3276.8 →
    // stay at LOD 4 instead of falling back to 3.
    expect(lodForZoom(SHEET, 1.0, 4)).toBe(4);
  });

  it("drops down once the user is firmly past the boundary", () => {
    // From the same starting LOD 4, drop zoom to 0.9 → screenPx = 3110 <
    // 3276.8 → finally downshift. Without previousLod the natural answer
    // for screenPx=3110 is ceil(log2(3110/512)) = 3.
    expect(lodForZoom(SHEET, 0.9, 4)).toBe(3);
  });
});

describe("tilePdfRect", () => {
  it("returns the full page for the LOD-0 tile of a square page", () => {
    const rect: PdfRect = tilePdfRect(
      { docId: "d", page: 0, lod: 0, x: 0, y: 0 },
      SQUARE,
    );
    expect(rect).toEqual({ x: 0, y: 0, w: 512, h: 512 });
  });

  it("clips edge tiles to the page bounds", () => {
    // Letter at LOD 1: tilePt = 396. column 1 spans 396..792, but page ends at 612
    const edge: PdfRect = tilePdfRect(
      { docId: "d", page: 0, lod: 1, x: 1, y: 0 },
      LETTER,
    );
    expect(edge).toEqual({ x: 396, y: 0, w: 612 - 396, h: 396 });
  });
});

describe("visibleTileKeys", () => {
  it("returns a single tile when viewport is contained within one tile", () => {
    const viewport: PdfRect = { x: 100, y: 100, w: 50, h: 50 };
    const keys = visibleTileKeys("d", 0, SQUARE, 1, viewport);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ lod: 1, x: 0, y: 0 });
  });

  it("returns all tiles whose pdfRect intersects the viewport", () => {
    // Square page at LOD 1: 2x2 = 4 tiles, each 256pt. Viewport spanning the page returns all 4.
    const viewport: PdfRect = { x: 0, y: 0, w: 512, h: 512 };
    const keys = visibleTileKeys("d", 0, SQUARE, 1, viewport);
    expect(keys).toHaveLength(4);
    expect(keys.map((k) => `${k.x},${k.y}`).sort()).toEqual([
      "0,0",
      "0,1",
      "1,0",
      "1,1",
    ]);
  });

  it("clamps to the grid when viewport extends beyond the page", () => {
    const viewport: PdfRect = { x: -1000, y: -1000, w: 5000, h: 5000 };
    const keys = visibleTileKeys("d", 0, SQUARE, 1, viewport);
    expect(keys).toHaveLength(4);
  });
});

// Type-only check that TILE_SIZE is reachable through this module surface
void TILE_SIZE;
