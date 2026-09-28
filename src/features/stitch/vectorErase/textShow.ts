/**
 * Glyph-exact removal inside PDF text-showing operators (Tj, TJ, ', ").
 *
 * The caller's content filter tracks the text state; this module lays out one
 * show operation glyph by glyph (the PDF text layout rules: width, Tc, Tw on a
 * single-byte space, Tz, TJ adjustments), asks the caller which glyph origins
 * were erased, and re-emits the operation as a TJ array in which every removed
 * glyph is replaced by the kerning adjustment that advances by exactly its
 * width — so every glyph after it lands where it always did.
 *
 * Replaces mupdf redaction for text: redaction re-filters the whole page and
 * clones a Form XObject per use, which on CAD sheets with tens of thousands of
 * block references runs for minutes and then fails.
 *
 * Pure. Exported for tests.
 */
import type { Mat } from "./contentFilter";

/** What the layout needs from a font: code length and advance widths. */
export interface FontMetrics {
  /** 1 for simple fonts, 2 for Identity-H composite fonts. */
  bytesPerCode: 1 | 2;
  /** Advance width of a code, in thousandths of text space. */
  width(code: number): number;
}

/** The parts of the graphics state text layout reads. */
export interface TextState {
  Tc: number;
  Tw: number;
  /** Horizontal scaling as a factor (Tz / 100). */
  Th: number;
  TL: number;
  Ts: number;
  font: string | null;
  Tfs: number;
}

export type TJElem = { kind: "str"; bytes: Uint8Array } | { kind: "num"; v: number };

const HEX = "0123456789abcdef";

/** Bytes of a literal string token `(…)` spanning [s, e). */
export function decodeLiteral(b: Uint8Array, s: number, e: number): Uint8Array {
  const out: number[] = [];
  for (let i = s + 1; i < e - 1; i++) {
    const c = b[i];
    if (c !== 92 /* \ */) {
      if (c === 13) { out.push(10); if (b[i + 1] === 10) i++; } // EOL in a string is \n
      else out.push(c);
      continue;
    }
    const n = b[++i];
    if (n === undefined) break;
    if (n >= 48 && n <= 55) {
      let v = n - 48;
      for (let k = 0; k < 2 && b[i + 1] >= 48 && b[i + 1] <= 55; k++) v = v * 8 + (b[++i] - 48);
      out.push(v & 255);
    } else if (n === 110) out.push(10);
    else if (n === 114) out.push(13);
    else if (n === 116) out.push(9);
    else if (n === 98) out.push(8);
    else if (n === 102) out.push(12);
    else if (n === 13) { if (b[i + 1] === 10) i++; } // line continuation
    else if (n === 10) { /* line continuation */ }
    else out.push(n); // \( \) \\ and anything else: the char itself
  }
  return Uint8Array.from(out);
}

/** Bytes of a hex string token `<…>` spanning [s, e). */
export function decodeHex(b: Uint8Array, s: number, e: number): Uint8Array {
  const digits: number[] = [];
  for (let i = s + 1; i < e - 1; i++) {
    const c = b[i] | 0x20;
    if (c >= 48 && c <= 57) digits.push(c - 48);
    else if (c >= 97 && c <= 102) digits.push(c - 87);
  }
  if (digits.length & 1) digits.push(0);
  const out = new Uint8Array(digits.length / 2);
  for (let k = 0; k < out.length; k++) out[k] = digits[2 * k] * 16 + digits[2 * k + 1];
  return out;
}

/** A string operand (literal or hex) spanning [s, e), or null. */
export function decodeString(b: Uint8Array, s: number, e: number): Uint8Array | null {
  if (b[s] === 40) return decodeLiteral(b, s, e);
  if (b[s] === 60 && b[s + 1] !== 60) return decodeHex(b, s, e);
  return null;
}

