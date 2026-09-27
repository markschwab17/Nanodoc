/**
 * A byte-level PDF content-stream filter for path painting.
 *
 * Walks a content stream (tokenizer + the small slice of the graphics state that
 * decides where a path lands: q/Q/cm and Form XObjects), hands every PAINTED
 * path — with its geometry and the CTM mapping user space to the caller's
 * pixel space — to `hooks.decide`, and applies the verdict as a minimal byte
 * edit:
 *
 *   keep     nothing changes
 *   erase    the painting operator becomes `n` (construction kept, nothing drawn;
 *            a pending `W` clip still applies, so clipping is untouched)
 *   rewrite  the path's construction operators are replaced by the caller's
 *            (used to cut the erased stretches out of a stroked polyline)
 *
 * Everything else — text, images, shadings, marked content, colours, the
 * operator order — is copied through byte-for-byte. That is the point of doing
 * this here rather than re-serialising through mupdf's PDF writer device: the
 * result is the SAME page minus the erased linework, with its layers (OCGs),
 * Form XObjects, fonts and structure intact, which is what AGTEK reads.
 *
 * `Do` of a Form XObject is delegated to `hooks.onDo`, which may recurse with
 * this same function and return a replacement resource name (for a per-instance
 * edited copy of the form); the name token is rewritten in place.
 *
 * Pure: no mupdf, no DOM. Exported for tests.
 */

import { decodeString, parseTJArray, showText, type FontMetrics, type TextState, type TJElem } from "./textShow";

/** Affine matrix [a b c d e f], PDF row-vector convention: p' = p · M. */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** m · n — apply `m` first, then `n` (same as fz_concat / PDF `cm` order). */
export function matMul(m: readonly number[], n: readonly number[]): Mat {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

/** A path segment in the path's own user space. `l`: [x, y]; `c`: [x1 y1 x2 y2 x3 y3]. */
export interface PathSegment {
  kind: "l" | "c";
  pts: number[];
}

export interface SubPath {
  x0: number;
  y0: number;
  segs: PathSegment[];
  closed: boolean;
}

export interface PaintedPath {
  subpaths: SubPath[];
  /** The painting operator as written: S s f F f* B B* b b*. */
  paint: string;
  /** A `W`/`W*` preceded the paint: the path is also a clip and must survive. */
  clip: boolean;
  /** False when the construction was irregular (unknown operand counts, a
   *  non-path operator mid-path) — only keep/erase verdicts are honoured. */
  editable: boolean;
  /** User space → caller space (pixels). */
  ctm: Mat;
  /** Line width (`w`) in user space at paint time. */
  lineWidth: number;
  /** Fill colour as RGB 0..1 when it is a plain device colour, else null. */
  fillRGB?: number[] | null;
}

/** `farKept`: inked samples the erase never reached (> FAR_PX from any erased
 *  pixel) inside what the verdict removes — over-deletion evidence. */
export type PathVerdict =
  | { kind: "keep" }
  | { kind: "erase"; farKept?: number }
  | { kind: "rewrite"; construction: string; farKept?: number; paint?: string };

export interface FilterHooks {
  decide(path: PaintedPath): PathVerdict;
  /** A `Do` at this CTM. Return a replacement XObject name, "" to drop the
   *  draw, or null to leave it. */
  onDo?(name: string, ctm: Mat, lineWidth: number): string | null;
  /** Metrics of a font resource, or null when its glyphs cannot be laid out. */
  font?(name: string): FontMetrics | null;
  /** Was the glyph whose origin is at (x, y) in caller space erased? Text is
   *  only laid out when this is given. */
  eraseGlyph?(x: number, y: number): boolean;
  /** Is a glyph really drawn with its origin at (x, y)? Guards the layout. */
  knownGlyph?(x: number, y: number): boolean;
}

export interface FilterStats {
  /** Glyphs removed from text-showing operators. */
  glyphsRemoved: number;
  painted: number;
  erased: number;
  rewritten: number;
  formsReplaced: number;
}

export interface FilterResult {
  bytes: Uint8Array;
  changed: boolean;
  stats: FilterStats;
}

// ── lexer tables ────────────────────────────────────────────────────────────

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of "()<>[]{}/%") DELIM[c.charCodeAt(0)] = 1;

