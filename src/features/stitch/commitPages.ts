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
import { autoStitch, AutoStitchAborted, type OcrStats } from "@/features/stitch/autostitch/autoStitch";
import { frameMask, type TilePlacement } from "@/features/stitch/autostitch/layout";
import type { AlignmentVerdict, SeamStatus, SeamReportEntry } from "@/features/stitch/autostitch/stitchCore";
import { AUTO_ALIGN_UNAVAILABLE_REASONS, type AutoAlignReason } from "./addToProjectCopy";
import type { recognize } from "./autostitch/ocrService";
import { resolvePageScale, isUniform, tileSizeAtReference, referenceScaleFor, referenceBaseline, newTileCanvasFactor, assertEveryPageScaled } from "./pageScales";
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
  /** The typed set scale, or null when the user left the field empty. Between them,
   *  `pageScales` and `uniformScale` MUST give every selected page a scale: a commit
   *  throws `MissingSheetScaleError` before rendering anything rather than size a
   *  sheet at a guessed 1"=20' (see `assertEveryPageScaled`). */
  uniformScale: number | null;
  /** Sheet identity the caller already knows, per page (CTO's plan labels). Fed
   *  straight to `autoStitch`; ignored by a plain add. */
  pageCodes?: Map<number, string>;
  removeWhiteBackground: boolean;
  renderer: PDFRenderer;
  onProgress?: (done: number, total: number) => void;
  ocr?: typeof recognize;
  /** Auto-align only: tile ids this commit REPLACES. The store swaps them for the new
   *  tiles in one undo step, so a single undo after an earned auto-align puts the grid
   *  back rather than leaving the grid and the composite on the canvas together. */
  replaceTileIds?: string[];
  /** Cooperative abort, checked between page renders and handed straight to
   *  `autoStitch`. When it goes true the commit throws `AutoStitchAborted`
   *  BEFORE `addTiles`, so an aborted run leaves the canvas untouched — the
   *  caller can treat that error as "cancelled", not "failed". */
  shouldAbort?: () => boolean;
}

/**
 * A probe result the caller has already paid for, reused instead of re-running the
 * solver. It must carry the honesty payload too: without it the commit had no seam
 * report, so the demotion below silently did nothing and the modal path committed
 * placements the plan path would have held back.
 */
export interface CachedProbePlacement {
  placements: TilePlacement[];
  rootFtPerIn: number;
  worstResidFt: number;
  method?: string;
  seamReport?: SeamReportEntry[];
  alignmentVerdict?: AlignmentVerdict;
  alongAnchored?: number[];
  worstAlongUncertaintyFt?: number;
  worstAlongUncertaintySource?: "sweep" | "vote" | "bound";
  refPageIndices?: number[];
}

export interface CommitResult {
  added: number;
  unalignedIds: string[];
  message: string | null;
  /** Auto-align only. The honesty verdict from the post-solve seam verification,
   *  and WHY the run did not place everything (`'ok'` when it did).
   *
   *  READ THESE TOGETHER, ALWAYS. On `reason: 'too_slow'` (unknown OCR reads twice)
   *  `verdict` and `seams` still carry the numbers off that second, still-holed solve
   *  — real figures computed over the anchors that DID land, and therefore exactly the
   *  kind of confident-looking evidence nobody is standing behind. Nothing may quote
   *  them without checking `reason` first; that is why `message` omits the seam figure
   *  entirely on this path. */
  verdict?: AlignmentVerdict;
  reason?: AutoAlignReason;
  /** Per-seam quality, for the UI: which pages, how the seam rated, how far it sits
   *  from what its own measurement said, and whether it pinned the along axis. Carries
   *  the still-holed second solve's numbers on `reason: 'too_slow'` — see `verdict`. */
  seams?: { pageIndexes: [number, number]; status: SeamStatus; residFt?: number; perpDeltaFt?: number; alongAnchored?: boolean }[];
  /** Page indices pinned along the matchline as well as across it, and how far an
   *  un-anchored one could slide. `worstAlongUncertaintySource` says whether that
   *  figure was MEASURED (`sweep`/`vote`) or is only the geometric bound (`bound`) —
   *  a bound must not be read out to the user as "up to N ft". */
  alongAnchored?: number[];
  worstAlongUncertaintyFt?: number;
  worstAlongUncertaintySource?: "sweep" | "vote" | "bound";
  /** 0-based indices of pages the solve PLACED but never pinned along the matchline —
   *  the pages `reason: 'along_unresolved'` is about. Deliberately not "every page in
   *  the run minus the anchored ones": a page that was never placed at all (no refs,
   *  a skipped notes sheet) has a different problem, and naming it here told the user
   *  a sheet "meets the matchline correctly" when nothing ever matched it.
   *  Absent when the solver reported no along data (old probes). */
  alongUnresolvedPages?: number[];
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
  // No sheet is ever sized at a guessed scale: fail before any work if one has none.
  assertEveryPageScaled(selected, pageScales, uniformScale);