/** Elements of a TJ array token `[…]` spanning [s, e), or null if malformed. */
export function parseTJArray(b: Uint8Array, s: number, e: number): TJElem[] | null {
  const out: TJElem[] = [];
  let i = s + 1;
  while (i < e - 1) {
    const c = b[i];
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 0) { i++; continue; }
    if (c === 40) {
      let depth = 0, j = i;
      for (; j < e; j++) {
        if (b[j] === 92) { j++; continue; }
        if (b[j] === 40) depth++;
        else if (b[j] === 41 && --depth === 0) break;
      }
      out.push({ kind: "str", bytes: decodeLiteral(b, i, j + 1) });
      i = j + 1;
      continue;
    }
    if (c === 60) {
      let j = i + 1;
      while (j < e && b[j] !== 62) j++;
      out.push({ kind: "str", bytes: decodeHex(b, i, j + 1) });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < e - 1 && b[j] !== 32 && b[j] !== 9 && b[j] !== 10 && b[j] !== 13 && b[j] !== 40 && b[j] !== 60 && b[j] !== 93) j++;
    const v = Number(String.fromCharCode(...b.subarray(i, j)));
    if (!Number.isFinite(v)) return null;
    out.push({ kind: "num", v });
    i = j;
  }
  return out;
}

const fmt = (v: number): string => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
};

function toHex(bytes: number[]): string {
  let s = "<";
  for (const v of bytes) s += HEX[v >> 4] + HEX[v & 15];
  return s + ">";
}

/**
 * Lay out one show operation. `tm` is the text matrix before it; `ctm` maps
 * user space to the caller's pixel space; `erased(x, y)` answers for a glyph
 * origin in pixel space. Returns the text matrix after the operation and, when
 * any glyph was removed, the replacement TJ array (without the operator).
 */
export function showText(
  elems: TJElem[],
  ts: TextState,
  tm: Mat,
  ctm: Mat,
  font: FontMetrics,
  erased: (x: number, y: number) => boolean,
  /** Is there really a glyph at this origin (per the renderer)? When given, an
   *  operation whose layout disagrees with it anywhere is left untouched: a
   *  wrong width would shift every glyph after a removed one. */
  known?: (x: number, y: number) => boolean
): { tm: Mat; replacement: string | null; removed: number } {
  let trusted = true;
  let m: Mat = tm.slice() as Mat;
  const parts: string[] = [];
  let run: number[] = [];
  let pendingAdj = 0;
  let removed = 0;
  const flushRun = () => {
    if (pendingAdj) { parts.push(fmt(pendingAdj)); pendingAdj = 0; }
    if (run.length) { parts.push(toHex(run)); run = []; }
  };
  const advance = (tx: number) => {
    m = [m[0], m[1], m[2], m[3], m[4] + tx * m[0], m[5] + tx * m[1]];
  };
  for (const el of elems) {
    if (el.kind === "num") {
      if (run.length) flushRun();
      pendingAdj += el.v;
      advance(-(el.v / 1000) * ts.Tfs * ts.Th);
      continue;
    }
    const bpc = font.bytesPerCode;
    for (let k = 0; k + bpc <= el.bytes.length; k += bpc) {
      const code = bpc === 2 ? (el.bytes[k] << 8) | el.bytes[k + 1] : el.bytes[k];
      const w0 = font.width(code);
      const tw = bpc === 1 && code === 32 ? ts.Tw : 0;
      // Glyph origin: text-space (0, Ts) through Tm, then the CTM.
      const ux = ts.Ts * m[2] + m[4], uy = ts.Ts * m[3] + m[5];
      const px = ux * ctm[0] + uy * ctm[2] + ctm[4], py = ux * ctm[1] + uy * ctm[3] + ctm[5];
      if (known && !known(px, py)) trusted = false;
      if (ts.Tfs !== 0 && erased(px, py)) {
        if (run.length) flushRun();
        pendingAdj += -((w0 / 1000) * ts.Tfs + ts.Tc + tw) * 1000 / ts.Tfs;
        removed++;
      } else {
        if (pendingAdj) flushRun();
        for (let q = 0; q < bpc; q++) run.push(el.bytes[k + q]);
      }
      advance(((w0 / 1000) * ts.Tfs + ts.Tc + tw) * ts.Th);
    }
  }
  flushRun();
  if (!trusted) return { tm: m, replacement: null, removed: 0 };
  return { tm: m, replacement: removed ? `[${parts.join(" ")}]` : null, removed };
}
