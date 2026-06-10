/**
 * Image utilities for PDF stitch – e.g. make white/near-white pixels transparent
 * so only the actual PDF content (vectors, text, graphics) is visible.
 */

/** Default threshold: pixels with R,G,B all >= this are treated as "white" and made transparent. */
const DEFAULT_WHITE_THRESHOLD = 248;

/**
 * Makes white (and near-white) pixels fully transparent **in place**.
 * Mutates the provided ImageData directly — no allocation.
 */
export function makeWhiteTransparentInPlace(
  imageData: ImageData,
  threshold: number = DEFAULT_WHITE_THRESHOLD
): void {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] >= threshold && data[i + 1] >= threshold && data[i + 2] >= threshold) {
      data[i + 3] = 0;
    }
  }
}

/**
 * Returns a new ImageData with white (and near-white) pixels made fully transparent.
 * Non-white pixels keep their RGB and full opacity.
 * Use when importing PDFs so only the vector/content shows, not the page background.
 */
export function makeWhiteTransparent(
  imageData: ImageData,
  threshold: number = DEFAULT_WHITE_THRESHOLD
): ImageData {
  const { width, height, data: src } = imageData;
  const out = new ImageData(width, height);
  const dst = out.data;

  for (let i = 0; i < src.length; i += 4) {
    const r = src[i];
    const g = src[i + 1];
    const b = src[i + 2];
    const a = src[i + 3];

    const isWhite =
      r >= threshold && g >= threshold && b >= threshold;

    dst[i] = r;
    dst[i + 1] = g;
    dst[i + 2] = b;
    dst[i + 3] = isWhite ? 0 : a;
  }

  return out;
}

import { canvasToTileLocal, getTileAABB, tileLocalToCanvas, type TilePose } from "./stitchGeometry";

/** Canvas-space rectangle (same units as tile x, y, width, height). */
export interface CanvasRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Canvas-space AABB of a tile-local pixel-space bbox (rotation-aware). */
function localBboxToCanvasRect(
  tile: TilePose,
  imgWidth: number,
  imgHeight: number,
  minPx: number,
  minPy: number,
  maxPx: number,
  maxPy: number
): CanvasRect {
  const lx0 = (minPx / imgWidth) * tile.width;
  const ly0 = (minPy / imgHeight) * tile.height;
  const lx1 = ((maxPx + 1) / imgWidth) * tile.width;
  const ly1 = ((maxPy + 1) / imgHeight) * tile.height;
  const corners = [
    tileLocalToCanvas(lx0, ly0, tile),
    tileLocalToCanvas(lx1, ly0, tile),
    tileLocalToCanvas(lx1, ly1, tile),
    tileLocalToCanvas(lx0, ly1, tile),
  ];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const c of corners) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x);
    maxY = Math.max(maxY, c.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Load a data URL (PNG) into ImageData. Resolves when the image has loaded.
 */
function imageDataUrlToImageData(dataUrl: string): Promise<{ imageData: ImageData; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Could not get 2d context"));
        return;
      }
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, w, h);
      resolve({ imageData, width: w, height: h });
    };
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = dataUrl;
  });
}

