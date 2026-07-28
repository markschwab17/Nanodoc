/**
 * Main-thread OCR CLIENT. All tesseract/canvas work lives in ocr.worker.ts; this
 * module is pure message plumbing to that worker and does ZERO computation on the
 * main thread (so OCR can never starve the modal's own page-render loop):
 *
 *   - `recognize(image)` — used by the live (non-probe) auto-align path — is a
 *     thin request/reply over the OCR worker, returning [] on failure/timeout.
 *   - `attachOcrRpc(probeWorker)` FORWARDS the probe worker's `{kind:"ocr-req"}`
 *     frames to the OCR worker (re-transferring the pixel buffer) and relays the
 *     `{kind:"ocr-res"}` reply back — again, no canvas, no tesseract on main.
 *
 * Both callers share ONE OCR worker and ONE main-side id space, so a live
 * recognize() and a forwarded probe request can never cross-resolve.
 *
 * Testable in vitest: no tesseract/DOM imports here (they moved to the worker);
 * only `Worker`, which tests mock.
 */

export interface RawImage { width: number; height: number; data: Uint8ClampedArray }
export interface OcrWord {
  text: string;
  confidence: number; // 0..100
  bbox: { x0: number; y0: number; x1: number; y1: number }; // px in the recognized image
}

const OCR_TIMEOUT_MS = 30_000;

// One OCR worker, lazily spawned, shared by recognize() and the probe forwarder.
let ocrWorker: Worker | null = null;
let ocrSeq = 0;
// id → resolver for a live recognize() call.
const pending = new Map<number, (words: OcrWord[]) => void>();
// id → where to relay a forwarded probe reply.
const forwardMap = new Map<number, { target: Worker; probeOcrId: number }>();

function ensureOcrWorker(): Worker {
  if (!ocrWorker) {
    const w = new Worker(new URL("./ocr.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<{ ocrId: number; words: OcrWord[] }>) => {
      const { ocrId, words } = e.data;
      const resolve = pending.get(ocrId);
      if (resolve) { pending.delete(ocrId); resolve(words ?? []); return; }
      const fwd = forwardMap.get(ocrId);
      if (fwd) { forwardMap.delete(ocrId); fwd.target.postMessage({ kind: "ocr-res", ocrId: fwd.probeOcrId, words: words ?? [] }); }
    };
    // A crashed OCR worker must not hang callers: fail every outstanding job [] and
    // drop the singleton so the next call respawns clean.
    w.onerror = () => {
      for (const [, resolve] of pending) resolve([]);
      pending.clear();
      for (const [, fwd] of forwardMap) fwd.target.postMessage({ kind: "ocr-res", ocrId: fwd.probeOcrId, words: [] });
      forwardMap.clear();
      try { w.terminate(); } catch { /* ignore */ }
      if (ocrWorker === w) ocrWorker = null;
    };
    ocrWorker = w;
  }
  return ocrWorker;
}

/** OCR a raw RGBA raster via the OCR worker. Returns [] on any failure/timeout. */
export async function recognize(image: RawImage): Promise<OcrWord[]> {
  try {
    const worker = ensureOcrWorker();
    const id = ++ocrSeq;
    return await new Promise<OcrWord[]>((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve([]); }, OCR_TIMEOUT_MS);
      pending.set(id, (words) => { clearTimeout(timer); resolve(words); });
      worker.postMessage({ ocrId: id, image }, [image.data.buffer]);
    });
  } catch (err) {
    console.warn("[ocrService] recognize failed:", err);
    return [];
  }
}

/**
 * Answer `{kind:"ocr-req", ocrId, image}` messages from the stitch probe worker
 * by FORWARDING them to the OCR worker and relaying its `{ocrId, words}` reply
 * back as `{kind:"ocr-res", ocrId, words}`. Attach once per probe worker, right
 * after construction. Pure plumbing — no tesseract/canvas on the main thread.
 * A per-request timeout guarantees the probe's own 30s fallback isn't the only
 * safety net and keeps `forwardMap` from leaking if the OCR worker never replies.
 */
export function attachOcrRpc(probeWorker: Worker): void {
  probeWorker.addEventListener("message", (e: MessageEvent<any>) => {
    const d = e.data;
    if (!d || d.kind !== "ocr-req") return;
    const image = d.image as RawImage;
    const ocr = ensureOcrWorker();
    const id = ++ocrSeq;
    forwardMap.set(id, { target: probeWorker, probeOcrId: d.ocrId });
    // Leak/hang guard: if the OCR worker never replies, relay [] and drop the
    // entry. Once the real reply is relayed (onmessage above), forwardMap.delete
    // here returns false, so the timer can't double-send.
    setTimeout(() => {
      if (forwardMap.delete(id)) probeWorker.postMessage({ kind: "ocr-res", ocrId: d.ocrId, words: [] });
    }, OCR_TIMEOUT_MS);
    ocr.postMessage({ ocrId: id, image }, [image.data.buffer]);
  });
}
