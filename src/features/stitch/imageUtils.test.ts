/**
 * Erase operations must map canvas points through the tile's CENTER-based
 * rotation (like the DOM and stitchGeometry), not the axis-aligned rect —
 * otherwise erases on rotated tiles hit the wrong pixels.
 */

import { describe, expect, test } from "vitest";
import {
  applyAlphaMaskNearest,
  eraseCanvasRectInImage,
  floodFillErase,
  pickRasterScale,
} from "./imageUtils";

const W = 100;
const H = 50;

/** Plain-object ImageData stand-in (jsdom-safe; the code only reads .data). */
function makeImageData(w: number, h: number): ImageData {
  return {
    data: new Uint8ClampedArray(w * h * 4),
    width: w,
    height: h,
    colorSpace: "srgb",
  } as unknown as ImageData;
}

function setPixel(img: ImageData, x: number, y: number, r: number, g: number, b: number, a = 255) {
  const i = (y * W + x) * 4;
  img.data[i] = r;
  img.data[i + 1] = g;
  img.data[i + 2] = b;
  img.data[i + 3] = a;
}

function alphaAt(img: ImageData, x: number, y: number): number {
  return img.data[(y * W + x) * 4 + 3];
}

/** 100x50 tile at origin. Rotated 90° it occupies x∈[25,75], y∈[-25,75]. */
const ROTATED_TILE = { x: 0, y: 0, width: W, height: H, rotation: 90 };
const FLAT_TILE = { x: 0, y: 0, width: W, height: H };

describe("floodFillErase", () => {
  test("erases a connected blob on an unrotated tile", () => {
    const img = makeImageData(W, H);
    for (let y = 13; y <= 17; y++) for (let x = 8; x <= 12; x++) setPixel(img, x, y, 255, 0, 0);
    const rect = floodFillErase(img, W, H, FLAT_TILE, 10.5, 15.5);
    expect(rect).not.toBeNull();
    expect(alphaAt(img, 10, 15)).toBe(0);
  });

  test("maps the click through center-based rotation on a rotated tile", () => {
    const img = makeImageData(W, H);
    // Blob around tile-local (10, 15)
    for (let y = 13; y <= 17; y++) for (let x = 8; x <= 12; x++) setPixel(img, x, y, 255, 0, 0);
    // Canvas point (60, -15) is inside the ROTATED footprint (and outside the
    // unrotated rect); it maps to tile-local (10, 15).
    const rect = floodFillErase(img, W, H, ROTATED_TILE, 60, -15);
    expect(rect).not.toBeNull();
    expect(alphaAt(img, 10, 15)).toBe(0);
  });

  test("feedback rect for a rotated tile contains the clicked canvas point", () => {
    const img = makeImageData(W, H);
    for (let y = 13; y <= 17; y++) for (let x = 8; x <= 12; x++) setPixel(img, x, y, 255, 0, 0);
    const rect = floodFillErase(img, W, H, ROTATED_TILE, 60, -15)!;
    expect(rect).not.toBeNull();
    expect(60).toBeGreaterThanOrEqual(rect.x);
    expect(60).toBeLessThanOrEqual(rect.x + rect.w);
    expect(-15).toBeGreaterThanOrEqual(rect.y);
    expect(-15).toBeLessThanOrEqual(rect.y + rect.h);
  });
});

describe("pickRasterScale", () => {
  test("small pages get the max scale", () => {
    // Letter: 612x792pt at 4x = ~7.8MP, well under budget
    expect(pickRasterScale(612, 792)).toBe(4);
  });

  test("large sheets are scaled down to fit the pixel budget", () => {
    // 24x36" = 1728x2592pt; budget 16MP → sqrt(16e6 / 4.48e6) ≈ 1.89
    const s = pickRasterScale(1728, 2592);
    expect(s).toBeLessThan(4);
    expect(1728 * s * 2592 * s).toBeLessThanOrEqual(16_000_000 + 1);
  });

  test("never drops below the minimum scale", () => {
    expect(pickRasterScale(100000, 100000, { minScale: 1 })).toBe(1);
  });
});

describe("applyAlphaMaskNearest", () => {
  function makeImg(w: number, h: number, alpha: number): ImageData {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = 100;
      data[i * 4 + 3] = alpha;
    }
    return { data, width: w, height: h, colorSpace: "srgb" } as unknown as ImageData;
  }

  test("transfers erased (alpha 0) mask regions onto a larger render", () => {
    const mask = makeImg(2, 2, 255);
    mask.data[3] = 0; // top-left mask pixel erased
    const target = makeImg(4, 4, 255);
    applyAlphaMaskNearest(target, 4, 4, mask, 2, 2);
    // Top-left 2x2 quadrant of the target maps to the erased mask pixel
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      expect(target.data[(y * 4 + x) * 4 + 3]).toBe(0);
    }
    // The other quadrants stay opaque
    for (const [x, y] of [[3, 0], [0, 3], [3, 3], [2, 2]]) {
      expect(target.data[(y * 4 + x) * 4 + 3]).toBe(255);
    }
  });

  test("leaves the target untouched when the mask is fully opaque", () => {
    const mask = makeImg(2, 2, 255);
    const target = makeImg(4, 4, 200);
    applyAlphaMaskNearest(target, 4, 4, mask, 2, 2);
    for (let i = 0; i < 16; i++) {
      expect(target.data[i * 4 + 3]).toBe(200);
    }
  });
});

describe("eraseCanvasRectInImage", () => {
  test("erases an axis-aligned canvas rect on an unrotated tile", () => {
    const img = makeImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) setPixel(img, x, y, 255, 0, 0);
    const result = eraseCanvasRectInImage(img, W, H, FLAT_TILE, { x: 5, y: 10, w: 10, h: 10 });
    expect(result).not.toBeNull();
    expect(alphaAt(img, 10, 15)).toBe(0);
    expect(alphaAt(img, 50, 25)).toBe(255);
  });

  test("erases the correct pixels on a rotated tile", () => {
    const img = makeImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) setPixel(img, x, y, 255, 0, 0);
    // Canvas rect over the TOP of the rotated footprint (outside the
    // unrotated rect). Tile-local (10, 15) sits at canvas (60, -15) → erased;
    // tile-local (50, 25) is the center at canvas (50, 25) → untouched.
    const result = eraseCanvasRectInImage(img, W, H, ROTATED_TILE, { x: 55, y: -20, w: 10, h: 10 });
    expect(result).not.toBeNull();
    expect(alphaAt(img, 10, 15)).toBe(0);
    expect(alphaAt(img, 50, 25)).toBe(255);
  });

  test("returns null when the rect misses the rotated footprint", () => {
    const img = makeImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) setPixel(img, x, y, 255, 0, 0);
    // x∈[80,95] is inside the unrotated rect but OUTSIDE the rotated footprint x∈[25,75].
    const result = eraseCanvasRectInImage(img, W, H, ROTATED_TILE, { x: 80, y: 20, w: 15, h: 10 });
    expect(result).toBeNull();
  });
});
