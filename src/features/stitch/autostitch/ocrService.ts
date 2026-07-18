/**
 * Main-thread OCR service: a lazy tesseract.js singleton, fully offline
 * (worker/core resolved from the bundle, language data from /ocr/).
 *
 * Runs on the MAIN thread only. The stitch probe worker must NOT import this —
 * it requests OCR over the RPC in `attachOcrRpc` (nested workers are not
 * portable across webviews). Vitest must not import this module either
 * (tesseract.js touches DOM/Worker APIs); all testable math lives in ocrBands.ts.
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

// A tesseract.js scheduler holding two workers: the probe worker fires many
// band OCR requests over the RPC and (before this) they queued behind one
// worker. Two workers let concurrent `ocr-req`s genuinely overlap, roughly
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
      const workers = await Promise.all(
        Array.from({ length: WORKER_COUNT }, () => createWorker("eng", 1, opts))
      );
      for (const worker of workers) {
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
        scheduler.addWorker(worker);
      }
      return scheduler;
    })();
    // A failed init must not poison every later call.
    schedulerPromise.catch(() => { schedulerPromise = null; });
  }
  return schedulerPromise;
}

/** OCR a raw RGBA raster. Returns [] on any failure (OCR is best-effort). */
export async function recognize(image: RawImage): Promise<OcrWord[]> {
  try {
    const scheduler = await ensureScheduler();
    // tesseract.js's worker rejects a raw ImageData posted from the main thread
    // ("Error attempting to read image") — it needs a canvas/image-like source.
    // Draw the raster onto an offscreen canvas and hand that to recognize() instead.
    // ImageData requires Uint8ClampedArray<ArrayBuffer>, not <ArrayBufferLike>
    // (the latter could be SharedArrayBuffer-backed) — same cast used in NativeRenderer.ts.
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(new ImageData(image.data as unknown as Uint8ClampedArray<ArrayBuffer>, image.width, image.height), 0, 0);
    const { data } = await scheduler.addJob("recognize", canvas);
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
 * construction. Failures answer with [] so the worker never hangs.
 */
export function attachOcrRpc(worker: Worker): void {
  worker.addEventListener("message", async (e: MessageEvent<any>) => {
    const d = e.data;
    if (!d || d.kind !== "ocr-req") return;
    const words = await recognize(d.image as RawImage);
    worker.postMessage({ kind: "ocr-res", ocrId: d.ocrId, words });
  });
}
