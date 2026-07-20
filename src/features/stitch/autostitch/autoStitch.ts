import type { PageExtract, Label } from "./types";
import { capturePage } from "./captureDevice";
// NOTE: scale inference (inferScale) is deferred to Task 10 of the original
// roadmap. Do not import it yet.
import { stitchSheets, findEdgeStroke, oneSidedStrokeAnchor, seamCrossings, crossingConsensus, FT, type SheetInput, type StitchMethod, type StitchResult, type StitchAnchor, type Crossing } from "./stitchCore";
import { detectKeymapGrid } from "./keymap";
import { sliceExtract, stripFrames, type Frame } from "./frameDetect";
import { layoutPlacements, type TilePlacement, type PlacedSheetPose } from "./layout";
import { pageEdgeBands, sheetNoBand, rotateRaw, wordsToLabels, parseSheetNumber } from "./ocrBands";
import { renderBand } from "./bandRender";
import { parseSheetRefs, type SheetRef } from "./tokens";
import type { OcrWord, RawImage } from "./ocrService";

const DEFAULT_SCALE = 20;

/** Drawing-density floor (geometry vector count). Used ONLY to prune the
 *  reciprocal anchor-search pass (a raster page has zero vector geometry and
 *  the anchor's segment vote needs vectors, so searching it is wasted). It is
 *  deliberately NOT a gate on OCR: raster/scanned pages have zero geometry and
 *  are exactly the pages OCR exists to rescue. */
export const PLAN_GEOMETRY_MIN = 5000;

export interface AutoStitchOptions {
  userScale?: number | null;
  onProgress?: (done: number, total: number) => void;
  /** OCR callback (main thread: ocrService.recognize; worker: the RPC shim). Absent → no OCR channel. */
  ocr?: (image: RawImage) => Promise<OcrWord[]>;
  /** Diagnostic hook: surfaces the raw solver inputs/result (pairs, anchors) for
   *  the Node stitch-diag harness. Never used in production. */
  onDebug?: (d: { anchors: StitchAnchor[]; result: StitchResult; inputs: SheetInput[] }) => void;
}
export interface AutoStitchResult {
  placements: TilePlacement[];
  rootFtPerIn: number;
  alignedCount: number;
  unplacedCount: number;
  worstResidFt: number;
  method: StitchMethod;
  poses: PlacedSheetPose[];
  /** Page indices carrying a usable adjacency signal (an edge-band sheet ref,
   *  discipline code, strip callout, or matchline) AFTER the OCR merge. The
   *  feasibility gate rates aligned-count against these, not the whole
   *  selection, so selecting all pages of a set with many notes/details sheets
   *  (which carry no adjacency signal and can never align) doesn't read as
   *  "unstitchable". */
  refPageIndices: number[];
}

/** Yield to the event loop so the tab stays responsive between page extractions. */
const yieldToMain = () => new Promise<void>((r) => setTimeout(r, 0));

/** True when the page carries a usable adjacency signal on an edge band: a sheet
 *  cross-ref, discipline code, strip callout, or matchline sitting at a page edge
 *  (not interior). Serves both uses: the OCR gate skips pages that already have
 *  one (`!hasEdgeRefs`), and the feasibility denominator counts pages that have
 *  one after the OCR merge (ref-bearing pages). */
function hasEdgeRefs(extract: PageExtract): boolean {
  const all = [...extract.shxLabels, ...extract.labels];
  return parseSheetRefs(all, extract.view).some(
    (r) => r.edge !== "interior" && (r.sheet != null || r.sheetCode != null || r.strip != null || r.matchline)
  );
}

/**
 * Resolve each page's printed sheet number, sanity-checking OCR reads and
 * repairing collisions. Pure (no mupdf / no I/O) so it is unit-testable.
 *
 *  - Sanity: an OCR-sourced number that is null, non-integer, or outside
 *    [1, 2·pageCount] is a misread → fall back to page order (pageIndex+1).
 *    text/fallback numbers are trusted as given; a null of any source also
 *    falls back to page order.
 *  - Collision repair: a resolved number shared by ≥2 pages where at least one
 *    is still OCR-sourced is almost certainly a misread — reset every
 *    OCR-sourced page in that group to its page-order fallback (distinct
 *    pageIndex+1 per page, so the reset group cannot re-collide internally).
 *
 * Returns pageIndex → resolved printed number.
 */
