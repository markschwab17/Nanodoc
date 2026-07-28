/**
 * OCR worker: owns the tesseract.js scheduler and does ALL raster→text work off
 * the main thread. It receives `{ocrId, image: RawImage}` (the pixel buffer is
 * transferred, not copied) and replies `{ocrId, words}`. All canvas work
 * (OffscreenCanvas) happens here — the main thread never touches a canvas for
 * OCR, so the modal's own page-render loop is never starved by OCR.
 *
 * Offline: the tesseract worker/core are resolved from the bundle (no CDN) and
 * language data from /ocr/. tesseract.js spawns its OWN nested worker from
 * `workerPath`; nested workers are supported in Chrome, which is all this app
 * targets.
 */
// Vite turns these into bundled asset URLs — no CDN at runtime.
// (If a path 404s after a tesseract.js upgrade, check `ls node_modules/tesseract.js/dist`.)
import workerUrl from "tesseract.js/dist/worker.min.js?url";
import coreUrl from "tesseract.js-core/tesseract-core-simd.wasm.js?url";
import type { OcrWord, RawImage } from "./ocrService";

// A tesseract.js scheduler holding two workers: the probe fires many band-OCR
// requests and two workers let concurrent jobs genuinely overlap, roughly
// halving band-OCR wall time on plan-dense sets.
let schedulerPromise: Promise<any> | null = null;
const WORKER_COUNT = 2;

async function ensureScheduler(): Promise<any> {
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

/** OCR a raw RGBA raster inside the worker. Returns [] on any failure. */
async function recognizeInWorker(image: RawImage): Promise<OcrWord[]> {
  const scheduler = await ensureScheduler();
  // tesseract.js rejects a raw ImageData ("Error attempting to read image") — it
  // needs a canvas/image-like source. In a worker the equivalent of the main
  // thread's <canvas> is an OffscreenCanvas; tesseract.js 5.x's loadImage()
  // handles OffscreenCanvas (convertToBlob) directly. No document, no main thread.
  // ImageData requires Uint8ClampedArray<ArrayBuffer>, not <ArrayBufferLike>
  // (the latter could be SharedArrayBuffer-backed) — same cast used in NativeRenderer.ts.
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(new ImageData(image.data as unknown as Uint8ClampedArray<ArrayBuffer>, image.width, image.height), 0, 0);
  const { data } = await scheduler.addJob("recognize", canvas);
  const words: OcrWord[] = [];
  for (const w of data.words ?? []) {
    if (!w.text?.trim()) continue;
    words.push({ text: w.text.trim(), confidence: w.confidence, bbox: { ...w.bbox } });
  }
  return words;
}

self.onmessage = async (e: MessageEvent<{ ocrId: number; image: RawImage }>) => {
  const { ocrId, image } = e.data;
  let words: OcrWord[] = [];
  try {
    words = await recognizeInWorker(image);
  } catch (err) {
    console.warn("[ocr.worker] recognize failed:", err);
    words = [];
  }
  (self as any).postMessage({ ocrId, words });
};
