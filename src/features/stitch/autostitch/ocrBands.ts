/**
 * Pure math for the OCR band channel: where to raster, how to rotate vertical
 * bands upright, and how OCR word boxes map back to page points as synthetic
 * Labels. No mupdf, no tesseract — everything here runs under vitest.
 * Conventions: page space is points y-down; `rot` 90 = the raster was rotated
 * CLOCKWISE before OCR (so a bottom-up vertical text reads left-to-right).
 */
import type { Label } from "./types";
import type { OcrWord, RawImage } from "./ocrService";

export interface BandSpec { edge: "top" | "bottom" | "left" | "right"; clip: [number, number, number, number] }

/** Four bands straddling a frame's edges (labels sit ON the border). */
export function edgeBands(bbox: [number, number, number, number], bandPt = 60): BandSpec[] {
  const [x0, y0, x1, y1] = bbox;
  return [
    { edge: "top",    clip: [x0, y0 - bandPt, x1, y0 + bandPt] },
    { edge: "bottom", clip: [x0, y1 - bandPt, x1, y1 + bandPt] },
    { edge: "left",   clip: [x0 - bandPt, y0, x0 + bandPt, y1] },
    { edge: "right",  clip: [x1 - bandPt, y0, x1 + bandPt, y1] },
  ];
}

/** Title-block sheet-number cell: bottom-right corner of the PAGE. */
export function sheetNoBand(view: [number, number, number, number]): BandSpec {
  const [x0, y0, x1, y1] = view;
  const W = x1 - x0, H = y1 - y0;
  return { edge: "bottom", clip: [x1 - 0.2 * W, y1 - 0.12 * H, x1, y1] };
}

/** Rotate an RGBA raster. 90 = clockwise, 270 = counter-clockwise. */
export function rotateRaw(img: RawImage, rot: 90 | 270): RawImage {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [dx, dy] = rot === 90 ? [h - 1 - y, x] : [y, w - 1 - x];
      const si = (y * w + x) * 4, di = (dy * h + dx) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
    }
  }
  return { width: h, height: w, data: out };
}

/**
 * Map OCR words (px in the possibly-rotated image) to page-pt Labels.
 * `imgW/imgH` are the PRE-rotation band raster dimensions (clip width/height
 * times `scale`) — i.e. the dims of the image BEFORE it was rotated for OCR;
 * `scale` is raster px per page pt. Words under `minConf` are dropped.
 */
export function wordsToLabels(
  words: OcrWord[], band: BandSpec, scale: number,
  imgW: number, imgH: number, rot: 0 | 90 | 270, minConf = 60
): Label[] {
  const [cx0, cy0] = band.clip;
  const mapped: Label[] = [];
  for (const w of words) {
    if (w.confidence < minConf || !w.text.trim()) continue;
    // corners in the OCR image
    const corners: [number, number][] = [
      [w.bbox.x0, w.bbox.y0], [w.bbox.x1, w.bbox.y0], [w.bbox.x0, w.bbox.y1], [w.bbox.x1, w.bbox.y1],
    ];
    // undo the rotation → pre-rotation raster px
    // (imgW/imgH are the PRE-rotation band raster dims: clip width/height * scale)
    const src = corners.map(([x, y]): [number, number] => {
      if (rot === 90) return [y, imgH - 1 - x];        // inverse of CW90 (dst = src rotated CW)
      if (rot === 270) return [imgW - 1 - y, x];       // inverse of CCW90
      return [x, y];
    });
    const xs = src.map((p) => p[0]), ys = src.map((p) => p[1]);
    const x = cx0 + Math.min(...xs) / scale, endX = cx0 + Math.max(...xs) / scale;
    const y = cy0 + Math.min(...ys) / scale, endY = cy0 + Math.max(...ys) / scale;
    mapped.push({ text: w.text.trim(), x, y, endX, endY, angle: 0, h: endY - y, font: "ocr" });
  }
  return mergePhrases(mapped);
}

/**
 * Merge adjacent same-baseline OCR word labels into phrase labels so the ref
 * regexes ("SEE SHEET 9") can match. Words merge when their vertical centers
 * differ by < 0.6x the taller word's height and the horizontal gap is
 * < 1.5x that height. Text joins with single spaces; bbox is the union.
 */
export function mergePhrases(labels: Label[]): Label[] {
  const sorted = [...labels].sort((a, b) => {
    const ya = (a.y + a.endY) / 2, yb = (b.y + b.endY) / 2;
    return Math.abs(ya - yb) > Math.max(a.endY - a.y, b.endY - b.y) * 0.6 ? ya - yb : a.x - b.x;
  });
  const out: Label[] = [];
  for (const l of sorted) {
    const prev = out[out.length - 1];
    if (prev) {
      const h = Math.max(prev.endY - prev.y, l.endY - l.y);
      const sameLine = Math.abs((prev.y + prev.endY) / 2 - (l.y + l.endY) / 2) < 0.6 * h;
      const closeGap = l.x - prev.endX < 1.5 * h && l.x - prev.endX > -0.5 * h;
      if (sameLine && closeGap) {
        prev.text = `${prev.text} ${l.text}`;
        prev.x = Math.min(prev.x, l.x); prev.y = Math.min(prev.y, l.y);
        prev.endX = Math.max(prev.endX, l.endX); prev.endY = Math.max(prev.endY, l.endY);
        prev.h = Math.max(prev.h, l.endY - l.y);
        continue;
      }
    }
    out.push({ ...l });
  }
  return out;
}

/** "SHEET 2 OF 22" / "2 OF 22" (words may arrive split) → 2, else null. */
export function parseSheetNumber(words: OcrWord[]): number | null {
  const joined = words.map((w) => w.text).join(" ").toUpperCase();
  const m = joined.match(/(?:SHEET\s+)?(\d{1,3})\s+OF\s+\d{1,3}/);
  return m ? Number(m[1]) : null;
}
