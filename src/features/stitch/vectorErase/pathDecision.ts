/**
 * Decide what an erase did to one painted path, from the erase mask.
 *
 * STROKED paths (the bulk of CAD linework) are judged per SEGMENT, and within a
 * segment per sample (~every 0.75 px along it): the runs of erased samples are
 * cut out and the rest is re-emitted, so a rectangle erase that crosses a
 * contour line removes exactly the stretch inside the rectangle, and an
 * element erase that took one leg of a polyline removes that leg only. Two
 * smoothing rules stop raster noise from cutting good lines:
 *   - an erased run shorter than MIN_RUN_PX is kept (a crossing with an erased
 *     line only blanks a pixel or two of this one);
 *   - a kept run shorter than MIN_RUN_PX next to erased ones is erased (the
 *     anti-aliased fringe the flood fill leaves at a line's end).
 * Samples over blank pixels (dash gaps, clipped-away parts, white) carry no
 * vote and take their neighbours' state.
 *
 * FILLED paths, clip paths and irregular constructions are judged WHOLE: removed
 * when at least ERASE_FRACTION of their inked samples (edges + interior grid)
 * are erased. A fill can't be cut cleanly, so a fill straddling a rectangle
 * erase stays or goes by majority.
 *
 * Pure. Exported for tests.
 */
import type { Mat, PaintedPath, PathVerdict, SubPath } from "./contentFilter";
import { anyErasedIn, sampleState, STATE_ERASED, STATE_KEPT, type EraseMask } from "./eraseMask";

/** Spacing of samples along a segment, in pixels. */
export const STEP_PX = 0.75;
/** Shortest erased/kept run (pixels) that is believed rather than smoothed away. */
export const MIN_RUN_PX = 3;
/** A whole-verdict path goes when this fraction of its inked samples is erased. */
export const ERASE_FRACTION = 0.5;
const MAX_SEG_SAMPLES = 20000;
const MAX_EDGE_SAMPLES = 4000;
const MAX_INTERIOR_SAMPLES = 1600;
const CURVE_CHORDS = 8;

type Pt = [number, number];

const tx = (m: Mat, x: number, y: number): Pt => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];

/** A segment together with its start point (user space). */
interface Seg {
  p0: Pt;
  kind: "l" | "c";
  pts: number[];
}

function segsOf(sp: SubPath): Seg[] {
  const out: Seg[] = [];
  let p: Pt = [sp.x0, sp.y0];
  for (const s of sp.segs) {
    out.push({ p0: p, kind: s.kind, pts: s.pts });
    p = s.kind === "l" ? [s.pts[0], s.pts[1]] : [s.pts[4], s.pts[5]];
  }
  if (sp.closed && (p[0] !== sp.x0 || p[1] !== sp.y0)) {
    out.push({ p0: p, kind: "l", pts: [sp.x0, sp.y0] });
  }
  return out;
}

function cubicAt(p0: Pt, c1: Pt, c2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0], a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1]];
}

function pointAt(seg: Seg, t: number): Pt {
  if (seg.kind === "l") {
    return [seg.p0[0] + (seg.pts[0] - seg.p0[0]) * t, seg.p0[1] + (seg.pts[1] - seg.p0[1]) * t];
  }
  const q = seg.pts;
  return cubicAt(seg.p0, [q[0], q[1]], [q[2], q[3]], [q[4], q[5]], t);
}

