/**
 * WorkerPool — fans tile requests across N tile-render workers.
 *
 * Behaviors:
 *   - Priority queue: visible > prefetch
 *   - Dedupe: identical TileKey requested while in-flight returns the same Promise
 *   - Cancel: drop pending (not in-flight) requests matching a predicate
 *   - Timeout: kill+restart any worker whose tile takes too long; reject its task
 *   - Document data sent once per (worker, docId) and cached worker-side
 *
 * Mirrors the timeout-and-restart pattern from PDFRenderer.ts. Uses a smaller
 * per-tile timeout because tiles should be much cheaper than full pages.
 */

import { isTauri } from "@/shared/utils/environment";
import {
  tileKeyString,
  type PageDims,
  type RenderedTile,
  type TileKey,
} from "./types";
import { tilePdfRect } from "./lod";
import type {
  TileWorkerRequest,
  TileWorkerResponse,
} from "./tileRender.worker";

/** Per-tile render timeout (ms). Smaller than the legacy per-page 120s/15s. */
const WORKER_RENDER_TIMEOUT_MS = isTauri ? 30_000 : 10_000;

/** Default pool size: leave one core for the main thread; clamp to [2, 8]. */
function defaultPoolSize(): number {
  const cores = globalThis.navigator?.hardwareConcurrency ?? 4;
  return Math.max(2, Math.min(8, cores - 1));
}

export type Priority = "visible" | "prefetch";

export interface WorkerPoolOptions {
  /** Override pool size for tests / low-memory environments. */
  size?: number;
  /**
   * Provide PDF bytes for a given docId on first request to a worker.
   * Called at most once per (worker, docId) pair.
   */
  pdfDataFor: (docId: string) => Uint8Array;
}

interface QueueItem {
  key: TileKey;
  pageDims: PageDims;
  priority: Priority;
  resolve: (t: RenderedTile) => void;
  reject: (e: Error) => void;
  enqueuedAt: number;
}

interface WorkerSlot {
  id: number;
  worker: Worker;
  ready: boolean;
  knownDocIds: Set<string>;
  busy: QueueItem | null;
  timer: ReturnType<typeof setTimeout> | null;
  nextRequestId: number;
  /**
   * Set when a still-running tile is cancelled mid-render. The worker can't
   * be aborted (no AbortController across structured-cloned messages), but
   * when the result eventually arrives we throw it away rather than resolving
   * a cancelled caller. Cheaper than killing+respawning the worker (which
   * would force a fresh mupdf init + DisplayList rebuild for every cancel).
   */
  busyCancelled: boolean;
}

export class WorkerPool {
  private slots: WorkerSlot[] = [];
  private queue: QueueItem[] = [];
  private inflight = new Map<string, Promise<RenderedTile>>();
  private destroyed = false;
  private opts: WorkerPoolOptions;
  // visibilitychange handler reference — kept so destroy() can detach it.
  // When the tab/window is hidden, queued tiles wait. We don't pause
  // already-busy slots (they finish their current tile and naturally idle
  // because no new work is dispatched).
  private onVisibilityChange: (() => void) | null = null;

