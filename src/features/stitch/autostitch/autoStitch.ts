import type { PageExtract, Label } from "./types";
import { capturePage } from "./captureDevice";
// NOTE: scale inference (inferScale) is deferred to Task 10 of the original
// roadmap. Do not import it yet.
import { stitchSheets, type SheetInput, type StitchMethod } from "./stitchCore";
import { detectKeymapGrid } from "./keymap";
import { sliceExtract, stripFrames, type Frame } from "./frameDetect";
import { layoutPlacements, type TilePlacement, type PlacedSheetPose } from "./layout";
import { pageEdgeBands, sheetNoBand, rotateRaw, wordsToLabels, parseSheetNumber } from "./ocrBands";
import { renderBand } from "./bandRender";
import { parseSheetRefs } from "./tokens";
import type { OcrWord, RawImage } from "./ocrService";

const DEFAULT_SCALE = 20;

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

export async function autoStitch(
  mupdf: any,
  doc: any,
  pageIndices: number[],
  opts: AutoStitchOptions = {}
): Promise<AutoStitchResult> {
  const total = pageIndices.length;
  const units: Unit[] = [];
  const pageSize = new Map<number, { w: number; h: number }>();

  // Per-page results collected in the first pass; unit construction is deferred
  // to a second pass so the full-sheet OCR fallback can run in between (it merges
  // interior matchline labels that stripFrames and the units must then see).
  interface PageResult { pageIndex: number; extract: PageExtract; printedNo: number; scale: number; w: number; h: number; }
  const pageResults: PageResult[] = [];

  for (let i = 0; i < pageIndices.length; i++) {
    const pageIndex = pageIndices[i];
    await yieldToMain();
    const page = doc.loadPage(pageIndex);
    let extract: PageExtract;
    let printedNo: number | null = null;
    let recovered: Label[] = [];
    try {
      extract = capturePage(mupdf, page);
      // OCR recovery: OCR the PAGE-EDGE bands (no frame needed) when the text
      // channels are starved of edge refs. Strip refs recovered here declare a
      // two-strip page AND locate the split (see stripFrames) — geometry border
      // detection is not used (it misfires on dense civil sheets).
      if (opts.ocr && !hasEdgeRefs(extract)) {
        for (const band of pageEdgeBands(extract.view)) {
          const { image, scale } = renderBand(mupdf, page, band.clip);
          if (band.edge === "left" || band.edge === "right") {
            // Keep BOTH rotations: a readable label can sit in EITHER direction
            // (mixed-direction text along an edge). wordsToLabels maps each set
            // through its own rotation; garbage words from the wrong rotation
            // match no ref regex and are harmless.
            for (const rot of [90, 270] as const) {
              const words = await opts.ocr(rotateRaw(image, rot));
              // wordsToLabels wants PRE-rotation raster dims (it inverts the rotation itself)
              recovered.push(...wordsToLabels(words, band, scale, image.width, image.height, rot));
            }
          } else {
            recovered.push(...wordsToLabels(await opts.ocr(image), band, scale, image.width, image.height, 0));
          }
        }
        const nb = sheetNoBand(extract.view);
        const { image } = renderBand(mupdf, page, nb.clip);
        printedNo = parseSheetNumber(await opts.ocr(image));
      }
    } finally {
      page.destroy?.();
    }
    if (recovered.length) extract = { ...extract, labels: [...extract.labels, ...recovered] };

    // Printed sheet number: OCR > "SHEET n OF m" text > page order.
    if (printedNo == null) {
      for (const l of [...extract.shxLabels, ...extract.labels]) {
        const m = l.text.match(/SHEET\s+(?:NO\.?\s*)?(\d+)\s+OF\s+\d+/i);
        if (m) { printedNo = Number(m[1]); break; }
      }
    }
    if (printedNo == null) printedNo = pageIndex + 1;

    const w = extract.view[2] - extract.view[0];
    const h = extract.view[3] - extract.view[1];
    pageSize.set(pageIndex, { w, h });
    // Scale inference is deferred; uniform scale (user-entered or default).
    const scale = opts.userScale && opts.userScale > 0 ? opts.userScale : DEFAULT_SCALE;

    pageResults.push({ pageIndex, extract, printedNo, scale, w, h });
    opts.onProgress?.(i + 1, total);
  }

  // ── FULL-SHEET SPARSE OCR FALLBACK ──────────────────────────────────────────
  // East-side matchline labels sit mid-page (beside a notes column), outside every
  // edge band, so an east–west pair gets only a one-sided ref: no reciprocal, no
  // matchline prior, and the windowed segment vote aliases onto repeated building
  // modules. For each page implicated in a NON-reciprocated edge ref, sparsely OCR
  // the WHOLE sheet once (100 DPI) to recover interior "SEE SHEET n" matchline
  // labels wherever they sit. parseSheetRefs tags these edge:"interior"; the
  // loosened matchline gates in stitchCore let them join the pair graph anyway.
  if (opts.ocr) {
    // Directed reference relation over PRINTED numbers, plus each page's out-refs.
    const directed = new Set<string>(); // `${fromPrinted}->${toPrinted}`
    const outRefs = new Map<PageResult, Set<number>>();
    for (const pr of pageResults) {
      const refs = parseSheetRefs([...pr.extract.shxLabels, ...pr.extract.labels], pr.extract.view)
        .filter((r) => r.edge !== "interior");
      const outs = new Set<number>();
      for (const r of refs) if (r.sheet != null) outs.add(r.sheet);
      outRefs.set(pr, outs);
      for (const t of outs) directed.add(`${pr.printedNo}->${t}`);
    }
    const needsFallback = (pr: PageResult): boolean => {
      if (pr.extract.geometry.length < 5000) return false; // skip notes/cover pages
      const pP = pr.printedNo;
      const outs = outRefs.get(pr)!;
      // printed numbers of pages that reference this one
      const incoming = pageResults.filter((q) => outRefs.get(q)!.has(pP)).map((q) => q.printedNo);
      if (!outs.size && !incoming.length) return false; // not implicated in any pair
      for (const t of outs) if (!directed.has(`${t}->${pP}`)) return true;   // out, no reciprocal
      for (const q of incoming) if (!outs.has(q)) return true;               // in, no reciprocal
      return false;
    };
    const candidates = pageResults.filter(needsFallback).slice(0, 12); // cap runtime
    for (const pr of candidates) {
      await yieldToMain();
      const page = doc.loadPage(pr.pageIndex); // per-page loop destroyed the handle
      try {
        const { image, scale } = renderBand(mupdf, page, pr.extract.view, 100);
        const words = await opts.ocr(image);
        const found = wordsToLabels(words, { edge: "top", clip: pr.extract.view }, scale, image.width, image.height, 0);
        if (found.length) pr.extract = { ...pr.extract, labels: [...pr.extract.labels, ...found] };
      } finally {
        page.destroy?.();
      }
    }
  }

  // ── UNIT CONSTRUCTION (second pass) ──────────────────────────────────────────
  // Runs AFTER the fallback merges interior matchline labels so stripFrames and
  // the units see every recovered ref.
  for (const pr of pageResults) {
    const { pageIndex, extract, printedNo, scale, w, h } = pr;
    // Two-strip detection from strip refs. A matched below/above pair splits the
    // page; otherwise the page is one whole-page unit.
    const frames = stripFrames([...extract.shxLabels, ...extract.labels], extract.view) ?? [];
    if (frames.length >= 2) {
      for (const f of frames.slice(0, 2)) {
        units.push({ pageIndex, frame: f, extract: sliceExtract(extract, f), sizePt: { w, h }, scale, printedNo, key: 0 });
      }
    } else {
      units.push({ pageIndex, frame: null, extract, sizePt: { w, h }, scale, printedNo, key: 0 });
    }
  }

  if (!units.length) return { placements: [], rootFtPerIn: 0, alignedCount: 0, unplacedCount: 0, worstResidFt: 0, method: "none", poses: [] };

  // Unique numeric keys, stable order.
  units.forEach((u, i) => { u.key = i + 1; });
  const rootFtPerIn = units[0].scale;

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
    const res = stitchSheets(inputs, grid);
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
  return { placements, rootFtPerIn, alignedCount, unplacedCount: placements.length - alignedCount, worstResidFt, method, poses };
}
