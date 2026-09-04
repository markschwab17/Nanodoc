/**
 * The tile-raster side slice: object URLs kept off the tiles (and therefore out
 * of the undo snapshots), revoked only once nothing — live tile, undo stack or
 * redo stack — can bring the tile back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useStitchStore, tileRasterUrl } from "./stitchStore";
import { UNDO_MAX_SIZE } from "@/features/stitch/stitchConstants";

const blank = (): Omit<import("@/features/stitch/stitchTypes").StitchTile, "id"> => ({
  sourcePdfBytes: new Uint8Array(0),
  sourcePageIndex: 0,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
});

let created: string[];
let revoked: string[];
let n = 0;

beforeEach(() => {
  created = [];
  revoked = [];
  n = 0;
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: (_blob: Blob) => {
      const url = `blob:test/${++n}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url: string) => { revoked.push(url); },
  });
  // Reset BEFORE clearing the logs: the store is a module singleton, so this
  // revokes whatever the previous test left behind.
  useStitchStore.getState().reset();
  created.length = 0;
  revoked.length = 0;
  n = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tileRasters", () => {
  it("keeps the raster out of the tile and in the side slice, keyed by tile id", () => {
    useStitchStore.getState().addTiles([{ ...blank(), rasterBlob: new Blob(["x"]) }]);
    const tile = useStitchStore.getState().tiles[0];
    expect(tile.imageDataUrl).toBeUndefined();
    expect((tile as { rasterBlob?: Blob }).rasterBlob).toBeUndefined();
    expect(useStitchStore.getState().tileRasters[tile.id]).toBe(created[0]);
    expect(tileRasterUrl(tile)).toBe(created[0]);
  });

  it("gives two placements of one page their own revocable URLs", () => {
    const blob = new Blob(["x"]);
    useStitchStore.getState().addTiles([
      { ...blank(), rasterBlob: blob },
      { ...blank(), rasterBlob: blob },
    ]);
    const [a, b] = useStitchStore.getState().tiles;
    const rasters = useStitchStore.getState().tileRasters;
    expect(rasters[a.id]).not.toBe(rasters[b.id]);
  });

  it("lets a tile override its committed raster, and undo reveal it again", () => {
    useStitchStore.getState().addTiles([{ ...blank(), rasterBlob: new Blob(["x"]) }]);
    const id = useStitchStore.getState().tiles[0].id;
    const committed = useStitchStore.getState().tileRasters[id];

    useStitchStore.getState().updateTile(id, { imageDataUrl: "data:image/png;base64,ERASED" });
    expect(tileRasterUrl(useStitchStore.getState().tiles[0])).toBe("data:image/png;base64,ERASED");

    useStitchStore.getState().undo();
    expect(tileRasterUrl(useStitchStore.getState().tiles[0])).toBe(committed);
    expect(revoked).toEqual([]);
  });

  it("does not revoke a removed tile's raster while undo can bring it back", () => {
    useStitchStore.getState().addTiles([{ ...blank(), rasterBlob: new Blob(["x"]) }]);
    const id = useStitchStore.getState().tiles[0].id;

    useStitchStore.getState().removeTile(id);
    expect(revoked).toEqual([]);
    expect(useStitchStore.getState().tileRasters[id]).toBe(created[0]);

    useStitchStore.getState().undo();
    expect(useStitchStore.getState().tiles).toHaveLength(1);
    expect(tileRasterUrl(useStitchStore.getState().tiles[0])).toBe(created[0]);
  });

  it("revokes once the last snapshot mentioning the tile has aged out", () => {
    useStitchStore.getState().addTiles([{ ...blank(), rasterBlob: new Blob(["x"]) }]);
    const id = useStitchStore.getState().tiles[0].id;
    useStitchStore.getState().removeTile(id);

    // Push more snapshots than the stack holds, so no snapshot names the tile.
    for (let i = 0; i < UNDO_MAX_SIZE + 1; i++) useStitchStore.getState().pushUndoSnapshot();
    // Any tile-dropping op runs the sweep.
    useStitchStore.getState().removeTiles(["not-a-tile"]);

    expect(revoked).toEqual([created[0]]);
    expect(useStitchStore.getState().tileRasters[id]).toBeUndefined();
  });

  it("revokes everything on reset", () => {
    useStitchStore.getState().addTiles([
      { ...blank(), rasterBlob: new Blob(["a"]) },
      { ...blank(), rasterBlob: new Blob(["b"]) },
    ]);
    useStitchStore.getState().reset();
    expect(revoked.sort()).toEqual(created.slice(0, 2).sort());
    expect(useStitchStore.getState().tileRasters).toEqual({});
  });

  it("never puts the raster map into an undo snapshot", () => {
    useStitchStore.getState().addTiles([{ ...blank(), rasterBlob: new Blob(["x"]) }]);
    const snap = useStitchStore.getState().undoStack[0] as unknown as Record<string, unknown>;
    // `groups` rides along (names and colours, so an undone Ungroup comes back intact);
    // the RASTER map must not, which is what this is guarding.
    expect(Object.keys(snap)).toEqual(["tiles", "canvasWidth", "canvasHeight", "cropRect", "groups"]);
    expect(snap.tileRasters).toBeUndefined();
  });
});

describe("replaceTiles", () => {
  it("swaps one set for another in ONE undo step", () => {
    // Two calls (removeTiles + addTiles) made the grid→aligned swap two steps, so the
    // first undo after an auto-align left the grid AND the composite on the canvas.
    useStitchStore.getState().addTiles([blank(), blank()]);
    const gridIds = useStitchStore.getState().tiles.map((t) => t.id);
    const depth = useStitchStore.getState().undoStack.length;

    useStitchStore.getState().replaceTiles(gridIds, [{ ...blank(), x: 500 }, { ...blank(), x: 700 }]);
    expect(useStitchStore.getState().undoStack.length).toBe(depth + 1);
    expect(useStitchStore.getState().tiles.map((t) => t.x)).toEqual([500, 700]);

    useStitchStore.getState().undo();
    expect(useStitchStore.getState().tiles.map((t) => t.id)).toEqual(gridIds);
  });

  it("keeps the replaced tiles' rasters alive for the undo that brings them back", () => {
    useStitchStore.getState().addTiles([{ ...blank(), rasterBlob: new Blob(["grid"]) }]);
    const gridId = useStitchStore.getState().tiles[0].id;
    const gridUrl = useStitchStore.getState().tileRasters[gridId];

    useStitchStore.getState().replaceTiles([gridId], [{ ...blank(), rasterBlob: new Blob(["aligned"]) }]);
    // The snapshot still mentions the grid tile, so its image must NOT be revoked —
    // undoing has to show the sheet, not an error card.
    expect(revoked).not.toContain(gridUrl);
    useStitchStore.getState().undo();
    expect(useStitchStore.getState().tileRasters[gridId]).toBe(gridUrl);
  });

  it("adding with no removals behaves like addTiles", () => {
    useStitchStore.getState().replaceTiles([], [blank()]);
    expect(useStitchStore.getState().tiles).toHaveLength(1);
  });
});