  const newTiles: Array<TileData & { x: number; y: number }> = [];
  // ONE reference scale for the whole commit: the typed set scale wins; else a
  // canvas that already has sheets keeps its own reference (so a second blank-box
  // batch matches feet with what's already there); else the selection decides
  // (first selected page's own resolved scale — see `referenceBaseline`). Every
  // tile in this batch sizes against this same feet-per-inch baseline.
  const existingRef = useStitchStore.getState().referenceScaleFeetPerInch;
  const hasTiles = useStitchStore.getState().tiles.some((t) => t.sourcePageIndex >= 0 && !t.isScaleStamp);
  const refScale = referenceBaseline({ typed: uniformScale, existing: existingRef, hasTiles, selection: selected, pageScales });
  // Then onto the canvas as the user has ADJUSTED it: "Adjusted 1\"=" scaled every
  // sheet already placed, and a new sheet must land at that same feet-per-canvas-inch
  // — sized at the reference alone it came in "pre-adjust", out of step with its
  // neighbours. (Sizes are at `refScale` and the store is about to keep `refScale`,
  // so only the composition factor applies here.)
  const canvasFactor = newTileCanvasFactor({
    compositionScaleFactor: useStitchStore.getState().compositionScaleFactor,
    batchRef: refScale,
    canvasRef: refScale,
  });
  // Start below any existing content so a second add doesn't stack
  // perfectly on top of the first batch.
  const existingTiles = useStitchStore.getState().tiles;
  let startY = MARGIN;
  for (const t of existingTiles) {
    const aabb = getTileAABB(t);
    startY = Math.max(startY, aabb.y + aabb.height + GAP);
  }

