import { describe, expect, it, vi } from "vitest";
import { TileCache } from "./TileCache";
import { type RenderedTile, type TileKey } from "./types";

function makeKey(overrides: Partial<TileKey> = {}): TileKey {
  return { docId: "d", page: 0, lod: 0, x: 0, y: 0, ...overrides };
}

function makeTile(key: TileKey, closeSpy = vi.fn()): RenderedTile {
  return {
    key,
    bitmap: { close: closeSpy } as unknown as ImageBitmap,
    pdfRect: { x: 0, y: 0, w: 0, h: 0 },
    pixelWidth: 512,
    pixelHeight: 512,
  };
}

describe("TileCache: put + get + has", () => {
  it("stores and retrieves tiles", () => {
    const cache = new TileCache({ capacity: 10 });
    const key = makeKey();
    cache.put(makeTile(key));
    expect(cache.has(key)).toBe(true);
    expect(cache.get(key)).toBeDefined();
  });

  it("returns undefined for missing keys", () => {
    const cache = new TileCache({ capacity: 10 });
    expect(cache.get(makeKey())).toBeUndefined();
    expect(cache.has(makeKey())).toBe(false);
  });

  it("size reflects insertions", () => {
    const cache = new TileCache({ capacity: 10 });
    cache.put(makeTile(makeKey({ x: 0 })));
    cache.put(makeTile(makeKey({ x: 1 })));
    expect(cache.size()).toBe(2);
  });
});

describe("TileCache: LRU eviction", () => {
  it("evicts oldest when capacity exceeded", () => {
    const cache = new TileCache({ capacity: 2 });
    cache.put(makeTile(makeKey({ x: 0 })));
    cache.put(makeTile(makeKey({ x: 1 })));
    cache.put(makeTile(makeKey({ x: 2 })));
    expect(cache.has(makeKey({ x: 0 }))).toBe(false);
    expect(cache.has(makeKey({ x: 1 }))).toBe(true);
    expect(cache.has(makeKey({ x: 2 }))).toBe(true);
  });

  it("get refreshes LRU position", () => {
    const cache = new TileCache({ capacity: 2 });
    cache.put(makeTile(makeKey({ x: 0 })));
    cache.put(makeTile(makeKey({ x: 1 })));
    cache.get(makeKey({ x: 0 })); // touch — promotes x=0 to most-recent
    cache.put(makeTile(makeKey({ x: 2 })));
    expect(cache.has(makeKey({ x: 0 }))).toBe(true);
    expect(cache.has(makeKey({ x: 1 }))).toBe(false);
    expect(cache.has(makeKey({ x: 2 }))).toBe(true);
  });

  it("does NOT call bitmap.close on routine eviction", () => {
    // Policy: bitmaps stay alive for GC to collect, so we never close while
    // a Tile component might still be mid-paint on the same bitmap.
    const cache = new TileCache({ capacity: 1 });
    const close = vi.fn();
    cache.put(makeTile(makeKey({ x: 0 }), close));
    cache.put(makeTile(makeKey({ x: 1 })));
    expect(close).not.toHaveBeenCalled();
  });
});

describe("TileCache: replacement", () => {
  it("does not evict when replacing an existing key, and does NOT close the old bitmap", () => {
    // Same bitmap-leak policy as routine eviction.
    const cache = new TileCache({ capacity: 1 });
    const closeA = vi.fn();
    const closeB = vi.fn();
    cache.put(makeTile(makeKey(), closeA));
    cache.put(makeTile(makeKey(), closeB));
    expect(cache.size()).toBe(1);
    expect(closeA).not.toHaveBeenCalled();
    expect(closeB).not.toHaveBeenCalled();
  });
});

describe("TileCache: findCoarserAncestor", () => {
  it("returns undefined when no ancestor cached", () => {
    const cache = new TileCache({ capacity: 10 });
    expect(cache.findCoarserAncestor(makeKey({ lod: 3, x: 5, y: 5 }))).toBeUndefined();
  });

  it("returns the finest cached ancestor", () => {
    const cache = new TileCache({ capacity: 10 });
    cache.put(makeTile(makeKey({ lod: 0, x: 0, y: 0 })));
    cache.put(makeTile(makeKey({ lod: 2, x: 1, y: 1 })));
    // Key at lod=3, x=2, y=2: lod-2 ancestor is (1,1); lod-0 ancestor is (0,0)
    const result = cache.findCoarserAncestor(makeKey({ lod: 3, x: 2, y: 2 }));
    expect(result?.key).toMatchObject({ lod: 2, x: 1, y: 1 });
  });

  it("walks up to LOD 0 when intermediate LODs are missing", () => {
    const cache = new TileCache({ capacity: 10 });
    cache.put(makeTile(makeKey({ lod: 0, x: 0, y: 0 })));
    const result = cache.findCoarserAncestor(makeKey({ lod: 3, x: 2, y: 2 }));
    expect(result?.key).toMatchObject({ lod: 0, x: 0, y: 0 });
  });

  it("returns undefined for LOD 0 keys", () => {
    const cache = new TileCache({ capacity: 10 });
    expect(cache.findCoarserAncestor(makeKey({ lod: 0 }))).toBeUndefined();
  });
});

describe("TileCache: invalidatePage", () => {
  it("drops only matching page tiles", () => {
    const cache = new TileCache({ capacity: 10 });
    cache.put(makeTile(makeKey({ page: 0, x: 0 })));
    cache.put(makeTile(makeKey({ page: 0, x: 1 })));
    cache.put(makeTile(makeKey({ page: 1, x: 0 })));
    cache.invalidatePage("d", 0);
    expect(cache.size()).toBe(1);
    expect(cache.has(makeKey({ page: 1, x: 0 }))).toBe(true);
  });

  it("does not affect other docIds", () => {
    const cache = new TileCache({ capacity: 10 });
    cache.put(makeTile(makeKey({ docId: "d1", page: 0 })));
    cache.put(makeTile(makeKey({ docId: "d2", page: 0 })));
    cache.invalidatePage("d1", 0);
    expect(cache.has(makeKey({ docId: "d2", page: 0 }))).toBe(true);
  });

  it("does NOT call bitmap.close on invalidatePage (GC handles it)", () => {
    const cache = new TileCache({ capacity: 10 });
    const close = vi.fn();
    cache.put(makeTile(makeKey(), close));
    cache.invalidatePage("d", 0);
    expect(close).not.toHaveBeenCalled();
  });
});

describe("TileCache: invalidateDoc", () => {
  it("drops all tiles for a docId", () => {
    const cache = new TileCache({ capacity: 10 });
    cache.put(makeTile(makeKey({ docId: "d1", page: 0 })));
    cache.put(makeTile(makeKey({ docId: "d1", page: 1 })));
    cache.put(makeTile(makeKey({ docId: "d2", page: 0 })));
    cache.invalidateDoc("d1");
    expect(cache.size()).toBe(1);
    expect(cache.has(makeKey({ docId: "d2", page: 0 }))).toBe(true);
  });
});

describe("TileCache: destroy", () => {
  it("clears the cache and closes all bitmaps", () => {
    const cache = new TileCache({ capacity: 10 });
    const closeA = vi.fn();
    const closeB = vi.fn();
    cache.put(makeTile(makeKey({ x: 0 }), closeA));
    cache.put(makeTile(makeKey({ x: 1 }), closeB));
    cache.destroy();
    expect(cache.size()).toBe(0);
    expect(closeA).toHaveBeenCalled();
    expect(closeB).toHaveBeenCalled();
  });
});
