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
import { getTileAABB, type TilePose } from "./stitchGeometry";
import { applyAlphaMaskNearest, decodeTileImage, encodeTileImage, pickRasterScale } from "./imageUtils";

/** Stored tile rasters are rendered at this scale (see AddPdfModal). */
const STORED_RASTER_SCALE = 1.5;

/**
 * Re-render an erased tile's source page at print DPI and replay the erase
 * mask (alpha 0 regions of the stored raster) onto it. Returns PNG bytes, or
 * null when re-rendering isn't possible or wouldn't beat the stored raster.
 */
async function renderModifiedTileHighRes(
  tile: {
    sourcePdfBytes: Uint8Array;
    sourcePageIndex: number;
    imageDataUrl?: string;
  },
  mupdfDocCache: Map<Uint8Array, any>
): Promise<Uint8Array | null> {
  if (!tile.imageDataUrl) return null;
  const mupdf = await import("mupdf").then((m) => m.default);
  let doc = mupdfDocCache.get(tile.sourcePdfBytes);
  if (!doc) {
    doc = mupdf.Document.openDocument(tile.sourcePdfBytes, "application/pdf");
    mupdfDocCache.set(tile.sourcePdfBytes, doc);
  }
  const page = doc.loadPage(tile.sourcePageIndex);
  try {
    const bounds = page.getBounds();
    const widthPt = bounds[2] - bounds[0];
    const heightPt = bounds[3] - bounds[1];
    const scale = pickRasterScale(widthPt, heightPt, { minScale: 1 });
    // No meaningful gain over the stored raster — skip the expensive render
    if (scale <= STORED_RASTER_SCALE + 0.1) return null;

    const pixmap = page.toPixmap(
      mupdf.Matrix.scale(scale, scale),
      mupdf.ColorSpace.DeviceRGB,
      true,
      false
    );
    const width = pixmap.getWidth();
    const height = pixmap.getHeight();
    const pixels = pixmap.getPixels();
    const imageData = new ImageData(width, height);
    const data = imageData.data;
    const numPixels = width * height;
    const components = pixmap.getNumberOfComponents();
    if (components === 4) {
      data.set(pixels.subarray(0, numPixels * 4));
    } else if (components === 3) {
      for (let i = 0; i < numPixels; i++) {
        data[i * 4] = pixels[i * 3];
        data[i * 4 + 1] = pixels[i * 3 + 1];
        data[i * 4 + 2] = pixels[i * 3 + 2];
        data[i * 4 + 3] = 255;
      }
    } else {
      pixmap.destroy?.();
      return null;
    }
    pixmap.destroy?.();

    // Replay the user's erases (and any white removal) from the stored raster
    const mask = await decodeTileImage(tile.imageDataUrl);
    applyAlphaMaskNearest(imageData, width, height, mask.imageData, mask.width, mask.height);

    const dataUrl = encodeTileImage(imageData);
    if (!dataUrl.startsWith("data:image/png")) return null;
    return dataUrlToBytes(dataUrl);
  } finally {
    page.destroy?.();
  }
}

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

/**
 * Whether a tile's on-screen footprint (rotation-aware) intersects the crop.
 * Exported for tests.
 */
export function tileIntersectsCrop(
  tile: TilePose,
  cropX: number,
  cropY: number,
  cropW: number,
  cropH: number
): boolean {
  const aabb = getTileAABB(tile);
  return (
    aabb.x + aabb.width > cropX &&
    aabb.x < cropX + cropW &&
    aabb.y + aabb.height > cropY &&
    aabb.y < cropY + cropH
  );
}

/**
 * Whether a tile's source page may use the lossless VECTOR embed path.
 *
 * pdf-lib's `drawPage` does NOT bake a source page's `/Rotate` into the embedded
 * form, but the tile's width/height and the preview raster use mupdf's
 * rotation-applied (displayed) dimensions. So for a rotated source page the
 * vector embed would export stretched and unrotated. Only unrotated pages are
 * safe for vector; rotated pages fall to the raster path (mupdf's render is
 * already correctly oriented). Exported for tests.
 */
export function canVectorEmbedRotation(srcRotationDeg: number): boolean {
  return ((((srcRotationDeg % 360) + 360) % 360)) === 0;
}

/**
 * Compute the pdf-lib draw pose (position + rotation) for a tile so the
 * exported page matches the editor exactly. Exported for tests.
 */
export function pdfPoseForTile(
  tile: { x: number; y: number; width: number; height: number; rotation?: number },
  cropX: number,
  cropY: number,
  cropH: number
): { x: number; y: number; rotationDeg: number } {
  let drawX = tile.x - cropX;
  let drawY = cropH - (tile.y - cropY) - tile.height;
  // CSS rotates clockwise (y-down); pdf-lib rotates counterclockwise (y-up).
  // The same apparent rotation therefore needs the negated angle in PDF space.
  const rotation = -(tile.rotation ?? 0);
  if (rotation !== 0) {
    const adjusted = centerRotatedOrigin(drawX, drawY, tile.width, tile.height, rotation);
    drawX = adjusted.x;
    drawY = adjusted.y;
  }
  return { x: drawX, y: drawY, rotationDeg: rotation };
}

