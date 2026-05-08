/**
 * TiledPageRenderer — orchestrator for tile-based page rendering.
 *
 * Owns a WorkerPool and a TileCache. Translates a (page, viewport, zoom)
 * into a set of tile keys at the right LOD, requests missing ones from
 * the pool, and lets the caller synchronously query what's paintable.
 *
 * The "never blank" rule is implemented in getVisibleTiles: missing primary
 * tiles fall through to coarser-LOD ancestors (via TileCache) so the
 * consumer always has something to draw — sharper as more tiles arrive.
 *
 * setViewport cancels pending requests that left the viewport, so the pool
 * is never wasted on tiles the user is no longer looking at.
 */

import { lodForZoom, visibleTileKeys } from "./lod";
import { TileCache } from "./TileCache";
import {
  tileKeyString,
  type PageDims,
  type PdfRect,
  type RenderedTile,
  type TileKey,
} from "./types";
import { WorkerPool } from "./WorkerPool";

export interface TiledPageRendererOptions {
  docId: string;
  pdfBytes: Uint8Array;
  pageDims: (page: number) => PageDims;
  workerCount?: number;
  cacheCapacity?: number;
}

export interface VisibleTilesResult {
  /** Tiles cached at the requested LOD. */
  primary: RenderedTile[];
  /**
   * Coarser-LOD ancestors used as fallback while primary tiles are loading.
   * Deduplicated — at most one entry per ancestor tile key.
   */
  fallback: RenderedTile[];
  /** Keys with neither a primary nor any cached ancestor. Caller may show a placeholder. */
  missing: TileKey[];
  /** The LOD chosen for this viewport. */
  lod: number;
}

export class TiledPageRenderer {
  private opts: TiledPageRendererOptions;
  private pool: WorkerPool;
  private cache: TileCache;
  private listeners = new Set<(t: RenderedTile) => void>();
  private destroyed = false;

  constructor(opts: TiledPageRendererOptions) {
    this.opts = opts;
    this.cache = new TileCache({ capacity: opts.cacheCapacity });
    this.pool = new WorkerPool({
      size: opts.workerCount,
      pdfDataFor: () => opts.pdfBytes,
    });
  }

  /**
   * Update the visible viewport. Cancels in-flight tile requests that left
   * the viewport, then enqueues missing tiles for the new viewport. Returns
   * synchronously; arrivals fire onTileReady.
   */
  setViewport(
    page: number,
    viewport: PdfRect,
    displayPxPerPoint: number,
  ): void {
    if (this.destroyed) return;
    const dims = this.opts.pageDims(page);
    const lod = lodForZoom(dims, displayPxPerPoint);
    const keys = visibleTileKeys(this.opts.docId, page, dims, lod, viewport);

    // Cancel pending requests for THIS doc that aren't in the new visible
    // set — including stale requests from a prior page or LOD.
    const visibleSet = new Set(keys.map(tileKeyString));
    this.pool.cancel((k) => {
      if (k.docId !== this.opts.docId) return false;
      return !visibleSet.has(tileKeyString(k));
    });

    // Enqueue missing primary tiles. The pool dedupes on the same TileKey,
    // so re-requesting an in-flight key is free.
    for (const key of keys) {
      if (this.cache.has(key)) continue;
      this.pool.request(key, dims, "visible").then(
        (tile) => {
          if (this.destroyed) {
            try {
              tile.bitmap.close();
            } catch {}
            return;
          }
          this.cache.put(tile);
          this.emit(tile);
        },
        () => {
          // Cancellation or render error — silent. Caller's next
          // getVisibleTiles will still return a fallback or a missing entry.
        },
      );
    }
  }

  /** Synchronously return what's currently paintable for this viewport. */
  getVisibleTiles(
    page: number,
    viewport: PdfRect,
    displayPxPerPoint: number,
  ): VisibleTilesResult {
    const dims = this.opts.pageDims(page);
    const lod = lodForZoom(dims, displayPxPerPoint);
    const keys = visibleTileKeys(this.opts.docId, page, dims, lod, viewport);

    const primary: RenderedTile[] = [];
    const fallback: RenderedTile[] = [];
    const missing: TileKey[] = [];
    const seenFallback = new Set<string>();

    for (const key of keys) {
      const tile = this.cache.get(key);
      if (tile) {
        primary.push(tile);
        continue;
      }
      const ancestor = this.cache.findCoarserAncestor(key);
      if (ancestor) {
        const ak = tileKeyString(ancestor.key);
        if (!seenFallback.has(ak)) {
          fallback.push(ancestor);
          seenFallback.add(ak);
        }
      } else {
        missing.push(key);
      }
    }

    return { primary, fallback, missing, lod };
  }

  /** Subscribe to tile arrivals. Returns an unsubscribe. */
  onTileReady(callback: (t: RenderedTile) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /** Drop all cached tiles for the document (e.g., after edit). */
  invalidate(): void {
    this.cache.invalidateDoc(this.opts.docId);
    this.pool.cancel((k) => k.docId === this.opts.docId);
  }

  destroy(): void {
    this.destroyed = true;
    this.pool.destroy();
    this.cache.destroy();
    this.listeners.clear();
  }

  private emit(tile: RenderedTile): void {
    for (const cb of this.listeners) {
      try {
        cb(tile);
      } catch (e) {
        console.warn("TiledPageRenderer onTileReady listener threw:", e);
      }
    }
  }
}
