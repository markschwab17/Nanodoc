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

/** Canvas-space rectangle (same units as tile x, y, width, height). */
export interface CanvasRect {
  x: number;
  y: number;
  w: number;
  h: number;
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
 * Erase (make transparent) the pixels inside the given canvas-space rectangle
 * on the tile's image. Returns the new image data URL, or null if the rect
 * doesn't intersect the tile or the tile has no image.
 */
export async function eraseRectFromTile(
  tile: { x: number; y: number; width: number; height: number; imageDataUrl?: string },
  rect: CanvasRect
): Promise<string | null> {
  if (!tile.imageDataUrl) return null;

  const tileRight = tile.x + tile.width;
  const tileBottom = tile.y + tile.height;
  const rectRight = rect.x + rect.w;
  const rectBottom = rect.y + rect.h;

  const ix0 = Math.max(tile.x, rect.x);
  const iy0 = Math.max(tile.y, rect.y);
  const ix1 = Math.min(tileRight, rectRight);
  const iy1 = Math.min(tileBottom, rectBottom);
  if (ix0 >= ix1 || iy0 >= iy1) return null;

  const { imageData, width: imgWidth, height: imgHeight } = await imageDataUrlToImageData(tile.imageDataUrl);

  const relX0 = (ix0 - tile.x) / tile.width;
  const relY0 = (iy0 - tile.y) / tile.height;
  const relX1 = (ix1 - tile.x) / tile.width;
  const relY1 = (iy1 - tile.y) / tile.height;

  const px0 = Math.max(0, Math.floor(relX0 * imgWidth));
  const py0 = Math.max(0, Math.floor(relY0 * imgHeight));
  const px1 = Math.min(imgWidth, Math.ceil(relX1 * imgWidth));
  const py1 = Math.min(imgHeight, Math.ceil(relY1 * imgHeight));

  const data = imageData.data;
  for (let py = py0; py < py1; py++) {
    for (let px = px0; px < px1; px++) {
      const i = (py * imgWidth + px) * 4;
      data[i + 3] = 0;
    }
  }

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
  tile: { x: number; y: number; width: number; height: number; imageDataUrl?: string },
  canvasX: number,
  canvasY: number,
  options: EraseConnectedOptions = {}
): Promise<EraseConnectedResult | null> {
  const imageSource = options.currentImageDataUrl ?? tile.imageDataUrl;
  if (!imageSource) return null;

  const { colorTolerance = 45, skipBackground = true, whiteThreshold = 248 } = options;

  if (
    canvasX < tile.x ||
    canvasY < tile.y ||
    canvasX >= tile.x + tile.width ||
    canvasY >= tile.y + tile.height
  ) {
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
  tile: { x: number; y: number; width: number; height: number },
  canvasX: number,
  canvasY: number,
  colorTolerance: number = 45,
  skipBackground: boolean = true,
  whiteThreshold: number = 248,
): CanvasRect | null {
  const data = imageData.data;

  // Convert canvas coords → pixel coords
  const relX = (canvasX - tile.x) / tile.width;
  const relY = (canvasY - tile.y) / tile.height;
  const px = Math.floor(relX * imgWidth);
  const py = Math.floor(relY * imgHeight);
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

  // Convert pixel bbox → canvas-space rect
  const relMinX = minPx / imgWidth;
  const relMinY = minPy / imgHeight;
  const relMaxX = (maxPx + 1) / imgWidth;
  const relMaxY = (maxPy + 1) / imgHeight;
  return {
    x: tile.x + relMinX * tile.width,
    y: tile.y + relMinY * tile.height,
    w: (relMaxX - relMinX) * tile.width,
    h: (relMaxY - relMinY) * tile.height,
  };
}
