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

/** Drawing-density floor (geometry vector count) separating plan sheets from
 *  cover/notes/details sheets. Plan sheets are worth OCRing / rating against;
 *  low-geometry sheets have no edge refs to recover and only burn OCR calls. */
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
  /** Page indices whose extract met the plan-density floor (PLAN_GEOMETRY_MIN).
   *  The feasibility gate rates aligned-count against these, not the whole
   *  selection, so selecting all pages of a set with many notes/details sheets
   *  doesn't read as "unstitchable". */
  planPageIndices: number[];
}

/** Yield to the event loop so the tab stays responsive between page extractions. */
const yieldToMain = () => new Promise<void>((r) => setTimeout(r, 0));

/** True when the page's existing text already provides edge refs (no OCR needed). */
function hasEdgeRefs(extract: PageExtract): boolean {
  const all = [...extract.shxLabels, ...extract.labels];
  return parseSheetRefs(all, extract.view).some((r) => r.edge !== "interior");
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
  const planPageIndices: number[] = [];
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
      // detection is not used (it misfires on dense civil sheets).
      // Density gate: cover/notes/details sheets have no edge refs either, so
      // they would burn ~9 OCR calls each for nothing. Only plan-density sheets
      // (matching the anchor pass's floor) are worth OCRing.
      if (opts.ocr && !hasEdgeRefs(extract) && (extract.geometry?.length ?? 0) >= PLAN_GEOMETRY_MIN) {
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
        // Sanity-check the OCR'd number: a misread (e.g. "2"→"22") would
        // silently misroute byPrinted ref resolution. Accept only an integer in
        // [1, 2·pageCount]; otherwise discard and fall through to the text scan.
        const ocrNo = parseSheetNumber(await opts.ocr(image));
        if (ocrNo != null && Number.isInteger(ocrNo) && ocrNo >= 1 && ocrNo <= pageIndices.length * 2) {
          printedNo = ocrNo;
          printedNoSource = "ocr";
        }
      }
    } finally {
      page.destroy?.();
    }
    if (recovered.length) extract = { ...extract, labels: [...extract.labels, ...recovered] };

    // Printed sheet number: OCR > "SHEET n OF m" text > page order.
    if (printedNo == null) {
      for (const l of [...extract.shxLabels, ...extract.labels]) {
        const m = l.text.match(/SHEET\s+(?:NO\.?\s*)?(\d+)\s+OF\s+\d+/i);
        if (m) { printedNo = Number(m[1]); printedNoSource = "text"; break; }
      }
    }
    if (printedNo == null) { printedNo = pageIndex + 1; printedNoSource = "fallback"; }

    pages.push({ pageIndex, extract, printedNo, printedNoSource });
    if ((extract.geometry?.length ?? 0) >= PLAN_GEOMETRY_MIN) planPageIndices.push(pageIndex);
    opts.onProgress?.(i + 1, total);
  }

  // ── printedNo collision repair ──────────────────────────────────────────────
  // Two pages sharing a printedNo where at least one came from OCR is almost
  // certainly a misread — reset the OCR-sourced one(s) to their page-order
  // fallback so byPrinted resolution (pass 2) and unit construction don't misroute.
  {
    const byNo = new Map<number, PageRec[]>();
    for (const p of pages) (byNo.get(p.printedNo) || byNo.set(p.printedNo, []).get(p.printedNo)!).push(p);
    for (const group of byNo.values()) {
      if (group.length < 2) continue;
      if (!group.some((p) => p.printedNoSource === "ocr")) continue;
      for (const p of group) {
        if (p.printedNoSource !== "ocr") continue;
        const fallback = p.pageIndex + 1;
        console.warn(`[autoStitch] printedNo collision on ${p.printedNo}: page ${p.pageIndex} was OCR-sourced; resetting to page-order fallback ${fallback}`);
        p.printedNo = fallback;
        p.printedNoSource = "fallback";
      }
    }
  }

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

  if (!units.length) return { placements: [], rootFtPerIn: 0, alignedCount: 0, unplacedCount: 0, worstResidFt: 0, method: "none", poses: [], planPageIndices };

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
  return { placements, rootFtPerIn, alignedCount, unplacedCount: placements.length - alignedCount, worstResidFt, method, poses, planPageIndices };
}
