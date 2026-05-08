/**
 * TileCache — L1 in-memory LRU cache of rendered tiles.
 *
 * Eviction policy: insertion-order Map. Oldest entry drops on overflow.
 * `get` refreshes a tile's position to the end of the Map (LRU-touch).
 *
 * NOTE on bitmap.close(): we intentionally do NOT call close() on routine
 * eviction/replacement. Closing a bitmap that React is currently rendering
 * (during StrictMode dev double-invoke or any concurrent commit) detaches
 * the image source mid-paint and crashes drawImage. We accept the short-term
 * GPU memory growth — bitmaps GC after their last reference dies. Only
 * `destroy()` (which assumes the cache will not be read again) closes
 * bitmaps. Phase-7 perf tuning will revisit eager close once we have a
 * solid render-frame ↔ cache barrier.
 *
 * `findCoarserAncestor` walks from `lod-1` down to LOD 0 and returns the
 * finest cached ancestor whose tile rect contains the requested tile's
 * rect — the "never blank" fallback used by TiledPageRenderer when the
 * primary tile isn't ready yet.
 */

import { isTauri } from "@/shared/utils/environment";
import {
  tileKeyString,
  type RenderedTile,
  type TileKey,
} from "./types";

// Tuned for phase-3: large enough that walking through a multi-page document
// at multiple LODs doesn't evict coarser-LOD ancestors that the
// "never blank" fallback path relies on. At 1MB per ImageBitmap (RGBA
// 512×512 estimated), 800 tiles ≈ 800MB worst case in browser; Tauri gets
// more headroom. Phase-7 perf tuning will revisit this with measurements.
const ADAPTIVE_DEFAULT_CAPACITY = isTauri ? 1600 : 800;

export interface TileCacheOptions {
  /** Max number of tiles before LRU eviction kicks in. */
  capacity?: number;
}

export class TileCache {
  private map = new Map<string, RenderedTile>();
  private capacity: number;

  constructor(opts?: TileCacheOptions) {
    this.capacity = opts?.capacity ?? ADAPTIVE_DEFAULT_CAPACITY;
  }

  has(key: TileKey): boolean {
    return this.map.has(tileKeyString(key));
  }

  /** Get + refresh LRU position. Returns undefined if not cached. */
  get(key: TileKey): RenderedTile | undefined {
    const k = tileKeyString(key);
    const tile = this.map.get(k);
    if (!tile) return undefined;
    this.map.delete(k);
    this.map.set(k, tile);
    return tile;
  }

  put(tile: RenderedTile): void {
    const k = tileKeyString(tile.key);

    const existing = this.map.get(k);
    if (existing) {
      // Replacement: drop the old map entry but do NOT close its bitmap —
      // a Tile component may still be drawing it on this commit.
      this.map.delete(k);
    } else if (this.map.size >= this.capacity) {
      // Evict oldest only when actually adding a new entry. Same rule:
      // drop the map slot but don't close the bitmap; the GC will collect
      // it once nothing references it.
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }

    this.map.set(k, tile);
  }

  /**
   * Walk from `key.lod - 1` down to LOD 0 and return the finest cached
   * ancestor (a tile whose PDF rect contains `key`'s rect at a coarser
   * resolution). Used for "never blank" fallback rendering.
   *
   * Returns undefined when no ancestor is cached.
   */
  findCoarserAncestor(key: TileKey): RenderedTile | undefined {
    for (let lod = key.lod - 1; lod >= 0; lod--) {
      const factor = Math.pow(2, key.lod - lod);
      const ancestorKey: TileKey = {
        docId: key.docId,
        page: key.page,
        lod,
        x: Math.floor(key.x / factor),
        y: Math.floor(key.y / factor),
      };
      const ancestor = this.get(ancestorKey);
      if (ancestor) return ancestor;
    }
    return undefined;
  }

  /** Drop all cached tiles for a (docId, page). Bitmaps GC naturally. */
  invalidatePage(docId: string, page: number): void {
    const prefix = `${docId}/${page}/`;
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) this.map.delete(key);
    }
  }

  /** Drop all cached tiles for a docId. Bitmaps GC naturally. */
  invalidateDoc(docId: string): void {
    const prefix = `${docId}/`;
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) this.map.delete(key);
    }
  }

  size(): number {
    return this.map.size;
  }

  destroy(): void {
    for (const tile of this.map.values()) {
      try {
        tile.bitmap.close();
      } catch {}
    }
    this.map.clear();
  }
}