/**
 * Map a tile's `hiddenRegions` (stored as fractions 0..1 of the tile's
 * width/height) into the export page's PDF (y-up) coordinate space, given the
 * tile's draw pose. Fractions are scaled to tile px first, then to PDF space.
 * Returns [] when the tile has no hidden regions, or when the tile is rotated —
 * v1 skips hole-clipping on rotated tiles (auto-align always produces rotation
 * 0). Exported for tests.
 */
export function tileHoleRectsInPdf(
  tile: {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
    hiddenRegions?: { x: number; y: number; w: number; h: number }[];
    relocatedRegions?: { rect: { x: number; y: number; w: number; h: number } }[];
  },
  cropX: number,
  cropY: number,
  cropH: number
): { x: number; y: number; w: number; h: number }[] {
  // A relocated region's SOURCE is clipped out too (its content is drawn at the
  // destination by tileRelocationsInPdf).
  const regions = [
    ...(tile.hiddenRegions ?? []),
    ...(tile.relocatedRegions ?? []).map((r) => r.rect),
  ];
  if (!regions.length || (tile.rotation ?? 0) !== 0) return [];
  return regions.map((r) => {
    // fraction (0..1) → tile-local px
    const rx = r.x * tile.width;
    const ry = r.y * tile.height;
    const rw = r.w * tile.width;
    const rh = r.h * tile.height;
    return {
      x: tile.x - cropX + rx,
      y: cropH - (tile.y - cropY + ry + rh), // flip to PDF y-up
      w: rw,
      h: rh,
    };
  });
}

/**
 * Map a tile's `relocatedRegions` into PDF (y-up) space. For each region returns
 * the DESTINATION rect (source rect shifted by the offset — used to clip the
 * relocated copy) and the draw offset `(offX, offY)` in PDF points to translate
 * the whole page/image so the region's content lands at the destination.
 * `offX = dx·width`, `offY = −dy·height` (dy is y-down; PDF is y-up). Returns []
 * for a rotated tile (relocation is v1-scoped to unrotated tiles). For tests.
 */
export function tileRelocationsInPdf(
  tile: {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation?: number;
    relocatedRegions?: { rect: { x: number; y: number; w: number; h: number }; dx: number; dy: number }[];
  },
  cropX: number,
  cropY: number,
  cropH: number
): { dest: { x: number; y: number; w: number; h: number }; offX: number; offY: number }[] {
  const regions = tile.relocatedRegions ?? [];
  if (!regions.length || (tile.rotation ?? 0) !== 0) return [];
  return regions.map((rr) => {
    const r = rr.rect;
    const rx = r.x * tile.width, ry = r.y * tile.height;
    const rw = r.w * tile.width, rh = r.h * tile.height;
    // source rect in PDF (same mapping as tileHoleRectsInPdf)
    const sx = tile.x - cropX + rx;
    const sy = cropH - (tile.y - cropY + ry + rh);
    const offX = rr.dx * tile.width;
    const offY = -rr.dy * tile.height;
    return { dest: { x: sx + offX, y: sy + offY, w: rw, h: rh }, offX, offY };
  });
}

