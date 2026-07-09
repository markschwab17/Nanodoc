/**
 * Per-page label logic: value formatting, integrated /PageLabels reading,
 * /PageLabels writing, and auto-extraction. Kept free of React so it can be
 * unit-tested and reused by the save pipeline.
 */

/** Mirrors mupdf's PDFDocument.PAGE_LABEL_* constants (usable without a live mupdf). */
export const PAGE_LABEL_STYLE = {
  NONE: "\0",
  DECIMAL: "D",
  ROMAN_UC: "R",
  ROMAN_LC: "r",
  ALPHA_UC: "A",
  ALPHA_LC: "a",
} as const;

const ROMAN: [number, string][] = [
  [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
  [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
];

function toRoman(n: number): string {
  let out = "";
  let rem = n;
  for (const [v, s] of ROMAN) {
    while (rem >= v) { out += s; rem -= v; }
  }
  return out;
}

// 1->a, 26->z, 27->aa, 28->bb (PDF spec: a..z then aa..zz, repeating the letter).
function toAlpha(n: number): string {
  const idx = (n - 1) % 26;
  const repeat = Math.floor((n - 1) / 26) + 1;
  return String.fromCharCode(97 + idx).repeat(repeat);
}

/** Format 1-based ordinal `n` per a mupdf page-label style constant. */
export function formatLabelValue(style: string, n: number): string {
  switch (style) {
    case PAGE_LABEL_STYLE.DECIMAL: return String(n);
    case PAGE_LABEL_STYLE.ROMAN_UC: return toRoman(n);
    case PAGE_LABEL_STYLE.ROMAN_LC: return toRoman(n).toLowerCase();
    case PAGE_LABEL_STYLE.ALPHA_UC: return toAlpha(n).toUpperCase();
    case PAGE_LABEL_STYLE.ALPHA_LC: return toAlpha(n);
    default: return "";
  }
}

/** Guard for mupdf's truthy null-objects. */
function isPresent(v: any): boolean {
  return v !== null && v !== undefined && !(v.isNull?.() ?? false);
}

function objToString(v: any): string | null {
  if (!isPresent(v)) return null;
  try { return typeof v.asString === "function" ? v.asString() : null; }
  catch { return null; }
}

function objToName(v: any): string | null {
  if (!isPresent(v)) return null;
  try { return typeof v.asName === "function" && v.isName?.() ? v.asName() : null; }
  catch { return null; }
}

function objToNumber(v: any): number | null {
  if (!isPresent(v)) return null;
  if (typeof v === "number") return v;
  if (typeof v.asNumber === "function") { try { return v.asNumber(); } catch { /* fall through */ } }
  if (typeof v.valueOf === "function") { const n = v.valueOf(); if (typeof n === "number") return n; }
  return null;
}

/**
 * Read the catalog /PageLabels number tree and compute each page's label.
 * /PageLabels/Nums = [start0, dict0, start1, dict1, ...]; each dict may have
 * /S (style name), /P (prefix string), /St (start, default 1). A range runs
 * from its start index until the next range's start. A range with no /S yields
 * prefix only. Returns null per page when no tree exists or a page is uncovered.
 */
export function readIntegratedPageLabels(pdfDoc: any, pageCount: number): (string | null)[] {
  const out: (string | null)[] = new Array(pageCount).fill(null);
  let nums: any;
  try {
    const root = pdfDoc.getTrailer().get("Root");
    const pageLabels = root.get("PageLabels");
    if (!isPresent(pageLabels)) return out;
    nums = pageLabels.get("Nums");
    if (!isPresent(nums)) return out;
  } catch { return out; }

  // Collect [startIndex, styleDict] pairs.
  const ranges: { start: number; style: string; prefix: string; st: number }[] = [];
  const len = typeof nums.length === "number" ? nums.length : (nums.getLength?.() ?? 0);
  for (let i = 0; i + 1 < len; i += 2) {
    const start = objToNumber(nums.get(i));
    if (start === null) continue;
    const dict = nums.get(i + 1);
    if (!isPresent(dict)) continue;
    const style = objToName(dict.get("S")) ?? PAGE_LABEL_STYLE.NONE;
    const prefix = objToString(dict.get("P")) ?? "";
    const st = objToNumber(dict.get("St")) ?? 1;
    ranges.push({ start, style, prefix, st });
  }
  if (ranges.length === 0) return out;
  ranges.sort((a, b) => a.start - b.start);

  for (let p = 0; p < pageCount; p++) {
    // Find the last range whose start <= p.
    let r: typeof ranges[number] | null = null;
    for (const cand of ranges) { if (cand.start <= p) r = cand; else break; }
    if (!r) { out[p] = null; continue; }
    const value = formatLabelValue(r.style, r.st + (p - r.start));
    out[p] = `${r.prefix}${value}`;
  }
  return out;
}