  constructor(opts: WorkerPoolOptions) {
    this.opts = opts;
    const size = opts.size ?? defaultPoolSize();
    for (let i = 0; i < size; i++) this.spawnSlot(i);
    if (typeof document !== "undefined") {
      this.onVisibilityChange = () => {
        if (document.visibilityState === "visible") this.dispatch();
      };
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
  }

  request(
    key: TileKey,
    pageDims: PageDims,
    priority: Priority = "visible",
  ): Promise<RenderedTile> {
    if (this.destroyed) {
      return Promise.reject(new Error("WorkerPool destroyed"));
    }
    const k = tileKeyString(key);
    const existing = this.inflight.get(k);
    if (existing) return existing;

    const promise = new Promise<RenderedTile>((resolve, reject) => {
      this.queue.push({
        key,
        pageDims,
        priority,
        resolve,
        reject,
        enqueuedAt: performance.now(),
      });
      this.dispatch();
    });
    this.inflight.set(k, promise);
    // Use .then(resolve, reject) for cleanup. .finally returns a NEW Promise
    // that adopts rejections — without a .catch chained to it the rejection
    // becomes "unhandled" (visible in the DevTools console). Doing the
    // cleanup via two-arg .then keeps every rejection consumed by *some*
    // handler in this file. Callers still get the original `promise`.
    const cleanup = () => this.inflight.delete(k);
    promise.then(cleanup, cleanup);
    return promise;
  }

  /**
   * Drop pending requests where `filter(key) === true`. Also marks any
   * in-flight slot whose busy item matches as cancelled — its result will be
   * dropped on arrival (and the bitmap closed) instead of resolving the
   * caller's promise. The slot itself is NOT killed; it stays alive for the
   * next tile so we don't pay mupdf re-init for every viewport change.
   */
  cancel(filter: (key: TileKey) => boolean): void {
    this.queue = this.queue.filter((item) => {
      if (filter(item.key)) {
        item.reject(new Error("Tile request cancelled"));
        return false;
      }
      return true;
    });
    for (const slot of this.slots) {
      if (!slot || !slot.busy || slot.busyCancelled) continue;
      if (filter(slot.busy.key)) {
        slot.busyCancelled = true;
        slot.busy.reject(new Error("Tile request cancelled"));
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.onVisibilityChange && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
      this.onVisibilityChange = null;
    }
    for (const slot of this.slots) {
      if (slot.timer) clearTimeout(slot.timer);
      slot.worker.terminate();
      if (slot.busy) slot.busy.reject(new Error("WorkerPool destroyed"));
    }
    this.slots = [];
    for (const item of this.queue) item.reject(new Error("WorkerPool destroyed"));
    this.queue = [];
    this.inflight.clear();
  }

  // ─── Internals ──────────────────────────────────────────────────────

  private spawnSlot(id: number): void {
    const worker = new Worker(
      new URL("./tileRender.worker.ts", import.meta.url),
      { type: "module" },
    );
    const slot: WorkerSlot = {
      id,
      worker,
      ready: false,
      knownDocIds: new Set(),
      busy: null,
      timer: null,
      nextRequestId: 0,
      busyCancelled: false,
    };
    worker.onmessage = (e: MessageEvent<TileWorkerResponse>) =>
      this.onMessage(slot, e.data);
    worker.onerror = (e) => {
      console.warn(`WorkerPool slot ${id} crashed:`, e.message);
      this.killAndRespawn(slot);
    };
    worker.postMessage({ type: "init" } satisfies TileWorkerRequest);
    this.slots[id] = slot;
  }

  private killAndRespawn(slot: WorkerSlot): void {
    if (slot.timer) clearTimeout(slot.timer);
    slot.worker.terminate();
    if (slot.busy) {
      // Don't double-reject — cancel() may have already settled this caller.
      if (!slot.busyCancelled) {
        slot.busy.reject(new Error("Worker terminated"));
      }
      slot.busy = null;
      slot.busyCancelled = false;
    }
    if (this.destroyed) return;
    this.spawnSlot(slot.id);
    this.dispatch();
  }

  private onMessage(slot: WorkerSlot, msg: TileWorkerResponse): void {
    if (msg.type === "ready") {
      slot.ready = true;
      this.dispatch();
      return;
    }
    if (msg.type === "tileResult") {
      const item = slot.busy;
      const cancelled = slot.busyCancelled;
      if (slot.timer) {
        clearTimeout(slot.timer);
        slot.timer = null;
      }
      slot.busy = null;
      slot.busyCancelled = false;
      if (cancelled) {
        // Caller already received a "Tile request cancelled" rejection from
        // the cancel() call. Close the now-orphaned bitmap to free its GPU
        // memory promptly instead of waiting for GC.
        try {
          msg.bitmap.close();
        } catch {}
      } else if (item) {
        const pdfRect = tilePdfRect(msg.key, item.pageDims);
        item.resolve({
          key: msg.key,
          bitmap: msg.bitmap,
          pdfRect,
          pixelWidth: msg.pixelWidth,
          pixelHeight: msg.pixelHeight,
        });
      }
      this.dispatch();
      return;
    }
    if (msg.type === "error") {
      const item = slot.busy;
      const cancelled = slot.busyCancelled;
      if (slot.timer) {
        clearTimeout(slot.timer);
        slot.timer = null;
      }
      slot.busy = null;
      slot.busyCancelled = false;
      // If the caller was already cancelled they have their rejection;
      // don't reject twice.
      if (item && !cancelled) item.reject(new Error(msg.message));

      // Mirror PDFRenderer.ts:114–126 — malloc failures poison the wasm heap.
      // Restart the worker; without this, every subsequent render in this
      // worker will fail with the same error.
      if (msg.message && /malloc|out of memory|out_of_memory/i.test(msg.message)) {
        console.warn(
          `WorkerPool slot ${slot.id}: malloc failure, restarting worker`,
        );
        this.killAndRespawn(slot);
        return;
      }
      this.dispatch();
      return;
    }
  }

  private dispatch(): void {
    if (this.destroyed || this.queue.length === 0) return;
    // Pause when the tab is hidden — backgrounded tabs shouldn't burn render
    // budget. Pending requests stay queued; visibilitychange re-dispatches.
    // Already-busy slots are allowed to finish their current tile.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }

    // Visible first, then by FIFO insertion order.
    this.queue.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority === "visible" ? -1 : 1;
      return a.enqueuedAt - b.enqueuedAt;
    });

    for (const slot of this.slots) {
      if (!slot || !slot.ready || slot.busy) continue;
      const next = this.queue.shift();
      if (!next) return;
      this.assign(slot, next);
    }
  }

  private assign(slot: WorkerSlot, item: QueueItem): void {
    slot.busy = item;
    const id = slot.nextRequestId++;
    const needsData = !slot.knownDocIds.has(item.key.docId);
    if (needsData) slot.knownDocIds.add(item.key.docId);
    const data = needsData ? this.opts.pdfDataFor(item.key.docId) : undefined;

    slot.timer = setTimeout(() => {
      console.warn(
        `WorkerPool: tile timeout (worker=${slot.id} key=${tileKeyString(item.key)})`,
      );
      this.killAndRespawn(slot);
    }, WORKER_RENDER_TIMEOUT_MS);

    const msg: TileWorkerRequest = {
      type: "renderTile",
      id,
      key: item.key,
      pageDims: item.pageDims,
      data,
    };
    // No transfer list: structured-clone the bytes so the main-thread copy
    // remains usable for the next worker. SharedArrayBuffer is a phase-7
    // optimization (requires COOP/COEP headers, currently not configured).
    slot.worker.postMessage(msg);
  }
}
