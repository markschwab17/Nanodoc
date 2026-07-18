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

let workerPromise: Promise<any> | null = null;

async function ensureWorker(): Promise<any> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker, PSM } = await import("tesseract.js");
      const worker = await createWorker("eng", 1, {
        workerPath: workerUrl,
        corePath: coreUrl,
        langPath: "/ocr",
        gzip: true,
      });
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
      return worker;
    })();
    // A failed init must not poison every later call.
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

/** OCR a raw RGBA raster. Returns [] on any failure (OCR is best-effort). */
export async function recognize(image: RawImage): Promise<OcrWord[]> {
  try {
    const worker = await ensureWorker();
    // ImageData requires Uint8ClampedArray<ArrayBuffer>, not <ArrayBufferLike>
    // (the latter could be SharedArrayBuffer-backed) — same cast used in NativeRenderer.ts.
    const imageData = new ImageData(image.data as unknown as Uint8ClampedArray<ArrayBuffer>, image.width, image.height);
    const { data } = await worker.recognize(imageData);
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
