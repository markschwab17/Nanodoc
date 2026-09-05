/**
 * Pure math for the OCR band channel: where to raster, how to rotate vertical
 * bands upright, and how OCR word boxes map back to page points as synthetic
 * Labels. No mupdf, no tesseract — everything here runs under vitest.
 * Conventions: page space is points y-down; `rot` 90 = the raster was rotated
 * CLOCKWISE before OCR (so a bottom-up vertical text reads left-to-right).
 */
import type { Label } from "./types";
import type { OcrWord, RawImage } from "./ocrService";
import { REF_NUMBER_SRC, REF_CODE_SRC, isMatchlineText } from "./tokens";

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
 *
 * `frame` is the sheet's ruled DRAWING frame when one was detected
 * (`detectDrawingFrame`). The four page bands are returned UNCHANGED, and an extra
 * frame-relative band is appended for each side whose frame border falls OUTSIDE
 * the page band — i.e. only where the page band cannot reach it. That is exactly
 * failure D: a drawing whose right border sits at ~72 % of the page width, behind a
 * notes column, never has its matchline callouts rasterised at all.
 *
 * Deliberately additive rather than a union or a replacement. OCR is sensitive to
 * the raster it is given: growing a band changes tesseract's segmentation and can
 * LOSE words it used to read (measured — widening Belcourt's bands cost two of its
 * four alignments). Keeping the page bands byte-identical keeps every result they
 * already produce, cache included, and adds coverage only where there was none.
 */
export function pageEdgeBands(
  view: [number, number, number, number],
  frame?: [number, number, number, number] | null,
): BandSpec[] {
  const [x0, y0, x1, y1] = view;
  const W = x1 - x0, H = y1 - y0;
  const bands: BandSpec[] = [
    { edge: "top",    clip: [x0, y0, x1, y0 + 0.15 * H] },
    { edge: "bottom", clip: [x0, y1 - 0.15 * H, x1, y1] },
    { edge: "left",   clip: [x0, y0, x0 + 0.12 * W, y1] },
    { edge: "right",  clip: [x1 - 0.12 * W, y0, x1, y1] },
  ];
  if (!frame) return bands;
  const [fx0, fy0, fx1, fy1] = frame;
  const FW = fx1 - fx0, FH = fy1 - fy0;
  if (!(FW > 0 && FH > 0)) return bands;
  if (fy0 > y0 + 0.15 * H) bands.push({ edge: "top",    clip: [fx0, fy0, fx1, fy0 + 0.15 * FH] });
  if (fy1 < y1 - 0.15 * H) bands.push({ edge: "bottom", clip: [fx0, fy1 - 0.15 * FH, fx1, fy1] });
  if (fx0 > x0 + 0.12 * W) bands.push({ edge: "left",   clip: [fx0, fy0, fx0 + 0.12 * FW, fy1] });
  if (fx1 < x1 - 0.12 * W) bands.push({ edge: "right",  clip: [fx1 - 0.12 * FW, fy0, fx1, fy1] });
  return bands;
}

/**
 * The OCR job budget, in raster pixels along a band's LONG edge, and the overlap
 * the retry cuts with.
 *
 * A pool job is bounded at 20 s from DISPATCH (`ocrService`), and browser
 * tesseract does not always finish a full-height side band inside that: a 36-inch
 * band at 200 dpi is ~860 x 7200 px, and on the Belcourt set four of those reads
 * came back as non-answers. The Node harness never hits it (same code, faster
 * tesseract build), so this is a browser-only failure and the corpus cannot see it.
 *
 * `splitBand` is how a band that has ALREADY failed that way is read instead: same
 * 200 dpi, no downsampling, but as several shorter reads. It is NOT used
 * speculatively — measured on the four eval sets, cutting every long band up front
 * cost 3 of them (a callout that straddles a cut is truncated, or worse misread into
 * a different valid-looking target), so only a band whose whole-band read produced
 * nothing is ever cut. See task-6-report.md.
 *
 * TARGET is the length a read comfortably finishes at and sets the starting sub-clip
 * count; MAX is the length above which we stop trusting that, and no sub-clip is
 * allowed to exceed it.
 *
 * OVERLAP is sized to a CALLOUT, not to a round number. The whole risk of cutting is
 * that "MATCH LINE SEE SHEET 7" lands across a cut and both halves read as rubbish;
 * the overlap is the width in which a phrase is guaranteed to appear whole in one
 * sub-clip. At 200 dpi the matchline callouts measured on this corpus run ~100-130 px
 * tall and up to ~1400 px long, so 1000 px (5 inches of sheet) covers the great
 * majority of them, where the 200 px first tried covers almost none.
 */
export const SPLIT_MAX_PX = 3000;
export const SPLIT_TARGET_PX = 2800;
export const RETRY_OVERLAP_PX = 1000;

/** Raster px a clip span occupies — `renderBand`'s own floor/ceil convention. */
const spanPx = (lo: number, hi: number, S: number) => Math.ceil(hi * S) - Math.floor(lo * S);

