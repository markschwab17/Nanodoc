/**
 * Committing selected PDF pages onto the stitch canvas.
 *
 * Two entry points, both extracted verbatim from `AddPdfModal`'s handlers so a
 * plan-driven entry screen can commit the same way the modal does:
 *  - `commitPlainAdd`    — render each page and flow the tiles into a grid.
 *  - `commitAutoAlign`   — render, then place by the auto-stitch solver (or a
 *                          probe result the caller already has cached).
 *
 * Both read and write `useStitchStore` directly (addTiles /
 * setReferenceScaleFeetPerInch / setSelectedTileIds) and RETURN the user-facing
 * message rather than showing it — the caller owns notifications, error copy
 * and closing whatever UI invoked the commit.
 */

import type { PDFRenderer } from "@/core/pdf/PDFRenderer";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { makeWhiteTransparentInPlace } from "@/features/stitch/imageUtils";
import { getTileAABB } from "@/features/stitch/stitchGeometry";
import { autoStitch, AutoStitchAborted } from "@/features/stitch/autostitch/autoStitch";
import { frameMask, type TilePlacement } from "@/features/stitch/autostitch/layout";
import type { AlignmentVerdict, SeamStatus, SeamReportEntry } from "@/features/stitch/autostitch/stitchCore";
import type { AutoAlignReason } from "./addToProjectCopy";
import type { recognize } from "./autostitch/ocrService";
import { resolvePageScale, isUniform, tileSizeAtReference, referenceScaleFor, referenceBaseline } from "./pageScales";
import { tileRenderScale, encodeTileRasterPng, TILE_RENDER_SCALE } from "./rasterEncode";

export { TILE_RENDER_SCALE };

/** Shown on a tile whose sheet image could not be produced. A raster that fails
 *  to encode used to render as NOTHING — an invisible tile the user could still
 *  select and drag but never see. */
export const RASTER_ERROR_MESSAGE = "This sheet's image couldn't be created. Remove it and add the page again.";
export const MARGIN = 20;
export const GAP = 10;
export const TILES_PER_ROW = 3;