/** Control points of the cubic restricted to [t0, t1] (de Casteljau, twice). */
export function subCubic(p0: Pt, c1: Pt, c2: Pt, p3: Pt, t0: number, t1: number): [Pt, Pt, Pt, Pt] {
  const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const splitLeft = (a: Pt, b: Pt, c: Pt, d: Pt, t: number): [Pt, Pt, Pt, Pt] => {
    const ab = lerp(a, b, t), bc = lerp(b, c, t), cd = lerp(c, d, t);
    const abc = lerp(ab, bc, t), bcd = lerp(bc, cd, t);
    return [a, ab, abc, lerp(abc, bcd, t)];
  };
  const splitRight = (a: Pt, b: Pt, c: Pt, d: Pt, t: number): [Pt, Pt, Pt, Pt] => {
    const ab = lerp(a, b, t), bc = lerp(b, c, t), cd = lerp(c, d, t);
    const abc = lerp(ab, bc, t), bcd = lerp(bc, cd, t);
    return [lerp(abc, bcd, t), bcd, cd, d];
  };
  const left = t1 >= 1 ? [p0, c1, c2, p3] as [Pt, Pt, Pt, Pt] : splitLeft(p0, c1, c2, p3, t1);
  if (t0 <= 0) return left;
  return splitRight(left[0], left[1], left[2], left[3], t0 / t1);
}

/** Pixel-space length estimate (curves: mean of chord and control polygon). */
function segPixelLength(seg: Seg, m: Mat): number {
  const a = tx(m, seg.p0[0], seg.p0[1]);
  if (seg.kind === "l") {
    const b = tx(m, seg.pts[0], seg.pts[1]);
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const q = seg.pts;
  const c1 = tx(m, q[0], q[1]), c2 = tx(m, q[2], q[3]), d = tx(m, q[4], q[5]);
  const poly = Math.hypot(c1[0] - a[0], c1[1] - a[1]) + Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) + Math.hypot(d[0] - c2[0], d[1] - c2[1]);
  return (poly + Math.hypot(d[0] - a[0], d[1] - a[1])) / 2;
}

/**
 * Per-sample states → the kept intervals of t in [0, 1], after the unknown
 * fill and the two smoothing passes. Pure; exported for tests.
 * `states`: 0 unknown, 1 kept, 2 erased. `minRun`: in samples.
 */
export function keptIntervals(states: ArrayLike<number>, minRun: number): Array<[number, number]> {
  const n = states.length;
  if (n === 0) return [[0, 1]];
  const s = Array.from(states);
  // Unknown samples inherit the previous known state; leading ones the first.
  let firstKnown = -1;
  for (let i = 0; i < n; i++) if (s[i] !== 0) { firstKnown = i; break; }
  if (firstKnown < 0) return [[0, 1]]; // nothing inked under it: leave it alone
  for (let i = 0; i < firstKnown; i++) s[i] = s[firstKnown];
  for (let i = firstKnown + 1; i < n; i++) if (s[i] === 0) s[i] = s[i - 1];

  type Run = { st: number; a: number; b: number }; // [a, b) in samples
  const toRuns = (): Run[] => {
    const runs: Run[] = [];
    for (let i = 0; i < n; ) {
      let j = i;
      while (j < n && s[j] === s[i]) j++;
      runs.push({ st: s[i], a: i, b: j });
      i = j;
    }
    return runs;
  };
  const flipShort = (from: number, to: number) => {
    const runs = toRuns();
    if (runs.length < 2) return;
    for (const r of runs) {
      if (r.st === from && r.b - r.a < minRun) for (let i = r.a; i < r.b; i++) s[i] = to;
    }
  };
  flipShort(STATE_ERASED, STATE_KEPT);
  flipShort(STATE_KEPT, STATE_ERASED);
  const out: Array<[number, number]> = [];
  for (const r of toRuns()) if (r.st === STATE_KEPT) out.push([r.a / n, r.b / n]);
  return out;
}

function segmentStates(seg: Seg, m: Mat, mask: EraseMask): { states: Uint8Array; step: number } {
  const len = segPixelLength(seg, m);
  const count = Math.max(1, Math.min(MAX_SEG_SAMPLES, Math.ceil(len / STEP_PX)));
  const states = new Uint8Array(count);
  const a = tx(m, seg.p0[0], seg.p0[1]);
  if (seg.kind === "l") {
    const b = tx(m, seg.pts[0], seg.pts[1]);
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      states[i] = sampleState(mask, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
    }
  } else {
    const q = seg.pts;
    const c1 = tx(m, q[0], q[1]), c2 = tx(m, q[2], q[3]), d = tx(m, q[4], q[5]);
    for (let i = 0; i < count; i++) {
      const p = cubicAt(a, c1, c2, d, (i + 0.5) / count);
      states[i] = sampleState(mask, p[0], p[1]);
    }
  }
  return { states, step: len / count };
}