/**
 * One band as the overlapping sub-clips it should be RE-read in, in order ALONG
 * the band (top→bottom for a side band, left→right for a top/bottom band).
 *
 * A band already short enough to be one job comes back as itself (`[band]`, the
 * identical object) — the caller reads that as "there is nothing to retry with",
 * because cutting it would just re-issue the same read.
 *
 * The count starts at `ceil(longEdgePx / SPLIT_TARGET_PX)` and is raised until the
 * sub-clip actually fits `SPLIT_MAX_PX`. The raise matters at this overlap and only
 * at this overlap: 3 sub-clips of a 7200 px band overlapping by 1000 px are 3067 px
 * each — longer than the budget the split exists to respect — so a 7200 px band
 * becomes 4 sub-clips of 2550 px. (At a 200 px overlap the starting count always
 * fits and the loop never runs.)
 *
 * The cut is uniform: `n` equal sub-clips each overlapping the next by `overlapPx`,
 * so sub-clip length is `(L + (n-1)*overlap) / n` and the last one ends exactly on
 * the band's far edge. Equal lengths keep the longest read as short as it can be for
 * that `n`, and pinning both ends means no strip of the band goes unread.
 *
 * Pure; page points in, page points out. `dpi` matches `renderBand`'s default.
 */
export function splitBand(band: BandSpec, overlapPx = RETRY_OVERLAP_PX, dpi = 200): BandSpec[] {
  const S = dpi / 72;
  const [x0, y0, x1, y1] = band.clip;
  const wPx = spanPx(x0, x1, S), hPx = spanPx(y0, y1, S);
  // Cut along the LONG edge whichever way the band lies: a side band is tall and cut
  // horizontally; a top/bottom band on a 36" sheet is just as long the other way and
  // is cut vertically.
  const vertical = hPx >= wPx;
  const longPx = vertical ? hPx : wPx;
  if (!(longPx > SPLIT_MAX_PX)) return [band];
  // An overlap at or above the budget can never fit (sub-clip length tends to the
  // overlap as n grows), so clamp it rather than spin.
  const ov = Math.max(0, Math.min(overlapPx, SPLIT_MAX_PX / 2));
  let n = Math.ceil(longPx / SPLIT_TARGET_PX);
  while ((longPx + (n - 1) * ov) / n > SPLIT_MAX_PX) n++;
  const lo = vertical ? y0 : x0, hi = vertical ? y1 : x1;
  const overlapPt = ov / S;
  const lenPt = ((hi - lo) + (n - 1) * overlapPt) / n;
  const stepPt = lenPt - overlapPt;
  const out: BandSpec[] = [];
  for (let i = 0; i < n; i++) {
    const a = lo + i * stepPt;
    // The last sub-clip is pinned to the band's far edge rather than computed, so
    // float drift cannot leave a sliver of the band unrastered.
    const b = i === n - 1 ? hi : a + lenPt;
    out.push({ edge: band.edge, clip: vertical ? [x0, a, x1, b] : [a, y0, b, y1] });
  }
  return out;
}

/**
 * Drop labels the overlap between two sub-clips produced twice.
 *
 * A callout inside the overlap is rastered into BOTH neighbouring sub-clips and read
 * by both, so it arrives as two Labels with the same text at (very nearly) the same
 * place — the two reads see the same pixels at the same scale, and only the crop
 * origin's rounding and tesseract's own segmentation move the box at all.
 * `mergeWords` cannot help here: it works inside ONE read's word list, in that
 * read's image pixels, and knows nothing of the read next door.
 *
 * Identical text within `tolPt` on every side of the box is therefore the same
 * physical callout. The tolerance is generous (6 pt ≈ 17 px at 200 dpi) on purpose:
 * two genuinely distinct labels that read the same text sit hundreds of points apart
 * on a sheet, so there is nothing to lose by being loose, while being tight would
 * leak a duplicated ref into the solver's vote. First occurrence wins, which keeps
 * the order the sub-clips were consumed in.
 */
export function dedupeLabels(labels: Label[], tolPt = 6): Label[] {
  const out: Label[] = [];
  for (const l of labels) {
    const dup = out.some((k) => k.text === l.text
      && Math.abs(k.x - l.x) <= tolPt && Math.abs(k.y - l.y) <= tolPt
      && Math.abs(k.endX - l.endX) <= tolPt && Math.abs(k.endY - l.endY) <= tolPt);
    if (!dup) out.push(l);
  }
  return out;
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
 * Callout phrases found by sliding a short window over CONSECUTIVE same-line words,
 * independently of `mergeWords`. `mergeWords` decides by geometry alone and gets it
 * wrong in both directions on dense civil sheets; this pass decides by CONTENT — a
 * run of ≤ `maxWords` words that READS as a callout is one, whatever the gaps looked
 * like. The shortest match wins at each start and its words are consumed, so one
 * callout yields one phrase.
 *
 * Two shapes qualify. A complete reference ("SEE SHEET 6", "SEE SHEET C-302") is the
 * obvious one. A bare MATCHLINE is the other, and it matters as much: a matchline
 * with no readable target is still the fact that this edge abuts something, which is
 * what `matchlinePrior` pairs on and what `hasEdgeRefs` counts — and outlined CAD
 * text routinely arrives as "MATCH" + "LINE" in two words, or with the MATCH clipped
 * away entirely ("LINE S EE SHEET"). Pure; exported for tests.
 */
export function refPhraseWindows(words: OcrWord[], maxWords = 4): OcrWord[] {
  const { sorted, lineOf } = clusterLines(words);
  const out: OcrWord[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let n = 2; n <= maxWords && i + n <= sorted.length; n++) {
      const win = sorted.slice(i, i + n);
      if (lineOf.get(win[n - 1]) !== lineOf.get(win[0])) break; // window left the line
      const text = win.map((w) => w.text).join(" ");
      if (!REF_PHRASE_RE.test(text) && !isMatchlineText(text)) continue;
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
