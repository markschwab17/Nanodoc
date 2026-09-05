/**
 * Main-thread OCR service.
 *
 * Portability rule: the tesseract workers are created HERE, on the MAIN thread
 * — nested workers (tesseract spawned from inside another worker) are not
 * portable to WKWebView (macOS) / WebKitGTK (Linux), the Tauri webviews this app
 * packages for, and their failure is silent. So tesseract stays on main.
 *
 * To keep the main thread free (OCR must never starve the modal's own
 * page-render loop), the heavy raster→image conversion runs in ocr.worker.ts:
 * `recognize()` transfers the pixel buffer to that CONVERSION worker, gets a
 * cheap Blob back, and hands it to the OCR pool — tesseract then posts the Blob
 * to its own (main-owned, non-nested) worker. The only main-thread cost is the
 * postMessage/queue calls.
 *
 * The pool itself is `ocrPool.ts`, shared verbatim with the Node eval harness:
 * a FIFO queue over POOL_SIZE lazily-created workers, with each job's timeout
 * measured from DISPATCH rather than from queueing, and a timeout retiring only
 * the one worker that hung. It replaced tesseract's `createScheduler`, whose
 * queue-time timeout and all-or-nothing recycle threw away every queued job
 * whenever a single crop was slow.
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
import { createOcrPool, defaultOcrPoolSize, OCR_NO_RESULT, type OcrPool } from "./ocrPool";

export interface RawImage { width: number; height: number; data: Uint8ClampedArray }
export interface OcrWord {
  text: string;
  confidence: number; // 0..100
  bbox: { x0: number; y0: number; x1: number; y1: number }; // px in the recognized image
}

const OCR_TIMEOUT_MS = 30_000;

// Recognition-job timeout (ms) — bounds ONE job from the moment a pool worker
// picks it up (separate from OCR_TIMEOUT_MS's use for the conversion-worker
// RPC). Because it starts at dispatch, not at queueing, a job that waited
// behind three others still gets its full budget; 20s is comfortably above the
// slowest real band-OCR we have measured and well below "the user gave up".
// Overridable only via __setOcrJobTimeoutMsForTest so production always uses
// OCR_JOB_TIMEOUT_MS; kept as its own mutable binding (rather than exporting
// the constant directly) because ESM named exports are read-only bindings — a
// test importer cannot reassign them.
const OCR_JOB_TIMEOUT_MS = 20_000;
let ocrJobTimeoutMs = OCR_JOB_TIMEOUT_MS;

/** Test-only: shorten the recognition-job timeout so hang tests don't wait the real 20s. */
export function __setOcrJobTimeoutMsForTest(ms: number): void {
  ocrJobTimeoutMs = ms;
}

// ── tesseract worker pool (MAIN thread) ────────────────────────────────────
// The probe fires many band-OCR requests; several workers let them genuinely
// overlap instead of queueing behind one another.
let pool: OcrPool<Blob, any> | null = null;

/** Boot one configured tesseract worker (the pool's per-worker init). */
async function createTesseractWorker(): Promise<{ recognize(input: Blob): Promise<any>; terminate(): unknown }> {
  const { createWorker, PSM } = await import("tesseract.js");
  const worker = await createWorker("eng", 1, {
    workerPath: workerUrl,
    corePath: coreUrl,
    langPath: "/ocr",
    gzip: true,
  });
  try {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
  } catch (err) {
    // A worker that came up but couldn't be configured still holds a live Web
    // Worker + wasm instance — don't leak it just because init failed.
    try { await worker.terminate(); } catch { /* ignore */ }
    throw err;
  }
  return worker as unknown as { recognize(input: Blob): Promise<any>; terminate(): unknown };
}

