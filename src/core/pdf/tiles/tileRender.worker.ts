/**
 * Tile Render Worker
 *
 * Renders one PDF tile per request. One worker = one mupdf wasm instance.
 * Caches per-page DisplayList so repeated tiles of the same page skip
 * content-stream re-parsing.
 *
 * Returns ImageBitmap (transferable, zero-copy).
 *
 * Mirrors the worker init handshake and document-bytes-cache pattern from
 * src/core/pdf/pdfRender.worker.ts. The differences:
 *   - renders a sub-rectangle (tile) of the page, not the whole page
 *   - returns ImageBitmap instead of ArrayBuffer
 *   - caches DisplayList per page
 */

import { TILE_SIZE, type TileKey, type PageDims } from "./types";

let mupdf: any = null;
let currentDoc: any = null;
let currentDocId: string | null = null;
let cachedData: Uint8Array | null = null;

const displayListCache = new Map<number, any>();

async function ensureMupdf() {
  if (!mupdf) {
    const mod = await import("mupdf");
    mupdf = mod.default;
  }
}

function dropDisplayLists() {
  for (const list of displayListCache.values()) {
    try {
      list.destroy();
    } catch {}
  }
  displayListCache.clear();
}

function openDocument(docId: string, data?: Uint8Array) {
  if (currentDocId === docId && currentDoc) return;
  dropDisplayLists();
  if (currentDoc) {
    try {
      currentDoc.destroy();
    } catch {}
    currentDoc = null;
  }
  const pdfBytes = data ?? cachedData;
  if (!pdfBytes) {
    throw new Error("No PDF data available for document " + docId);
  }
  currentDoc = mupdf.Document.openDocument(pdfBytes, "application/pdf");
  currentDocId = docId;
  cachedData = pdfBytes;
}

function getDisplayList(pageNumber: number): any {
  const cached = displayListCache.get(pageNumber);
  if (cached) return cached;
  const page = currentDoc.loadPage(pageNumber);
  // showExtras=false: the legacy renderer also uses false (annotations are
  // overlaid by React on top of the bitmap, not baked into it).
  const list = page.toDisplayList(false);
  displayListCache.set(pageNumber, list);
  try {
    page.destroy();
  } catch {}
  return list;
}

export type TileWorkerRequest =
  | { type: "init" }
  | {
      type: "renderTile";
      id: number;
      key: TileKey;
      pageDims: PageDims;
      data?: Uint8Array;
    };

export type TileWorkerResponse =
  | { type: "ready" }
  | {
      type: "tileResult";
      id: number;
      key: TileKey;
      bitmap: ImageBitmap;
      pixelWidth: number;
      pixelHeight: number;
    }
  | { type: "error"; id: number; message: string };

self.onmessage = async (event: MessageEvent<TileWorkerRequest>) => {
  const msg = event.data;

  if (msg.type === "init") {
    try {
      await ensureMupdf();
      (self as any).postMessage({ type: "ready" } satisfies TileWorkerResponse);
    } catch (e: any) {
      (self as any).postMessage({
        type: "error",
        id: -1,
        message: e?.message ?? String(e),
      } satisfies TileWorkerResponse);
    }
    return;
  }

  if (msg.type === "renderTile") {
    let pixmap: any = null;
    let device: any = null;
    try {
      await ensureMupdf();
      openDocument(msg.key.docId, msg.data);
      const list = getDisplayList(msg.key.page);

      // Tile geometry in PDF point space (mirrors lod.ts conventions).
      const pageMaxPt = Math.max(msg.pageDims.widthPt, msg.pageDims.heightPt);
      const tilePt = pageMaxPt / Math.pow(2, msg.key.lod);
      const tileX0 = msg.key.x * tilePt;
      const tileY0 = msg.key.y * tilePt;

      // PDF→pixel scale chosen so the tile is exactly TILE_SIZE pixels wide.
      const scale = TILE_SIZE / tilePt;

      // Pixmap bbox is in pixel space, offset so the DrawDevice clips to the
      // tile region of the page. Allocating the bbox at the tile's pixel
      // origin (rather than 0,0) is what makes mupdf paint only the tile.
      const px0 = Math.round(tileX0 * scale);
      const py0 = Math.round(tileY0 * scale);
      const bbox: [number, number, number, number] = [
        px0,
        py0,
        px0 + TILE_SIZE,
        py0 + TILE_SIZE,
      ];

      pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, true);
      pixmap.clear(0xff); // white background for any region outside page bounds

      const matrix = mupdf.Matrix.scale(scale, scale);
      device = new mupdf.DrawDevice(matrix, pixmap);
      list.run(device, mupdf.Matrix.identity);
      device.close();

      const width = pixmap.getWidth();
      const height = pixmap.getHeight();
      const pixels = pixmap.getPixels();
      const components = pixmap.getNumberOfComponents();
      const numPixels = width * height;

      // ImageData requires Uint8ClampedArray<ArrayBuffer>, not <ArrayBufferLike>
      // (the latter could be SharedArrayBuffer-backed). Allocate a fresh buffer
      // and copy into it — mirrors pdfRender.worker.ts:94-110.
      // DrawDevice with alpha=true produces 4 components, but the legacy worker
      // also defends against 3 components — keep the same defense here.
      const buffer = new ArrayBuffer(numPixels * 4);
      const rgba = new Uint8ClampedArray(buffer);
      if (components === 4) {
        rgba.set(pixels.subarray(0, numPixels * 4));
      } else if (components === 3) {
        for (let i = 0; i < numPixels; i++) {
          const s = i * 3;
          const d = i * 4;
          rgba[d] = pixels[s];
          rgba[d + 1] = pixels[s + 1];
          rgba[d + 2] = pixels[s + 2];
          rgba[d + 3] = 255;
        }
      } else {
        throw new Error(`Unsupported color components: ${components}`);
      }

      const imageData = new ImageData(rgba, width, height);
      const bitmap = await createImageBitmap(imageData);

      const result: TileWorkerResponse = {
        type: "tileResult",
        id: msg.id,
        key: msg.key,
        bitmap,
        pixelWidth: width,
        pixelHeight: height,
      };
      (self as any).postMessage(result, [bitmap]);
    } catch (e: any) {
      (self as any).postMessage({
        type: "error",
        id: msg.id,
        message: e?.message ?? String(e),
      } satisfies TileWorkerResponse);
    } finally {
      try {
        device?.destroy();
      } catch {}
      try {
        pixmap?.destroy();
      } catch {}
    }
  }
};
