/**
 * Level-of-Detail (LOD) selection and tile geometry math.
 *
 * Convention: at LOD 0 the page's longest side equals one TILE_SIZE pixmap.
 * Each LOD doubles the resolution. Tiles are square in PDF point space —
 * `tilePt = max(pageWidthPt, pageHeightPt) / 2^lod` — so they're always
 * rendered at TILE_SIZE × TILE_SIZE pixels with uniform px-per-point.
 */

import { TILE_SIZE, type PageDims, type PdfRect, type TileKey } from "./types";

/** PDF-point side length of one tile at the given LOD (square in PDF space). */
export function tilePointSize(pageDims: PageDims, lod: number): number {
  const pageMax = Math.max(pageDims.widthPt, pageDims.heightPt);
  return pageMax / Math.pow(2, lod);
}

/** Number of tile columns/rows needed to cover the page at this LOD. */
export function tileGridSize(
  pageDims: PageDims,
  lod: number,
): { cols: number; rows: number } {
  const tilePt = tilePointSize(pageDims, lod);
  return {
    cols: Math.max(1, Math.ceil(pageDims.widthPt / tilePt)),
    rows: Math.max(1, Math.ceil(pageDims.heightPt / tilePt)),
  };
}

/**
 * Hard cap on LOD selection. With viewport-restricted tile requests
 * (TiledCanvas now passes only the visible PDF rect into setViewport /
 * getVisibleTiles), tile counts no longer explode at high LODs — only the
 * tiles on screen are rendered. Capped at 7 as a sanity bound (4× more
 * tiles per LOD step; 7 keeps the worst case manageable on construction
 * sheets at extreme zoom while still giving plenty of detail).
 */
const MAX_LOD = 7;

/**
 * Smallest LOD where one tile pixel covers >= one screen pixel.
 * `displayPxPerPoint` is the current zoom expressed as device pixels per PDF point.
 * Clamped to [0, MAX_LOD].
 */
export function lodForZoom(pageDims: PageDims, displayPxPerPoint: number): number {
  const pageMax = Math.max(pageDims.widthPt, pageDims.heightPt);
  const screenPx = pageMax * displayPxPerPoint;
  if (screenPx <= TILE_SIZE) return 0;
  const ideal = Math.ceil(Math.log2(screenPx / TILE_SIZE));
  return Math.max(0, Math.min(MAX_LOD, ideal));
}

/** PDF rectangle covered by the tile identified by `key` (clipped to page bounds). */
export function tilePdfRect(key: TileKey, pageDims: PageDims): PdfRect {
  const tilePt = tilePointSize(pageDims, key.lod);
  const x = key.x * tilePt;
  const y = key.y * tilePt;
  return {
    x,
    y,
    w: Math.min(tilePt, pageDims.widthPt - x),
    h: Math.min(tilePt, pageDims.heightPt - y),
  };
}

/** All tile keys whose PDF rect intersects `viewport` (in PDF points), at `lod`. */
export function visibleTileKeys(
  docId: string,
  page: number,
  pageDims: PageDims,
  lod: number,
  viewport: PdfRect,
): TileKey[] {
  const tilePt = tilePointSize(pageDims, lod);
  const { cols, rows } = tileGridSize(pageDims, lod);
  const x0 = Math.max(0, Math.floor(viewport.x / tilePt));
  const y0 = Math.max(0, Math.floor(viewport.y / tilePt));
  const x1 = Math.min(cols - 1, Math.floor((viewport.x + viewport.w) / tilePt));
  const y1 = Math.min(rows - 1, Math.floor((viewport.y + viewport.h) / tilePt));
  const out: TileKey[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      out.push({ docId, page, lod, x, y });
    }
  }
  return out;
}