function ensurePool(): OcrPool<Blob, any> {
  if (!pool) {
    pool = createOcrPool<Blob, any>({
      size: defaultOcrPoolSize(),
      createWorker: createTesseractWorker,
      // Read per dispatch so __setOcrJobTimeoutMsForTest applies to jobs the
      // already-built pool dispatches later.
      timeoutMs: () => ocrJobTimeoutMs,
      onTimeout: () => console.warn("[ocrService] recognize job timed out — retiring that worker"),
    });
  }
  return pool;
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
 *  - ocrJobTimeoutMs bounds the recognition job itself, from the moment a pool
 *    worker picks it up. Without it a hung tesseract job never settles: the
 *    direct auto-align path would spin forever, and — worse — the hang would
 *    permanently pin one of the pool's slots, so repeated hangs quietly degrade
 *    OCR until every slot is stuck and OCR is silently dead. On timeout this
 *    call resolves [] and the pool retires just that worker (see ocrPool.ts).
 *
 * `signal`: aborting drops a still-queued job outright (it never runs) and
 * makes an in-flight one's result be ignored; either way the call resolves [].
 *
 * `onNoResult`: fired when the pool answered OCR_NO_RESULT and the caller did NOT
 * abort — i.e. this read is a NON-ANSWER (the job blew its 20 s budget, or the pool
 * was torn down under it), not a crop that genuinely holds no text. The return type
 * stays `OcrWord[]` and stays `[]`, so every existing caller is unaffected; the hook
 * exists because `autoStitch` needs to tell the two apart to decide whether a band
 * is worth re-reading as sub-clips, and `[]` cannot carry that. A conversion or
 * transport THROW is deliberately not reported here — it is a broken pipe, not a
 * band that was too big, and re-rastering it four times would not help.
 */
export async function recognize(
  image: RawImage,
  opts?: { signal?: AbortSignal; onNoResult?: () => void },
): Promise<OcrWord[]> {
  try {
    // Kick the first worker's boot off BEFORE converting, so the wasm+traineddata
    // load overlaps the raster→Blob round-trip instead of following it.
    const jobs = ensurePool();
    jobs.prewarm();
    const blob = await imageToBlob(image);
    // Conversion is not free (a PNG encode per band), and the probe now issues a
    // whole page of them at once — so re-check before queueing rather than letting
    // the pool drop an already-converted job.
    if (opts?.signal?.aborted) return [];

    const result = await jobs.run(blob, { signal: opts?.signal });
    if (result === OCR_NO_RESULT) {
      // Timed out, aborted, or torn down. An ABORT is the caller's own doing and
      // must not look like a failed read (it would have the aligner retry work it
      // has just given up on), so only the other two are reported.
      if (!opts?.signal?.aborted) opts?.onNoResult?.();
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
 * Release the OCR pool and the conversion worker.
 *
 * The pool holds up to POOL_SIZE real Web Workers, each with the tesseract SIMD
 * WASM heap plus the `eng` traineddata — 80-120 MB apiece — and it used to be
 * held for the rest of the session the moment any probe touched OCR, whether or
 * not another sheet was ever read. Callers therefore shut it down when their OCR
 * work is finished (the probe settles, the plan run ends, the modal closes);
 * `ensurePool` builds a fresh one lazily on the next `recognize`, so shutting
 * down is never destructive, only a cost the next caller pays once.
 *
 * Best-effort and idempotent: it never throws, and tearing down with jobs still
 * queued or in flight simply makes those `recognize` calls resolve `[]`, which
 * every caller already treats as "no words".
 */
export async function shutdownOcr(): Promise<void> {
  // BOTH singletons are detached BEFORE the first await. Terminating the pool is
  // asynchronous, and a `recognize()` that starts during that window must find
  // the module state already empty and build itself a fresh pool and conversion
  // worker — not adopt the ones being torn down and then have them terminated
  // underneath it.
  const dyingPool = pool;
  const worker = convWorker;
  pool = null;
  convWorker = null;
  if (worker) {
    // Anything still waiting on a conversion will never be answered now.
    for (const [, resolve] of convPending) resolve(null);
    convPending.clear();
    try { worker.terminate(); } catch { /* ignore */ }
  }
  if (dyingPool) {
    try { await dyingPool.terminate(); } catch { /* already dead, or never initialised */ }
  }
}

/**
 * Answer `{kind:"ocr-req", ocrId, image}` messages from the stitch probe worker
 * with `{kind:"ocr-res", ocrId, words}`. Attach once per worker, right after
 * construction. Each request runs the full pipeline (conversion worker → blob →
 * main-thread OCR pool) independently, so replies stay paired to their probe
 * ocrId even when they complete out of order. Failures answer with [] so the
 * probe worker never hangs.
 *
 * `{kind:"ocr-abort", ocrId}` cancels one outstanding request. The probe sends it
 * when its run is aborted, and it has to reach the POOL rather than merely be
 * ignored on arrival: the probe issues a whole page of band reads at once, so an
 * abandoned run leaves dozens of jobs sitting in the pool's queue — and a queued
 * job has no deadline of its own. Aborting drops the queued ones outright.
 *
 * The reply carries `noResult` when `recognize` reported a NON-ANSWER (see its
 * `onNoResult`). It rides along on the existing message rather than as a second
 * one so the reply stays a single settle per ocrId.
 */
export function attachOcrRpc(probeWorker: Worker): void {
  const outstanding = new Map<number, AbortController>();
  probeWorker.addEventListener("message", async (e: MessageEvent<any>) => {
    const d = e.data;
    if (d && d.kind === "ocr-abort") {
      const ctrl = outstanding.get(d.ocrId);
      outstanding.delete(d.ocrId);
      ctrl?.abort();
      return;
    }
    if (!d || d.kind !== "ocr-req") return;
    const ctrl = new AbortController();
    outstanding.set(d.ocrId, ctrl);
    let words: OcrWord[];
    let noResult = false;
    try {
      words = await recognize(d.image as RawImage, {
        signal: ctrl.signal,
        onNoResult: () => { noResult = true; },
      });
    } finally {
      outstanding.delete(d.ocrId);
    }
    // The probe has already resolved this id with [] and stopped listening for it;
    // a late reply would only be dropped there, so don't send one.
    if (ctrl.signal.aborted) return;
    probeWorker.postMessage({ kind: "ocr-res", ocrId: d.ocrId, words, noResult });
  });
}
