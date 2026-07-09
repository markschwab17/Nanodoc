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
