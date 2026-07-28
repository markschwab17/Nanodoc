/**
 * Main-thread OCR service.
 *
 * Portability rule: the tesseract scheduler is created HERE, on the MAIN thread
 * — nested workers (tesseract spawned from inside another worker) are not
 * portable to WKWebView (macOS) / WebKitGTK (Linux), the Tauri webviews this app
 * packages for, and their failure is silent. So tesseract stays on main.
 *
 * To keep the main thread free (OCR must never starve the modal's own
 * page-render loop), the heavy raster→image conversion runs in ocr.worker.ts:
 * `recognize()` transfers the pixel buffer to that CONVERSION worker, gets a
 * cheap Blob back, and hands it to `scheduler.addJob("recognize", blob)` —
 * tesseract then posts the Blob to its own (main-owned, non-nested) worker. The
 * only main-thread cost is the postMessage/addJob calls.
 *
 * Fallback: if the conversion worker can't init (ancient webview without
 * OffscreenCanvas), conversion falls back to a main-thread `<canvas>` (the
 * pre-worker path) so OCR still works — degraded, but never silently dead.
 *
 * Testable in vitest: tesseract.js is imported dynamically (mockable) and the
 * conversion worker is `Worker` (mocked in tests); no top-level DOM work.
 */
// Vite turns these into bundled asset URLs — no CDN at runtime.
// (If a path 404s after a tesseract.js upgrade, check `ls node_modules/tesseract.js/dist`.)
import workerUrl from "tesseract.js/dist/worker.min.js?url";
import coreUrl from "tesseract.js-core/tesseract-core-simd.wasm.js?url";

export interface RawImage { width: number; height: number; data: Uint8ClampedArray }
export interface OcrWord {
  text: string;
  confidence: number; // 0..100
  bbox: { x0: number; y0: number; x1: number; y1: number }; // px in the recognized image
}

const OCR_TIMEOUT_MS = 30_000;

// Recognition-job timeout (ms) — bounds `scheduler.addJob("recognize", …)`
// itself (separate from OCR_TIMEOUT_MS's use for the conversion-worker RPC).
// Overridable only via __setOcrJobTimeoutMsForTest so production always uses
// OCR_TIMEOUT_MS; kept as its own mutable binding (rather than exporting
// OCR_TIMEOUT_MS directly) because ESM named exports are read-only bindings —
// a test importer cannot reassign them.
let ocrJobTimeoutMs = OCR_TIMEOUT_MS;

/** Test-only: shorten the recognition-job timeout so hang tests don't wait the real 30s. */
export function __setOcrJobTimeoutMsForTest(ms: number): void {
  ocrJobTimeoutMs = ms;
}

// ── tesseract scheduler (MAIN thread) ──────────────────────────────────────
// A scheduler holding two workers: the probe fires many band-OCR requests and
// two workers let concurrent jobs genuinely overlap, roughly halving band-OCR
// wall time on plan-dense sets.
let schedulerPromise: Promise<any> | null = null;
const WORKER_COUNT = 2;

// Deliberately NOT `async`: it must return the exact `schedulerPromise`
// object (reference-equal), not a fresh wrapper promise, so callers can later
// compare it by identity (`schedulerPromise === capturedPromise`) to guard a
// timeout-triggered recycle against clobbering a newer scheduler. An `async`
// function always wraps its return value in a new promise, which would break
// that identity check even though it resolves to the same value.
function ensureScheduler(): Promise<any> {
  if (!schedulerPromise) {
    schedulerPromise = (async () => {
      const { createScheduler, createWorker, PSM } = await import("tesseract.js");
      const scheduler = createScheduler();
      const opts = {
        workerPath: workerUrl,
        corePath: coreUrl,
        langPath: "/ocr",
        gzip: true,
      };
      // Track every successfully created worker so a mid-init failure (a later
      // createWorker / setParameters / addWorker throwing) can't leak the ones
      // already spun up — each holds a live Web Worker + wasm instance. Created
      // sequentially so `created` is exact: a rejection can't leave a sibling
      // still resolving into the array after the catch runs (as Promise.all could).
      const created: any[] = [];
      try {
        for (let n = 0; n < WORKER_COUNT; n++) {
          const worker = await createWorker("eng", 1, opts);
          created.push(worker);
          await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
          scheduler.addWorker(worker);
        }
        return scheduler;
      } catch (err) {
        // Best-effort teardown of everything created, then re-throw so the
        // singleton resets (see the .catch below) and a later call retries clean.
        for (const worker of created) {
          try { await worker.terminate(); } catch { /* ignore */ }
        }
        throw err;
      }
    })();
    // A failed init must not poison every later call.
    schedulerPromise.catch(() => { schedulerPromise = null; });
  }
  return schedulerPromise;
}