const PAINT_OPS = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"]);
const CONSTRUCT_OPS = new Set(["m", "l", "c", "v", "y", "h", "re"]);

const enc = new TextEncoder();

/** Parse a PDF numeric token; NaN if it is not one. */
function parseNumber(b: Uint8Array, s: number, e: number): number {
  let i = s;
  let neg = false;
  if (b[i] === 43 /* + */) i++;
  else if (b[i] === 45 /* - */) { neg = true; i++; }
  // Some producers write "--5"; tolerate a doubled sign like mupdf does.
  if (b[i] === 45) { neg = !neg; i++; }
  let v = 0;
  let digits = 0;
  while (i < e && b[i] >= 48 && b[i] <= 57) { v = v * 10 + (b[i] - 48); i++; digits++; }
  if (i < e && b[i] === 46 /* . */) {
    i++;
    let f = 0.1;
    while (i < e && b[i] >= 48 && b[i] <= 57) { v += (b[i] - 48) * f; f *= 0.1; i++; digits++; }
  }
  if (i !== e || digits === 0) return NaN;
  return neg ? -v : v;
}

function decodeName(b: Uint8Array, s: number, e: number): string {
  let out = "";
  for (let i = s; i < e; i++) {
    if (b[i] === 35 /* # */ && i + 2 < e) {
      const h = parseInt(String.fromCharCode(b[i + 1], b[i + 2]), 16);
      if (!Number.isNaN(h)) { out += String.fromCharCode(h); i += 2; continue; }
    }
    out += String.fromCharCode(b[i]);
  }
  return out;
}

/** Index just past a literal string starting at `i` (which points at `(`). */
function skipLiteralString(b: Uint8Array, i: number): number {
  let depth = 0;
  const n = b.length;
  for (; i < n; i++) {
    const c = b[i];
    if (c === 92 /* \ */) { i++; continue; }
    if (c === 40) depth++;
    else if (c === 41) { depth--; if (depth === 0) return i + 1; }
  }
  return n;
}

/** Index just past a hex string starting at `i` (which points at `<`). */
function skipHexString(b: Uint8Array, i: number): number {
  const n = b.length;
  for (i++; i < n; i++) if (b[i] === 62) return i + 1;
  return n;
}

/** Index just past an array or dictionary starting at `i` (`[` or `<<`). */
function skipCompound(b: Uint8Array, i: number): number {
  const n = b.length;
  let depth = 0;
  while (i < n) {
    const c = b[i];
    if (c === 40) { i = skipLiteralString(b, i); continue; }
    if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; }
    if (c === 91) { depth++; i++; }
    else if (c === 93) { depth--; i++; }
    else if (c === 60) {
      if (b[i + 1] === 60) { depth++; i += 2; }
      else { i = skipHexString(b, i); continue; }
    } else if (c === 62 && b[i + 1] === 62) { depth--; i += 2; }
    else i++;
    if (depth <= 0) return i;
  }
  return n;
}

/** True when the bytes after an `EI` candidate look like content again (ASCII
 *  operators/operands), not more binary image data. */
function looksLikeContentAfter(b: Uint8Array, i: number): boolean {
  const end = Math.min(b.length, i + 48);
  for (let k = i; k < end; k++) {
    const c = b[k];
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126)) continue;
    return false;
  }
  return true;
}

/**
 * Index just past an inline image's data, given `i` just after the `ID`
 * keyword. With a declared length (/L or /Length, PDF 2.0) the data is skipped
 * exactly; otherwise the first `EI` delimited by whitespace AND followed by
 * text-like bytes ends it — a bare " EI " inside compressed data is not enough.
 */