export function resolvePrintedNos(
  pages: { pageIndex: number; printedNo: number | null; source: "ocr" | "text" | "fallback" }[],
  pageCount: number
): Map<number, number> {
  const resolved = new Map<number, { no: number; source: "ocr" | "text" | "fallback" }>();
  for (const p of pages) {
    let no = p.printedNo;
    let source = p.source;
    const validOcr = no != null && Number.isInteger(no) && no >= 1 && no <= pageCount * 2;
    if (source === "ocr" && !validOcr) { no = null; source = "fallback"; }
    if (no == null) { no = p.pageIndex + 1; source = "fallback"; }
    resolved.set(p.pageIndex, { no, source });
  }

  const byNo = new Map<number, { pageIndex: number; source: "ocr" | "text" | "fallback" }[]>();
  for (const [pageIndex, r] of resolved) {
    if (!byNo.has(r.no)) byNo.set(r.no, []);
    byNo.get(r.no)!.push({ pageIndex, source: r.source });
  }
  for (const group of byNo.values()) {
    if (group.length < 2) continue;
    if (!group.some((g) => g.source === "ocr")) continue;
    for (const g of group) {
      if (g.source !== "ocr") continue;
      const fallback = g.pageIndex + 1;
      console.warn(`[autoStitch] printedNo collision on ${resolved.get(g.pageIndex)!.no}: page ${g.pageIndex} was OCR-sourced; resetting to page-order fallback ${fallback}`);
      resolved.set(g.pageIndex, { no: fallback, source: "fallback" });
    }
  }

  return new Map([...resolved].map(([k, v]) => [k, v.no]));
}

interface Unit {
  pageIndex: number;
  frame: Frame | null;      // null = whole page
  extract: PageExtract;     // frame-local when frame != null
  sizePt: { w: number; h: number }; // FULL page size
  scale: number;
  printedNo: number;
  key: number;              // unique numeric key (assigned after uniquify)
}

/** Per-page record collected in pass 1 (extract + printed number). */
interface PageRec { pageIndex: number; extract: PageExtract; printedNo: number; printedNoSource: "ocr" | "text" | "fallback"; }

/** Reciprocal-label anchor before unit-key resolution: endpoints keyed by
 *  (pageIndex, label-y). `perp` is the axis the facing label pins precisely — "x"
 *  for a left/right (vertical-matchline) ref, "y" for a top/bottom (horizontal-
 *  matchline) ref; `dFt` is the offset on that axis, convention d = posFt_j -
 *  posFt_i (dx when perp "x", dy when perp "y"). `precise` marks anchors whose
 *  `dFt` was replaced by the physical-matchline-STROKE delta (sub-foot), not the
 *  ±17 ft label-position delta. */
interface RawAnchor { pageI: number; yI: number; pageJ: number; yJ: number; perp: "x" | "y"; dFt: number; precise?: boolean; along?: number; alongPrecise?: boolean; loDelta?: number; hiDelta?: number; crI?: Crossing[]; crJ?: Crossing[]; }

