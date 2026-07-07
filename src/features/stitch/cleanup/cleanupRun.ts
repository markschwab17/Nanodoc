import { capturePage } from "@/features/stitch/autostitch/captureDevice";
import { buildFurnitureFilter } from "@/features/stitch/autostitch/stitchCore";
import { detectTitleBlock, detectMatchMargins, type CleanupRegion, type Rect } from "./cleanupDetect";
import type { PageExtract } from "@/features/stitch/autostitch/types";

export interface TileProposal { tileId: string; regions: CleanupRegion[]; }

const yieldToMain = () => new Promise<void>((r) => setTimeout(r, 0));

/** `mupdf` is the namespace ((await import("mupdf")).default), like PDFRenderer. */
export async function detectCleanupForTiles(
  mupdf: any,
  tiles: { id: string; sourcePdfBytes: Uint8Array; sourcePageIndex: number; width: number; height: number }[],
  onProgress?: (done: number, total: number) => void,
): Promise<TileProposal[]> {
  // 1. capture every tile's source page.
  const docCache = new Map<Uint8Array, any>();
  const extracts: { tile: (typeof tiles)[number]; ex: PageExtract }[] = [];
  try {
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      await yieldToMain();
      try {
        let doc = docCache.get(t.sourcePdfBytes);
        if (!doc) { doc = mupdf.Document.openDocument(t.sourcePdfBytes, "application/pdf"); docCache.set(t.sourcePdfBytes, doc); }
        const page = doc.loadPage(t.sourcePageIndex);
        let ex: PageExtract;
        try { ex = capturePage(mupdf, page); } finally { page.destroy?.(); }
        extracts.push({ tile: t, ex });
      } catch (e) {
        console.warn(`[cleanupRun] Failed to capture tile ${t.id}:`, e);
      }
      onProgress?.(i + 1, tiles.length);
    }
  } finally {
    for (const doc of docCache.values()) { try { doc.destroy?.(); } catch { /* already freed */ } }
  }

  // 2. set-shared furniture filter (needs the whole set to spot repeated boilerplate).
  const furnSheets = extracts.map(({ ex }, i) => ({ key: i, raw: { shxLabels: [...ex.shxLabels, ...ex.labels] } }));
  const furn = buildFurnitureFilter(furnSheets, Math.max(2, Math.min(3, extracts.length)));

  // 3. detect per page, map page-local points -> page FRACTIONS (0..1 of the
  //    page view). Storing fractions instead of tile px makes hidden regions
  //    survive resize + composition-scale automatically (the tile's width/height
  //    can change without touching the stored region).
  const out: TileProposal[] = [];
  for (const { tile, ex } of extracts) {
    const [x0, y0, x1, y1] = ex.view;
    const pw = (x1 - x0) || 1, ph = (y1 - y0) || 1;
    const toLocal = (r: Rect): Rect => ({ x: (r.x - x0) / pw, y: (r.y - y0) / ph, w: r.w / pw, h: r.h / ph });
    const regions: CleanupRegion[] = [];
    const tb = detectTitleBlock(ex, (l) => furn.isFurniture(l));
    if (tb) regions.push({ ...tb, rect: toLocal(tb.rect) });
    for (const m of detectMatchMargins(ex)) regions.push({ ...m, rect: toLocal(m.rect) });
    out.push({ tileId: tile.id, regions });
  }
  return out;
}
