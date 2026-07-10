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
import { autoStitch } from "./autoStitch";
import { toProbeResult, type ProbeRequest, type ProbeMessage } from "./stitchProbe";

let mupdf: any = null;
async function ensureMupdf() {
  if (!mupdf) mupdf = (await import("mupdf")).default;
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
      res = await autoStitch(mupdf, doc, pageIndices, { userScale });
    } finally {
      doc.destroy?.();
    }
    const msg: ProbeMessage = toProbeResult(res, docId);
    self.postMessage(msg);
  } catch (err) {
    const msg: ProbeMessage = { docId, error: String(err) };
    self.postMessage(msg);
  }
}

self.onmessage = (e: MessageEvent<ProbeRequest>) => {
  latestDocId = e.data.docId;
  queue = queue.then(() => handle(e.data));
};
