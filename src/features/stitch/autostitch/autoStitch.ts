import type { PageExtract, Label } from "./types";
import { capturePage } from "./captureDevice";
// NOTE: scale inference (inferScale) is deferred to Task 10 of the original
// roadmap. Do not import it yet.
import { stitchSheets, FT, type SheetInput, type StitchMethod } from "./stitchCore";
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
 *  (pageIndex, label-y); dxFt uses the convention d = posFt_j - posFt_i. */
interface RawAnchor { pageI: number; yI: number; pageJ: number; yJ: number; dxFt: number; }

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
    const OPP: Record<string, string> = { left: "right", right: "left" };
    const RE = /SEE\s+SHEET\s+(?:NO\.?\s*)?(\d+)/i;

    /** Band-search page i's interior for the reciprocal "SEE SHEET <expected>" label. */
    const searchReciprocal = async (iPage: PageRec, jPage: PageRec, refJ: SheetRef): Promise<RawAnchor | null> => {
      const [x0, y0, x1, y1] = iPage.extract.view;
      const W = x1 - x0;
      // Region = the side of i OPPOSITE the ref's edge. Ref on j's left edge → i is
      // WEST of j → i's matching label sits near i's EAST matchline (right side).
      const [rx0, rx1] = refJ.edge === "left"
        ? [x0 + 0.45 * W, x0 + 0.98 * W]
        : [x0 + 0.02 * W, x0 + 0.55 * W];
      const expected = jPage.printedNo;
      const page = doc.loadPage(iPage.pageIndex);
      try {
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
                return { pageI: iPage.pageIndex, yI: cy, pageJ: jPage.pageIndex, yJ: refJ.at.y, dxFt: FT(cx, scale) - FT(refJ.at.x, scale) };
              }
            }
          }
        }
      } finally {
        page.destroy?.();
      }
      return null;
    };

    let searched = 0;
    outer:
    for (const jPage of pages) {
      for (const r of edgeRefsOf(jPage)) {
        if (r.edge !== "left" && r.edge !== "right") continue;
        for (const iPage of byPrinted.get(r.sheet!) || []) {
          if (iPage.pageIndex === jPage.pageIndex) continue;
          // Skip if i ALREADY has a reciprocal edge ref (opposite edge → j's #).
          if (edgeRefsOf(iPage).some((ri) => ri.sheet === jPage.printedNo && ri.edge === OPP[r.edge])) continue;
          // Prune raster/low-geometry pages here (unlike the OCR gate): the anchor
          // confirms via a vector segment vote, which a page with no geometry can't feed.
          if ((iPage.extract.geometry?.length ?? 0) < PLAN_GEOMETRY_MIN) continue;
          if (searched >= 10) break outer;
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
  const anchors = rawAnchors
    .map((a) => {
      const ki = keyForLabel(a.pageI, a.yI), kj = keyForLabel(a.pageJ, a.yJ);
      return ki != null && kj != null && ki !== kj ? { i: ki, j: kj, dx: a.dxFt } : null;
    })
    .filter((a): a is { i: number; j: number; dx: number } => a != null);

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