  const sizes: Array<{ w: number; h: number }> = [];
  // Depth-1 encode pipeline: the PNG encode for page N runs in the worker while
  // the main thread rasterises page N+1 (the raster is ~700-1200 ms of mupdf,
  // the encode ~200-300 ms, and they used to run back to back). Exactly one
  // encode is ever in flight, so at most two rasters are live on this side —
  // the memory budget the cap bought is not handed back.
  let inFlight: { at: number; blob: Promise<Blob | null> } | null = null;
  const drainEncode = async () => {
    if (!inFlight) return;
    const { at, blob } = inFlight;
    inFlight = null;
    const raster = await blob;
    newTiles[at].rasterBlob = raster ?? undefined;
    newTiles[at].rasterError = raster ? undefined : RASTER_ERROR_MESSAGE;
  };
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
    const atRef = tileSizeAtReference(widthPt, heightPt, pageScale, refScale);
    const tileW = atRef.width * canvasFactor;
    const tileH = atRef.height * canvasFactor;
    // noCache: this raster is copied into a PNG on the next line and never
    // requested again — caching it would pin 38 MB per sheet for the session.
    const rendered = await renderer.renderPage(doc, pageIndex, { scale: tileRenderScale(widthPt, heightPt), noCache: true });
    const imageData = rendered.imageData as ImageData;
    if (imageData && imageData.data && removeWhiteBackground) makeWhiteTransparentInPlace(imageData);
    // Collect the PREVIOUS page's encode now that this page's raster is done —
    // it ran in the worker while mupdf was busy above.
    await drainEncode();
    newTiles.push({
      sourcePdfBytes: pdfBytes,
      sourcePageIndex: pageIndex,
      sourceFileName: fileName,
      width: tileW,
      height: tileH,
      rasterError: RASTER_ERROR_MESSAGE, // replaced by drainEncode on success
      scaleFeetPerInch: pageScale,
      x: 0,
      y: 0,
    });
    if (imageData && imageData.data) {
      inFlight = { at: newTiles.length - 1, blob: encodeTileRasterPng(imageData) };
    }
    sizes.push({ w: tileW, h: tileH });
    // Progress tracks the RASTER, the long pole — not the encode trailing it.
    onProgress?.(idx + 1, selected.length);
  }
  await drainEncode();
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
  input: CommitInput & { cached?: CachedProbePlacement | null }
): Promise<CommitResult> {
  const {
    mupdf, doc, pdfBytes, fileName, selected, pageScales, uniformScale, pageCodes,
    removeWhiteBackground, renderer, onProgress, ocr, cached, shouldAbort, replaceTileIds,
  } = input;
  const checkAbort = () => { if (shouldAbort?.()) throw new AutoStitchAborted(); };
  // No sheet is ever sized at a guessed scale — and the live solver below would
  // otherwise fill a gap with its own 1"=20' default. Fail before any work.
  assertEveryPageScaled(selected, pageScales, uniformScale);

  // 1. Render rasters for the selected pages (same as the plain add).
  // Keyed by page index and holding the BLOB: a two-strip page commits twice,
  // and `addTiles` gives each resulting tile its OWN object URL so revoking one
  // cannot blank the other.
  const rasters = new Map<number, Blob>();
  // Depth-1 encode pipeline — see commitPlainAdd.
  let inFlight: { pageIndex: number; blob: Promise<Blob | null> } | null = null;
  const drainEncode = async () => {
    if (!inFlight) return;
    const { pageIndex, blob } = inFlight;
    inFlight = null;
    const raster = await blob;
    if (raster) rasters.set(pageIndex, raster);
  };
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
    await drainEncode();
    if (imageData?.data) inFlight = { pageIndex, blob: encodeTileRasterPng(imageData) };
    onProgress?.(i + 1, selected.length);
  }
  await drainEncode();

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
  let alongAnchored: number[] | undefined;
  let worstAlongUncertaintyFt = 0;
  let worstAlongUncertaintySource: "sweep" | "vote" | "bound" | undefined;
  /** The live run reached its layout without a read it asked for, twice over. Set
   *  only on the live path — a cached probe has already been through the same gate
   *  in the modal/hook, which is why it is cached at all. */
  let unknownEvidence = false;
  if (cached) {
    // The cached path skips the solver entirely, so its own abort checkpoints
    // never run — check here instead.
    checkAbort();
    placements = cached.placements;
    rootFtPerIn = cached.rootFtPerIn;
    worstResidFt = cached.worstResidFt;
    // The honesty payload the probe already computed. `method` matters: without it
    // every cached commit reported `method: "none"` and therefore the wrong reason.
    method = cached.method ?? (cached.placements.some((p) => p.aligned) ? "geometric" : "none");
    verdict = cached.alignmentVerdict;
    seamReport = cached.seamReport;
    alongAnchored = cached.alongAnchored;
    worstAlongUncertaintyFt = cached.worstAlongUncertaintyFt ?? 0;
    worstAlongUncertaintySource = cached.worstAlongUncertaintySource;
    refPageIndices = cached.refPageIndices ?? selected;
  } else {
    /**
     * THE LIVE PATH RUNS THE ALIGNER ITSELF, so it owns the same promise the probe
     * makes — and used to break.
     *
     * The probe gates (`useEarnedAutoAlign`, `modalProbeGate`) refuse to present a
     * verdict built on reads that never came back. But this branch is not the probe:
     * it is reached whenever there is no cached result to reuse — no probe ran, it
     * errored, it is still going, or (the live case that matters) the user ticked a
     * MIXED-SCALE selection, which can never reuse the uniform-scale probe. The modal
     * then offers "Add & auto-align" off a probe that WAS clean, and the commit
     * quietly re-solves with reads that may not be. One lost strip read moves a
     * Belcourt sheet ~39 ft with the verdict, the residual and the anchor list
     * unchanged, so nothing downstream would ever have noticed.
     *
     * Same rule as the probe, therefore: unknown reads → run it once more (a second
     * expired 20 s job on the same crop is a different roll of the same dice, and one
     * clean re-run is what the hook already does); still unknown → nothing this run
     * measured is committed as an alignment. The sheets are still PLACED — they are
     * just all placed for the user to align by hand, with the existing "the check took
     * too long" copy saying why. Never a composite built on a read that never landed.
     */
    const runSolver = () => autoStitch(mupdf, doc, selected, {
      userScale: uniformScale,
      pageScales,
      pageCodes,
      onProgress,
      ocr,
      shouldAbort,
    });
    const holed = (r: { ocrStats?: OcrStats }) => (r.ocrStats?.unknown ?? 0) > 0;
    let result = await runSolver();
    if (holed(result)) {
      // Between the two runs, and only here: a user who cancelled during the first
      // solve must not pay for a second. `autoStitch` re-checks continuously inside.
      checkAbort();
      console.debug("[commitAutoAlign] unknown OCR reads — re-solving once", result.ocrStats);
      result = await runSolver();
      unknownEvidence = holed(result);
      if (unknownEvidence) console.warn("[commitAutoAlign] unknown OCR reads twice — placing for manual alignment", result.ocrStats);
    }
    placements = result.placements;
    rootFtPerIn = result.rootFtPerIn;
    worstResidFt = result.worstResidFt;
    // Taken from the LAST solve either way — including the second, still-holed one when
    // `unknownEvidence` is set. They are not lies, they are just answers to a question
    // asked of incomplete evidence, so they only mean anything alongside `reason`
    // ('too_slow'); see CommitResult.verdict.
    verdict = result.alignmentVerdict;
    seamReport = result.seamReport;
    skipped = result.skipped.map((s) => ({ pageIndex: s.pageIndex, role: s.role }));
    refPageIndices = result.refPageIndices;
    method = result.method;
    alongAnchored = result.alongAnchored;
    worstAlongUncertaintyFt = result.worstAlongUncertaintyFt ?? 0;
    worstAlongUncertaintySource = result.worstAlongUncertaintySource;
  }

  // ── HONESTY GATE ON THE COMMIT ──────────────────────────────────────────────
  // A placement the solver could not stand behind must not be presented as an
  // alignment. Three cases are demoted to "unaligned" — placed below, selected, and
  // named by the coach mark — rather than committed into the composite:
  //   • a unit with ANY suspect seam and no verified one (a seam is suspect only on
  //     positive evidence it is wrong; a verified seam elsewhere still anchors it);
  //   • a unit bonded ONLY through the band-seam channel, the weakest in the ladder;
  //   • a unit that is not ALONG-ANCHORED — connected across its seams but never
  //     pinned along them, so it can sit tens of feet out while every cross-seam
  //     residual is sub-foot. That is the reference set's p8 (42 ft), p9 (22 ft) and
  //     both strips (63-70 ft), and it is the case that made "offered" mean "looks
  //     right and is wrong".
  // Demote, never block: the sheets are still placed, just not claimed as aligned.
  const demoted = new Set<number>();
  const alongSet = alongAnchored ? new Set(alongAnchored) : null;
  const status = new Map<number, { verified: number; suspect: number; seamOnly: number; total: number }>();
  for (const s of seamReport ?? []) {
    for (const pageIndex of s.pageIndexes) {
      const e = status.get(pageIndex) ?? { verified: 0, suspect: 0, seamOnly: 0, total: 0 };
      e.total++;
      if (s.status === "verified") e.verified++;
      if (s.status === "suspect") e.suspect++;
      if (s.detail.channel === "seam") e.seamOnly++;
      status.set(pageIndex, e);
    }
  }
  for (const p of placements) {
    if (!p.aligned) continue;
    if (alongSet && !alongSet.has(p.pageIndex)) { demoted.add(p.pageIndex); continue; }
    const e = status.get(p.pageIndex);
    if (!e || e.verified > 0) continue;
    if (e.suspect > 0 || e.seamOnly === e.total) demoted.add(p.pageIndex);
  }
  // The FOURTH case, and the only one that is not about the geometry: the run reached
  // this layout twice without a read it asked for. The seam report cannot catch that —
  // it grades what was measured, and the hole is in what wasn't — so the demotion is
  // wholesale. Every sheet is placed, none is claimed.
  if (unknownEvidence) for (const p of placements) demoted.add(p.pageIndex);

  // Read the pre-commit baseline BEFORE addTiles below so "does the canvas already
  // have sheets" reflects what was there before this batch, not this batch itself.
  const existingRef = useStitchStore.getState().referenceScaleFeetPerInch;
  const hasTiles = useStitchStore.getState().tiles.some((t) => t.sourcePageIndex >= 0 && !t.isScaleStamp);
  const refScale = referenceScaleFor(selected, pageScales, uniformScale);
  const { value: finalRef, write } = finalReferenceScale({
    uniformScale, existingRef, hasTiles, isUniformSelection, refScale, rootFtPerIn,
  });
  // The solver's poses are in points at `rootFtPerIn`; the canvas keeps `finalRef`
  // and has been scaled as a whole by the user's "Adjusted 1\"=". Bring the poses
  // onto the canvas as it stands (see `newTileCanvasFactor`) — without this the
  // aligned set replaced an adjusted grid at its un-adjusted size.
  const canvasFactor = newTileCanvasFactor({
    compositionScaleFactor: useStitchStore.getState().compositionScaleFactor,
    batchRef: rootFtPerIn,
    canvasRef: finalRef,
  });

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
      x: p.x * canvasFactor, y: p.y * canvasFactor,
      width: p.width * canvasFactor, height: p.height * canvasFactor,
      rasterBlob: rasters.get(p.pageIndex),
      rasterError: rasters.has(p.pageIndex) ? undefined : RASTER_ERROR_MESSAGE,
      hiddenRegions: p.sourceFrame ? frameMask(p.sourceFrame, pw, ph) : undefined,
      scaleFeetPerInch: resolvePageScale(p.pageIndex, pageScales, uniformScale),
    };
  });
  // Last checkpoint before anything is written: past here the commit lands.
  checkAbort();
  if (replaceTileIds?.length) useStitchStore.getState().replaceTiles(replaceTileIds, newTiles);
  else useStitchStore.getState().addTiles(newTiles);
  fitCanvasIfUntouched();
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
  const alongUnresolvedPages = alongSet
    ? [...new Set(placements.filter((p) => p.aligned && !alongSet.has(p.pageIndex)).map((p) => p.pageIndex))].sort(
        (a, b) => a - b,
      )
    : undefined;
  let reason: AutoAlignReason = "ok";
  // First, because it outranks every judgement made about the geometry: those are all
  // read off a solve whose evidence had a hole in it, so quoting them would dress an
  // unknown up as a finding.
  if (unknownEvidence) reason = "too_slow";
  else if (method === "none") reason = refPageIndices.length < 2 ? "no_refs" : "not_adjacent";
  else if (alongUnresolvedPages?.length) reason = "along_unresolved";
  else if (verdict === "unverified" || demoted.size > 0) reason = "unverified";
  const alignedCount = selected.length - unalignedIds.length;
  // The seam figure is TWO numbers, because a seam has two axes and only one of them
  // was ever reported: "1.33 ft across" is the cross-seam residual, "±40 ft along" is
  // how far an un-anchored sheet could slide along the matchline. Quoting only the
  // first is what let a 42-ft error read as a 0.00-ft success.
  // A `bound` figure is the sheets' own extent, not a measurement — quoting "±720 ft"
  // reads as a precision the engine does not have. Say the axis is unresolved instead.
  const measuredSlide = worstAlongUncertaintyFt > 0 && worstAlongUncertaintySource !== "bound";
  const seamText = demoted.size > 0 && worstAlongUncertaintyFt > 0
    ? measuredSlide
      ? `worst seam ${worstResidFt.toFixed(2)} ft across, ±${Math.round(worstAlongUncertaintyFt)} ft along`
      : `worst seam ${worstResidFt.toFixed(2)} ft across, along the matchline unresolved`
    : `worst seam ${worstResidFt.toFixed(2)} ft`;
  // A run with a hole in its reads gets no seam figure at all: `worstResidFt` is a real
  // number computed over the anchors that DID land, and quoting "worst seam 0.00 ft" on
  // a solve nobody is standing behind is the precise flavour of confident-and-wrong this
  // change exists to remove. Say what happened instead, in the words the strip uses.
  const message = unknownEvidence
    ? `Added ${selected.length} page${selected.length === 1 ? "" : "s"} for manual alignment — ${AUTO_ALIGN_UNAVAILABLE_REASONS.too_slow}.`
    : unalignedIds.length > 0
    ? `Aligned ${alignedCount} of ${selected.length} pages · ${seamText}. ${unalignedIds.length} placed below for manual alignment.`
    : `Aligned ${selected.length} pages · ${seamText}.`;
  return {
    added: newTiles.length, unalignedIds, message,
    verdict, reason, skipped, pagesWithoutRefs,
    alongAnchored, worstAlongUncertaintyFt, worstAlongUncertaintySource, alongUnresolvedPages,
    seams: seamReport?.map((s) => ({
      pageIndexes: s.pageIndexes, status: s.status,
      residFt: s.detail.residFt, perpDeltaFt: s.detail.perpDeltaFt,
      alongAnchored: s.detail.alongAnchored,
    })),
  };
}