function skipInlineImageData(b: Uint8Array, i: number, declaredLength: number | null): number {
  const n = b.length;
  if (i < n && WS[b[i]]) i++; // the single whitespace after ID
  if (declaredLength != null && declaredLength >= 0 && i + declaredLength <= n) {
    let k = i + declaredLength;
    while (k < n && WS[b[k]]) k++;
    if (b[k] === 69 && b[k + 1] === 73) return k + 2;
  }
  for (; i + 1 < n; i++) {
    if (
      b[i] === 69 && b[i + 1] === 73 &&
      (i === 0 || WS[b[i - 1]]) &&
      (i + 2 >= n || WS[b[i + 2]] || DELIM[b[i + 2]]) &&
      looksLikeContentAfter(b, i + 2)
    ) {
      return i + 2;
    }
  }
  return n;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function applyEdits(b: Uint8Array, edits: Edit[]): Uint8Array {
  if (!edits.length) return b;
  edits.sort((a, c) => a.start - c.start);
  const parts: Uint8Array[] = [];
  let pos = 0;
  let total = 0;
  for (const e of edits) {
    if (e.start < pos) continue; // overlapping edit — the earlier one wins
    const before = b.subarray(pos, e.start);
    const repl = enc.encode(e.text);
    parts.push(before, repl);
    total += before.length + repl.length;
    pos = e.end;
  }
  const tail = b.subarray(pos);
  parts.push(tail);
  total += tail.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Filter one content stream. `baseCtm` maps this stream's initial user space to
 * the caller's space (for a page: page transform × raster scale; for a form:
 * form /Matrix × the CTM at its `Do`).
 */
export function filterContentStream(bytes: Uint8Array, baseCtm: Mat, hooks: FilterHooks, initialLineWidth = 1): FilterResult {
  const b = bytes;
  const n = b.length;
  const edits: Edit[] = [];
  const stats: FilterStats = { glyphsRemoved: 0, painted: 0, erased: 0, rewritten: 0, formsReplaced: 0 };

  // Operand stack for the operator being read.
  const opStart: number[] = [];
  const opEnd: number[] = [];
  const opNum: number[] = [];
  const opName: (string | null)[] = [];
  let nOps = 0;
  const pushOperand = (s: number, e: number, num: number, name: string | null) => {
    opStart[nOps] = s; opEnd[nOps] = e; opNum[nOps] = num; opName[nOps] = name; nOps++;
  };

  let ctm: Mat = baseCtm.slice() as Mat;
  const strElems = (k: number): TJElem[] | null => {
    const bytes = decodeString(b, opStart[k], opEnd[k]);
    return bytes ? [{ kind: "str", bytes }] : null;
  };
  let lineWidth = initialLineWidth;
  // Text state lives in the graphics state (saved by q/Q); the text matrices
  // do not. `tmKnown` drops when a show could not be laid out (unknown font),
  // until the next operator that sets Tm from Tlm.
  let ts: TextState = { Tc: 0, Tw: 0, Th: 1, TL: 0, Ts: 0, font: null, Tfs: 0 };
  let tm: Mat = [1, 0, 0, 1, 0, 0];
  let tlm: Mat = [1, 0, 0, 1, 0, 0];
  let tmKnown = true;
  const textOn = !!hooks.eraseGlyph;
  const fontCache = new Map<string, FontMetrics | null>();
  const fontOf = (name: string | null): FontMetrics | null => {
    if (!name || !hooks.font) return null;
    if (!fontCache.has(name)) fontCache.set(name, hooks.font(name));
    return fontCache.get(name)!;
  };
  // Non-stroking colour, as RGB when it is a plain device colour (null: a
  // pattern, separation or ICC space we do not evaluate).
  let fillRGB: number[] | null = [0, 0, 0];
  let fillCS = "DeviceGray";
  const ctmStack: Array<{ ctm: Mat; lineWidth: number; ts: TextState; fillRGB: number[] | null; fillCS: string }> = [];
  const deviceRGB = (cs: string, v: number[]): number[] | null => {
    if (cs === "DeviceGray" && v.length === 1) return [v[0], v[0], v[0]];
    if (cs === "DeviceRGB" && v.length === 3) return v;
    if (cs === "DeviceCMYK" && v.length === 4) return [0, 1, 2].map((k) => (1 - v[k]) * (1 - v[3]));
    return null;
  };
  const operandNums = (): number[] | null => {
    const out: number[] = [];
    for (let k = 0; k < nOps; k++) { if (Number.isNaN(opNum[k])) return null; out.push(opNum[k]); }
    return out;
  };
  /** Lay out a show operation; on removals, replace [start, end) with `prefix [..] TJ`. */
  const show = (elems: TJElem[] | null, start: number, end: number, prefix: string) => {
    const f = fontOf(ts.font);
    if (!elems || !f || !tmKnown) { tmKnown = false; return; }
    const r = showText(elems, ts, tm, ctm, f, hooks.eraseGlyph!, hooks.knownGlyph);
    tm = r.tm;
    if (r.replacement) {
      edits.push({ start, end, text: `${prefix}${r.replacement} TJ` });
      stats.glyphsRemoved += r.removed;
    }
  };
  const nextLine = (tx: number, ty: number) => {
    tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tx * tlm[0] + ty * tlm[2] + tlm[4], tx * tlm[1] + ty * tlm[3] + tlm[5]];
    tm = tlm.slice() as Mat;
    tmKnown = true;
  };

  // Current path under construction.
  let pathStart = -1;
  let subpaths: SubPath[] = [];
  let cur: SubPath | null = null;
  let cx = 0, cy = 0; // current point
  let sx = 0, sy = 0; // current subpath start (for h)
  let clip = false;
  let editable = true;
  let inPath = false;

  const resetPath = () => {
    pathStart = -1; subpaths = []; cur = null; clip = false; editable = true; inPath = false;
  };
  const ensureSub = () => {
    if (!cur) {
      cur = { x0: cx, y0: cy, segs: [], closed: false };
      subpaths.push(cur);
      sx = cx; sy = cy;
    }
    return cur;
  };
  const nums = (count: number): number[] | null => {
    if (nOps !== count) return null;
    const out: number[] = [];
    for (let k = 0; k < count; k++) {
      if (Number.isNaN(opNum[k])) return null;
      out.push(opNum[k]);
    }
    return out;
  };

  const handleConstruct = (op: string, tokStart: number) => {
    if (!inPath) {
      inPath = true;
      pathStart = nOps > 0 ? opStart[0] : tokStart;
    }
    switch (op) {
      case "m": {
        const a = nums(2);
        if (!a) { editable = false; return; }
        cx = a[0]; cy = a[1];
        cur = { x0: cx, y0: cy, segs: [], closed: false };
        subpaths.push(cur);
        sx = cx; sy = cy;
        return;
      }
      case "l": {
        const a = nums(2);
        if (!a) { editable = false; return; }
        ensureSub().segs.push({ kind: "l", pts: a });
        cx = a[0]; cy = a[1];
        return;
      }
      case "c": {
        const a = nums(6);
        if (!a) { editable = false; return; }
        ensureSub().segs.push({ kind: "c", pts: a });
        cx = a[4]; cy = a[5];
        return;
      }
      case "v": {
        const a = nums(4);
        if (!a) { editable = false; return; }
        ensureSub().segs.push({ kind: "c", pts: [cx, cy, a[0], a[1], a[2], a[3]] });
        cx = a[2]; cy = a[3];
        return;
      }
      case "y": {
        const a = nums(4);
        if (!a) { editable = false; return; }
        ensureSub().segs.push({ kind: "c", pts: [a[0], a[1], a[2], a[3], a[2], a[3]] });
        cx = a[2]; cy = a[3];
        return;
      }
      case "h": {
        if (cur) { cur.closed = true; }
        cx = sx; cy = sy;
        cur = null; // a following segment starts a new subpath at the start point
        return;
      }
      case "re": {
        const a = nums(4);
        if (!a) { editable = false; return; }
        const [x, y, w, h] = a;
        subpaths.push({
          x0: x, y0: y, closed: true,
          segs: [
            { kind: "l", pts: [x + w, y] },
            { kind: "l", pts: [x + w, y + h] },
            { kind: "l", pts: [x, y + h] },
          ],
        });
        cur = null;
        cx = sx = x; cy = sy = y;
        return;
      }
    }
  };

  const handlePaint = (op: string, tokStart: number, tokEnd: number) => {
    if (op === "n" || !inPath) { resetPath(); return; }
    if (op === "s" || op === "b" || op === "b*") {
      const last = subpaths[subpaths.length - 1];
      if (last) last.closed = true;
    }
    stats.painted++;
    const verdict = hooks.decide({ subpaths, paint: op, clip, editable, ctm, lineWidth, fillRGB });
    if (verdict.kind === "erase") {
      edits.push({ start: tokStart, end: tokEnd, text: "n" });
      stats.erased++;
    } else if (verdict.kind === "rewrite" && editable && !clip && pathStart >= 0) {
      // `s` closed the last subpath itself; the rewrite carries its own closes.
      const paintOp = verdict.paint ?? (op === "s" ? "S" : op);
      edits.push({ start: pathStart, end: tokEnd, text: `${verdict.construction} ${paintOp}` });
      stats.rewritten++;
    }
    resetPath();
  };

  let i = 0;
  while (i < n) {
    const c = b[i];
    if (WS[c]) { i++; continue; }
    if (c === 37 /* % */) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; }
    if (c === 40 /* ( */) { const s = i; i = skipLiteralString(b, i); pushOperand(s, i, NaN, null); continue; }
    if (c === 60 /* < */) {
      const s = i;
      i = b[i + 1] === 60 ? skipCompound(b, i) : skipHexString(b, i);
      pushOperand(s, i, NaN, null);
      continue;
    }
    if (c === 91 /* [ */) { const s = i; i = skipCompound(b, i); pushOperand(s, i, NaN, null); continue; }
    if (c === 47 /* / */) {
      const s = i;
      i++;
      while (i < n && !WS[b[i]] && !DELIM[b[i]]) i++;
      pushOperand(s, i, NaN, decodeName(b, s + 1, i));
      continue;
    }
    if (DELIM[c]) { i++; continue; } // stray ) ] > { } — ignore like a lenient reader

    // Regular token: a number or an operator.
    const s = i;
    while (i < n && !WS[b[i]] && !DELIM[b[i]]) i++;
    const first = b[s];
    if ((first >= 48 && first <= 57) || first === 43 || first === 45 || first === 46) {
      const v = parseNumber(b, s, i);
      if (!Number.isNaN(v)) { pushOperand(s, i, v, null); continue; }
    }
    const op = String.fromCharCode.apply(null, b.subarray(s, i) as unknown as number[]);
    if (op === "true" || op === "false" || op === "null") { pushOperand(s, i, NaN, null); continue; }

    if (CONSTRUCT_OPS.has(op)) {
      handleConstruct(op, s);
    } else if (op === "W" || op === "W*") {
      if (inPath) clip = true;
    } else if (PAINT_OPS.has(op)) {
      handlePaint(op, s, i);
    } else {
      if (inPath) editable = false; // illegal mid-path operator: whole verdicts only
      switch (op) {
        case "q":
          ctmStack.push({ ctm, lineWidth, ts: { ...ts }, fillRGB, fillCS });
          break;
        case "Q":
          if (ctmStack.length) ({ ctm, lineWidth, ts, fillRGB, fillCS } = ctmStack.pop()!);
          break;
        case "g": { const v = operandNums(); fillCS = "DeviceGray"; fillRGB = v ? deviceRGB("DeviceGray", v) : null; break; }
        case "rg": { const v = operandNums(); fillCS = "DeviceRGB"; fillRGB = v ? deviceRGB("DeviceRGB", v) : null; break; }
        case "k": { const v = operandNums(); fillCS = "DeviceCMYK"; fillRGB = v ? deviceRGB("DeviceCMYK", v) : null; break; }
        case "cs":
          fillCS = nOps === 1 && opName[0] != null ? opName[0] : "";
          // Each device space starts at black; anything else is not evaluated.
          fillRGB = fillCS === "DeviceGray" || fillCS === "DeviceRGB" || fillCS === "DeviceCMYK" ? [0, 0, 0] : null;
          break;
        case "sc":
        case "scn": { const v = operandNums(); fillRGB = v ? deviceRGB(fillCS, v) : null; break; }
        case "BT":
          tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0]; tmKnown = true;
          break;
        case "Tf":
          if (nOps >= 2 && opName[nOps - 2] != null && !Number.isNaN(opNum[nOps - 1])) { ts.font = opName[nOps - 2]; ts.Tfs = opNum[nOps - 1]; }
          break;
        case "Tc": { const a = nums(1); if (a) ts.Tc = a[0]; break; }
        case "Tw": { const a = nums(1); if (a) ts.Tw = a[0]; break; }
        case "Tz": { const a = nums(1); if (a) ts.Th = a[0] / 100; break; }
        case "TL": { const a = nums(1); if (a) ts.TL = a[0]; break; }
        case "Ts": { const a = nums(1); if (a) ts.Ts = a[0]; break; }
        case "Td": { const a = nums(2); if (a) nextLine(a[0], a[1]); break; }
        case "TD": { const a = nums(2); if (a) { ts.TL = -a[1]; nextLine(a[0], a[1]); } break; }
        case "T*": nextLine(0, -ts.TL); break;
        case "Tm": {
          const a = nums(6);
          if (a) { tlm = a as Mat; tm = a.slice() as Mat; tmKnown = true; }
          break;
        }
        case "Tj":
          if (textOn && nOps === 1) show(strElems(0), opStart[0], i, "");
          else tmKnown = false;
          break;
        case "'":
          nextLine(0, -ts.TL);
          if (textOn && nOps === 1) show(strElems(0), opStart[0], i, "T* ");
          else tmKnown = false;
          break;
        case "\"": {
          if (nOps === 3 && !Number.isNaN(opNum[0]) && !Number.isNaN(opNum[1])) {
            ts.Tw = opNum[0]; ts.Tc = opNum[1];
            nextLine(0, -ts.TL);
            if (textOn) {
              const aw = String.fromCharCode(...b.subarray(opStart[0], opEnd[0]));
              const ac = String.fromCharCode(...b.subarray(opStart[1], opEnd[1]));
              show(strElems(2), opStart[0], i, `${aw} Tw ${ac} Tc T* `);
            }
          } else tmKnown = false;
          break;
        }
        case "TJ":
          if (textOn && nOps === 1 && b[opStart[0]] === 91) show(parseTJArray(b, opStart[0], opEnd[0]), opStart[0], i, "");
          else tmKnown = false;
          break;
        case "cm": {
          const m = nums(6);
          if (m) ctm = matMul(m, ctm);
          break;
        }
        case "w": {
          const lw = nums(1);
          if (lw) lineWidth = lw[0];
          break;
        }
        case "Do": {
          if (nOps >= 1 && opName[nOps - 1] != null && hooks.onDo) {
            const k = nOps - 1;
            const repl = hooks.onDo(opName[k]!, ctm, lineWidth);
            if (repl === "") {
              // Drop the draw altogether (an image the erase took whole).
              edits.push({ start: opStart[k], end: i, text: "" });
              stats.erased++;
            } else if (repl) {
              edits.push({ start: opStart[k], end: opEnd[k], text: `/${repl}` });
              stats.formsReplaced++;
            }
          }
          break;
        }
        case "BI": {
          // Inline image: read its dictionary up to ID (noting a declared
          // /L or /Length), then skip the raw data up to EI.
          nOps = 0;
          let lastName: string | null = null;
          let declared: number | null = null;
          while (i < n) {
            while (i < n && WS[b[i]]) i++;
            if (b[i] === 73 && b[i + 1] === 68 && (i + 2 >= n || WS[b[i + 2]] || DELIM[b[i + 2]])) {
              i = skipInlineImageData(b, i + 2, declared);
              break;
            }
            if (b[i] === 40) { i = skipLiteralString(b, i); lastName = null; }
            else if (b[i] === 60 || b[i] === 91) { i = b[i] === 60 && b[i + 1] !== 60 ? skipHexString(b, i) : skipCompound(b, i); lastName = null; }
            else if (b[i] === 47) {
              const s0 = ++i;
              while (i < n && !WS[b[i]] && !DELIM[b[i]]) i++;
              lastName = decodeName(b, s0, i);
            } else {
              const s0 = i;
              i++;
              while (i < n && !WS[b[i]] && !DELIM[b[i]]) i++;
              if (lastName === "L" || lastName === "Length") {
                const v = parseNumber(b, s0, i);
                if (!Number.isNaN(v)) declared = v;
              }
              lastName = null;
            }
          }
          break;
        }
      }
    }
    nOps = 0;
  }

  const out = applyEdits(b, edits);
  return { bytes: out, changed: edits.length > 0, stats };
}