// ── raster→Blob conversion (CONVERSION worker, off main; main-thread fallback) ─
// OffscreenCanvas in the main realm reliably implies it in the worker realm
// (same engine), so this feature-detect decides the conversion path up front.
const canUseWorkerConversion = typeof OffscreenCanvas !== "undefined";

let convWorker: Worker | null = null;
let convSeq = 0;
// convId → resolver; null means the worker could not produce a blob.
const convPending = new Map<number, (blob: Blob | null) => void>();

function ensureConvWorker(): Worker {
  if (!convWorker) {
    const w = new Worker(new URL("./ocr.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<{ ocrId: number; blob?: Blob; error?: string }>) => {
      const { ocrId, blob, error } = e.data;
      const resolve = convPending.get(ocrId);
      if (resolve) { convPending.delete(ocrId); resolve(error ? null : (blob ?? null)); }
    };
    // A crashed conversion worker must not hang callers: fail every outstanding
    // convert (null) and drop the singleton so the next call respawns clean.
    w.onerror = () => {
      for (const [, resolve] of convPending) resolve(null);
      convPending.clear();
      try { w.terminate(); } catch { /* ignore */ }
      if (convWorker === w) convWorker = null;
    };
    convWorker = w;
  }
  return convWorker;
}

/** Convert a raster to a Blob in the conversion worker (buffer transferred). null on failure. */
function convertViaWorker(image: RawImage): Promise<Blob | null> {
  return new Promise<Blob | null>((resolve) => {
    let worker: Worker;
    try { worker = ensureConvWorker(); } catch { resolve(null); return; }
    const id = ++convSeq;
    const timer = setTimeout(() => { convPending.delete(id); resolve(null); }, OCR_TIMEOUT_MS);
    convPending.set(id, (blob) => { clearTimeout(timer); resolve(blob); });
    worker.postMessage({ ocrId: id, image }, [image.data.buffer]);
  });
}

let warnedMainThreadFallback = false;
/** Main-thread `<canvas>` conversion — the degraded fallback when no OffscreenCanvas. */
function convertOnMainThread(image: RawImage): Promise<Blob> {
  if (!warnedMainThreadFallback) {
    warnedMainThreadFallback = true;
    console.warn("[ocrService] OffscreenCanvas unavailable — converting OCR rasters on the main thread (degraded, but OCR still works)");
  }
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("2d context unavailable"));
  ctx.putImageData(
    new ImageData(image.data as unknown as Uint8ClampedArray<ArrayBuffer>, image.width, image.height),
    0,
    0,
  );
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob returned null"))), "image/png");
  });
}

/** Raster→Blob: conversion worker when available (buffer transferred), else main-thread canvas. */
async function imageToBlob(image: RawImage): Promise<Blob> {
  if (canUseWorkerConversion) {
    const blob = await convertViaWorker(image);
    if (blob) return blob;
    // The worker path already transferred (detached) the buffer, so we can't
    // retry on main for THIS image — surface as a failure ([] up the stack).
    throw new Error("OCR conversion worker failed");
  }
  return convertOnMainThread(image);
}