/** Yield to the event loop so the tab stays responsive during long PDF work. */
export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function imageDataToDataUrl(imageData: ImageData): string {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

export interface CommitInput {
  mupdf: any;
  doc: any;
  pdfBytes: Uint8Array;
  fileName: string | undefined;
  /** Ascending page indices. */
  selected: number[];
  /** Per-page feet-per-inch overrides. */
  pageScales: Map<number, number>;
  /** The typed set scale, or null when the user left the field empty. */
  uniformScale: number | null;
  /** Sheet identity the caller already knows, per page (CTO's plan labels). Fed
   *  straight to `autoStitch`; ignored by a plain add. */
  pageCodes?: Map<number, string>;
  removeWhiteBackground: boolean;
  renderer: PDFRenderer;
  onProgress?: (done: number, total: number) => void;
  ocr?: typeof recognize;
  /** Cooperative abort, checked between page renders and handed straight to
   *  `autoStitch`. When it goes true the commit throws `AutoStitchAborted`
   *  BEFORE `addTiles`, so an aborted run leaves the canvas untouched — the
   *  caller can treat that error as "cancelled", not "failed". */
  shouldAbort?: () => boolean;
}

export interface CommitResult {
  added: number;
  unalignedIds: string[];
  message: string | null;
  /** Auto-align only. The honesty verdict from the post-solve seam verification,
   *  and WHY the run did not place everything (`'ok'` when it did). */
  verdict?: AlignmentVerdict;
  reason?: AutoAlignReason;
  /** Per-seam quality, for the UI: which pages, how the seam rated, and how far it
   *  sits from what its own measurement said. */
  seams?: { pageIndexes: [number, number]; status: SeamStatus; residFt?: number; perpDeltaFt?: number }[];
  /** Pages deliberately kept out of the tiling (overall/key/notes/index/details). */
  skipped?: { pageIndex: number; role: string }[];
  /** 0-based indices of committed pages carrying no readable sheet number or
   *  matchline callout — the pages `reason: 'no_refs'` is about. */
  pagesWithoutRefs?: number[];
}

/** Row flow used by the plain add: `TILES_PER_ROW` tiles per row, `GAP` between
 *  them, each row as tall as its tallest tile, the first row starting at
 *  `startY` (below anything already on the canvas). Pure — same sizes in, same
 *  positions out, in the same order. */
export function gridLayout(sizes: { w: number; h: number }[], startY: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  let rowY = startY;
  for (let i = 0; i < sizes.length; i += TILES_PER_ROW) {
    const row = sizes.slice(i, i + TILES_PER_ROW);
    let x = MARGIN;
    const maxH = Math.max(...row.map((s) => s.h));
    for (const s of row) {
      out.push({ x, y: rowY });
      x += s.w + GAP;
    }
    rowY += maxH + GAP;
  }
  return out;
}

/** The reference scale an auto-align commit lands on, and whether it may be
 *  written to the store. Priority: an explicitly typed set scale wins outright;
 *  else a canvas that already has sheets keeps its own reference scale (the
 *  same baseline rule as the plain add — see `referenceBaseline`); else a
 *  uniform selection roots on its one resolved scale and a mixed selection
 *  roots on the solver's `rootFtPerIn` (already per-page-scale aware). The
 *  store is only written when the user typed a scale or nothing is set yet,
 *  so a guessed scale never silently overwrites a deliberate canvas scale. */
export function finalReferenceScale(args: {
  uniformScale: number | null;
  existingRef: number | null;
  hasTiles: boolean;
  isUniformSelection: boolean;
  refScale: number;
  rootFtPerIn: number;
}): { value: number; write: boolean } {
  const { uniformScale, existingRef, hasTiles, isUniformSelection, refScale, rootFtPerIn } = args;
  const value =
    uniformScale ??
    (hasTiles && existingRef != null && existingRef > 0 ? existingRef : isUniformSelection ? refScale : rootFtPerIn);
  return { value, write: uniformScale != null || existingRef == null };
}

type TileData = {
  sourcePdfBytes: Uint8Array;
  sourcePageIndex: number;
  sourceFileName?: string;
  width: number;
  height: number;
  /** The committed sheet PNG. `addTiles` turns it into a `tileRasters` entry
   *  keyed by the new tile id — it never lands on the tile itself. */
  rasterBlob?: Blob;
  rasterError?: string;
  scaleFeetPerInch?: number;
};

/** Render the selected pages and flow them into a grid below whatever is
 *  already on the canvas. Throws on render failure; the caller owns the error
 *  copy. */
/**
 * After tiles land: if the user has never picked a canvas size themselves, the page is still
 * the 8.5×11 default — far too small for construction plan sheets, which is exactly what made
 * a fresh stitch session look like a stamp-sized page under a wall of drawings. Grow the paper
 * to wrap what was just placed. A size the user chose is left alone.
 */
function fitCanvasIfUntouched(): void {
  const store = useStitchStore.getState();
  if (store.canvasSizeTouched) return;
  store.fitCanvasToTiles();
}

export async function commitPlainAdd(input: CommitInput): Promise<CommitResult> {
  const { doc, pdfBytes, fileName, selected, pageScales, uniformScale, removeWhiteBackground, renderer, onProgress, shouldAbort } = input;
  const checkAbort = () => { if (shouldAbort?.()) throw new AutoStitchAborted(); };

  const newTiles: Array<TileData & { x: number; y: number }> = [];
  // ONE reference scale for the whole commit: the typed set scale wins; else a
  // canvas that already has sheets keeps its own reference (so a second blank-box
  // batch matches feet with what's already there); else the selection decides
  // (first selected page's own resolved scale — see `referenceBaseline`). Every
  // tile in this batch sizes against this same feet-per-inch baseline.
  const existingRef = useStitchStore.getState().referenceScaleFeetPerInch;
  const hasTiles = useStitchStore.getState().tiles.some((t) => t.sourcePageIndex >= 0 && !t.isScaleStamp);
  const refScale = referenceBaseline({ typed: uniformScale, existing: existingRef, hasTiles, selection: selected, pageScales });
  // Start below any existing content so a second add doesn't stack
  // perfectly on top of the first batch.
  const existingTiles = useStitchStore.getState().tiles;
  let startY = MARGIN;
  for (const t of existingTiles) {
    const aabb = getTileAABB(t);
    startY = Math.max(startY, aabb.y + aabb.height + GAP);
  }

  const sizes: Array<{ w: number; h: number }> = [];
  for (let idx = 0; idx < selected.length; idx++) {
    const pageIndex = selected[idx];
    await yieldToMain();
    checkAbort();
    const page = doc.loadPage(pageIndex);
    const bounds = page.getBounds();
    page.destroy?.();
    const widthPt = bounds[2] - bounds[0];
    const heightPt = bounds[3] - bounds[1];
    // Use original PDF page size in pt (e.g. 8.5"×11" = 612×792 pt), scaled up
    // when this page's own scale is coarser than the batch's reference scale
    // (mixed-scale sets size and align by feet).
    const pageScale = resolvePageScale(pageIndex, pageScales, uniformScale);
    const { width: tileW, height: tileH } = tileSizeAtReference(widthPt, heightPt, pageScale, refScale);
    // noCache: this raster is copied into a PNG on the next line and never
    // requested again — caching it would pin 38 MB per sheet for the session.
    const rendered = await renderer.renderPage(doc, pageIndex, { scale: tileRenderScale(widthPt, heightPt), noCache: true });
    const imageData = rendered.imageData as ImageData;
    if (imageData && imageData.data && removeWhiteBackground) makeWhiteTransparentInPlace(imageData);
    // The encode runs in a worker and CONSUMES imageData (the pixel buffer is
    // transferred), so nothing may touch it after this point.
    const raster = imageData && imageData.data ? await encodeTileRasterPng(imageData) : null;
    newTiles.push({
      sourcePdfBytes: pdfBytes,
      sourcePageIndex: pageIndex,
      sourceFileName: fileName,
      width: tileW,
      height: tileH,
      rasterBlob: raster ?? undefined,
      rasterError: raster ? undefined : RASTER_ERROR_MESSAGE,
      scaleFeetPerInch: pageScale,
      x: 0,
      y: 0,
    });
    sizes.push({ w: tileW, h: tileH });
    onProgress?.(idx + 1, selected.length);
  }
  // Last checkpoint before anything is written: past here the commit lands.
  checkAbort();
  const positions = gridLayout(sizes, startY);
  for (let i = 0; i < newTiles.length; i++) {
    newTiles[i].x = positions[i].x;
    newTiles[i].y = positions[i].y;
  }

  // Only write the store when the user typed a scale or the store is unset —
  // otherwise a blank box on a canvas that already has a reference scale would
  // silently overwrite a deliberately set canvas scale with a guessed one.
  if (uniformScale != null || existingRef == null) useStitchStore.getState().setReferenceScaleFeetPerInch(refScale);
  useStitchStore.getState().addTiles(newTiles);
  fitCanvasIfUntouched();
  return { added: newTiles.length, unalignedIds: [], message: null };
}

/** Render the selected pages, place them by the auto-stitch solver (or by
 *  `cached` placements the caller already probed), and commit as one undo step.
 *  Returns the report line; the caller shows it. Throws on failure. */
export async function commitAutoAlign(
  input: CommitInput & { cached?: { placements: TilePlacement[]; rootFtPerIn: number; worstResidFt: number } | null }
): Promise<CommitResult> {
  const {
    mupdf, doc, pdfBytes, fileName, selected, pageScales, uniformScale, pageCodes,
    removeWhiteBackground, renderer, onProgress, ocr, cached, shouldAbort,
  } = input;
  const checkAbort = () => { if (shouldAbort?.()) throw new AutoStitchAborted(); };

  // 1. Render rasters for the selected pages (same as the plain add).
  // Keyed by page index and holding the BLOB: a two-strip page commits twice,
  // and `addTiles` gives each resulting tile its OWN object URL so revoking one
  // cannot blank the other.
  const rasters = new Map<number, Blob>();
  for (let i = 0; i < selected.length; i++) {
    const pageIndex = selected[i];
    await new Promise<void>((r) => setTimeout(r, 0));
    checkAbort();
    const bpage = doc.loadPage(pageIndex);
    const pbounds = bpage.getBounds();
    bpage.destroy?.();
    const scale = tileRenderScale(pbounds[2] - pbounds[0], pbounds[3] - pbounds[1]);
    // noCache — see commitPlainAdd.
    const rendered = await renderer.renderPage(doc, pageIndex, { scale, noCache: true });
    const imageData = rendered.imageData as ImageData;
    if (imageData?.data && removeWhiteBackground) makeWhiteTransparentInPlace(imageData);
    // Consumes imageData (buffer transferred to the encode worker).
    const raster = imageData?.data ? await encodeTileRasterPng(imageData) : null;
    if (raster) rasters.set(pageIndex, raster);
    onProgress?.(i + 1, selected.length);
  }

  // 2. Placements: prefer the caller's cached probe (skip the second stitch);
  //    else fall back to running the aligner live (probe absent/errored/running).
  // The probe always ran with a uniform (null) scale, so its cached poses are
  // only valid when this selection turns out uniform too — a mixed selection
  // always takes the live path, which is per-page-scale aware.
  const isUniformSelection = isUniform(selected, pageScales, uniformScale);
  let placements: TilePlacement[];
  let rootFtPerIn: number;
  let worstResidFt: number;
  let verdict: AlignmentVerdict | undefined;
  let seamReport: SeamReportEntry[] | undefined;
  let skipped: { pageIndex: number; role: string }[] = [];
  let refPageIndices: number[] = [];
  let method: string = "none";
  if (cached) {
    // The cached path skips the solver entirely, so its own abort checkpoints
    // never run — check here instead.
    checkAbort();
    placements = cached.placements;
    rootFtPerIn = cached.rootFtPerIn;
    worstResidFt = cached.worstResidFt;
  } else {
    const result = await autoStitch(mupdf, doc, selected, {
      userScale: uniformScale,
      pageScales,
      pageCodes,
      onProgress,
      ocr,
      shouldAbort,
    });
    placements = result.placements;
    rootFtPerIn = result.rootFtPerIn;
    worstResidFt = result.worstResidFt;
    verdict = result.alignmentVerdict;
    seamReport = result.seamReport;
    skipped = result.skipped.map((s) => ({ pageIndex: s.pageIndex, role: s.role }));
    refPageIndices = result.refPageIndices;
    method = result.method;
  }

  // ── HONESTY GATE ON THE COMMIT ──────────────────────────────────────────────
  // A placement the solver could not physically verify must not be presented as an
  // alignment. Two cases are demoted to "unaligned" — placed below, selected, and
  // counted in the coach mark — rather than committed into the composite:
  //   • a unit every one of whose seams is SUSPECT (a seam is suspect only on
  //     positive evidence it is wrong; one verified seam elsewhere still anchors it);
  //   • a unit bonded ONLY through the band-seam channel, the weakest in the ladder.
  // This is what the CTO plan path was missing: the modal has always refused to
  // offer auto-align on an unverified set, while `commitAutoAlign` committed it.
  const demoted = new Set<number>();
  if (seamReport?.length) {
    const status = new Map<number, { verified: number; suspect: number; seamOnly: number; total: number }>();
    for (const s of seamReport) {
      for (const pageIndex of s.pageIndexes) {
        const e = status.get(pageIndex) ?? { verified: 0, suspect: 0, seamOnly: 0, total: 0 };
        e.total++;
        if (s.status === "verified") e.verified++;
        if (s.status === "suspect") e.suspect++;
        if (s.detail.channel === "seam") e.seamOnly++;
        status.set(pageIndex, e);
      }
    }
    for (const [pageIndex, e] of status) {
      if (e.verified > 0) continue;
      if (e.suspect === e.total || e.seamOnly === e.total) demoted.add(pageIndex);
    }
  }

  // 3. Build one tile per PLACEMENT (a two-strip page commits twice, each
  //    masked to its own frame) and commit as one undo step.
  const newTiles = placements.map((p) => {
    const page = doc.loadPage(p.pageIndex);
    const bounds = page.getBounds();
    page.destroy?.();
    const pw = bounds[2] - bounds[0], ph = bounds[3] - bounds[1];
    return {
      sourcePdfBytes: pdfBytes,
      sourcePageIndex: p.pageIndex,
      sourceFileName: fileName,
      x: p.x, y: p.y,
      width: p.width, height: p.height,
      rasterBlob: rasters.get(p.pageIndex),
      rasterError: rasters.has(p.pageIndex) ? undefined : RASTER_ERROR_MESSAGE,
      hiddenRegions: p.sourceFrame ? frameMask(p.sourceFrame, pw, ph) : undefined,
      scaleFeetPerInch: resolvePageScale(p.pageIndex, pageScales, uniformScale),
    };
  });
  // Read the pre-commit baseline BEFORE addTiles below so "does the canvas already
  // have sheets" reflects what was there before this batch, not this batch itself.
  const existingRef = useStitchStore.getState().referenceScaleFeetPerInch;
  const hasTiles = useStitchStore.getState().tiles.some((t) => t.sourcePageIndex >= 0 && !t.isScaleStamp);
  // Last checkpoint before anything is written: past here the commit lands.
  checkAbort();
  useStitchStore.getState().addTiles(newTiles);
  fitCanvasIfUntouched();
  const refScale = referenceScaleFor(selected, pageScales, uniformScale);
  const { value: finalRef, write } = finalReferenceScale({
    uniformScale, existingRef, hasTiles, isUniformSelection, refScale, rootFtPerIn,
  });
  if (write) useStitchStore.getState().setReferenceScaleFeetPerInch(finalRef);

  // 4. Leave unaligned tiles selected so the user can place them manually.
  const added = useStitchStore.getState().tiles.slice(-newTiles.length);
  const alignedSet = new Set(
    placements.filter((p) => p.aligned && !demoted.has(p.pageIndex)).map((p) => p.pageIndex),
  );
  const unalignedIds = added.filter((t) => !alignedSet.has(t.sourcePageIndex)).map((t) => t.id);
  if (unalignedIds.length) useStitchStore.getState().setSelectedTileIds(unalignedIds);

  // 5. Report — including WHY, when it did not place everything.
  //   no_refs       nothing on these sheets says which sheet they are or what they
  //                 adjoin, so there was never anything to match by;
  //   not_adjacent  the sheets are readable but reference no one another — they are
  //                 simply not neighbours;
  //   unverified    they were matched, but the seams could not be confirmed.
  const refSet = new Set(refPageIndices);
  const pagesWithoutRefs = selected.filter((p) => !refSet.has(p));
  let reason: AutoAlignReason = "ok";
  if (method === "none") reason = refPageIndices.length < 2 ? "no_refs" : "not_adjacent";
  else if (verdict === "unverified" || demoted.size > 0) reason = "unverified";
  const alignedCount = selected.length - unalignedIds.length;
  const message = unalignedIds.length > 0
    ? `Aligned ${alignedCount} of ${selected.length} pages · worst seam ${worstResidFt.toFixed(2)} ft. ${unalignedIds.length} placed below for manual alignment.`
    : `Aligned ${selected.length} pages · worst seam ${worstResidFt.toFixed(2)} ft.`;
  return {
    added: newTiles.length, unalignedIds, message,
    verdict, reason, skipped, pagesWithoutRefs,
    seams: seamReport?.map((s) => ({
      pageIndexes: s.pageIndexes, status: s.status,
      residFt: s.detail.residFt, perpDeltaFt: s.detail.perpDeltaFt,
    })),
  };
}