function imageDataToDataUrl(imageData: ImageData): string {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Erase (make transparent) the pixels whose CANVAS position falls inside the
 * given canvas-space rectangle. Rotation-aware: pixels are mapped through the
 * tile's center-based rotation, matching what's on screen.
 * Mutates `imageData` in place. Returns the canvas-space AABB of the erased
 * region, or null if nothing intersects.
 */
export function eraseCanvasRectInImage(
  imageData: ImageData,
  imgWidth: number,
  imgHeight: number,
  tile: TilePose,
  rect: CanvasRect
): CanvasRect | null {
  const rectRight = rect.x + rect.w;
  const rectBottom = rect.y + rect.h;

  // Pixel-space search window: the rect's corners mapped into tile-local space.
  const corners = [
    canvasToTileLocal({ x: rect.x, y: rect.y }, tile),
    canvasToTileLocal({ x: rectRight, y: rect.y }, tile),
    canvasToTileLocal({ x: rectRight, y: rectBottom }, tile),
    canvasToTileLocal({ x: rect.x, y: rectBottom }, tile),
  ];
  let lu0 = Infinity,
    lv0 = Infinity,
    lu1 = -Infinity,
    lv1 = -Infinity;
  for (const c of corners) {
    if (!c) return null;
    lu0 = Math.min(lu0, c.u);
    lv0 = Math.min(lv0, c.v);
    lu1 = Math.max(lu1, c.u);
    lv1 = Math.max(lv1, c.v);
  }

  const px0 = Math.max(0, Math.floor((lu0 / tile.width) * imgWidth));
  const py0 = Math.max(0, Math.floor((lv0 / tile.height) * imgHeight));
  const px1 = Math.min(imgWidth, Math.ceil((lu1 / tile.width) * imgWidth));
  const py1 = Math.min(imgHeight, Math.ceil((lv1 / tile.height) * imgHeight));
  if (px0 >= px1 || py0 >= py1) return null;

  const data = imageData.data;
  let minPx = Infinity,
    minPy = Infinity,
    maxPx = -Infinity,
    maxPy = -Infinity;
  for (let py = py0; py < py1; py++) {
    for (let px = px0; px < px1; px++) {
      // Pixel center in canvas space must be inside the erase rect.
      const lu = ((px + 0.5) / imgWidth) * tile.width;
      const lv = ((py + 0.5) / imgHeight) * tile.height;
      const c = tileLocalToCanvas(lu, lv, tile);
      if (c.x < rect.x || c.x >= rectRight || c.y < rect.y || c.y >= rectBottom) continue;
      data[(py * imgWidth + px) * 4 + 3] = 0;
      if (px < minPx) minPx = px;
      if (px > maxPx) maxPx = px;
      if (py < minPy) minPy = py;
      if (py > maxPy) maxPy = py;
    }
  }
  if (minPx === Infinity) return null;
  return localBboxToCanvasRect(tile, imgWidth, imgHeight, minPx, minPy, maxPx, maxPy);
}

/**
 * Erase (make transparent) the pixels inside the given canvas-space rectangle
 * on the tile's image. Returns the new image data URL, or null if the rect
 * doesn't intersect the tile or the tile has no image.
 */
export async function eraseRectFromTile(
  tile: { x: number; y: number; width: number; height: number; rotation?: number; imageDataUrl?: string },
  rect: CanvasRect
): Promise<string | null> {
  if (!tile.imageDataUrl) return null;

  // Cheap rotation-aware cull before the expensive decode.
  const aabb = getTileAABB(tile);
  if (
    rect.x + rect.w <= aabb.x ||
    rect.x >= aabb.x + aabb.width ||
    rect.y + rect.h <= aabb.y ||
    rect.y >= aabb.y + aabb.height
  ) {
    return null;
  }

  const { imageData, width: imgWidth, height: imgHeight } = await imageDataUrlToImageData(tile.imageDataUrl);
  const erased = eraseCanvasRectInImage(imageData, imgWidth, imgHeight, tile, rect);
  if (!erased) return null;

  return imageDataToDataUrl(imageData);
}

/** Options for eraseConnectedAt (click-to-delete element). */
export interface EraseConnectedOptions {
  /** Max RGB distance (0–442) to consider same color. Default 45. */
  colorTolerance?: number;
  /** If true, do not erase when clicking on white/transparent. Default true. */
  skipBackground?: boolean;
  /** White threshold for skipBackground (R,G,B >= this). Default 248. */
  whiteThreshold?: number;
  /** When provided, use this image instead of tile.imageDataUrl (for chaining erases along a path). */
  currentImageDataUrl?: string;
}

/** Result of eraseConnectedAt: new image data URL and the canvas rect of what was erased (for visual feedback). */
export interface EraseConnectedResult {
  dataUrl: string;
  canvasRect: CanvasRect;
}

/**
 * Erase the connected "element" at the given canvas-space point.
 * Uses flood-fill from that pixel: all 8-connected pixels with similar color
 * are made transparent. Good for removing a line, shape, or border when you
 * click on it.
 * Returns the new image data URL and the bounding box of the erased region (for feedback), or null.
 */
export async function eraseConnectedAt(
  tile: { x: number; y: number; width: number; height: number; rotation?: number; imageDataUrl?: string },
  canvasX: number,
  canvasY: number,
  options: EraseConnectedOptions = {}
): Promise<EraseConnectedResult | null> {
  const imageSource = options.currentImageDataUrl ?? tile.imageDataUrl;
  if (!imageSource) return null;

  const { colorTolerance = 45, skipBackground = true, whiteThreshold = 248 } = options;

  // Rotation-aware containment check (cheap, avoids the decode).
  const local = canvasToTileLocal({ x: canvasX, y: canvasY }, tile);
  if (!local || local.u < 0 || local.u >= tile.width || local.v < 0 || local.v >= tile.height) {
    return null;
  }

  const { imageData, width: imgWidth, height: imgHeight } = await imageDataUrlToImageData(imageSource);

  const rect = floodFillErase(imageData, imgWidth, imgHeight, tile, canvasX, canvasY, colorTolerance, skipBackground, whiteThreshold);
  if (!rect) return null;

  return {
    dataUrl: imageDataToDataUrl(imageData),
    canvasRect: rect,
  };
}

// ─── High-DPI raster export helpers ──────────────────────────────────────────

/** Default pixel budget for export rasters — stays under browser canvas area limits. */
const DEFAULT_MAX_RASTER_PIXELS = 16_000_000;

/**
 * Pick a render scale for a page so the resulting raster fits a pixel budget.
 * Clamped to [minScale, maxScale].
 */
export function pickRasterScale(
  widthPt: number,
  heightPt: number,
  opts: { maxPixels?: number; minScale?: number; maxScale?: number } = {}
): number {
  const { maxPixels = DEFAULT_MAX_RASTER_PIXELS, minScale = 1, maxScale = 4 } = opts;
  const budgetScale = Math.sqrt(maxPixels / Math.max(1, widthPt * heightPt));
  return Math.min(maxScale, Math.max(minScale, budgetScale));
}

/**
 * Transfer erased regions (alpha === 0) from a low-res mask onto a target
 * render of the same page at a different resolution, using nearest-neighbor
 * sampling. Mutates `target` in place.
 */
export function applyAlphaMaskNearest(
  target: ImageData,
  targetW: number,
  targetH: number,
  mask: ImageData,
  maskW: number,
  maskH: number
): void {
  const t = target.data;
  const m = mask.data;
  for (let y = 0; y < targetH; y++) {
    const my = Math.min(maskH - 1, Math.floor((y / targetH) * maskH));
    const mRow = my * maskW;
    const tRow = y * targetW;
    for (let x = 0; x < targetW; x++) {
      const mx = Math.min(maskW - 1, Math.floor((x / targetW) * maskW));
      if (m[(mRow + mx) * 4 + 3] === 0) {
        t[(tRow + x) * 4 + 3] = 0;
      }
    }
  }
}

// ─── Direct ImageData API (no data-URL round-trips) ─────────────────────────

/** Options for direct (in-memory) flood-fill erase — no encode/decode. */
export interface EraseConnectedDirectOptions {
  colorTolerance?: number;
  skipBackground?: boolean;
  whiteThreshold?: number;
}

/**
 * Load a tile's image data URL into raw ImageData (one-time decode at stroke start).
 */
export async function decodeTileImage(dataUrl: string): Promise<{ imageData: ImageData; width: number; height: number }> {
  return imageDataUrlToImageData(dataUrl);
}

/**
 * Encode raw ImageData back to a PNG data URL (one-time encode at stroke end).
 */
export function encodeTileImage(imageData: ImageData): string {
  return imageDataToDataUrl(imageData);
}

/**
 * Flood-fill erase directly on an ImageData buffer — NO encode/decode.
 * Mutates `imageData` in place.  Returns the canvas-space bounding rect of the
 * erased region, or null if nothing was erased (transparent / background hit).
 *
 * Uses an index-based flat queue (Int32Array) instead of Array.shift() for O(n)
 * total instead of O(n²), and squared colour distance to avoid Math.sqrt per pixel.
 */
export function floodFillErase(
  imageData: ImageData,
  imgWidth: number,
  imgHeight: number,
  tile: TilePose,
  canvasX: number,
  canvasY: number,
  colorTolerance: number = 45,
  skipBackground: boolean = true,
  whiteThreshold: number = 248,
): CanvasRect | null {
  const data = imageData.data;

  // Convert canvas coords → pixel coords through the tile's center rotation
  const local = canvasToTileLocal({ x: canvasX, y: canvasY }, tile);
  if (!local) return null;
  const px = Math.floor((local.u / tile.width) * imgWidth);
  const py = Math.floor((local.v / tile.height) * imgHeight);
  if (px < 0 || px >= imgWidth || py < 0 || py >= imgHeight) return null;

  const idx = (py * imgWidth + px) * 4;
  const r0 = data[idx];
  const g0 = data[idx + 1];
  const b0 = data[idx + 2];
  const a0 = data[idx + 3];

  if (a0 === 0) return null;
  if (skipBackground && r0 >= whiteThreshold && g0 >= whiteThreshold && b0 >= whiteThreshold) return null;

  // Pre-square tolerance so we never call Math.sqrt
  const tolSq = colorTolerance * colorTolerance;

  // Flat queue: pairs of (x, y) stored in a typed array.
  // Worst case: every pixel queued once → imgWidth * imgHeight entries.
  const totalPixels = imgWidth * imgHeight;
  const queue = new Int32Array(totalPixels * 2);
  let head = 0;
  let tail = 0;

  const visited = new Uint8Array(totalPixels);

  // Seed
  const seedLi = py * imgWidth + px;
  visited[seedLi] = 1;
  queue[tail++] = px;
  queue[tail++] = py;

  let minPx = px;
  let maxPx = px;
  let minPy = py;
  let maxPy = py;

  // Neighbour offsets (8-connected) – inlined to avoid allocations
  const dxs = [-1, 1, 0, 0, -1, 1, -1, 1];
  const dys = [0, 0, -1, 1, -1, -1, 1, 1];

  while (head < tail) {
    const x = queue[head++];
    const y = queue[head++];

    const i = (y * imgWidth + x) * 4;
    data[i + 3] = 0; // erase

    if (x < minPx) minPx = x;
    if (x > maxPx) maxPx = x;
    if (y < minPy) minPy = y;
    if (y > maxPy) maxPy = y;

    for (let d = 0; d < 8; d++) {
      const nx = x + dxs[d];
      const ny = y + dys[d];
      if (nx < 0 || nx >= imgWidth || ny < 0 || ny >= imgHeight) continue;
      const li = ny * imgWidth + nx;
      if (visited[li]) continue;
      const j = li * 4;
      if (data[j + 3] === 0) continue;
      if (skipBackground && data[j] >= whiteThreshold && data[j + 1] >= whiteThreshold && data[j + 2] >= whiteThreshold) continue;
      const dr = data[j] - r0;
      const dg = data[j + 1] - g0;
      const db = data[j + 2] - b0;
      if (dr * dr + dg * dg + db * db <= tolSq) {
        visited[li] = 1;
        queue[tail++] = nx;
        queue[tail++] = ny;
      }
    }
  }

  // Convert pixel bbox → canvas-space rect (rotation-aware)
  return localBboxToCanvasRect(tile, imgWidth, imgHeight, minPx, minPy, maxPx, maxPy);
}
