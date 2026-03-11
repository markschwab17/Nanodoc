/**
 * Shared helper: add PDF bytes to the stitch canvas (same layout and render logic as AddPdfModal).
 * Used by StitchView CTO preload and by AddPdfModal for both file picker and "From Civiltakeoff".
 */

import { PDFRenderer } from "@/core/pdf/PDFRenderer";
import { makeWhiteTransparentInPlace } from "@/features/stitch/imageUtils";
import { useStitchStore } from "@/shared/stores/stitchStore";
import type { StitchTile } from "@/features/stitch/stitchTypes";

const TILE_RENDER_SCALE = 1.5;
const MARGIN = 20;
const GAP = 10;
const TILES_PER_ROW = 3;

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function imageDataToDataUrl(imageData: ImageData): string {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

export interface AddPdfToStitchOptions {
  /** Remove white background from rendered pages. Default true. */
  removeWhiteBackground?: boolean;
  /** Scale label (e.g. 20 for 1"=20'). If finite and > 0, sets store reference scale. */
  scaleFeetPerInch?: number;
  /** Page indices to add (0-based). Default: all pages. */
  pageIndices?: number[];
}

/**
 * Opens the PDF with mupdf, renders the given (or all) pages at TILE_RENDER_SCALE,
 * optionally removes white background, builds tiles with same layout as AddPdfModal, and adds them to the stitch store.
 */
export async function addPdfBytesToStitchCanvas(
  pdfBytes: Uint8Array,
  fileName: string,
  options: AddPdfToStitchOptions = {}
): Promise<void> {
  const {
    removeWhiteBackground = true,
    scaleFeetPerInch,
    pageIndices: requestedPages,
  } = options;

  const mupdf = await import("mupdf").then((m) => m.default);
  const doc = mupdf.Document.openDocument(pdfBytes, "application/pdf");
  const pageCount = doc.countPages();
  const pageIndices =
    requestedPages != null && requestedPages.length > 0
      ? requestedPages.filter((i) => i >= 0 && i < pageCount).sort((a, b) => a - b)
      : Array.from({ length: pageCount }, (_, i) => i);

  if (pageIndices.length === 0) return;

  const renderer = new PDFRenderer(mupdf);
  type TileInput = Omit<StitchTile, "id">;
  const newTiles: TileInput[] = [];
  let rowY = MARGIN;
  const rowBuffer: Array<{ tile: TileInput; w: number; h: number }> = [];

  const flushRow = () => {
    if (rowBuffer.length === 0) return;
    let x = MARGIN;
    const maxH = Math.max(...rowBuffer.map((b) => b.h));
    for (const { tile, w } of rowBuffer) {
      newTiles.push({ ...tile, x, y: rowY });
      x += w + GAP;
    }
    rowY += maxH + GAP;
    rowBuffer.length = 0;
  };

  for (const pageIndex of pageIndices) {
    await yieldToMain();
    const page = doc.loadPage(pageIndex);
    const bounds = page.getBounds();
    const widthPt = bounds[2] - bounds[0];
    const heightPt = bounds[3] - bounds[1];
    const tileW = widthPt;
    const tileH = heightPt;
    const rendered = await renderer.renderPage(doc, pageIndex, {
      scale: TILE_RENDER_SCALE,
    });
    const imageData = rendered.imageData as ImageData;
    if (imageData?.data && removeWhiteBackground) {
      makeWhiteTransparentInPlace(imageData);
    }
    const dataUrl = imageData?.data ? imageDataToDataUrl(imageData) : undefined;
    const tileData: TileInput = {
      sourcePdfBytes: pdfBytes,
      sourcePageIndex: pageIndex,
      sourceFileName: fileName || undefined,
      width: tileW,
      height: tileH,
      imageDataUrl: dataUrl,
      x: 0,
      y: 0,
    };
    rowBuffer.push({ tile: tileData, w: tileW, h: tileH });
    if (rowBuffer.length === TILES_PER_ROW) flushRow();
  }
  flushRow();

  const store = useStitchStore.getState();
  store.addTiles(newTiles);
  if (scaleFeetPerInch != null && Number.isFinite(scaleFeetPerInch) && scaleFeetPerInch > 0) {
    store.setReferenceScaleFeetPerInch(scaleFeetPerInch);
  }
}