/**
 * OCR a raw RGBA raster. Returns [] on any failure (OCR is best-effort).
 *
 * Two independent timeouts guard this call:
 *  - OCR_TIMEOUT_MS bounds the conversion-worker RPC (raster → Blob).
 *  - ocrJobTimeoutMs (same 30s default, shortenable in tests) bounds the
 *    `scheduler.addJob("recognize", …)` call itself. Without this, a hung
 *    tesseract job never settles: the direct auto-align path would spin
 *    forever, and — worse — the hang permanently pins one of the scheduler's
 *    WORKER_COUNT slots, so repeated hangs quietly degrade OCR until every
 *    slot is stuck and OCR is silently dead.
 *
 * On a recognition-job timeout we resolve [] for this call AND recycle: the
 * scheduler is terminated best-effort (fire-and-forget, errors swallowed) and
 * the lazy singleton is cleared so the next call reinitializes a clean
 * scheduler. The recycle is guarded by identity — it only runs if the
 * module's scheduler singleton still refers to the exact scheduler THIS call
 * timed out on, so a stale timeout firing after a newer scheduler has since
 * been created (e.g. an earlier hang already recycled and a later call built
 * a fresh one) can never terminate that newer, healthy scheduler.
 */
export async function recognize(image: RawImage): Promise<OcrWord[]> {
  try {
    // Convert (in the worker) and spin up tesseract concurrently. Promise.all
    // attaches handlers to both up front, so if one rejects the other's later
    // settlement can't become an unhandled rejection. Capture the scheduler
    // PROMISE (not just the resolved scheduler) so a later timeout can check,
    // by identity, whether the module singleton still points at it.
    const schedPromise = ensureScheduler();
    const [scheduler, blob] = await Promise.all([schedPromise, imageToBlob(image)]);

    const TIMEOUT = Symbol("ocr-job-timeout");
    let timer: ReturnType<typeof setTimeout>;
    // Promise.race attaches a handler to the losing promise too, so if
    // addJob rejects after the timeout already won, it's still "handled" —
    // no unhandled-rejection warning.
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), ocrJobTimeoutMs);
    });
    const result = await Promise.race([scheduler.addJob("recognize", blob), timeout]);
    clearTimeout(timer!);

    if (result === TIMEOUT) {
      console.warn("[ocrService] recognize job timed out — recycling scheduler");
      // Identity guard: only recycle if no one has already replaced the
      // singleton (see docstring above).
      if (schedulerPromise === schedPromise) {
        schedulerPromise = null;
        try {
          Promise.resolve(scheduler.terminate()).catch(() => { /* best-effort */ });
        } catch { /* best-effort */ }
      }
      return [];
    }

    const { data } = result as { data: { words?: any[] } };
    const words: OcrWord[] = [];
    for (const w of data.words ?? []) {
      if (!w.text?.trim()) continue;
      words.push({ text: w.text.trim(), confidence: w.confidence, bbox: { ...w.bbox } });
    }
    return words;
  } catch (err) {
    console.warn("[ocrService] recognize failed:", err);
    return [];
  }
}

/**
 * Answer `{kind:"ocr-req", ocrId, image}` messages from the stitch probe worker
 * with `{kind:"ocr-res", ocrId, words}`. Attach once per worker, right after
 * construction. Each request runs the full pipeline (conversion worker → blob →
 * main-thread scheduler) independently, so replies stay paired to their probe
 * ocrId even when they complete out of order. Failures answer with [] so the
 * probe worker never hangs.
 */
export function attachOcrRpc(probeWorker: Worker): void {
  probeWorker.addEventListener("message", async (e: MessageEvent<any>) => {
    const d = e.data;
    if (!d || d.kind !== "ocr-req") return;
    const words = await recognize(d.image as RawImage);
    probeWorker.postMessage({ kind: "ocr-res", ocrId: d.ocrId, words });
  });
}
