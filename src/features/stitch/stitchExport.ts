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

import type { PDFDocument as PdfLibDocument, PDFEmbeddedPage } from "pdf-lib";
import { useStitchStore, tileRasterUrl } from "@/shared/stores/stitchStore";
import { getTileAABB, type TilePose } from "./stitchGeometry";
import { applyAlphaMaskNearest, decodeTileImage, encodeTileImage, pickRasterScale } from "./imageUtils";
import { tileRenderScale } from "./rasterEncode";

/** Stored tile rasters are rendered at this scale (see AddPdfModal). */
/** What scale the STORED tile raster was rendered at, for this page's size —
 *  the commit caps the long edge, so it is 1.5x only on small pages. Used to
 *  decide whether a print-DPI re-render is actually worth it. */
const storedRasterScale = tileRenderScale;

/**
 * Re-render an erased tile's source page at print DPI and replay the erase
 * mask (alpha 0 regions of the stored raster) onto it. Returns PNG bytes, or
 * null when re-rendering isn't possible or wouldn't beat the stored raster.
 */
async function renderModifiedTileHighRes(
  tile: {
    sourcePdfBytes: Uint8Array;
    sourcePageIndex: number;
  },
  rasterUrl: string,
  mupdfDocCache: Map<Uint8Array, any>
): Promise<Uint8Array | null> {
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
    if (scale <= storedRasterScale(widthPt, heightPt) + 0.1) return null;

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
    const mask = await decodeTileImage(rasterUrl);
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
 * Bytes + MIME for a tile raster, whichever form it is in: a `data:` URL (scale
 * stamps, cleanup crops, erase results) or a `blob:` object URL (sheet rasters
 * since the commit path stopped base64-encoding them). Returns null for a form
 * pdf-lib cannot embed, so the caller skips the tile exactly as before.
 */
async function tileRasterBytes(url: string): Promise<{ bytes: Uint8Array; mime: "png" | "jpg" } | null> {
  if (url.startsWith("data:image/png")) return { bytes: dataUrlToBytes(url), mime: "png" };
  if (url.startsWith("data:image/jpeg") || url.startsWith("data:image/jpg")) {
    return { bytes: dataUrlToBytes(url), mime: "jpg" };
  }
  if (url.startsWith("data:")) return null;
  try {
    const blob = await (await fetch(url)).blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (blob.type === "image/png") return { bytes, mime: "png" };
    if (blob.type === "image/jpeg" || blob.type === "image/jpg") return { bytes, mime: "jpg" };
    return null;
  } catch {
    return null;
  }
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
 * Where to anchor pdf-lib's `drawPage` so an embedded source page that carries a
 * `/Rotate` attribute lands UPRIGHT inside the w×h box whose lower-left is (x, y).
 *
 * pdf-lib embeds the UNROTATED media box and never bakes `/Rotate`, while the
 * tile's width/height (and its preview raster) are mupdf's rotation-applied,
 * displayed dimensions. The vector embed used to refuse rotated pages and fall
 * to the raster path — which silently turned every landscape CAD plot saved with
 * `/Rotate 270` (Belcourt, Rose Hill) into a capped 3072-px bitmap with NO vector
 * linework, so the site sheet lost snapping. Displaying `/Rotate r` means
 * rotating the content CLOCKWISE by r; `drawPage` rotates counter-clockwise
 * about its anchor, so the rotation is −r and the anchor moves to whichever box
 * corner the content's lower-left corner lands on. Only multiples of 90 exist in
 * PDF; anything else is normalised to the nearest legal value by the caller's
 * source (pdf-lib's `getRotation()` already returns a multiple of 90).
 * Exported for tests.
 */
export function rotatedSourcePose(
  srcRotationDeg: number,
  x: number,
  y: number,
  w: number,
  h: number
): { x: number; y: number; width: number; height: number; rotateDeg: number } {
  const r = (((srcRotationDeg % 360) + 360) % 360);
  switch (r) {
    case 90:  return { x, y: y + h, width: h, height: w, rotateDeg: -90 };
    case 180: return { x: x + w, y: y + h, width: w, height: h, rotateDeg: 180 };
    case 270: return { x: x + w, y, width: h, height: w, rotateDeg: 90 };
    default:  return { x, y, width: w, height: h, rotateDeg: 0 };
  }
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

/**
 * Export page bounds when there is no explicit crop: the canvas rect (0,0,W,H)
 * expanded to include every tile AABB, so tiles parked in the open space around
 * the canvas are not cut from the export. Exported for tests.
 */
export function contentExportBounds(
  canvasWidth: number,
  canvasHeight: number,
  aabbs: { x: number; y: number; width: number; height: number }[]
): { cropX: number; cropY: number; cropW: number; cropH: number } {
  let minX = 0, minY = 0, maxX = canvasWidth, maxY = canvasHeight;
  for (const a of aabbs) {
    minX = Math.min(minX, a.x);
    minY = Math.min(minY, a.y);
    maxX = Math.max(maxX, a.x + a.width);
    maxY = Math.max(maxY, a.y + a.height);
  }
  return { cropX: minX, cropY: minY, cropW: maxX - minX, cropH: maxY - minY };
}

/**
 * Embed one source page as a vector XObject, forcing pdf-lib's DEFERRED embed
 * to run right here.
 *
 * `embedPdf` only queues the work: the real embedding happens inside
 * `PDFEmbeddedPage.embed()`, which pdf-lib does not call until `pdfDoc.save()`.
 * So a page pdf-lib cannot embed — a blank page with no /Contents throws
 * `MissingPageContentsEmbeddingError` — used to escape the caller's try/catch
 * and abort the WHOLE export at save time, instead of demoting that one tile to
 * the raster path.
 *
 * Awaiting `embed()` here moves that failure inside the catch. On failure the
 * dead entry is dropped from the document's pending-embed list so `save()`
 * doesn't retry (and re-throw) it, and null is returned so the caller falls
 * through to the raster path without ever drawing the broken page.
 *
 * Exported for tests.
 */
export async function embedTileSource(
  pdfDoc: PdfLibDocument,
  sourceDoc: PdfLibDocument,
  pageIndex: number
): Promise<PDFEmbeddedPage | null> {
  let embeddedPage: PDFEmbeddedPage | undefined;
  try {
    [embeddedPage] = await pdfDoc.embedPdf(sourceDoc, [pageIndex]);
    if (!embeddedPage) return null;
    // Force the deferred embed NOW so a failure lands in this catch, not in save().
    await embeddedPage.embed();
    return embeddedPage;
  } catch (e) {
    console.warn(`Vector embed failed for source page ${pageIndex}, falling back to raster:`, e);
    // pdf-lib pushed this page onto its private pending list before embedding;
    // leaving it there would make save() re-run the same failing embed.
    if (embeddedPage) {
      const pending = (pdfDoc as unknown as { embeddedPages?: PDFEmbeddedPage[] }).embeddedPages;
      const idx = pending ? pending.indexOf(embeddedPage) : -1;
      if (pending && idx >= 0) pending.splice(idx, 1);
    }
    return null;
  }
}

export async function exportStitchToPdf(): Promise<Uint8Array | null> {
  const { canvasWidth, canvasHeight, tiles, cropRect } = useStitchStore.getState();

  // No explicit crop: the page is the canvas, EXPANDED to include any tiles the
  // user parked in the open space around the canvas (e.g. relocated notes), so
  // nothing off-page is silently cut from the export.
  const { cropX, cropY, cropW, cropH } = cropRect
    ? { cropX: cropRect.x, cropY: cropRect.y, cropW: cropRect.w, cropH: cropRect.h }
    : contentExportBounds(canvasWidth, canvasHeight, tiles.map((t) => getTileAABB(t)));

  const tilesToDraw = tiles.filter((t) => tileIntersectsCrop(t, cropX, cropY, cropW, cropH));

  if (tilesToDraw.length === 0) return null;

  const pdfLib = await import("pdf-lib");
  const {
    PDFDocument,
    degrees,
    translate,
    rotateDegrees,
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
      // Null once the embed is known to have failed — the page is drawn ONLY on
      // a proven-good embed, so nothing dangling ever reaches the output.
      let embeddedPage: PDFEmbeddedPage | null = null;
      // The source page's own /Rotate, baked into the draw pose below (see
      // rotatedSourcePose) — a rotated plot keeps its vector linework.
      let srcRotation = 0;
      try {
        let sourceDoc = sourceDocCache.get(tile.sourcePdfBytes);
        if (!sourceDoc) {
          sourceDoc = await PDFDocument.load(tile.sourcePdfBytes, { ignoreEncryption: true });
          sourceDocCache.set(tile.sourcePdfBytes, sourceDoc);
        }
        srcRotation = sourceDoc.getPage(tile.sourcePageIndex).getRotation().angle;

        // Embeds AND flushes: a page pdf-lib can't embed returns null here rather
        // than exploding later inside save() (see embedTileSource).
        embeddedPage = await embedTileSource(pdfDoc, sourceDoc, tile.sourcePageIndex);
      } catch (e) {
        console.warn("Vector embed failed, falling back to raster:", e);
      }

      if (embeddedPage) {
        const good = embeddedPage;
        // Draw in a local frame whose origin is the tile's lower-left corner and
        // whose axes carry the tile's own editor rotation. The source's /Rotate is
        // then a second, inner rotation about the pose's anchor — composing the
        // two through the CTM is what lets a rotated plot AND a rotated tile both
        // land exactly where the editor shows them.
        const pose = rotatedSourcePose(srcRotation, 0, 0, tile.width, tile.height);
        const drawSource = (x: number, y: number) => {
          page.pushOperators(pushGraphicsState(), translate(x, y));
          if (rotation !== 0) page.pushOperators(rotateDegrees(rotation));
          page.drawPage(good, {
            x: pose.x,
            y: pose.y,
            width: pose.width,
            height: pose.height,
            ...(pose.rotateDeg !== 0 ? { rotate: degrees(pose.rotateDeg) } : {}),
          });
          page.pushOperators(popGraphicsState());
        };
        openClipped();
        drawSource(drawX, drawY);
        page.pushOperators(popGraphicsState());
        drawRelocations((x, y) => drawSource(x, y));
        continue;
      }
    }

    // ── Raster fallback (erased tiles, scale stamps, vector-fail) ─────
    // The tile's own override if it has one, else its committed sheet raster.
    const rasterUrl = tileRasterUrl(tile);
    if (!rasterUrl) continue;

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
        highResBytes = await renderModifiedTileHighRes(tile, rasterUrl, mupdfDocCache);
      } catch (e) {
        console.warn("High-DPI re-render failed, using stored raster:", e);
      }
    }

    let pdfImage;
    if (highResBytes) {
      pdfImage = await pdfDoc.embedPng(highResBytes);
    } else {
      const raster = await tileRasterBytes(rasterUrl);
      if (!raster) continue;
      pdfImage = raster.mime === "png"
        ? await pdfDoc.embedPng(raster.bytes)
        : await pdfDoc.embedJpg(raster.bytes);
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
