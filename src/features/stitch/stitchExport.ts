/**
 * Export stitch canvas to a single flattened PDF using pdf-lib.
 */

import { useStitchStore } from "@/shared/stores/stitchStore";

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(",")[1] || dataUrl;
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

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

  for (const tile of tilesToDraw) {
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
    const drawX = tile.x - cropX;
    const drawY = cropH - (tile.y - cropY) - tile.height;
    const rotation = tile.rotation ?? 0;
    const opts: { x: number; y: number; width: number; height: number; rotate?: ReturnType<typeof degrees> } = {
      x: drawX,
      y: drawY,
      width: tile.width,
      height: tile.height,
    };
    if (rotation !== 0) opts.rotate = degrees(rotation);
    page.drawImage(pdfImage, opts);
  }

  return pdfDoc.save({ useObjectStreams: false });
}
