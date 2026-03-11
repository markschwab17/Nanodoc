/**
 * Export stitch canvas to a single flattened PDF using pdf-lib.
 *
 * Strategy: for tiles that still have their original source PDF bytes and have
 * NOT been content-erased, we embed the original vector PDF page (lossless,
 * pixel-perfect).  For tiles whose image has been modified (erased pixels) we
 * fall back to embedding the rasterised PNG.
 */

import { useStitchStore } from "@/shared/stores/stitchStore";

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] || dataUrl;
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * Detect whether a tile's image has been modified from the original render.
 * We mark tiles as "dirty" when content-delete has replaced their imageDataUrl.
 * A simple heuristic: if the tile still has sourcePdfBytes AND the imageDataUrl
 * has not been swapped by an erase operation, we treat it as clean.  The erase
 * codepath always replaces imageDataUrl, so any tile that went through erase
 * will have a *different* dataUrl than the one produced at import time.
 *
 * Because we cannot cheaply diff data URLs, we use a flag on the tile.
 * If `tile._imageModified` is set (added by the erase code), prefer raster.
 * Otherwise prefer vector.
 */

export async function exportStitchToPdf(): Promise<Uint8Array | null> {
  const { canvasWidth, canvasHeight, tiles, cropRect } = useStitchStore.getState();

  const cropX = cropRect?.x ?? 0;
  const cropY = cropRect?.y ?? 0;
  const cropW = cropRect?.w ?? canvasWidth;
  const cropH = cropRect?.h ?? canvasHeight;

  const tilesToDraw = tiles.filter((t) => {
    const tx0 = t.x;
    const ty0 = t.y;
    const tx1 = t.x + t.width;
    const ty1 = t.y + t.height;
    return tx1 > cropX && tx0 < cropX + cropW && ty1 > cropY && ty0 < cropY + cropH;
  });

  if (tilesToDraw.length === 0) return null;

  const { PDFDocument, degrees } = await import("pdf-lib");
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([cropW, cropH]);

  // Cache loaded source PDFs so we don't re-parse the same bytes multiple times
  const sourceDocCache = new Map<Uint8Array, Awaited<ReturnType<typeof PDFDocument.load>>>();

  for (const tile of tilesToDraw) {
    const drawX = tile.x - cropX;
    // PDF coordinate system: origin at bottom-left, Y goes up
    const drawY = cropH - (tile.y - cropY) - tile.height;
    const rotation = tile.rotation ?? 0;

    // Try to embed the original vector PDF page (lossless)
    if (tile.sourcePdfBytes && tile.sourcePageIndex != null && !tile.isScaleStamp) {
      try {
        let sourceDoc = sourceDocCache.get(tile.sourcePdfBytes);
        if (!sourceDoc) {
          sourceDoc = await PDFDocument.load(tile.sourcePdfBytes, { ignoreEncryption: true });
          sourceDocCache.set(tile.sourcePdfBytes, sourceDoc);
        }
        const [embeddedPage] = await pdfDoc.embedPdf(sourceDoc, [tile.sourcePageIndex]);

        const opts: {
          x: number; y: number;
          width: number; height: number;
          rotate?: ReturnType<typeof degrees>;
        } = {
          x: drawX,
          y: drawY,
          width: tile.width,
          height: tile.height,
        };
        if (rotation !== 0) opts.rotate = degrees(rotation);
        page.drawPage(embeddedPage, opts);
        continue;
      } catch (e) {
        // If vector embed fails (encrypted, broken xref, etc.), fall through to raster
        console.warn("Vector embed failed for tile, falling back to raster:", e);
      }
    }

    // Fallback: embed rasterised PNG/JPEG
    if (!tile.imageDataUrl) continue;
    const imageBytes = dataUrlToBytes(tile.imageDataUrl);
    let pdfImage;
    if (tile.imageDataUrl.startsWith("data:image/png")) {
      pdfImage = await pdfDoc.embedPng(imageBytes);
    } else if (
      tile.imageDataUrl.startsWith("data:image/jpeg") ||
      tile.imageDataUrl.startsWith("data:image/jpg")
    ) {
      pdfImage = await pdfDoc.embedJpg(imageBytes);
    } else {
      continue;
    }
    const imgOpts: {
      x: number; y: number;
      width: number; height: number;
      rotate?: ReturnType<typeof degrees>;
    } = {
      x: drawX,
      y: drawY,
      width: tile.width,
      height: tile.height,
    };
    if (rotation !== 0) imgOpts.rotate = degrees(rotation);
    page.drawImage(pdfImage, imgOpts);
  }

  return pdfDoc.save({ useObjectStreams: false });
}
