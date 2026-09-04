/**
 * Pure math for the OCR band channel: where to raster, how to rotate vertical
 * bands upright, and how OCR word boxes map back to page points as synthetic
 * Labels. No mupdf, no tesseract — everything here runs under vitest.
 * Conventions: page space is points y-down; `rot` 90 = the raster was rotated
 * CLOCKWISE before OCR (so a bottom-up vertical text reads left-to-right).
 */
import type { Label } from "./types";
import type { OcrWord, RawImage } from "./ocrService";
import { REF_NUMBER_SRC, REF_CODE_SRC } from "./tokens";

export interface BandSpec { edge: "top" | "bottom" | "left" | "right"; clip: [number, number, number, number] }

/**
 * Inward edge bands of the PAGE view for OCR (no frame needed): matchline
 * labels on this class of sheet sit within these fractions of the page edges
 * (validated on the reference set at 200 DPI). Some sheets (e.g. reference
 * set sheet 10) inset their plan frame ~9% from the page edges, pushing
 * matchline labels further inward than a tight band would catch — top/bottom
 * 15% of height, left/right 12% of width covers that inset frame while
 * staying inside `parseSheetRefs`'s 18% edge-classification gate, so
 * recovered refs still classify as edge refs.
 */
export function pageEdgeBands(view: [number, number, number, number]): BandSpec[] {
  const [x0, y0, x1, y1] = view;
  const W = x1 - x0, H = y1 - y0;
  return [
    { edge: "top",    clip: [x0, y0, x1, y0 + 0.15 * H] },
    { edge: "bottom", clip: [x0, y1 - 0.15 * H, x1, y1] },
    { edge: "left",   clip: [x0, y0, x0 + 0.12 * W, y1] },
    { edge: "right",  clip: [x1 - 0.12 * W, y0, x1, y1] },
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
  // Merge words into phrases in OCR-IMAGE pixel space, where text is horizontal
  // by construction (vertical bands are rotated upright BEFORE OCR). Merging in
  // page space fails for rotated side bands: mapped words stack vertically there,
  // so a horizontal-baseline merge never joins them ("SEE" above "BELOW").
  const kept = words.filter((w) => w.confidence >= minConf && w.text.trim());
  const merged = mergeWords(kept);
  // Phrase merging is a heuristic and it fails BOTH ways on real sheets: it can
  // leave "SEE" and "SHEET 7" apart (a wide leader gap), or glue a callout into a
  // 100-character run of grading text. Independently of it, scan short runs of
  // consecutive words for a complete reference phrase and emit those as extra
  // labels — a ref that either failure hid is then still recovered. Windows the
  // merge already produced verbatim are dropped so refs are not double-counted.
  const windows = refPhraseWindows(kept).filter((w) => !merged.some((m) => m.text.includes(w.text)));
  const mapped: Label[] = [];
  for (const w of [...merged, ...windows]) {
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
  return mapped;
}

/**
 * Merge adjacent same-line OCR words into phrase words so the ref regexes
 * ("SEE SHEET 9", "SEE BELOW LEFT") can match. Operates in OCR-IMAGE pixel
 * space (text horizontal by construction). Words merge when they share a line
 * bin and the horizontal gap is < 1.5x the taller box's height (and gap
 * > -0.5x that height). Text joins with single spaces; bbox is the union;
 * confidence is the min of the parts.
 */
const yc = (w: OcrWord) => (w.bbox.y0 + w.bbox.y1) / 2;
const hOf = (w: OcrWord) => w.bbox.y1 - w.bbox.y0;

/**
 * Cluster words into text LINES (1-D scan over y-centres) and return them sorted
 * by (line, x0). A pairwise "same line" test inside a sort comparator is not a
 * strict weak order (transitivity breaks when heights vary) and corrupts
 * Array#sort, hence the explicit clustering pass.
 */
function clusterLines(words: OcrWord[]): { sorted: OcrWord[]; lineOf: Map<OcrWord, number> } {
  const byY = [...words].sort((a, b) => yc(a) - yc(b));
  const lineOf = new Map<OcrWord, number>();
  let line = 0;
  for (let i = 0; i < byY.length; i++) {
    if (i > 0) {
      const prev = byY[i - 1], cur = byY[i];
      const h = Math.max(hOf(prev), hOf(cur));
      if (yc(cur) - yc(prev) >= 0.6 * h) line++;
    }
    lineOf.set(byY[i], line);
  }
  const sorted = [...words].sort((a, b) => (lineOf.get(a)! - lineOf.get(b)!) || (a.bbox.x0 - b.bbox.x0));
  return { sorted, lineOf };
}

const bboxUnion = (ws: OcrWord[]) => ({
  x0: Math.min(...ws.map((w) => w.bbox.x0)), y0: Math.min(...ws.map((w) => w.bbox.y0)),
  x1: Math.max(...ws.map((w) => w.bbox.x1)), y1: Math.max(...ws.map((w) => w.bbox.y1)),
});

// A complete reference phrase — the callout vocabulary plus the sheet it names.
const REF_PHRASE_RE = new RegExp(`(?:${REF_NUMBER_SRC})|(?:${REF_CODE_SRC})`, "i");

/**
 * Reference phrases found by sliding a short window over CONSECUTIVE same-line
 * words, independently of `mergeWords`. `mergeWords` decides by geometry alone and
 * gets it wrong in both directions on dense civil sheets; this pass decides by
 * CONTENT — a run of ≤ `maxWords` words that reads as a complete "SEE SHEET n"
 * callout is one, whatever the gaps looked like. The shortest match wins at each
 * start and its words are consumed, so one callout yields one phrase. Pure;
 * exported for tests.
 */
export function refPhraseWindows(words: OcrWord[], maxWords = 4): OcrWord[] {
  const { sorted, lineOf } = clusterLines(words);
  const out: OcrWord[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let n = 2; n <= maxWords && i + n <= sorted.length; n++) {
      const win = sorted.slice(i, i + n);
      if (lineOf.get(win[n - 1]) !== lineOf.get(win[0])) break; // window left the line
      const text = win.map((w) => w.text).join(" ");
      if (!REF_PHRASE_RE.test(text)) continue;
      out.push({ text, confidence: Math.min(...win.map((w) => w.confidence)), bbox: bboxUnion(win) });
      i += n - 1; // consume the window
      break;
    }
  }
  return out;
}

export function mergeWords(words: OcrWord[]): OcrWord[] {
  const { sorted, lineOf } = clusterLines(words);
  const out: OcrWord[] = [];
  let prevLine = -1; // line of out[out.length - 1] (out holds fresh objects, not map keys)
  for (const w of sorted) {
    const prev = out[out.length - 1];
    const wLine = lineOf.get(w)!;
    if (prev && prevLine === wLine) {
      const h = Math.max(hOf(prev), hOf(w));
      const gap = w.bbox.x0 - prev.bbox.x1;
      // HEIGHT COMPATIBILITY: only merge text drawn at the same size. Without it a
      // 111 px matchline callout absorbs the 20 px grading annotations around it
      // (the gap test uses the TALLER box, so a big box swallows its neighbours)
      // and the ref regex then fails on a 100-character run. Two runs of one
      // phrase are drawn at one size, so 1.5x is generous.
      const compatible = Math.min(hOf(prev), hOf(w)) * 1.5 >= Math.max(hOf(prev), hOf(w));
      if (compatible && gap < 1.5 * h && gap > -0.5 * h) {
        prev.text = `${prev.text} ${w.text}`;
        prev.bbox = {
          x0: Math.min(prev.bbox.x0, w.bbox.x0), y0: Math.min(prev.bbox.y0, w.bbox.y0),
          x1: Math.max(prev.bbox.x1, w.bbox.x1), y1: Math.max(prev.bbox.y1, w.bbox.y1),
        };
        prev.confidence = Math.min(prev.confidence, w.confidence);
        continue;
      }
    }
    out.push({ text: w.text, confidence: w.confidence, bbox: { ...w.bbox } });
    prevLine = wLine;
  }
  return out;
}

/**
 * Single-character shapes tesseract returns for a large isolated DIGIT. The
 * title-block sheet number is drawn alone, at 4-8x the surrounding text size, with
 * no word context to constrain the classifier, so a systematic look-alike letter is
 * the common failure ("5" -> "S" at confidence 5 on all four Belcourt sheets).
 * Only unambiguous single-glyph shapes are mapped, and only for a lone token in the
 * sheet-number cell; `resolvePrintedNos` still range-checks the result.
 */
const DIGIT_LOOKALIKE: Record<string, number> = {
  O: 0, Q: 0, D: 0, I: 1, L: 1, "|": 1, Z: 2, A: 4, S: 5, G: 6, B: 8,
};

/**
 * The printed sheet number from the title-block cell.
 *
 * First the plain reading, "SHEET 2 OF 22" / "2 OF 22" (words may arrive split).
 * When that fails, fall back to the LAYOUT: on a great many title blocks the number
 * lives in its own cell as one very large glyph while "OF 30 SHEETS" is set in the
 * ordinary small type beside it. So if the cell says "OF n SHEETS" at all, take the
 * tallest token in it — accepted when it is a bare number, or a single character
 * whose shape is an unambiguous digit look-alike. Without this the Belcourt set read
 * no number on any sheet, every "SEE SHEET n" resolved to nothing, and 0 of 4 sheets
 * could align.
 */
export function parseSheetNumber(words: OcrWord[]): number | null {
  const joined = words.map((w) => w.text).join(" ").toUpperCase();
  const m = joined.match(/(?:SHEET\s+)?(\d{1,3})\s+OF\s+\d{1,3}/);
  if (m) return Number(m[1]);
  if (!/\bOF\s+\d{1,3}\s+SHEETS?\b/.test(joined)) return null;
  const heights = words.map(hOf).filter((h) => h > 0).sort((a, b) => a - b);
  if (!heights.length) return null;
  const median = heights[Math.floor(heights.length / 2)];
  const tall = words.filter((w) => hOf(w) >= 1.8 * median)
    .sort((a, b) => (hOf(b) - hOf(a)) || (b.confidence - a.confidence) || (a.bbox.x0 - b.bbox.x0));
  for (const w of tall) {
    const t = w.text.trim();
    if (/^\d{1,3}$/.test(t)) return Number(t);
    if (t.length === 1) {
      const d = DIGIT_LOOKALIKE[t.toUpperCase()];
      if (d != null) return d;
    }
  }
  return null;
}