export async function exportStitchToPdf(): Promise<Uint8Array | null> {
  const { canvasWidth, canvasHeight, tiles, cropRect } = useStitchStore.getState();

  const cropX = cropRect?.x ?? 0;
  const cropY = cropRect?.y ?? 0;
  const cropW = cropRect?.w ?? canvasWidth;
  const cropH = cropRect?.h ?? canvasHeight;

  const tilesToDraw = tiles.filter((t) => tileIntersectsCrop(t, cropX, cropY, cropW, cropH));

  if (tilesToDraw.length === 0) return null;

  const pdfLib = await import("pdf-lib");
  const {
    PDFDocument,
    degrees,
    pushGraphicsState,
    popGraphicsState,
    setGraphicsState,
    PDFName,
    moveTo,
    lineTo,
    closePath,
    clipEvenOdd,
    endPath,
  } = pdfLib;
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([cropW, cropH]);

  // Register Multiply blend mode so white backgrounds become transparent
  // instead of clipping content from tiles underneath.
  const multiplyGsName = "GS_Multiply";
  const multiplyGsDict = pdfDoc.context.obj({ Type: "ExtGState", BM: "Multiply" });
  page.node.setExtGState(PDFName.of(multiplyGsName), multiplyGsDict);

  // Cache loaded source PDFs so we don't re-parse the same bytes multiple times
  const sourceDocCache = new Map<Uint8Array, Awaited<ReturnType<typeof PDFDocument.load>>>();
  // mupdf docs for high-DPI re-render of erased tiles (destroyed at the end)
  const mupdfDocCache = new Map<Uint8Array, any>();

  for (const tile of tilesToDraw) {
    // Draw pose in PDF coord system (origin bottom-left, Y up, CCW rotation)
    const { x: drawX, y: drawY, rotationDeg: rotation } = pdfPoseForTile(tile, cropX, cropY, cropH);

    // Clean-Composite: tile-local hidden regions (incl. relocated sources) mapped
    // into PDF page space. Non-empty only for unrotated tiles (v1 scope).
    const holes = tileHoleRectsInPdf(tile, cropX, cropY, cropH);
    // Relocated regions: content drawn a second time, clipped-to-dest + translated.
    const relocations = tileRelocationsInPdf(tile, cropX, cropY, cropH);
    // Open a Multiply graphics state, optionally clipped (even-odd) to exclude
    // the tile's hidden regions so the export matches the editor's clean view.
    const openClipped = () => {
      page.pushOperators(pushGraphicsState(), setGraphicsState(multiplyGsName));
      if (holes.length) {
        const ops = [
          // Outer rect = full crop so the tile draws everywhere except holes.
          moveTo(0, 0),
          lineTo(cropW, 0),
          lineTo(cropW, cropH),
          lineTo(0, cropH),
          closePath(),
        ];
        for (const h of holes) {
          ops.push(
            moveTo(h.x, h.y),
            lineTo(h.x + h.w, h.y),
            lineTo(h.x + h.w, h.y + h.h),
            lineTo(h.x, h.y + h.h),
            closePath()
          );
        }
        ops.push(clipEvenOdd(), endPath());
        page.pushOperators(...ops);
      }
    };

    // Draw each relocated region's content: clip to its destination rect, then
    // draw the whole page/image shifted by the offset so only that piece shows
    // at its new spot. `drawOne(x, y)` places the page/image at (x, y).
    const drawRelocations = (drawOne: (x: number, y: number) => void) => {
      for (const rel of relocations) {
        page.pushOperators(pushGraphicsState(), setGraphicsState(multiplyGsName));
        page.pushOperators(
          moveTo(rel.dest.x, rel.dest.y),
          lineTo(rel.dest.x + rel.dest.w, rel.dest.y),
          lineTo(rel.dest.x + rel.dest.w, rel.dest.y + rel.dest.h),
          lineTo(rel.dest.x, rel.dest.y + rel.dest.h),
          closePath(),
          clipEvenOdd(),
          endPath()
        );
        drawOne(drawX + rel.offX, drawY + rel.offY);
        page.pushOperators(popGraphicsState());
      }
    };

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
        // A rotated source page (/Rotate != 0) can't use the vector embed: pdf-lib
        // won't bake the rotation, so it would export stretched + unrotated. Fall
        // through to the raster path (mupdf's stored render is already oriented).
        const srcRotation = sourceDoc.getPage(tile.sourcePageIndex).getRotation().angle;
        if (!canVectorEmbedRotation(srcRotation)) throw new Error(`ROTATED_SOURCE:${srcRotation}`);

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
        openClipped();
        page.drawPage(embeddedPage, opts);
        page.pushOperators(popGraphicsState());
        drawRelocations((x, y) => page.drawPage(embeddedPage, { x, y, width: tile.width, height: tile.height }));
        continue;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Rotated source pages fall to the raster path on purpose — not a failure.
        if (!msg.startsWith("ROTATED_SOURCE:")) {
          console.warn("Vector embed failed, falling back to raster:", e);
        }
      }
    }

    // ── Raster fallback (erased tiles, scale stamps, vector-fail) ─────
    if (!tile.imageDataUrl) continue;

    // Erased tiles: the stored raster is only 1.5x — re-render the source
    // page at print DPI and replay the erase mask so one small erase doesn't
    // demote a whole sheet to a soft raster.
    let highResBytes: Uint8Array | null = null;
    if (
      tile.imageModified &&
      !tile.isScaleStamp &&
      tile.sourcePdfBytes &&
      tile.sourcePdfBytes.length > 0 &&
      tile.sourcePageIndex >= 0
    ) {
      try {
        highResBytes = await renderModifiedTileHighRes(tile, mupdfDocCache);
      } catch (e) {
        console.warn("High-DPI re-render failed, using stored raster:", e);
      }
    }

    let pdfImage;
    if (highResBytes) {
      pdfImage = await pdfDoc.embedPng(highResBytes);
    } else if (tile.imageDataUrl.startsWith("data:image/png")) {
      pdfImage = await pdfDoc.embedPng(dataUrlToBytes(tile.imageDataUrl));
    } else if (
      tile.imageDataUrl.startsWith("data:image/jpeg") ||
      tile.imageDataUrl.startsWith("data:image/jpg")
    ) {
      pdfImage = await pdfDoc.embedJpg(dataUrlToBytes(tile.imageDataUrl));
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
    openClipped();
    page.drawImage(pdfImage, imgOpts);
    page.pushOperators(popGraphicsState());
    drawRelocations((x, y) => page.drawImage(pdfImage, { x, y, width: tile.width, height: tile.height }));
  }

  for (const doc of mupdfDocCache.values()) {
    try {
      doc.destroy?.();
    } catch {
      // already freed
    }
  }

  return pdfDoc.save({ useObjectStreams: false });
}
