/**
 * What a saved composite is made of: where each source sheet sits on the canvas, at what
 * scale, rotated how, with which regions hidden. Civiltakeoff stores this on the page it
 * creates from the stitch (Site Sheet spec §4.1) so takeoff drawn on a source sheet can be
 * moved onto the composite by that tile's pose. Coordinates are canvas points, y-down; the
 * exported PDF page is `exportBounds`, so pdfX = x − exportBounds.x, pdfYdown = y − exportBounds.y.
 * `exportBounds` mirrors exactly how `exportStitchToPdf` (stitchExport.ts) computes its page
 * bounds — cropRect when set, else the canvas expanded to include EVERY tile (scale stamps
 * included) — so the manifest always agrees with the PDF page it describes.
 *
 * Raw vs. effective scale: tile poses (x/y/width/height) are POST-composition — squeezed or
 * stretched by `compositionScaleFactor` when the composite was scaled as a whole (see
 * `scaleComposition`) — while `referenceScaleFeetPerInch` and each tile's `scaleFeetPerInch`
 * are the raw as-imported values and don't reflect that squeeze. `effectiveReferenceScaleFeetPerInch`
 * and each tile's `effectiveScaleFeetPerInch` divide by `compositionScaleFactor` so they agree
 * with the poses: a sheet imported at 1″=20′ on a composition shrunk by 0.5 is effectively
 * 1″=40′ (the same inch on the composed canvas now spans twice the feet).
 */
import { useStitchStore } from "@/shared/stores/stitchStore";
import { getTileAABB } from "./stitchGeometry";
import { contentExportBounds, tileIntersectsCrop } from "./stitchExport";
import type { StitchTile } from "./stitchTypes";

export interface StitchManifestTile {
  sourceFileName: string | null;
  sourcePageIndex: number;
  x: number; y: number; width: number; height: number;
  rotation: number;
  /** Raw as-imported scale (feet per inch). Does not account for `compositionScaleFactor`. */
  scaleFeetPerInch: number | null;
  /** `scaleFeetPerInch` divided by `compositionScaleFactor` — agrees with the tile's
   *  post-composition pose (x/y/width/height). Null when `scaleFeetPerInch` is null. */
  effectiveScaleFeetPerInch: number | null;
  hiddenRegions: { x: number; y: number; w: number; h: number }[];
  relocatedRegions: { rect: { x: number; y: number; w: number; h: number }; dx: number; dy: number }[];
}
export interface StitchManifest {
  version: 1;
  createdAt: string;
  canvas: { widthPt: number; heightPt: number };
  exportBounds: { x: number; y: number; w: number; h: number };
  /** Raw as-imported reference scale (feet per inch). Does not account for `compositionScaleFactor`. */
  referenceScaleFeetPerInch: number | null;
  /** `referenceScaleFeetPerInch` divided by `compositionScaleFactor` — agrees with the tile
   *  poses (x/y/width/height), which are post-composition. Null when the reference is null. */
  effectiveReferenceScaleFeetPerInch: number | null;
  compositionScaleFactor: number;
  tiles: StitchManifestTile[];
}

export function buildStitchManifest(): StitchManifest {
  const { tiles, canvasWidth, canvasHeight, cropRect, referenceScaleFeetPerInch, compositionScaleFactor } = useStitchStore.getState();
  // Guard against a zero/NaN factor (should not happen in practice) so division never
  // produces Infinity/NaN in the manifest — treat it as an unscaled (1x) composition.
  const factor = compositionScaleFactor && Number.isFinite(compositionScaleFactor) ? compositionScaleFactor : 1;
  const pdfTiles = tiles.filter((t: StitchTile) => t.sourcePageIndex >= 0 && !t.isScaleStamp);
  let bounds: { x: number; y: number; w: number; h: number };
  if (cropRect) {
    bounds = { x: cropRect.x, y: cropRect.y, w: cropRect.w, h: cropRect.h };
  } else {
    const b = contentExportBounds(canvasWidth, canvasHeight, tiles.map(getTileAABB));
    bounds = { x: b.cropX, y: b.cropY, w: b.cropW, h: b.cropH };
  }
  const inside = pdfTiles.filter((t) => tileIntersectsCrop(t, bounds.x, bounds.y, bounds.w, bounds.h));
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    canvas: { widthPt: canvasWidth, heightPt: canvasHeight },
    exportBounds: bounds,
    referenceScaleFeetPerInch: referenceScaleFeetPerInch ?? null,
    effectiveReferenceScaleFeetPerInch: referenceScaleFeetPerInch != null ? referenceScaleFeetPerInch / factor : null,
    compositionScaleFactor,
    tiles: inside.map((t) => ({
      sourceFileName: t.sourceFileName ?? null,
      sourcePageIndex: t.sourcePageIndex,
      x: t.x, y: t.y, width: t.width, height: t.height,
      rotation: t.rotation ?? 0,
      scaleFeetPerInch: t.scaleFeetPerInch ?? null,
      effectiveScaleFeetPerInch: t.scaleFeetPerInch != null ? t.scaleFeetPerInch / factor : null,
      hiddenRegions: (t.hiddenRegions ?? []).map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
      relocatedRegions: (t.relocatedRegions ?? []).map((r) => ({ rect: { x: r.rect.x, y: r.rect.y, w: r.rect.w, h: r.rect.h }, dx: r.dx, dy: r.dy })),
    })),
  };
}
