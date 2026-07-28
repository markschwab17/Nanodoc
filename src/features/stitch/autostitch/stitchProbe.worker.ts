/**
 * Stitch feasibility probe worker.
 *
 * Runs the SAME deterministic aligner that "Add & auto-align" runs, once, in a
 * worker with its OWN mupdf document (mupdf docs are not safe to share with the
 * modal's thumbnail-render loop). The result feeds the button's feasibility gate
 * and is committed verbatim on click, so the heavy stitch runs once, not twice.
 *
 * Mirrors the mupdf-in-worker init pattern of src/core/pdf/tiles/tileRender.worker.ts.
 */
import { autoStitch, AutoStitchAborted } from "./autoStitch";
import { toProbeResult, type ProbeRequest, type ProbeMessage } from "./stitchProbe";
import type { OcrWord, RawImage } from "./ocrService";

let mupdf: any = null;
async function ensureMupdf() {
  if (!mupdf) mupdf = (await import("mupdf")).default;
}

// Cooperative-abort target. A plain "Add pages" click posts {kind:"abort", docId};
// the running autoStitch for that docId then throws AutoStitchAborted at its next
// checkpoint. Only the CURRENT probe's docId is tracked (probes are serialized).
let abortDocId = 0;

// ── OCR over RPC to the main thread (tesseract cannot nest here portably) ──
let ocrSeq = 0;
const ocrPending = new Map<number, (words: OcrWord[]) => void>();
const OCR_TIMEOUT_MS = 30_000;
function ocrViaMain(image: RawImage): Promise<OcrWord[]> {
  return new Promise((resolve) => {
    const id = ++ocrSeq;
    const timer = setTimeout(() => { ocrPending.delete(id); resolve([]); }, OCR_TIMEOUT_MS);
    ocrPending.set(id, (words) => { clearTimeout(timer); resolve(words); });
    (self as any).postMessage({ kind: "ocr-req", ocrId: id, image }, [image.data.buffer]);
  });
}

// A persistent worker can receive a new document (rapid "Change file") while a
// prior probe is still running. Chain each request onto the previous so two
// autoStitch passes never interleave on the shared mupdf WASM instance, and skip
// any request already superseded by a newer docId before it starts.
let latestDocId = 0;
let queue: Promise<void> = Promise.resolve();

async function handle(req: ProbeRequest) {
  const { docId, pdfBytes, pageIndices, userScale } = req;
  if (docId !== latestDocId) return; // superseded before we started — skip
  try {
    await ensureMupdf();
    const doc = mupdf.Document.openDocument(pdfBytes, "application/pdf");
    let res;
    try {
      res = await autoStitch(mupdf, doc, pageIndices, {
        userScale,
        ocr: ocrViaMain,
        shouldAbort: () => abortDocId === docId,
        onOcrStart: () => self.postMessage({ kind: "ocrPhase", docId }),
      });
    } finally {
      doc.destroy?.();
    }
    const msg: ProbeMessage = toProbeResult(res, docId);
    self.postMessage(msg);
  } catch (err) {
    // An abort is not a failure — report it as skipped so the modal shows no toast.
    const msg: ProbeMessage = err instanceof AutoStitchAborted
      ? { docId, aborted: true }
      : { docId, error: String(err) };
    self.postMessage(msg);
  }
}

self.onmessage = (e: MessageEvent<any>) => {
  if (e.data && e.data.kind === "ocr-res") {
    const cb = ocrPending.get(e.data.ocrId);
    ocrPending.delete(e.data.ocrId);
    cb?.(e.data.words as OcrWord[]);
    return;
  }
  if (e.data && e.data.kind === "abort") {
    // Stop the running (or queued) probe for this docId at its next checkpoint.
    abortDocId = e.data.docId;
    return;
  }
  latestDocId = (e.data as ProbeRequest).docId;
  // .catch keeps the chain self-healing: handle() cannot reject today, but a
  // future edit that let it throw would otherwise poison every later request
  // (the tail would stay a rejected promise → permanent worker death).
  queue = queue.then(() => handle(e.data as ProbeRequest)).catch(() => {});
};