export async function autoStitch(
  mupdf: any,
  doc: any,
  pageIndices: number[],
  opts: AutoStitchOptions = {}
): Promise<AutoStitchResult> {
  const total = pageIndices.length;
  const units: Unit[] = [];
  // Scale inference is deferred; uniform scale (user-entered or default).
  const scale = opts.userScale && opts.userScale > 0 ? opts.userScale : DEFAULT_SCALE;

  // ── PASS 1: per-page capture + edge-band OCR recovery ───────────────────────
  // Collect each page's extract + printed number FIRST (page released after
  // capture); unit construction is deferred to pass 3 so the reciprocal-anchor
  // pass (pass 2) can run against the whole set between them.
  const pages: PageRec[] = [];
  const refPageIndices: number[] = [];
  for (let i = 0; i < pageIndices.length; i++) {
    const pageIndex = pageIndices[i];
    await yieldToMain();
    const page = doc.loadPage(pageIndex);
    let extract: PageExtract;
    let printedNo: number | null = null;
    let printedNoSource: "ocr" | "text" | "fallback" = "fallback";
    let recovered: Label[] = [];
    try {
      extract = capturePage(mupdf, page);
      // OCR recovery: OCR the PAGE-EDGE bands (no frame needed) when the text
      // channels are starved of edge refs. Strip refs recovered here declare a
      // two-strip page AND locate the split (see stripFrames) — geometry border
      // detection is not used (it misfires on dense civil sheets). No density
      // gate here: raster/scanned pages carry zero vector geometry and are
      // exactly the pages OCR exists to rescue, so gating on geometry would
      // disable OCR precisely where it is needed.
      if (opts.ocr && !hasEdgeRefs(extract)) {
        for (const band of pageEdgeBands(extract.view)) {
          const { image, scale: bandScale } = renderBand(mupdf, page, band.clip);
          if (band.edge === "left" || band.edge === "right") {
            const cands: { rot: 90 | 270; words: OcrWord[] }[] = [];
            for (const rot of [90, 270] as const) cands.push({ rot, words: await opts.ocr(rotateRaw(image, rot)) });
            const score = (ws: OcrWord[]) => ws.reduce((s, w) => s + Math.max(0, w.confidence - 50), 0);
            const best = cands.sort((a, b) => score(b.words) - score(a.words))[0];
            // wordsToLabels wants PRE-rotation raster dims (it inverts the rotation itself)
            recovered.push(...wordsToLabels(best.words, band, bandScale, image.width, image.height, best.rot));
          } else {
            recovered.push(...wordsToLabels(await opts.ocr(image), band, bandScale, image.width, image.height, 0));
          }
        }
        const nb = sheetNoBand(extract.view);
        const { image } = renderBand(mupdf, page, nb.clip);
        // Record the raw OCR read; resolvePrintedNos sanity-checks the range
        // (a misread like "2"→"22" would otherwise misroute byPrinted resolution).
        const ocrNo = parseSheetNumber(await opts.ocr(image));
        if (ocrNo != null) { printedNo = ocrNo; printedNoSource = "ocr"; }
      }
    } finally {
      page.destroy?.();
    }
    if (recovered.length) extract = { ...extract, labels: [...extract.labels, ...recovered] };

    // Printed sheet number candidate: OCR > "SHEET n OF m" text > page order.
    // The final number (sanity + collision repair) is resolved below.
    if (printedNo == null) {
      for (const l of [...extract.shxLabels, ...extract.labels]) {
        const m = l.text.match(/SHEET\s+(?:NO\.?\s*)?(\d+)\s+OF\s+\d+/i);
        if (m) { printedNo = Number(m[1]); printedNoSource = "text"; break; }
      }
    }

    pages.push({ pageIndex, extract, printedNo: printedNo ?? pageIndex + 1, printedNoSource });
    // Ref-bearing after the OCR merge: does the page carry any usable adjacency
    // signal? This is the feasibility denominator (see refPageIndices).
    if (hasEdgeRefs(extract)) refPageIndices.push(pageIndex);
    opts.onProgress?.(i + 1, total);
  }

  // Sanity-check OCR reads and repair printedNo collisions, then apply.
  const resolvedNos = resolvePrintedNos(
    pages.map((p) => ({ pageIndex: p.pageIndex, printedNo: p.printedNo, source: p.printedNoSource })),
    pageIndices.length
  );
  for (const p of pages) p.printedNo = resolvedNos.get(p.pageIndex)!;

  // ── PASS 2: reciprocal interior-matchline anchor search ─────────────────────
  // A one-sided edge ref on page j ("SEE SHEET n" on its left/right edge) has no
  // reciprocal edge ref on the referenced page i, because i's matching label sits
  // INTERIOR (~75% width, beside the notes column) — outside every edge band. We
  // targeted-OCR that interior region of i for the reciprocal "SEE SHEET <j's #>"
  // label; the search is EXPECTED-NUMBER gated so an unrelated interior matchline
  // label can never anchor. The facing pair pins dx to ±17ft (stitchCore then runs
  // a ±30ft windowed segment vote in the true basin).
  const rawAnchors: RawAnchor[] = [];
  if (opts.ocr) {
    const byPrinted = new Map<number, PageRec[]>();
    for (const p of pages) (byPrinted.get(p.printedNo) || byPrinted.set(p.printedNo, []).get(p.printedNo)!).push(p);
    const edgeRefsOf = (p: PageRec): SheetRef[] =>
      parseSheetRefs([...p.extract.shxLabels, ...p.extract.labels], p.extract.view)
        .filter((r) => r.edge !== "interior" && r.sheet != null);
    const OPP: Record<string, string> = { left: "right", right: "left", top: "bottom", bottom: "top" };
    const RE = /SEE\s+SHEET\s+(?:NO\.?\s*)?(\d+)/i;

    /**
     * Register a matchline seam on BOTH axes from geometry. (1) PERP axis: both
     * sheets DRAW the shared matchline as a long (usually dashed) stroke, whose
     * cross-position is EXACT geometry, so `perpDelta = FT(strokeI) − FT(strokeJ)`
     * pins the perpendicular axis to sub-foot (unlike the ±17 ft LABEL delta). (2)
     * ALONG axis: real linework (streets, curbs, lot lines) CROSSES the matchline at
     * identical world stations on both sheets, so a 1-D consensus of the crossing
     * deltas (`seamCrossings` + `crossingConsensus`, windowed around the label along-
     * delta) pins the along axis exactly too — the axis that otherwise carried 10-60
     * ft of segVote/label slop and slid streets sideways across the seam.
     *
     * `crossI`/`crossJ` are the facing labels' PERP cross-coordinates; `alongI`/
     * `alongJ` their ALONG coordinates — both in each page's whole-page coordinate
     * space, so every returned delta obeys d(i→j) = posFt_j − posFt_i. A vertical
     * matchline (perp "x") scans axis "v"; horizontal (perp "y") scans "h". Returns
     * perpDelta null (falls back to the label delta) unless a stroke is found on both
     * sheets; along null unless the crossing consensus is decisive. `loDelta`/
     * `hiDelta` are the matchline dash-extent endpoint deltas (diag cross-check). */
    const seamRegister = (
      pi: PageRec, crossI: number, alongI: number,
      pj: PageRec, crossJ: number, alongJ: number, perp: "x" | "y",
    ): { perpDelta: number | null; along: number | null; loDelta: number | null; hiDelta: number | null; crI: Crossing[]; crJ: Crossing[] } => {
      const axis = perp === "x" ? "v" : "h";
      // Rebase each endpoint to its strip's frame-local coordinates (no-op for whole
      // pages / a top strip): stroke deltas and crossing stations then key to the same
      // space as the unit's view/placement downstream.
      const fi = frameLocal(pi, crossI, alongI, perp), fj = frameLocal(pj, crossJ, alongJ, perp);
      const extI = { lo: 0, hi: 0 }, extJ = { lo: 0, hi: 0 };
      const si = findEdgeStroke(fi.geometry, axis, fi.cross, fi.view, 100, 0.3, extI);
      const sj = findEdgeStroke(fj.geometry, axis, fj.cross, fj.view, 100, 0.3, extJ);
      if (si == null || sj == null) return { perpDelta: null, along: null, loDelta: null, hiDelta: null, crI: [], crJ: [] };
      const perpDelta = FT(si, scale) - FT(sj, scale);
      // Along-axis seam-crossing consensus, windowed around the label along-delta so
      // far-off pairings can't flood the histogram. Crossings are collected at each
      // sheet's OWN stroke cross-position (si / sj), and carry an orientation signature
      // so crossingConsensus (and the downstream JOINT sweep) can gate street↔street.
      const center = FT(fi.along, scale) - FT(fj.along, scale);
      const ci = seamCrossings(fi.geometry, axis, si, scale);
      const cj = seamCrossings(fj.geometry, axis, sj, scale);
      // Window (±60 ft @20) and bin (2 ft @20) are page-point-derived so the vote
      // makes identical decisions at any scale (values just scale linearly).
      const cons = crossingConsensus(ci, cj, center, { window: FT(216, scale), bin: FT(7.2, scale) });
      return {
        perpDelta, along: cons ? cons.along : null,
        loDelta: FT(extI.lo, scale) - FT(extJ.lo, scale),
        hiDelta: FT(extI.hi, scale) - FT(extJ.hi, scale),
        crI: ci, crJ: cj,
      };
    };

    // Frame-local view of a split-page endpoint. When `p` is a two-strip page and the
    // label point (x,y) falls in a strip frame, returns that frame's sliceExtract plus
    // the label's cross/along coords REBASED to the frame origin — so the stroke search
    // and crossing stations key to the strip's OWN coordinates (view [0,0,w,h]),
    // matching how the strip UNIT's view and placement are keyed downstream. Whole-page
    // otherwise (a no-op frame origin (0,0) for a full-page unit or a top strip). This
    // is the strip-local rebase the prior round flagged as required: seamRegister used
    // whole-page coords, harmless for a full-width row seam's along-x but wrong once a
    // strip becomes a floating unit whose posFt is its frame origin.
    const frameLocal = (p: PageRec, cross: number, along: number, perp: "x" | "y") => {
      const frames = stripFrames([...p.extract.shxLabels, ...p.extract.labels], p.extract.view) ?? [];
      const px = perp === "y" ? along : cross, py = perp === "y" ? cross : along;
      const f = frames.find((fr) => fr.bbox[0] <= px && px <= fr.bbox[2] && fr.bbox[1] <= py && py <= fr.bbox[3]);
      if (!f) return { geometry: p.extract.geometry, view: p.extract.view, cross, along };
      const ext = sliceExtract(p.extract, f);
      const foCross = perp === "y" ? f.bbox[1] : f.bbox[0];
      const foAlong = perp === "y" ? f.bbox[0] : f.bbox[1];
      return { geometry: ext.geometry, view: ext.view, cross: cross - foCross, along: along - foAlong };
    };

    /**
     * ONE-SIDED stroke anchor fallback. When j references i but the reciprocal OCR
     * search below recovers NO label on i, both sheets may still DRAW the shared
     * matchline; `oneSidedStrokeAnchor` (stitchCore) locates j's stroke near its ref and
     * i's as the matchline border in i's facing outer band. Restricted to refs
     * originating on a split-page STRIP (jFrame != null) — the units the reciprocal path
     * cannot anchor — and computed on the strip's FRAME-LOCAL slice so its deltas/
     * stations key to the strip's coordinates. Keeps whole-page seams untouched.
     */
    const oneSidedAnchor = (iPage: PageRec, jPage: PageRec, refJ: SheetRef): RawAnchor | null => {
      const frames = stripFrames([...jPage.extract.shxLabels, ...jPage.extract.labels], jPage.extract.view) ?? [];
      const jFrame = frames.find((f) => f.bbox[1] <= refJ.at.y && refJ.at.y <= f.bbox[3] && f.bbox[0] <= refJ.at.x && refJ.at.x <= f.bbox[2]);
      if (!jFrame) return null; // strip-only
      const jExtract = sliceExtract(jPage.extract, jFrame);
      const jAt = { x: refJ.at.x - jFrame.bbox[0], y: refJ.at.y - jFrame.bbox[1] };
      const r = oneSidedStrokeAnchor(iPage.extract.geometry, iPage.extract.view, jExtract.geometry, jExtract.view, jAt, refJ.edge, scale);
      if (!r) return null;
      const [, iy0, , iy1] = iPage.extract.view;
      return {
        pageI: iPage.pageIndex, yI: r.perp === "y" ? r.siCross : (iy0 + iy1) / 2,
        pageJ: jPage.pageIndex, yJ: refJ.at.y,
        perp: r.perp, dFt: r.dFt, precise: true, along: undefined, alongPrecise: false,
        loDelta: r.loDelta, hiDelta: r.hiDelta, crI: r.crI, crJ: r.crJ,
      };
    };

    /**
     * Band-search page i's interior for the reciprocal "SEE SHEET <expected>"
     * label. A left/right ref on j drives a VERTICAL interior band scan on i (side
     * opposite the ref edge; text is vertical → OCR at rot 90/270) and anchors dx.
     * A top/bottom ref drives a HORIZONTAL interior band scan (opposite half's
     * y-range; text is horizontal → no rotation) and anchors dy. Same world-line
     * reasoning either way: the two facing labels lie on the shared matchline, so
     * the offset on the perpendicular axis is d = FT(pos_i) - FT(pos_j).
     */
    const searchReciprocal = async (iPage: PageRec, jPage: PageRec, refJ: SheetRef): Promise<RawAnchor | null> => {
      const [x0, y0, x1, y1] = iPage.extract.view;
      const W = x1 - x0, H = y1 - y0;
      const expected = jPage.printedNo;
      const horiz = refJ.edge === "left" || refJ.edge === "right"; // vertical matchline → pins x
      // A ref that ORIGINATES on a split-page STRIP is the case the narrow one-sided
      // band gets wrong: the strip's neighbour carries its "SEE SHEET n" at the FAR
      // interior (opposite the half the row-seam geometry assumes — verified on
      // PG_SITE: p9/p10 carry "SEE SHEET 2" at their SOUTH matchline). For those we scan
      // i's FULL interior; the expected-number gate + abutment floor keep it safe. Every
      // other (whole-page) ref keeps the original targeted band so no resolved seam
      // shifts. Strip anchors also leave the ALONG axis FREE (the per-seam crossing
      // consensus aliases on the periodic module) for the joint sweep to resolve.
      const jStripFrames = stripFrames([...jPage.extract.shxLabels, ...jPage.extract.labels], jPage.extract.view) ?? [];
      const jIsStrip = jStripFrames.some((f) => f.bbox[0] <= refJ.at.x && refJ.at.x <= f.bbox[2] && f.bbox[1] <= refJ.at.y && refJ.at.y <= f.bbox[3]);
      const page = doc.loadPage(iPage.pageIndex);
      try {
        if (horiz) {
          // Region = the side of i OPPOSITE the ref's edge (whole-page ref), or i's FULL
          // interior for a strip ref (either side may carry the reciprocal label).
          const [rx0, rx1] = jIsStrip ? [x0 + 0.02 * W, x0 + 0.98 * W]
            : refJ.edge === "left" ? [x0 + 0.45 * W, x0 + 0.98 * W] : [x0 + 0.02 * W, x0 + 0.55 * W];
          for (let bx0 = rx0; bx0 < rx1; bx0 += 120) {
            const bx1 = Math.min(bx0 + 160, rx1);
            const clip: [number, number, number, number] = [bx0, y0, bx1, y1];
            const { image, scale: bandScale } = renderBand(mupdf, page, clip, 150);
            for (const rot of [90, 270] as const) {
              const labels = wordsToLabels(await opts.ocr!(rotateRaw(image, rot)), { edge: "left", clip }, bandScale, image.width, image.height, rot);
              for (const lab of labels) {
                const m = lab.text.match(RE);
                if (m && Number(m[1]) === expected) {
                  const cx = (lab.x + lab.endX) / 2, cy = (lab.y + lab.endY) / 2;
                  // i's reciprocal label is INTERIOR (no outer edge → strongest); j's is at refJ.edge.
                  const reg = seamRegister(iPage, cx, cy, jPage, refJ.at.x, refJ.at.y, "x");
                  return { pageI: iPage.pageIndex, yI: cy, pageJ: jPage.pageIndex, yJ: refJ.at.y, perp: "x",
                    dFt: reg.perpDelta ?? FT(cx, scale) - FT(refJ.at.x, scale), precise: reg.perpDelta != null,
                    along: jIsStrip ? undefined : (reg.along ?? undefined), alongPrecise: jIsStrip ? false : reg.along != null, loDelta: reg.loDelta ?? undefined, hiDelta: reg.hiDelta ?? undefined, crI: reg.crI, crJ: reg.crJ };
                }
              }
            }
          }
        } else {
          // Top/bottom ref: horizontal matchline, horizontal text (no rotation). Ref on
          // j's top edge → i's matching label near i's south interior; bottom → north.
          // A strip ref scans i's FULL interior (either side may carry the label).
          const [ry0, ry1] = jIsStrip ? [y0 + 0.02 * H, y0 + 0.98 * H]
            : refJ.edge === "top" ? [y0 + 0.45 * H, y0 + 0.98 * H] : [y0 + 0.02 * H, y0 + 0.55 * H];
          for (let by0 = ry0; by0 < ry1; by0 += 120) {
            const by1 = Math.min(by0 + 160, ry1);
            const clip: [number, number, number, number] = [x0, by0, x1, by1];
            const { image, scale: bandScale } = renderBand(mupdf, page, clip, 150);
            const labels = wordsToLabels(await opts.ocr!(image), { edge: "top", clip }, bandScale, image.width, image.height, 0);
            for (const lab of labels) {
              const m = lab.text.match(RE);
              if (m && Number(m[1]) === expected) {
                const cx = (lab.x + lab.endX) / 2, cy = (lab.y + lab.endY) / 2;
                const reg = seamRegister(iPage, cy, cx, jPage, refJ.at.y, refJ.at.x, "y");
                return { pageI: iPage.pageIndex, yI: cy, pageJ: jPage.pageIndex, yJ: refJ.at.y, perp: "y",
                  dFt: reg.perpDelta ?? FT(cy, scale) - FT(refJ.at.y, scale), precise: reg.perpDelta != null,
                  along: jIsStrip ? undefined : (reg.along ?? undefined), alongPrecise: jIsStrip ? false : reg.along != null, loDelta: reg.loDelta ?? undefined, hiDelta: reg.hiDelta ?? undefined, crI: reg.crI, crJ: reg.crJ };
              }
            }
          }
        }
      } finally {
        page.destroy?.();
      }
      // No reciprocal label recovered on i → fall back to the one-sided STROKE anchor
      // for a strip ref (both sheets still DRAW the shared matchline; locate i's stroke
      // by its facing edge band, not by a label). Returns null when i has no such
      // matchline stroke, leaving behaviour unchanged for non-adjacent references.
      return oneSidedAnchor(iPage, jPage, refJ);
    };

    // ── MUTUAL facing edge refs: anchor directly, no OCR search ────────────────
    // When BOTH sheets carry the reciprocal edge label (common for top/bottom
    // matchlines, which sit at the page edge on both sheets — e.g. p4 top "SEE
    // SHEET 7" ↔ p7 bottom "SEE SHEET 4"), the two labels lie on the shared
    // matchline, so they anchor the perpendicular offset outright: dx for a left/
    // right (vertical-matchline) pair, dy for a top/bottom (horizontal-matchline)
    // pair. This is the reciprocal signal for pairs the interior OCR search skips
    // (it skips i when i already has the opposite-edge ref). Each unordered pair is
    // emitted once (guard jPage < iPage); a coarse label-position dy/dx is enough —
    // stitchSheets' ±30ft-equivalent windowed segment vote refines it in the true
    // basin, and a wrong sign simply yields no segment inliers (anchor dropped).
    for (const jPage of pages) {
      for (const r of edgeRefsOf(jPage)) {
        for (const iPage of byPrinted.get(r.sheet!) || []) {
          if (iPage.pageIndex >= jPage.pageIndex) continue; // emit each unordered pair once
          const ri = edgeRefsOf(iPage).find((x) => x.sheet === jPage.printedNo && x.edge === OPP[r.edge]);
          if (!ri) continue;
          const horiz = r.edge === "left" || r.edge === "right";
          if (horiz) {
            const reg = seamRegister(iPage, ri.at.x, ri.at.y, jPage, r.at.x, r.at.y, "x");
            rawAnchors.push({ pageI: iPage.pageIndex, yI: ri.at.y, pageJ: jPage.pageIndex, yJ: r.at.y, perp: "x",
              dFt: reg.perpDelta ?? FT(ri.at.x, scale) - FT(r.at.x, scale), precise: reg.perpDelta != null,
              along: reg.along ?? undefined, alongPrecise: reg.along != null, loDelta: reg.loDelta ?? undefined, hiDelta: reg.hiDelta ?? undefined, crI: reg.crI, crJ: reg.crJ });
          } else {
            const reg = seamRegister(iPage, ri.at.y, ri.at.x, jPage, r.at.y, r.at.x, "y");
            rawAnchors.push({ pageI: iPage.pageIndex, yI: ri.at.y, pageJ: jPage.pageIndex, yJ: r.at.y, perp: "y",
              dFt: reg.perpDelta ?? FT(ri.at.y, scale) - FT(r.at.y, scale), precise: reg.perpDelta != null,
              along: reg.along ?? undefined, alongPrecise: reg.along != null, loDelta: reg.loDelta ?? undefined, hiDelta: reg.hiDelta ?? undefined, crI: reg.crI, crJ: reg.crJ });
          }
        }
      }
    }

    let searched = 0;
    outer:
    for (const jPage of pages) {
      for (const r of edgeRefsOf(jPage)) {
        // Every physical edge drives a reciprocal search: left/right pins dx, top/
        // bottom pins dy. Both are one-sided (the referenced sheet's matching label
        // sits interior, outside every edge band) and need the targeted interior scan.
        if (r.edge !== "left" && r.edge !== "right" && r.edge !== "top" && r.edge !== "bottom") continue;
        for (const iPage of byPrinted.get(r.sheet!) || []) {
          if (iPage.pageIndex === jPage.pageIndex) continue;
          // Skip if i ALREADY has a reciprocal edge ref (opposite edge → j's #).
          if (edgeRefsOf(iPage).some((ri) => ri.sheet === jPage.printedNo && ri.edge === OPP[r.edge])) continue;
          // Prune raster/low-geometry pages here (unlike the OCR gate): the anchor
          // confirms via a vector segment vote, which a page with no geometry can't feed.
          if ((iPage.extract.geometry?.length ?? 0) < PLAN_GEOMETRY_MIN) continue;
          if (searched >= 16) break outer;
          searched++;
          const anchor = await searchReciprocal(iPage, jPage, r);
          if (anchor) rawAnchors.push(anchor);
        }
      }
    }
  }

  // ── PASS 3: unit construction ───────────────────────────────────────────────
  for (const p of pages) {
    // Two-strip detection from strip refs (recovered refs count). A matched
    // below/above pair splits the page; otherwise it is one whole-page unit.
    const frames: Frame[] = stripFrames([...p.extract.shxLabels, ...p.extract.labels], p.extract.view) ?? [];
    const w = p.extract.view[2] - p.extract.view[0];
    const h = p.extract.view[3] - p.extract.view[1];
    if (frames.length >= 2) {
      for (const f of frames.slice(0, 2)) {
        units.push({ pageIndex: p.pageIndex, frame: f, extract: sliceExtract(p.extract, f), sizePt: { w, h }, scale, printedNo: p.printedNo, key: 0 });
      }
    } else {
      units.push({ pageIndex: p.pageIndex, frame: null, extract: p.extract, sizePt: { w, h }, scale, printedNo: p.printedNo, key: 0 });
    }
  }

  if (!units.length) return { placements: [], rootFtPerIn: 0, alignedCount: 0, unplacedCount: 0, worstResidFt: 0, method: "none", poses: [], refPageIndices };

  // Unique numeric keys, stable order.
  units.forEach((u, i) => { u.key = i + 1; });
  const rootFtPerIn = units[0].scale;

  // Resolve each raw anchor's (pageIndex, labelY) endpoints to unit keys. On a
  // two-strip page the label's y selects the containing frame; single-unit pages
  // are trivial. Anchors whose endpoints collapse to one unit are dropped.
  const keyForLabel = (pageIndex: number, y: number): number | null => {
    const us = units.filter((u) => u.pageIndex === pageIndex);
    if (!us.length) return null;
    if (us.length === 1) return us[0].key;
    const hit = us.find((u) => u.frame && u.frame.bbox[1] <= y && y <= u.frame.bbox[3]);
    return (hit ?? us[0]).key;
  };
  const anchors: StitchAnchor[] = rawAnchors
    .map((a): StitchAnchor | null => {
      const ki = keyForLabel(a.pageI, a.yI), kj = keyForLabel(a.pageJ, a.yJ);
      if (ki == null || kj == null || ki === kj) return null;
      const common = {
        precise: a.precise, along: a.along, alongPrecise: a.alongPrecise,
        strokeLoDelta: a.loDelta, strokeHiDelta: a.hiDelta,
        crossI: a.crI, crossJ: a.crJ,
      };
      return a.perp === "y"
        ? { i: ki, j: kj, dy: a.dFt, perp: "y", ...common }
        : { i: ki, j: kj, dx: a.dFt, perp: "x", ...common };
    })
    .filter((a): a is StitchAnchor => a != null);

  let placementsByKey = new Map<number, { x: number; y: number }>();
  let worstResidFt = 0;
  let method: StitchMethod = "none";
  if (units.length >= 2) {
    const byPage = new Map<number, Unit[]>();
    for (const u of units) (byPage.get(u.pageIndex) || byPage.set(u.pageIndex, []).get(u.pageIndex)!).push(u);
    const inputs: SheetInput[] = units.map((u) => ({
      id: `p${u.pageIndex}f${u.frame ? "1" : "0"}k${u.key}`, no: u.key, scale: u.scale,
      view: u.extract.view, extract: u.extract,
      printedNo: u.printedNo, pageIndex: u.pageIndex,
      siblingKey: byPage.get(u.pageIndex)!.find((o) => o.key !== u.key)?.key,
      frame: u.frame?.bbox,
    }));
    // Key-map site grid (whole-page sets only; stitchSheets ignores it when
    // any page produced two units). Grid is keyed by unit key here.
    let grid: Map<number, { col: number; row: number }> | undefined;
    try {
      const byPageGrid = detectKeymapGrid(mupdf, doc, pageIndices);
      if (byPageGrid) {
        grid = new Map();
        for (const u of units) { const g = byPageGrid.get(u.pageIndex); if (g) grid.set(u.key, g); }
        if (grid.size < 2) grid = undefined;
      }
    } catch (e) {
      console.warn("[autoStitch] key-map detection failed:", e);
    }
    const res = stitchSheets(inputs, grid, anchors);
    opts.onDebug?.({ anchors, result: res, inputs });
    placementsByKey = res.placements;
    worstResidFt = res.worstResidFt;
    method = res.method;
  }

  // Per-unit poses for placed units; ONE whole-page null pose per fully-unplaced page.
  const poses: PlacedSheetPose[] = [];
  const pagesEmitted = new Set<number>();
  for (const u of units) {
    const pos = placementsByKey.get(u.key) ?? null;
    if (pos) {
      poses.push({ pageIndex: u.pageIndex, scale: u.scale, sizePt: u.sizePt, posFt: pos, frame: u.frame?.bbox });
      pagesEmitted.add(u.pageIndex);
    }
  }
  for (const u of units) {
    if (pagesEmitted.has(u.pageIndex)) continue;
    pagesEmitted.add(u.pageIndex);
    poses.push({ pageIndex: u.pageIndex, scale: u.scale, sizePt: u.sizePt, posFt: null });
  }

  const placements = layoutPlacements(poses, rootFtPerIn);
  const alignedCount = placements.filter((p) => p.aligned).length;
  return { placements, rootFtPerIn, alignedCount, unplacedCount: placements.length - alignedCount, worstResidFt, method, poses, refPageIndices };
}
