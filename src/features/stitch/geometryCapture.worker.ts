/**
 * Line-snapping geometry, captured OFF the main thread.
 *
 * The align loupe snaps clicks to captured linework, which means walking the page's
 * paths — on a dense civil sheet that is hundreds of milliseconds of mupdf, and doing
 * it on the main thread froze the cursor exactly while the user was aiming at a line.
 *
 * So it happens here: one worker for the life of the mode, one mupdf document per
 * source file (the bytes are sent once and the worker keeps the document open), and
 * `capturePageGeometry` — the geometry-only path, no glyphs, no reconstruction.
 *
 * The snap GRID is built here too, not just the raw paths: it is all typed arrays, so
 * it transfers to the main thread at zero copy, and building it there would have put a
 * tens-of-milliseconds loop back on the thread this worker exists to protect.
 */

import { capturePageGeometry } from "./autostitch/captureDevice";
import { buildSnapIndex, type SnapIndex } from "./loupeGeometry";

export interface CaptureRequest {
  type: "capture";
  id: number;
  /** Identity of the source file; bytes are only sent the first time. */
  docId: string;
  data?: Uint8Array;
  pageIndex: number;
}

export interface CaptureResult {
  type: "geometry";
  id: number;
  /** The finished snap grid, or null when the page has no strokes worth indexing. */
  index: SnapIndex | null;
}

export interface CaptureError {
  type: "error";
  id: number;
  message: string;
}

export type CaptureMessage = CaptureResult | CaptureError;

let mupdf: any = null;
const docs = new Map<string, any>();

async function ensureMupdf() {
  if (!mupdf) mupdf = (await import("mupdf")).default;
}

/**
 * Requests are serialised. The handler awaits (mupdf import, document open), so two
 * captures for the same file could otherwise interleave — the second finding no open
 * document and no bytes, because the first had already claimed "the bytes are sent".
 */
let chain: Promise<void> = Promise.resolve();

self.onmessage = (event: MessageEvent<CaptureRequest>) => {
  const msg = event.data;
  if (msg?.type !== "capture") return;
  chain = chain.then(() => handle(msg));
};

async function handle(msg: CaptureRequest): Promise<void> {
  try {
    await ensureMupdf();
    let doc = docs.get(msg.docId);
    if (!doc) {
      if (!msg.data) throw new Error("No document bytes for " + msg.docId);
      doc = mupdf.Document.openDocument(msg.data, "application/pdf");
      docs.set(msg.docId, doc);
    }
    let page: any = null;
    let geometry: ReturnType<typeof capturePageGeometry>["geometry"];
    try {
      page = doc.loadPage(msg.pageIndex);
      geometry = capturePageGeometry(mupdf, page).geometry;
    } finally {
      page?.destroy?.();
    }

    const index = geometry.length ? buildSnapIndex(geometry) : null;

    const reply: CaptureResult = { type: "geometry", id: msg.id, index };
    // Every array in the index is the worker's own — hand the buffers over rather
    // than copying a page's worth of geometry across the boundary.
    const transfer = index
      ? [
          index.segs.buffer,
          index.ends.buffer,
          index.cellStart.buffer,
          index.cellItems.buffer,
          index.oversize.buffer,
          index.stamp.buffer,
        ]
      : [];
    (self as unknown as Worker).postMessage(reply, transfer);
  } catch (e) {
    const reply: CaptureError = {
      type: "error",
      id: msg.id,
      message: e instanceof Error ? e.message : String(e),
    };
    (self as unknown as Worker).postMessage(reply);
  }
}
