/**
 * TileCache — L1 in-memory LRU cache of rendered tiles.
 *
 * Eviction policy: insertion-order Map. Oldest entry drops on overflow.
 * `get` refreshes a tile's position to the end of the Map (LRU-touch).
 * Any tile dropped (eviction, invalidation, replacement, destroy) has its
 * `ImageBitmap.close()` called to release decoded image memory.
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

const ADAPTIVE_DEFAULT_CAPACITY = isTauri ? 400 : 200;

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

    // Replacement: drop the old bitmap, then re-insert at the tail.
    const existing = this.map.get(k);
    if (existing) {
      this.map.delete(k);
      if (existing.bitmap !== tile.bitmap) {
        try {
          existing.bitmap.close();
        } catch {}
      }
    } else if (this.map.size >= this.capacity) {
      // Evict oldest only when actually adding a new entry.
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        const oldest = this.map.get(oldestKey);
        this.map.delete(oldestKey);
        if (oldest) {
          try {
            oldest.bitmap.close();
          } catch {}
        }
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

  /** Drop all cached tiles for a (docId, page). Closes their bitmaps. */
  invalidatePage(docId: string, page: number): void {
    const prefix = `${docId}/${page}/`;
    for (const [key, tile] of this.map) {
      if (key.startsWith(prefix)) {
        this.map.delete(key);
        try {
          tile.bitmap.close();
        } catch {}
      }
    }
  }

  /** Drop all cached tiles for a docId. Closes their bitmaps. */
  invalidateDoc(docId: string): void {
    const prefix = `${docId}/`;
    for (const [key, tile] of this.map) {
      if (key.startsWith(prefix)) {
        this.map.delete(key);
        try {
          tile.bitmap.close();
        } catch {}
      }
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
