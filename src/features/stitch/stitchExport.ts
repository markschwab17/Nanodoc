/**
 * Export stitch canvas to a single flattened PDF using pdf-lib.
 *
 * Tiles that still have their original source PDF and have NOT been
 * content-erased (imageModified !== true) are embedded as vector PDF
 * pages — lossless, pixel-perfect.  Erased / modified tiles fall back
 * to the rasterised PNG.
 *
 * Rotation fix: CSS rotates around center-center, so we replicate
 * that by computing an adjusted (x, y) for pdf-lib, which rotates
 * around the drawing origin.
 */

import { useStitchStore } from "@/shared/stores/stitchStore";

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] || dataUrl;
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * Compute the (x, y) that pdf-lib needs so that the drawn object
 * APPEARS to be rotated around its own centre — matching CSS
 * `transform-origin: center center`.
 *
 * pdf-lib rotates around the bottom-left corner (x, y).
 * CSS rotates around the centre (x+w/2, y+h/2 in screen coords,
 * mapped to PDF coords).
 */
function centerRotatedOrigin(
  drawX: number,
  drawY: number,
  w: number,
  h: number,
  angleDeg: number
): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // Centre of the tile in PDF coords
  const cx = drawX + w / 2;
  const cy = drawY + h / 2;
  // Bottom-left relative to centre
  const rlx = -w / 2;
  const rly = -h / 2;
  // Rotate the bottom-left around centre
  return {
    x: cx + rlx * cos - rly * sin,
    y: cy + rlx * sin + rly * cos,
  };
}

export async function exportStitchToPdf(): Promise<Uint8Array | null> {
  const { canvasWidth, canvasHeight, tiles, cropRect } = useStitchStore.getState();

  const cropX = cropRect?.x ?? 0;
  const cropY = cropRect?.y ?? 0;
  const cropW = cropRect?.w ?? canvasWidth;
  const cropH = cropRect?.h ?? canvasHeight;

  const tilesToDraw = tiles.filter((t) => {
    const tx1 = t.x + t.width;
    const ty1 = t.y + t.height;
    return tx1 > cropX && t.x < cropX + cropW && ty1 > cropY && t.y < cropY + cropH;
  });

  if (tilesToDraw.length === 0) return null;

  const pdfLib = await import("pdf-lib");
  const { PDFDocument, degrees, pushGraphicsState, popGraphicsState, setGraphicsState, PDFName } = pdfLib;
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([cropW, cropH]);

  // Register Multiply blend mode so white backgrounds become transparent
  // instead of clipping content from tiles underneath.
  const multiplyGsName = "GS_Multiply";
  const multiplyGsDict = pdfDoc.context.obj({ Type: "ExtGState", BM: "Multiply" });
  page.node.setExtGState(PDFName.of(multiplyGsName), multiplyGsDict);

  // Cache loaded source PDFs so we don't re-parse the same bytes multiple times
  const sourceDocCache = new Map<Uint8Array, Awaited<ReturnType<typeof PDFDocument.load>>>();

  for (const tile of tilesToDraw) {
    // Base position: PDF coord system (origin bottom-left, Y up)
    let drawX = tile.x - cropX;
    let drawY = cropH - (tile.y - cropY) - tile.height;
    const rotation = tile.rotation ?? 0;

    // Adjust for center-based rotation if needed
    if (rotation !== 0) {
      const adjusted = centerRotatedOrigin(drawX, drawY, tile.width, tile.height, rotation);
      drawX = adjusted.x;
      drawY = adjusted.y;
    }

    // ── Vector embed path (unmodified tiles only) ──────────────────────
    const canUseVector =
      tile.sourcePdfBytes &&
      tile.sourcePdfBytes.length > 0 &&
      tile.sourcePageIndex != null &&
      tile.sourcePageIndex >= 0 &&
      !tile.isScaleStamp &&
      !tile.imageModified;

    if (canUseVector) {
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
        page.pushOperators(pushGraphicsState(), setGraphicsState(multiplyGsName));
        page.drawPage(embeddedPage, opts);
        page.pushOperators(popGraphicsState());
        continue;
      } catch (e) {
        console.warn("Vector embed failed, falling back to raster:", e);
      }
    }

    // ── Raster fallback (erased tiles, scale stamps, vector-fail) ─────
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
    page.pushOperators(pushGraphicsState(), setGraphicsState(multiplyGsName));
    page.drawImage(pdfImage, imgOpts);
    page.pushOperators(popGraphicsState());
  }

  return pdfDoc.save({ useObjectStreams: false });
}