const fmt = (v: number): string => {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? "0" : String(r);
};
const P = (p: Pt) => `${fmt(p[0])} ${fmt(p[1])}`;

/** Re-emit a subpath keeping only `pieces[k]` of each of its segments. */
function emitSubpath(sp: SubPath, segs: Seg[], pieces: Array<Array<[number, number]>>): string {
  const full = pieces.every((p) => p.length === 1 && p[0][0] === 0 && p[0][1] === 1);
  const parts: string[] = [];
  if (full) {
    parts.push(`${P([sp.x0, sp.y0])} m`);
    for (const s of sp.segs) parts.push(s.kind === "l" ? `${fmt(s.pts[0])} ${fmt(s.pts[1])} l` : `${s.pts.map(fmt).join(" ")} c`);
    if (sp.closed) parts.push("h");
    return parts.join(" ");
  }
  let penAtEnd = false; // the pen sits at the end of the previous segment
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    let continued = penAtEnd;
    penAtEnd = false;
    for (const [t0, t1] of pieces[k]) {
      const start = t0 <= 0 ? seg.p0 : pointAt(seg, t0);
      if (!(continued && t0 <= 0)) parts.push(`${P(start)} m`);
      continued = false;
      if (seg.kind === "l") {
        parts.push(`${P(t1 >= 1 ? [seg.pts[0], seg.pts[1]] : pointAt(seg, t1))} l`);
      } else {
        const q = seg.pts;
        const [, c1, c2, d] = subCubic(seg.p0, [q[0], q[1]], [q[2], q[3]], [q[4], q[5]], t0, t1);
        parts.push(`${P(c1)} ${P(c2)} ${P(d)} c`);
      }
      if (t1 >= 1) penAtEnd = true;
    }
  }
  return parts.join(" ");
}

/** Winding-number point-in-polygon over flattened rings (pixel space). */
function insideRings(rings: Pt[][], x: number, y: number, evenOdd: boolean): boolean {
  let wind = 0;
  let crossings = 0;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yj <= y) !== (yi <= y)) {
        const xc = xj + ((y - yj) * (xi - xj)) / (yi - yj);
        if (xc > x) {
          crossings++;
          wind += yi > yj ? 1 : -1;
        }
      }
    }
  }
  return evenOdd ? (crossings & 1) === 1 : wind !== 0;
}

function flattenRing(sp: SubPath, m: Mat): Pt[] {
  const ring: Pt[] = [tx(m, sp.x0, sp.y0)];
  let p: Pt = [sp.x0, sp.y0];
  for (const s of sp.segs) {
    if (s.kind === "l") {
      p = [s.pts[0], s.pts[1]];
      ring.push(tx(m, p[0], p[1]));
    } else {
      const q = s.pts;
      for (let k = 1; k <= CURVE_CHORDS; k++) {
        const c = cubicAt(p, [q[0], q[1]], [q[2], q[3]], [q[4], q[5]], k / CURVE_CHORDS);
        ring.push(tx(m, c[0], c[1]));
      }
      p = [q[4], q[5]];
    }
  }
  return ring;
}

