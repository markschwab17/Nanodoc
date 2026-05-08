/**
 * Tile-pyramid shared types.
 *
 * Tile coordinates live in PDF point space, not screen space.
 * A TileKey identifies the same PDF rectangle regardless of current zoom —
 * this is what makes the cache stable across zoom interactions.
 */

export const TILE_SIZE = 512;

export interface PageDims {
  widthPt: number;
  heightPt: number;
}

export interface PdfRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TileKey {
  docId: string;
  page: number;
  lod: number;
  x: number;
  y: number;
}

export interface RenderedTile {
  key: TileKey;
  bitmap: ImageBitmap;
  pdfRect: PdfRect;
  pixelWidth: number;
  pixelHeight: number;
}

export function tileKeyString(key: TileKey): string {
  return `${key.docId}/${key.page}/${key.lod}/${key.x}_${key.y}`;
}

export function tileKeyEqual(a: TileKey, b: TileKey): boolean {
  return (
    a.docId === b.docId &&
    a.page === b.page &&
    a.lod === b.lod &&
    a.x === b.x &&
    a.y === b.y
  );
}
