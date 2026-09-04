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

/** How long to wait for the encode worker before falling back to main. */
const ENCODE_TIMEOUT_MS = 30_000;

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

// ── encode worker (lazily spawned, reused for the life of the tab) ──────────

let worker: Worker | null = null;
let workerDead = false;
let seq = 0;
const pending = new Map<number, (r: Blob | null) => void>();

function ensureWorker(): Worker | null {
  if (workerDead) return null;
  if (worker) return worker;
  try {
    const w = new Worker(new URL("./rasterEncode.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<RasterEncodeResponse>) => {
      const msg = e.data;
      const resolve = pending.get(msg.id);
      if (!resolve) return;
      pending.delete(msg.id);
      resolve("blob" in msg ? msg.blob : null);
    };
    // A crashed worker must not hang a commit: fail everything outstanding and
    // stop trying (every later encode takes the main-thread path).
    w.onerror = () => {
      for (const [, resolve] of pending) resolve(null);
      pending.clear();
      try { w.terminate(); } catch { /* ignore */ }
      if (worker === w) worker = null;
      workerDead = true;
    };
    worker = w;
    return w;
  } catch {
    workerDead = true;
    return null;
  }
}

/** Release the encode worker. Safe to call when none was ever spawned. */
export function disposeRasterEncoder(): void {
  if (worker) {
    try { worker.terminate(); } catch { /* ignore */ }
    worker = null;
  }
  for (const [, resolve] of pending) resolve(null);
  pending.clear();
  workerDead = false;
}

function encodeInWorker(imageData: ImageData): Promise<Blob | null> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(null);
  return new Promise<Blob | null>((resolve) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, ENCODE_TIMEOUT_MS);
    pending.set(id, (blob) => { clearTimeout(timer); resolve(blob); });
    const req: RasterEncodeRequest = {
      id,
      width: imageData.width,
      height: imageData.height,
      data: imageData.data,
    };
    try {
      // Transfer: the caller must not touch `imageData` afterwards.
      w.postMessage(req, [imageData.data.buffer]);
    } catch {
      clearTimeout(timer);
      pending.delete(id);
      resolve(null);
    }
  });
}

/** Main-thread `<canvas>` encode — the fallback when no worker is available. */
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
    // jsdom and very old webviews: fall back to the synchronous data URL and
    // wrap it, still refusing the empty "data:," WebKit returns over the cap.
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
 * Encode one tile raster to a PNG Blob: in the worker when it is available
 * (pixel buffer transferred, main thread untouched), on the main thread
 * otherwise. Returns null when the PNG could not be produced — callers surface
 * that as a visible error tile, never as an empty one.
 *
 * NOTE the worker path TRANSFERS `imageData.data`; treat `imageData` as
 * consumed once this is called.
 */
export async function encodeTileRasterPng(imageData: ImageData): Promise<Blob | null> {
  if (!imageData || !imageData.data || imageData.width < 1 || imageData.height < 1) return null;
  const viaWorker = await encodeInWorker(imageData);
  if (viaWorker) return viaWorker;
  // The worker path detaches the buffer on transfer, so a main-thread retry is
  // only possible when the transfer never happened (no worker, or postMessage
  // threw). `data.length === 0` is the detached case.
  if (imageData.data.length === 0) return null;
  return encodeOnMainThread(imageData);
}