/** Keep/erase for the whole path by the fraction of its inked samples erased. */
function wholeVerdict(path: PaintedPath, mask: EraseMask, bbox: [number, number, number, number]): PathVerdict {
  const m = path.ctm;
  const isFill = path.paint !== "S" && path.paint !== "s";
  let kept = 0, erased = 0;
  const tally = (st: number) => { if (st === STATE_KEPT) kept++; else if (st === STATE_ERASED) erased++; };

  // Edge samples (every segment, subpaths closed as painted).
  const allSegs: Seg[] = [];
  for (const sp of path.subpaths) allSegs.push(...segsOf(isFill ? { ...sp, closed: true } : sp));
  let total = 0;
  for (const s of allSegs) total += segPixelLength(s, m);
  const step = Math.max(STEP_PX, total / MAX_EDGE_SAMPLES);
  for (const s of allSegs) {
    const count = Math.max(1, Math.ceil(segPixelLength(s, m) / step));
    for (let i = 0; i < count; i++) {
      const p = pointAt(s, (i + 0.5) / count);
      const q = tx(m, p[0], p[1]);
      tally(sampleState(mask, q[0], q[1]));
    }
  }

  // Interior samples for fills.
  if (isFill) {
    const [x0, y0, x1, y1] = bbox;
    const area = Math.max(1, (x1 - x0) * (y1 - y0));
    const gs = Math.max(1, Math.sqrt(area / MAX_INTERIOR_SAMPLES));
    const rings = path.subpaths.map((sp) => flattenRing(sp, m));
    const evenOdd = path.paint.endsWith("*");
    for (let y = y0 + gs / 2; y < y1; y += gs) {
      for (let x = x0 + gs / 2; x < x1; x += gs) {
        if (insideRings(rings, x, y, evenOdd)) tally(sampleState(mask, x, y));
      }
    }
  }
  return erased > 0 && erased >= ERASE_FRACTION * (erased + kept) ? { kind: "erase" } : { kind: "keep" };
}

/** Pixel-space bbox of every point (control points included — conservative). */
function pathBBox(path: PaintedPath): [number, number, number, number] {
  const m = path.ctm;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => {
    const p = tx(m, x, y);
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  };
  for (const sp of path.subpaths) {
    add(sp.x0, sp.y0);
    for (const s of sp.segs) for (let k = 0; k < s.pts.length; k += 2) add(s.pts[k], s.pts[k + 1]);
  }
  return [x0, y0, x1, y1];
}

/** The verdict for one painted path. */
export function decidePath(path: PaintedPath, mask: EraseMask): PathVerdict {
  if (!path.subpaths.length) return { kind: "keep" };
  const bbox = pathBBox(path);
  const PAD = 2;
  if (!anyErasedIn(mask, Math.floor(bbox[0] - PAD), Math.floor(bbox[1] - PAD), Math.ceil(bbox[2] + PAD), Math.ceil(bbox[3] + PAD))) {
    return { kind: "keep" };
  }
  const strokeOnly = path.paint === "S" || path.paint === "s";
  if (!strokeOnly || path.clip || !path.editable) return wholeVerdict(path, mask, bbox);

  const m = path.ctm;
  let anyKept = false;
  let allFull = true;
  const out: string[] = [];
  for (const sp of path.subpaths) {
    const segs = segsOf(sp);
    if (!segs.length) {
      // A bare moveto (a round-cap dot at most): goes only if its point was erased.
      const p = tx(m, sp.x0, sp.y0);
      if (sampleState(mask, p[0], p[1]) === STATE_ERASED) { allFull = false; continue; }
      anyKept = true;
      out.push(`${P([sp.x0, sp.y0])} m${sp.closed ? " h" : ""}`);
      continue;
    }
    const pieces = segs.map((seg) => {
      const { states, step } = segmentStates(seg, m, mask);
      return keptIntervals(states, Math.max(1, Math.round(MIN_RUN_PX / Math.max(step, 1e-6))));
    });
    const full = pieces.every((p) => p.length === 1 && p[0][0] === 0 && p[0][1] === 1);
    if (!full) allFull = false;
    if (pieces.some((p) => p.length > 0)) {
      anyKept = true;
      out.push(emitSubpath(sp, segs, pieces));
    }
  }
  if (allFull) return { kind: "keep" };
  if (!anyKept) return { kind: "erase" };
  return { kind: "rewrite", construction: out.join(" ") };
}

