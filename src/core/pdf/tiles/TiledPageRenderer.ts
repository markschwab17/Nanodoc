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

import { lodForZoom, tilePdfRect, visibleTileKeys } from "./lod";
import { TileCache } from "./TileCache";
import { bumpTilesPending } from "./tileRendererStatus";
import { getTileStore } from "./TileStore";
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
  private lod0PrefetchDone = false;
  /** OPFS-backed L2. Lazy module-level singleton; null only on init failure. */
  private store = getTileStore();
  /**
   * Tracks tile keys that are mid-flight through the L1→L2→worker pipeline.
   * `pool.inflight` only covers worker requests, but a tile waiting on an
   * OPFS read shouldn't trigger a duplicate worker request when setViewport
   * fires again. Cleared when the fetch settles.
   */
  private fetching = new Set<string>();
  /**
   * Last LOD chosen per page. Threaded back into lodForZoom on subsequent
   * calls so small zoom dithers around an LOD boundary don't repeatedly
   * downshift+upshift, each cycle re-rendering a page worth of tiles.
   */
  private lastLodByPage = new Map<number, number>();
  /**
   * OffscreenCanvas reused for L2 readback (drawImage(bitmap) → getImageData).
   * Shared across persists to avoid per-tile canvas allocation.
   */
  private readbackCanvas: OffscreenCanvas | null = null;

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
    const lod = lodForZoom(
      dims,
      displayPxPerPoint,
      this.lastLodByPage.get(page),
    );
    this.lastLodByPage.set(page, lod);
    const keys = visibleTileKeys(this.opts.docId, page, dims, lod, viewport);

    // Cancel pending requests for THIS page that are stale. The right
    // balance:
    //   - Same target LOD but no longer in viewport → cancel (stale primary)
    //   - One-LOD-below ancestor + LOD-0 → keep (intentional prefetches)
    //   - Any OTHER LOD → cancel (stale visible from a prior LOD that the
    //     user has zoomed past — leaving these queued starves the current
    //     LOD's renders)
    // This is the third revision of this filter:
    //   v1 cancelled everything not in visibleSet → starved prefetches
    //   v2 cancelled only same-LOD-stale → starved current LOD with stale
    //      visible from prior LODs the user already left
    //   v3 (here) cancels both same-LOD-stale AND other-LOD non-prefetches
    const visibleSet = new Set(keys.map(tileKeyString));
    this.pool.cancel((k) => {
      if (k.docId !== this.opts.docId || k.page !== page) return false;
      if (k.lod === lod) return !visibleSet.has(tileKeyString(k));
      // Keep ancestor prefetches.
      if (k.lod === lod - 1 || k.lod === 0) return false;
      // Any other LOD → stale, cancel.
      return true;
    });

    // Queue LOD-0 FIRST and at "visible" priority. It's a single tile that
    // covers the whole page, renders fast, and guarantees the fallback
    // path has *something* to show (via findCoarserAncestor) the moment a
    // page is mounted or the user jumps to a high LOD. Without this
    // queued ahead of primary tiles, the page is blank until any of the
    // LOD-N primaries finish — which can take many seconds on a large
    // doc and is what looked like "blank tiles instead of a placeholder".
    if (lod > 0) {
      const lod0Key = { docId: this.opts.docId, page, lod: 0, x: 0, y: 0 };
      this.fetchTile(lod0Key, this.opts.pageDims(page), "visible");
    }

    // Enqueue missing primary tiles. fetchTile dedupes via this.fetching,
    // and pool.request dedupes within the worker pool.
    for (const key of keys) {
      this.fetchTile(key, dims, "visible");
    }

    // Prefetch the next-coarser LOD as a sharper fallback than LOD-0
    // (used by findCoarserAncestor preferentially since it returns the
    // finest cached ancestor). One LOD's worth of viewport-clipped tiles
    // — manageable.
    if (lod > 0) {
      const ancestorKeys = visibleTileKeys(
        this.opts.docId,
        page,
        dims,
        lod - 1,
        viewport,
      );
      for (const key of ancestorKeys) {
        this.fetchTile(key, dims, "prefetch");
      }
    }
  }

  /**
   * L1 → L2 → worker fallthrough for a single tile.
   *
   * - L1 hit: nothing to do; the tile is already paintable.
   * - L2 hit: hydrate pixels into an ImageBitmap on the main thread, drop
   *   into L1, emit. Skips the worker entirely — the win for reload perf.
   * - L2 miss: dispatch to worker as before; on success, write pixels back
   *   to L2 in the background so the next session benefits.
   *
   * Increments the global pending-tiles counter for the "Rendering…"
   * status indicator the moment we start any async work, decrements on
   * settle. Dedupes via `this.fetching`.
   */
  private fetchTile(
    key: TileKey,
    dims: PageDims,
    priority: "visible" | "prefetch",
  ): void {
    if (this.destroyed) return;
    if (this.cache.has(key)) return;
    const k = tileKeyString(key);
    if (this.fetching.has(k)) return;
    this.fetching.add(k);

    bumpTilesPending(1);
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      this.fetching.delete(k);
      bumpTilesPending(-1);
    };

    const handleTile = (tile: RenderedTile) => {
      if (this.destroyed) {
        try {
          tile.bitmap.close();
        } catch {}
        return;
      }
      this.cache.put(tile);
      this.emit(tile);
    };

    // Fast path: skip OPFS round-trip when our metadata says the key
    // definitely isn't there. This makes the no-L2 case as fast as before.
    const maybeInL2 = this.store.hasMeta(key);

    const fallbackToWorker = () => {
      if (this.destroyed) {
        settle();
        return;
      }
      this.pool.request(key, dims, priority).then(
        (tile) => {
          handleTile(tile);
          settle();
          // Persist to L2 in the background. Best-effort; never blocks.
          this.persistToL2(tile).catch(() => {});
        },
        () => {
          settle();
        },
      );
    };

    if (!maybeInL2) {
      fallbackToWorker();
      return;
    }

    this.store.get(key).then(
      async (hit) => {
        if (this.destroyed) {
          settle();
          return;
        }
        if (!hit) {
          fallbackToWorker();
          return;
        }
        // Re-check L1 — a concurrent worker arrival may have populated it
        // while we were waiting on disk.
        if (this.cache.has(key)) {
          settle();
          return;
        }
        try {
          // Copy into a fresh ArrayBuffer-backed Uint8ClampedArray so the
          // ImageData constructor's strict typing (no SharedArrayBuffer)
          // is satisfied regardless of where hit.pixels was sourced from.
          const fresh = new Uint8ClampedArray(
            new ArrayBuffer(hit.pixels.byteLength),
          );
          fresh.set(hit.pixels);
          const imageData = new ImageData(fresh, hit.width, hit.height);
          const bitmap = await createImageBitmap(imageData);
          if (this.destroyed) {
            try {
              bitmap.close();
            } catch {}
            settle();
            return;
          }
          const tile: RenderedTile = {
            key,
            bitmap,
            pdfRect: tilePdfRect(key, dims),
            pixelWidth: hit.width,
            pixelHeight: hit.height,
          };
          handleTile(tile);
          settle();
        } catch {
          // Hydration failed (corrupt buffer? race?) — fall through to
          // the worker so we still get a tile.
          fallbackToWorker();
        }
      },
      () => {
        fallbackToWorker();
      },
    );
  }

  /**
   * Read pixels back from a rendered tile's ImageBitmap and write them to
   * OPFS. Runs only on worker arrivals (L2 misses); skipped for L2 hits
   * since we already have those pixels persisted.
   *
   * Uses a single OffscreenCanvas reused across calls — sized to TILE_SIZE
   * which is the only tile size the worker ever produces.
   */
  private async persistToL2(tile: RenderedTile): Promise<void> {
    if (this.destroyed) return;
    if (typeof OffscreenCanvas === "undefined") return;
    try {
      if (
        !this.readbackCanvas ||
        this.readbackCanvas.width !== tile.pixelWidth ||
        this.readbackCanvas.height !== tile.pixelHeight
      ) {
        this.readbackCanvas = new OffscreenCanvas(
          tile.pixelWidth,
          tile.pixelHeight,
        );
      }
      const ctx = this.readbackCanvas.getContext("2d", {
        willReadFrequently: true,
      });
      if (!ctx) return;
      ctx.clearRect(0, 0, tile.pixelWidth, tile.pixelHeight);
      ctx.drawImage(tile.bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, tile.pixelWidth, tile.pixelHeight);
      await this.store.set(
        tile.key,
        data.data,
        tile.pixelWidth,
        tile.pixelHeight,
      );
    } catch {
      // Persistence is strictly best-effort — never let storage errors
      // surface to the rendering path.
    }
  }

  /** Synchronously return what's currently paintable for this viewport. */
  getVisibleTiles(
    page: number,
    viewport: PdfRect,
    displayPxPerPoint: number,
  ): VisibleTilesResult {
    const dims = this.opts.pageDims(page);
    // Use the same hysteresis-aware LOD that setViewport just chose so the
    // displayed primary set matches what we requested.
    const lod = lodForZoom(
      dims,
      displayPxPerPoint,
      this.lastLodByPage.get(page),
    );
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

    // Always include the LOD-0 tile as a permanent baseline beneath
    // everything else (when cached and we're rendering at a higher LOD).
    // findCoarserAncestor only returns LOD-0 when *nothing* finer is cached;
    // that means as soon as an intermediate ancestor (e.g. LOD-3) becomes
    // available, the LOD-0 leaves the fallback list and unmounts. During an
    // LOD upshift, intermediate ancestors mid-render then unmounting can
    // leave a 120ms window where new primaries are still fading in (opacity
    // 0→1) and the area underneath has no tile — perceived as a flash.
    // Pinning LOD-0 at the bottom guarantees something is always painted
    // there. It's a single tile per page so the cost is minimal.
    if (lod > 0) {
      const lod0Key: TileKey = {
        docId: this.opts.docId,
        page,
        lod: 0,
        x: 0,
        y: 0,
      };
      const lod0Tile = this.cache.get(lod0Key);
      if (lod0Tile && !seenFallback.has(tileKeyString(lod0Key))) {
        // unshift so it renders FIRST in the merged list — bottommost layer.
        fallback.unshift(lod0Tile);
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

  /**
   * Eagerly enqueue every page's single LOD-0 tile at "prefetch" priority.
   * LOD-0 is the never-blank backstop used by findCoarserAncestor: prefetching
   * it for all pages on doc open means a scroll/page-jump always has *some*
   * cached ancestor to draw immediately while higher-LOD primaries stream in.
   *
   * Idempotent: re-calls skip pages already queued or cached. Safe to invoke
   * multiple times; the WorkerPool dedupes in-flight identical TileKeys.
   */
  prefetchAllLod0(pageCount: number): void {
    if (this.destroyed) return;
    if (this.lod0PrefetchDone) return;
    this.lod0PrefetchDone = true;
    for (let page = 0; page < pageCount; page++) {
      const key = { docId: this.opts.docId, page, lod: 0, x: 0, y: 0 };
      this.fetchTile(key, this.opts.pageDims(page), "prefetch");
    }
  }

  /** Diagnostics: current cache size. Used by the dev HUD. */
  cacheSize(): number {
    return this.cache.size();
  }

  /** Drop all cached tiles for the document (e.g., after edit). */
  invalidate(): void {
    this.cache.invalidateDoc(this.opts.docId);
    this.pool.cancel((k) => k.docId === this.opts.docId);
    // Also drop persisted L2 tiles — after an edit, the rendered pixels
    // for this doc are stale. Best-effort, fire-and-forget.
    this.store.invalidateDoc(this.opts.docId).catch(() => {});
  }

  destroy(): void {
    this.destroyed = true;
    this.pool.destroy();
    this.cache.destroy();
    this.listeners.clear();
    this.fetching.clear();
    this.lastLodByPage.clear();
    this.readbackCanvas = null;
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
