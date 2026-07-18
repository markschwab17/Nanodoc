import type { PageExtract, Label } from "./types";
import { capturePage } from "./captureDevice";
// NOTE: scale inference (inferScale) is deferred to Task 10 of the original
// roadmap. Do not import it yet.
import { stitchSheets, type SheetInput, type StitchMethod } from "./stitchCore";
import { detectKeymapGrid } from "./keymap";
import { detectFrames, sliceExtract, type Frame } from "./frameDetect";
import { layoutPlacements, type TilePlacement, type PlacedSheetPose } from "./layout";
import { edgeBands, sheetNoBand, rotateRaw, wordsToLabels, parseSheetNumber } from "./ocrBands";
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

  for (let i = 0; i < pageIndices.length; i++) {
    const pageIndex = pageIndices[i];
    await yieldToMain();
    const page = doc.loadPage(pageIndex);
    let extract: PageExtract;
    let frames: Frame[] = [];
    let printedNo: number | null = null;
    let recovered: Label[] = [];
    try {
      extract = capturePage(mupdf, page);
      frames = detectFrames(extract);
      // OCR recovery: only when the text channels are starved AND we have frames.
      if (opts.ocr && frames.length && !hasEdgeRefs(extract)) {
        for (const f of frames) {
          for (const band of edgeBands(f.bbox)) {
            const { image, scale } = renderBand(mupdf, page, band.clip);
            if (band.edge === "left" || band.edge === "right") {
              const cands: { rot: 90 | 270; words: OcrWord[] }[] = [];
              for (const rot of [90, 270] as const) cands.push({ rot, words: await opts.ocr(rotateRaw(image, rot)) });
              const score = (ws: OcrWord[]) => ws.reduce((s, w) => s + Math.max(0, w.confidence - 50), 0);
              const best = cands.sort((a, b) => score(b.words) - score(a.words))[0];
              // wordsToLabels wants PRE-rotation raster dims (it inverts the rotation itself)
              recovered.push(...wordsToLabels(best.words, band, scale, image.width, image.height, best.rot));
            } else {
              recovered.push(...wordsToLabels(await opts.ocr(image), band, scale, image.width, image.height, 0));
            }
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

    if (frames.length >= 2) {
      for (const f of frames.slice(0, 2)) {
        units.push({ pageIndex, frame: f, extract: sliceExtract(extract, f), sizePt: { w, h }, scale, printedNo, key: 0 });
      }
    } else if (frames.length === 1) {
      units.push({ pageIndex, frame: frames[0], extract: sliceExtract(extract, frames[0]), sizePt: { w, h }, scale, printedNo, key: 0 });
    } else {
      units.push({ pageIndex, frame: null, extract, sizePt: { w, h }, scale, printedNo, key: 0 });
    }
    opts.onProgress?.(i + 1, total);
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
