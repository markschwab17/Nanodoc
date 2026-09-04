/**
 * Tile-raster sizing and PNG encoding.
 *
 * Two jobs, both about what a commit costs the tab:
 *
 *  1. `tileRenderScale` caps how big a sheet is ever rasterised. A flat 1.5x on
 *     a 36x24 in sheet is 3888x2592 = 10.1 MP, and every copy of that page —
 *     the mupdf pixmap, the ImageData, the canvas backing store, the decoded
 *     bitmap behind the <img> — is 40 MB. Capping the long edge at 3072 px is
 *     24 MB a copy for pixels the user cannot see at any sane zoom, and it puts
 *     a 30x42 in sheet (4536 px at 1.5x) back under WebKit's 4096-px-per-side
 *     canvas ceiling, where `toDataURL` silently returns `"data:,"`.
 *
 *  2. `encodeTileRasterPng` gets the PNG encode off the main thread. Vector
 *     export is untouched by both: `stitchExport` re-renders from
 *     `sourcePdfBytes` at its own budget and only falls back to the stored
 *     raster for erased / stamp / vector-fail tiles.
 *
 * THE BUFFER IS NEVER DETACHED. An earlier version transferred
 * `imageData.data.buffer` into the worker, which is free and tidy right up to
 * the first failure: on a webview without `OffscreenCanvas.convertToBlob` the
 * worker replies "error" having already taken the pixels, the main-thread
 * fallback has nothing left to encode, and EVERY sheet in the commit becomes an
 * error card. The buffer is copied instead, so the caller still holds the
 * pixels and every failure path — incapable worker, encode error, timeout —
 * can fall back. The price is one extra copy of the raster (24 MB for a 36x24
 * in sheet) alive for the ~300 ms the encode takes; the capability handshake
 * means an incapable worker costs no copy and no round-trip at all.
 */
import type { RasterEncodeRequest, RasterEncodeResponse } from "./rasterEncode.worker";

/** The scale a tile raster would use with no cap at all. */
export const TILE_RENDER_SCALE = 1.5;

/** Longest edge, in pixels, any tile raster may have. */
export const TILE_LONG_EDGE_PX = 3072;

/**
 * Hard ceiling on a canvas side. WebKit (Safari, and the WKWebView /
 * WebKitGTK that Tauri packages) caps canvas dimensions near 4096 px per side
 * on some builds and fails by returning an EMPTY image rather than throwing.
 * Nothing this module produces may cross it.
 */
export const CANVAS_MAX_SIDE_PX = 4096;

/** How long to wait for one encode before giving up on the worker entirely. */
const ENCODE_TIMEOUT_MS = 30_000;

/** How long to wait for the worker's `{kind:"ready"}` before writing it off. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Render scale for one page: 1.5x, reduced until the long edge fits
 * `TILE_LONG_EDGE_PX`, and never large enough to put either side past
 * `CANVAS_MAX_SIDE_PX`. Pure.
 */
export function tileRenderScale(widthPt: number, heightPt: number): number {
  const longPt = Math.max(widthPt, heightPt);
  if (!(longPt > 0) || !Number.isFinite(longPt)) return TILE_RENDER_SCALE;
  return Math.min(
    TILE_RENDER_SCALE,
    TILE_LONG_EDGE_PX / longPt,
    CANVAS_MAX_SIDE_PX / longPt,
  );
}

// ── encode worker (lazily spawned, reused for the life of the session) ──────

let worker: Worker | null = null;
/** Resolves true once the worker has PROVEN it can encode; false if it cannot,
 *  never started, died, or failed a job. Null before the first attempt. */
let capability: Promise<boolean> | null = null;
let seq = 0;
const pending = new Map<number, (r: Blob | null) => void>();

/** Terminate the worker and route everything, now and later, to the main
 *  thread. Called on a spawn failure, a worker error, a failed encode (the next
 *  page must not repeat a doomed round-trip) and an encode timeout. */
function retireWorker(): void {
  if (worker) {
    try { worker.terminate(); } catch { /* ignore */ }
    worker = null;
  }
  for (const [, resolve] of pending) resolve(null);
  pending.clear();
  capability = Promise.resolve(false);
}

/**
 * Spawn the worker (once) and wait for its capability handshake. Resolves
 * false — permanently, for this session — when there is no worker, no
 * `OffscreenCanvas.convertToBlob`, or no answer within HANDSHAKE_TIMEOUT_MS.
 */
