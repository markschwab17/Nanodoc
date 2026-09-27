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
}

export type PathVerdict =
  | { kind: "keep" }
  | { kind: "erase" }
  | { kind: "rewrite"; construction: string };

export interface FilterHooks {
  decide(path: PaintedPath): PathVerdict;
  /** A `Do` at this CTM. Return a replacement XObject name, or null to leave it. */
  onDo?(name: string, ctm: Mat): string | null;
}

export interface FilterStats {
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

/** Index just past an inline image's data, given `i` just after the `ID` keyword. */
function skipInlineImageData(b: Uint8Array, i: number): number {
  const n = b.length;
  if (i < n && WS[b[i]]) i++; // the single whitespace after ID
  for (; i + 1 < n; i++) {
    if (b[i] === 69 && b[i + 1] === 73 && (i === 0 || WS[b[i - 1]]) && (i + 2 >= n || WS[b[i + 2]] || DELIM[b[i + 2]])) {
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
export function filterContentStream(bytes: Uint8Array, baseCtm: Mat, hooks: FilterHooks): FilterResult {
  const b = bytes;
  const n = b.length;
  const edits: Edit[] = [];
  const stats: FilterStats = { painted: 0, erased: 0, rewritten: 0, formsReplaced: 0 };

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
  const ctmStack: Mat[] = [];

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
    const verdict = hooks.decide({ subpaths, paint: op, clip, editable, ctm });
    if (verdict.kind === "erase") {
      edits.push({ start: tokStart, end: tokEnd, text: "n" });
      stats.erased++;
    } else if (verdict.kind === "rewrite" && editable && !clip && pathStart >= 0) {
      // `s` closed the last subpath itself; the rewrite carries its own closes.
      const paintOp = op === "s" ? "S" : op;
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
          ctmStack.push(ctm);
          break;
        case "Q":
          if (ctmStack.length) ctm = ctmStack.pop()!;
          break;
        case "cm": {
          const m = nums(6);
          if (m) ctm = matMul(m, ctm);
          break;
        }
        case "Do": {
          if (nOps >= 1 && opName[nOps - 1] != null && hooks.onDo) {
            const k = nOps - 1;
            const repl = hooks.onDo(opName[k]!, ctm);
            if (repl) {
              edits.push({ start: opStart[k], end: opEnd[k], text: `/${repl}` });
              stats.formsReplaced++;
            }
          }
          break;
        }
        case "BI": {
          // Inline image: skip its dictionary up to ID, then the raw data up to EI.
          nOps = 0;
          while (i < n) {
            while (i < n && WS[b[i]]) i++;
            if (b[i] === 73 && b[i + 1] === 68 && (i + 2 >= n || WS[b[i + 2]] || DELIM[b[i + 2]])) {
              i = skipInlineImageData(b, i + 2);
              break;
            }
            if (b[i] === 40) i = skipLiteralString(b, i);
            else if (b[i] === 60 || b[i] === 91) i = b[i] === 60 && b[i + 1] !== 60 ? skipHexString(b, i) : skipCompound(b, i);
            else { i++; while (i < n && !WS[b[i]] && !DELIM[b[i]]) i++; }
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
