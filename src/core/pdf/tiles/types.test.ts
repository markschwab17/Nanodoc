import { describe, expect, it } from "vitest";
import { tileKeyEqual, tileKeyString, TILE_SIZE, type TileKey } from "./types";

describe("TILE_SIZE", () => {
  it("is 512", () => {
    expect(TILE_SIZE).toBe(512);
  });
});

describe("tileKeyString", () => {
  it("formats key as docId/page/lod/x_y", () => {
    const key: TileKey = { docId: "abc123", page: 7, lod: 3, x: 2, y: 4 };
    expect(tileKeyString(key)).toBe("abc123/7/3/2_4");
  });

  it("is stable across identical inputs", () => {
    const a: TileKey = { docId: "d", page: 1, lod: 0, x: 0, y: 0 };
    const b: TileKey = { docId: "d", page: 1, lod: 0, x: 0, y: 0 };
    expect(tileKeyString(a)).toBe(tileKeyString(b));
  });

  it("differs when any field differs", () => {
    const base: TileKey = { docId: "d", page: 1, lod: 0, x: 0, y: 0 };
    expect(tileKeyString({ ...base, docId: "e" })).not.toBe(tileKeyString(base));
    expect(tileKeyString({ ...base, page: 2 })).not.toBe(tileKeyString(base));
    expect(tileKeyString({ ...base, lod: 1 })).not.toBe(tileKeyString(base));
    expect(tileKeyString({ ...base, x: 1 })).not.toBe(tileKeyString(base));
    expect(tileKeyString({ ...base, y: 1 })).not.toBe(tileKeyString(base));
  });
});

describe("tileKeyEqual", () => {
  it("returns true for structurally identical keys", () => {
    const a: TileKey = { docId: "d", page: 1, lod: 0, x: 0, y: 0 };
    const b: TileKey = { docId: "d", page: 1, lod: 0, x: 0, y: 0 };
    expect(tileKeyEqual(a, b)).toBe(true);
  });

  it("returns false when any field differs", () => {
    const a: TileKey = { docId: "d", page: 1, lod: 0, x: 0, y: 0 };
    expect(tileKeyEqual(a, { ...a, x: 1 })).toBe(false);
  });
});