function ensureCapableWorker(): Promise<boolean> {
  if (capability) return capability;
  capability = new Promise<boolean>((resolve) => {
    let w: Worker;
    try {
      w = new Worker(new URL("./rasterEncode.worker.ts", import.meta.url), { type: "module" });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const settle = (capable: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!capable) { try { w.terminate(); } catch { /* ignore */ } if (worker === w) worker = null; }
      resolve(capable);
    };
    const timer = setTimeout(() => settle(false), HANDSHAKE_TIMEOUT_MS);

    w.onmessage = (e: MessageEvent<RasterEncodeResponse>) => {
      const msg = e.data;
      if (msg.kind === "ready") { settle(msg.capable); return; }
      const resolveJob = pending.get(msg.id);
      if (!resolveJob) return;
      pending.delete(msg.id);
      if (msg.kind === "result") { resolveJob(msg.blob); return; }
      // A message-level error means this worker cannot do the job (a partial
      // OffscreenCanvas implementation, an out-of-memory encode). Retire it so
      // the rest of the commit goes straight to the main thread — and resolve
      // null so THIS page falls back too (the caller still has its pixels).
      console.warn("[rasterEncode] worker encode failed, falling back to the main thread:", msg.message);
      resolveJob(null);
      retireWorker();
    };
    w.onerror = () => {
      settle(false);
      retireWorker();
    };
    worker = w;
  });
  return capability;
}

/** Release the encode worker and let a later session spawn a fresh one.
 *  Safe when none was ever created. */
export function disposeRasterEncoder(): void {
  if (worker) {
    try { worker.terminate(); } catch { /* ignore */ }
    worker = null;
  }
  for (const [, resolve] of pending) resolve(null);
  pending.clear();
  capability = null;
}

/** Post one encode to a worker already known to be capable. Null on error or
 *  timeout — the caller's ImageData is untouched either way. */
function encodeInWorker(imageData: ImageData): Promise<Blob | null> {
  const w = worker;
  if (!w) return Promise.resolve(null);
  return new Promise<Blob | null>((resolve) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      console.warn("[rasterEncode] worker encode timed out, falling back to the main thread");
      resolve(null);
      retireWorker();
    }, ENCODE_TIMEOUT_MS);
    pending.set(id, (blob) => { clearTimeout(timer); resolve(blob); });
    const req: RasterEncodeRequest = {
      id,
      width: imageData.width,
      height: imageData.height,
      data: imageData.data,
    };
    try {
      // NO transfer list: the worker gets a copy so this ImageData survives for
      // the fallback. See the module docstring.
      w.postMessage(req);
    } catch {
      clearTimeout(timer);
      pending.delete(id);
      resolve(null);
    }
  });
}

/** Main-thread `<canvas>` encode — the fallback whenever the worker cannot. */
function encodeOnMainThread(imageData: ImageData): Promise<Blob | null> {
  if (
    imageData.width > CANVAS_MAX_SIDE_PX ||
    imageData.height > CANVAS_MAX_SIDE_PX ||
    imageData.width < 1 ||
    imageData.height < 1
  ) {
    // Past the WebKit ceiling `toBlob` returns null and `toDataURL` returns the
    // string "data:," with no error at all — refuse rather than emit a blank.
    return Promise.resolve(null);
  }
  let canvas: HTMLCanvasElement;
  try {
    canvas = document.createElement("canvas");
    canvas.width = imageData.width;
    canvas.height = imageData.height;
  } catch {
    return Promise.resolve(null);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.putImageData(imageData, 0, 0);
  if (typeof canvas.toBlob !== "function") {
    // Very old webviews: the synchronous data URL, still refusing the empty
    // "data:," WebKit returns over the cap.
    try {
      const url = canvas.toDataURL("image/png");
      if (!url || !url.startsWith("data:image/png") || url.length < 32) return Promise.resolve(null);
      const bin = atob(url.slice(url.indexOf(",") + 1));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return Promise.resolve(new Blob([bytes], { type: "image/png" }));
    } catch {
      return Promise.resolve(null);
    }
  }
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob && blob.size > 0 ? blob : null), "image/png");
  });
}

/**
 * Encode one tile raster to a PNG Blob: in the worker when it has proven it
 * can, on the main thread otherwise or whenever the worker fails. Returns null
 * only when NEITHER path could produce a PNG — callers surface that as a
 * visible error tile, never as an empty one.
 *
 * `imageData` is read, never consumed: it is still valid after this resolves.
 */
export async function encodeTileRasterPng(imageData: ImageData): Promise<Blob | null> {
  if (!imageData || !imageData.data || imageData.width < 1 || imageData.height < 1) return null;
  if (await ensureCapableWorker()) {
    const viaWorker = await encodeInWorker(imageData);
    if (viaWorker) return viaWorker;
  }
  return encodeOnMainThread(imageData);
}
