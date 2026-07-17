/**
 * PDF Render Worker
 *
 * Runs mupdf rendering off the main thread so toPixmap() doesn't block
 * scrolling, panning, or zoom interactions.
 *
 * The worker caches the document — only the first render for a given docId
 * needs to transfer the PDF data.  Subsequent renders for the same doc
 * re-use the already-opened document.
 */

let mupdf: any = null;
let currentDoc: any = null;
let currentDocId: string | null = null;
let cachedData: Uint8Array | null = null;

async function ensureMupdf() {
  if (!mupdf) {
    const mod = await import("mupdf");
    mupdf = mod.default;
  }
}

function openDocument(docId: string, data?: Uint8Array) {
  // Same doc, no fresh bytes → reuse the open document. When `data` IS
  // provided for an already-open docId, the main thread is pushing refreshed
  // bytes after a structural edit — reopen from them.
  if (currentDocId === docId && currentDoc && !data) return;
  const pdfBytes = data ?? cachedData;
  if (!pdfBytes) throw new Error("No PDF data available for document " + docId);
  if (currentDoc) {
    try {
      currentDoc.destroy();
    } catch {
      /* ignore */
    }
  }
  currentDoc = mupdf.Document.openDocument(pdfBytes, "application/pdf");
  currentDocId = docId;
  cachedData = pdfBytes;
}

export type WorkerRequest =
  | { type: "render"; id: number; docId: string; data?: Uint8Array; pageNumber: number; scale: number; rotation: number }
  | { type: "init" };

export interface WorkerRenderResult {
  type: "renderResult";
  id: number;
  width: number;
  height: number;
  buffer: ArrayBuffer;
}

export interface WorkerReady {
  type: "ready";
}

export interface WorkerError {
  type: "error";
  id: number;
  message: string;
}

export type WorkerResponse = WorkerRenderResult | WorkerReady | WorkerError;

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;

  if (msg.type === "init") {
    try {
      await ensureMupdf();
      (self as any).postMessage({ type: "ready" } satisfies WorkerReady);
    } catch (e: any) {
      (self as any).postMessage({ type: "error", id: -1, message: e.message } satisfies WorkerError);
    }
    return;
  }

  if (msg.type === "render") {
    try {
      await ensureMupdf();
      openDocument(msg.docId, msg.data);

      const page = currentDoc.loadPage(msg.pageNumber);

      let matrix = mupdf.Matrix.scale(msg.scale, msg.scale);
      if (msg.rotation !== 0) {
        const rotationMatrix = mupdf.Matrix.rotate(msg.rotation);
        matrix = mupdf.Matrix.concat(matrix, rotationMatrix);
      }

      // RGBA, exclude annotations (rendered by React)
      const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, true, false);

      const width = pixmap.getWidth();
      const height = pixmap.getHeight();
      const pixels = pixmap.getPixels();
      const components = pixmap.getNumberOfComponents();
      const numPixels = width * height;

      // Build RGBA buffer
      let buffer: ArrayBuffer;
      if (components === 4) {
        buffer = new ArrayBuffer(numPixels * 4);
        new Uint8ClampedArray(buffer).set(pixels.subarray(0, numPixels * 4));
      } else if (components === 3) {
        buffer = new ArrayBuffer(numPixels * 4);
        const dst = new Uint8ClampedArray(buffer);
        for (let i = 0; i < numPixels; i++) {
          const s = i * 3;
          const d = i * 4;
          dst[d] = pixels[s];
          dst[d + 1] = pixels[s + 1];
          dst[d + 2] = pixels[s + 2];
          dst[d + 3] = 255;
        }
      } else {
        throw new Error(`Unsupported color components: ${components}`);
      }

      const result: WorkerRenderResult = { type: "renderResult", id: msg.id, width, height, buffer };
      (self as any).postMessage(result, [buffer]); // Transfer buffer (zero-copy)
    } catch (e: any) {
      (self as any).postMessage({ type: "error", id: msg.id, message: e.message } satisfies WorkerError);
    }
  }
};
