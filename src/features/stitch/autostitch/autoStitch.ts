import type { PageExtract } from "./types";
import { capturePage } from "./captureDevice";
// NOTE: scale inference (inferScale) is deferred to Task 10. Do not import it yet.
import { stitchSheets, type SheetInput } from "./stitchCore";
import { detectKeymapGrid } from "./keymap";
import { layoutPlacements, type TilePlacement } from "./layout";

const DEFAULT_SCALE = 20;

export interface AutoStitchOptions {
  userScale?: number | null;
  onProgress?: (done: number, total: number) => void;
}
export interface AutoStitchResult {
  placements: TilePlacement[];
  rootFtPerIn: number;
  alignedCount: number;
  unplacedCount: number;
  worstResidFt: number;
}

/** Yield to the event loop so the tab stays responsive between page extractions. */
const yieldToMain = () => new Promise<void>((r) => setTimeout(r, 0));

export async function autoStitch(
  mupdf: any,
  doc: any,
  pageIndices: number[],
  opts: AutoStitchOptions = {}
): Promise<AutoStitchResult> {
  const total = pageIndices.length;
  const rows: { pageIndex: number; extract: PageExtract; scale: number; sizePt: { w: number; h: number }; no: number }[] = [];

  for (let i = 0; i < pageIndices.length; i++) {
    const pageIndex = pageIndices[i];
    await yieldToMain();
    const page = doc.loadPage(pageIndex);
    let extract: PageExtract;
    try {
      extract = capturePage(mupdf, page);
    } finally {
      page.destroy?.();
    }
    // Scale inference is deferred to Task 10. Until then use a uniform scale
    // (user-entered or default). Same-scale sets place exactly regardless of the
    // value (per-sheet scale cancels in points->feet->canvas). Task 10 replaces
    // this line with per-page inferScale(extract).
    const scale = opts.userScale && opts.userScale > 0 ? opts.userScale : DEFAULT_SCALE;
    const w = extract.view[2] - extract.view[0];
    const h = extract.view[3] - extract.view[1];
    let no = pageIndex + 1;
    for (const l of [...extract.shxLabels, ...extract.labels]) {
      const m = l.text.match(/SHEET\s+(?:NO\.?\s*)?(\d+)\s+OF\s+\d+/i);
      if (m) { no = Number(m[1]); break; }
    }
    rows.push({ pageIndex, extract, scale, sizePt: { w, h }, no });
    opts.onProgress?.(i + 1, total);
  }

  // Unique sheet numbers (printed numbers can collide with synthetic ones).
  const used = new Set<number>();
  for (const r of rows) { while (used.has(r.no)) r.no += 10000; used.add(r.no); }

  if (!rows.length) return { placements: [], rootFtPerIn: 0, alignedCount: 0, unplacedCount: 0, worstResidFt: 0 };

  const rootFtPerIn = rows[0].scale; // == the stitch root sheet's scale (consistent frame)

  let placementsByNo = new Map<number, { x: number; y: number }>();
  let worstResidFt = 0;
  if (rows.length >= 2) {
    const inputs: SheetInput[] = rows.map((r) => ({
      id: String(r.pageIndex), no: r.no, scale: r.scale, view: r.extract.view, extract: r.extract,
    }));
    // Key-map site grid, when present (sheets whose matchlines are unreadable
    // outlined text): gives the exact tile topology → keyed by sheet `no`.
    let grid: Map<number, { col: number; row: number }> | undefined;
    try {
      const byPage = detectKeymapGrid(mupdf, doc, pageIndices);
      if (byPage) {
        grid = new Map();
        for (const r of rows) { const g = byPage.get(r.pageIndex); if (g) grid.set(r.no, g); }
        if (grid.size < 2) grid = undefined;
      }
    } catch (e) {
      console.warn("[autoStitch] key-map detection failed:", e);
    }
    const res = stitchSheets(inputs, grid);
    placementsByNo = res.placements;
    worstResidFt = res.worstResidFt;
  }

  const placements = layoutPlacements(
    rows.map((r) => ({ pageIndex: r.pageIndex, scale: r.scale, sizePt: r.sizePt, posFt: placementsByNo.get(r.no) ?? null })),
    rootFtPerIn
  );
  const alignedCount = placements.filter((p) => p.aligned).length;
  return { placements, rootFtPerIn, alignedCount, unplacedCount: placements.length - alignedCount, worstResidFt };
}
