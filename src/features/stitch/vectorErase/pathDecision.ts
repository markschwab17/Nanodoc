/**
 * Decide what an erase did to one painted path, from the erase mask.
 *
 * STROKED paths (the bulk of CAD linework) are judged per SEGMENT, and within a
 * segment per sample (~every 0.75 px along it): the runs of erased samples are
 * cut out and the rest is re-emitted, so a rectangle erase that crosses a
 * contour line removes exactly the stretch inside the rectangle, and an
 * element erase that took one leg of a polyline removes that leg only. Two
 * smoothing rules stop raster noise from cutting good lines:
 *   - an erased run shorter than MIN_RUN_PX with kept line on both sides is
 *     kept (a crossing with an erased line only blanks a pixel or two);
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
import { anyErasedIn, inkWeight, sampleState, STATE_ERASED, STATE_KEPT, STATE_NONE, type EraseMask } from "./eraseMask";

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
  const flipShort = (from: number, to: number, interiorOnly: boolean) => {
    const runs = toRuns();
    if (runs.length < 2) return;
    runs.forEach((r, k) => {
      if (interiorOnly && (k === 0 || k === runs.length - 1)) return;
      if (r.st === from && r.b - r.a < minRun) for (let i = r.a; i < r.b; i++) s[i] = to;
    });
  };
  // A short erased blip is a crossing only when kept line continues on BOTH
  // sides; at a segment's end it is the start of the erase (a rectangle edge a
  // pixel or two before the vertex) and goes.
  flipShort(STATE_ERASED, STATE_KEPT, true);
  flipShort(STATE_KEPT, STATE_ERASED, false);
  const out: Array<[number, number]> = [];
  for (const r of toRuns()) if (r.st === STATE_KEPT) out.push([r.a / n, r.b / n]);
  return out;
}

/**
 * Per-sample states along a segment. Each sample looks ACROSS the stroke too
 * (centre and ± half its width): a line half hidden under a later fill, whose
 * visible half the user erased, is then judged on the half that shows.
 * Each look weighs by how much ink the reference has there, so a stroke's dark
 * core outvotes the faint anti-aliased pixel beside it; ties go to KEPT.
 */
function segmentStates(seg: Seg, m: Mat, cx: Ctx, halfWidth: number): { states: Uint8Array; step: number } {
  const len = segPixelLength(seg, m);
  const count = Math.max(1, Math.min(MAX_SEG_SAMPLES, Math.ceil(len / STEP_PX)));
  const states = new Uint8Array(count);
  const a = tx(m, seg.p0[0], seg.p0[1]);
  const q = seg.pts;
  const b = seg.kind === "l" ? tx(m, q[0], q[1]) : null;
  const c1 = seg.kind === "c" ? tx(m, q[0], q[1]) : null;
  const c2 = seg.kind === "c" ? tx(m, q[2], q[3]) : null;
  const d = seg.kind === "c" ? tx(m, q[4], q[5]) : null;
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    let px: number, py: number, dx: number, dy: number;
    if (b) {
      px = a[0] + (b[0] - a[0]) * t; py = a[1] + (b[1] - a[1]) * t;
      dx = b[0] - a[0]; dy = b[1] - a[1];
    } else {
      const p = cubicAt(a, c1!, c2!, d!, t);
      px = p[0]; py = p[1];
      const u = 1 - t; // derivative of the cubic
      dx = 3 * (u * u * (c1![0] - a[0]) + 2 * u * t * (c2![0] - c1![0]) + t * t * (d![0] - c2![0]));
      dy = 3 * (u * u * (c1![1] - a[1]) + 2 * u * t * (c2![1] - c1![1]) + t * t * (d![1] - c2![1]));
    }
    const nl = Math.hypot(dx, dy) || 1;
    const nx = (-dy / nl) * halfWidth, ny = (dx / nl) * halfWidth;
    let k = 0, e = 0;
    // The centre may borrow its neighbours' vote (a hairline between pixel
    // centres); the side looks count only the pixel they land on.
    let looks: Array<[number, number, number]> = [
      [px, py, cx.sample(px, py)],
      [px + nx, py + ny, cx.raw(px + nx, py + ny)],
      [px - nx, py - ny, cx.raw(px - nx, py - ny)],
    ];
    // Hidden on every look: the occlusion index knows nothing of clipping or
    // transparency, so a later fill it believes covers the stroke may not.
    // Judge such a sample on what the page shows there instead.
    if (cx.occluded && looks.every(([lx, ly]) => cx.occluded!(lx, ly))) {
      looks = [
        [px, py, sampleState(cx.mask, px, py)],
        [px + nx, py + ny, rawState(cx.mask, px + nx, py + ny)],
        [px - nx, py - ny, rawState(cx.mask, px - nx, py - ny)],
      ];
    }
    for (const [sx, sy, st] of looks) {
      if (st === STATE_KEPT) k += inkWeight(cx.mask, sx, sy);
      else if (st === STATE_ERASED) e += inkWeight(cx.mask, sx, sy);
    }
    states[i] = e > k ? STATE_ERASED : k > 0 ? STATE_KEPT : 0;
    // Half of the stroke's own width erased, half kept (the flood fill took one
    // anti-aliased side): the stroke stays, and those erased pixels are its own
    // ambiguity, not residue for the verification to hold against the clean.
    if (e > 0 && states[i] === STATE_KEPT && cx.tolerate) {
      for (const [sx, sy, st] of looks) if (st === STATE_ERASED) cx.tolerate(sx, sy);
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
  // Partial: kept pieces become runs (one moveto each). On a closed subpath a run
  // that ends at the closing point and one that starts at the start point are
  // the same stretch of the ring, so they are joined through the start point.
  type Run = { start: Pt; ops: string[] };
  const runs: Run[] = [];
  let penAtEnd = false; // the pen sits at the end of the previous segment
  let firstAtOrigin = false;
  let lastAtEnd = false;
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    let continued = penAtEnd;
    penAtEnd = false;
    for (const [t0, t1] of pieces[k]) {
      const start = t0 <= 0 ? seg.p0 : pointAt(seg, t0);
      if (!(continued && t0 <= 0) || !runs.length) {
        runs.push({ start, ops: [] });
        if (runs.length === 1) firstAtOrigin = k === 0 && t0 <= 0;
      }
      continued = false;
      const run = runs[runs.length - 1];
      if (seg.kind === "l") {
        run.ops.push(`${P(t1 >= 1 ? [seg.pts[0], seg.pts[1]] : pointAt(seg, t1))} l`);
      } else {
        const q = seg.pts;
        const [, c1, c2, d] = subCubic(seg.p0, [q[0], q[1]], [q[2], q[3]], [q[4], q[5]], t0, t1);
        run.ops.push(`${P(c1)} ${P(c2)} ${P(d)} c`);
      }
      if (t1 >= 1) penAtEnd = true;
      lastAtEnd = k === segs.length - 1 && t1 >= 1;
    }
  }
  if (sp.closed && runs.length >= 2 && firstAtOrigin && lastAtEnd) {
    const first = runs.shift()!;
    runs[runs.length - 1].ops.push(...first.ops);
  }
  return runs.map((r) => `${P(r.start)} m ${r.ops.join(" ")}`).join(" ");
}

/** Winding-number point-in-polygon over flattened rings (pixel space). */
export function insideRings(rings: Pt[][], x: number, y: number, evenOdd: boolean): boolean {
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

export function flattenRing(sp: SubPath, m: Mat): Pt[] {
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

/** Pixels around a KEPT sample searched for an ERASED one before the sample
 *  counts as kept ink the erase never reached. */
export const FAR_PX = 3;

/** No ERASED pixel within FAR_PX of the point. */
function farFromErased(mask: EraseMask, x: number, y: number): boolean {
  const px = Math.floor(x), py = Math.floor(y);
  const { width: W, height: H, state } = mask;
  for (let yy = Math.max(0, py - FAR_PX); yy <= Math.min(H - 1, py + FAR_PX); yy++) {
    const row = yy * W;
    for (let xx = Math.max(0, px - FAR_PX); xx <= Math.min(W - 1, px + FAR_PX); xx++) {
      if (state[row + xx] === STATE_ERASED) return false;
    }
  }
  return true;
}

interface Tally { kept: number; erased: number; farKept: number }

/** Inked-sample tally of a set of subpaths (edges, plus interior for fills). */
function tallyUnit(subpaths: SubPath[], isFill: boolean, evenOdd: boolean, m: Mat, cx: Ctx, edges = true): Tally {
  const mask = cx.mask;
  const t: Tally = { kept: 0, erased: 0, farKept: 0 };
  const tally = (x: number, y: number) => {
    const st = cx.sample(x, y);
    if (st === STATE_KEPT) { t.kept++; if (farFromErased(mask, x, y)) t.farKept++; }
    else if (st === STATE_ERASED) t.erased++;
  };
  // Edge samples (every segment, subpaths closed as painted).
  const allSegs: Seg[] = [];
  if (edges) for (const sp of subpaths) allSegs.push(...segsOf(isFill ? { ...sp, closed: true } : sp));
  let total = 0;
  for (const s of allSegs) total += segPixelLength(s, m);
  const step = Math.max(STEP_PX, total / MAX_EDGE_SAMPLES);
  for (const s of allSegs) {
    const count = Math.max(1, Math.ceil(segPixelLength(s, m) / step));
    for (let i = 0; i < count; i++) {
      const p = pointAt(s, (i + 0.5) / count);
      const q = tx(m, p[0], p[1]);
      tally(q[0], q[1]);
    }
  }
  // Interior samples for fills.
  if (isFill) {
    const rings = subpaths.map((sp) => flattenRing(sp, m));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rings) for (const [x, y] of r) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const area = Math.max(1, (x1 - x0) * (y1 - y0));
    const gs = Math.max(1, Math.sqrt(area / MAX_INTERIOR_SAMPLES));
    for (let y = y0 + gs / 2; y < y1; y += gs) {
      for (let x = x0 + gs / 2; x < x1; x += gs) {
        if (insideRings(rings, x, y, evenOdd)) tally(x, y);
      }
    }
    // No visible interior at all (a white or covered fill): nothing votes, and
    // for a fill+stroke the edges belong to the outline — the fill stays.
  }
  return t;
}

const erasedByMajority = (t: Tally) => t.erased > 0 && t.erased >= ERASE_FRACTION * (t.erased + t.kept);

/** Far-kept samples a removed unit may carry before it counts as over-deletion:
 *  a couple of samples of rendering noise, or a sliver of a large shape. A
 *  whole kept part (one square of three) is far above this. */
export const FAR_KEPT_TOLERANCE = 0.05;
const farKeptOf = (t: Tally) => (t.farKept > Math.max(2, FAR_KEPT_TOLERANCE * (t.kept + t.erased)) ? t.farKept : 0);

/** Absolute pixel area enclosed by the path's flattened subpaths (shoelace). */
function pixelArea(subpaths: SubPath[], m: Mat): number {
  let area = 0;
  for (const sp of subpaths) {
    const r = flattenRing(sp, m);
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
    area += Math.abs(a) / 2;
  }
  return area;
}

/**
 * Groups of subpaths whose flattened extents overlap (union-find on padded
 * bboxes). A group can be dropped from a fill without changing how the others
 * fill — a hole and its outline always land in the same group. Exported for tests.
 */
export function overlapGroups(subpaths: SubPath[], m: Mat): number[][] {
  const boxes = subpaths.map((sp) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of flattenRing(sp, m)) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return [x0 - 1, y0 - 1, x1 + 1, y1 + 1];
  });
  const parent = subpaths.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  // Sweep by x0 so a sheet-sized fill of many small pieces stays near-linear.
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a][0] - boxes[b][0]);
  for (let a = 0; a < order.length; a++) {
    const i = order[a];
    for (let c = a + 1; c < order.length; c++) {
      const j = order[c];
      if (boxes[j][0] > boxes[i][2]) break;
      if (boxes[j][1] <= boxes[i][3] && boxes[i][1] <= boxes[j][3]) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, number[]>();
  subpaths.forEach((_, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  });
  return [...groups.values()].sort((a, b) => a[0] - b[0]);
}

/** Emit subpaths unchanged (fill rewrite: only whole groups are dropped). */
function emitWhole(sp: SubPath): string {
  const parts = [`${P([sp.x0, sp.y0])} m`];
  for (const s of sp.segs) parts.push(s.kind === "l" ? `${fmt(s.pts[0])} ${fmt(s.pts[1])} l` : `${s.pts.map(fmt).join(" ")} c`);
  if (sp.closed) parts.push("h");
  return parts.join(" ");
}

/**
 * Fills, clips and irregular paths: per overlap GROUP of subpaths when the path
 * may be rewritten (a fill of three separate squares loses only the erased
 * ones), else the whole path by majority. `farKept` reports kept ink, away from
 * any erase, inside whatever was removed — the caller treats it as a failure.
 */
/** Sutherland–Hodgman clip of a ring to an axis-aligned box. Pure. */
function clipRingToBox(ring: Pt[], x0: number, y0: number, x1: number, y1: number): Pt[] {
  let pts = ring;
  const edges: Array<[(p: Pt) => boolean, (a: Pt, b: Pt) => Pt]> = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1]],
  ];
  for (const [inside, cross] of edges) {
    const out: Pt[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[i];
      const ia = inside(a), ib = inside(b);
      if (ib) { if (!ia) out.push(cross(a, b)); out.push(b); }
      else if (ia) out.push(cross(a, b));
    }
    pts = out;
    if (!pts.length) break;
  }
  return pts;
}

function invert(m: Mat): Mat | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

/** Erased areas thinner than twice this (pixels) are lines drawn OVER a fill
 *  (erasing them reveals the fill), not a cut out of it. */
export const REGION_OPEN_PX = 2;
/** Every RGB component at least this: a white fill. */
const WHITE_COMPONENT = 0.95;
/** A fill inked over less than this share of its area is treated as white. */
const VISIBLE_FILL_SHARE = 0.3;

/**
 * Morphological opening (erode then dilate, square of radius r) of a 0/1
 * bitmap: removes everything thinner than 2r+1 and keeps areas intact.
 * Separable min/max passes. Pure; exported for tests.
 */
export function openBitmap(bits: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const pass = (src: Uint8Array, horizontal: boolean, keepIfAll: boolean): Uint8Array => {
    const out = new Uint8Array(w * h);
    const n = horizontal ? w : h, lines = horizontal ? h : w;
    for (let l = 0; l < lines; l++) {
      for (let i = 0; i < n; i++) {
        let v = keepIfAll ? 1 : 0;
        for (let k = i - r; k <= i + r; k++) {
          const b = k < 0 || k >= n ? 0 : src[horizontal ? l * w + k : k * w + l];
          if (keepIfAll && !b) { v = 0; break; }
          if (!keepIfAll && b) { v = 1; break; }
        }
        out[horizontal ? l * w + i : i * w + l] = v;
      }
    }
    return out;
  };
  const eroded = pass(pass(bits, true, true), false, true);
  return pass(pass(eroded, true, false), false, false);
}

/**
 * The 0-cells of a bitmap as disjoint rectangles [x0, y0, x1, y1) — row runs,
 * merged downwards while a run repeats exactly. Pure; exported for tests.
 */
export function complementRects(bits: Uint8Array, w: number, h: number): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  let active = new Map<string, number>(); // "x0,x1" → start row
  for (let y = 0; y <= h; y++) {
    const runs = new Map<string, number>();
    if (y < h) {
      for (let x = 0; x < w; ) {
        if (bits[y * w + x]) { x++; continue; }
        let e = x;
        while (e < w && !bits[y * w + e]) e++;
        const key = `${x},${e}`;
        runs.set(key, active.has(key) ? active.get(key)! : y);
        x = e;
      }
    }
    for (const [key, y0] of active) {
      if (!runs.has(key)) {
        const [x0, x1] = key.split(",").map(Number);
        out.push([x0, y0, x1, y]);
      }
    }
    active = runs;
  }
  return out;
}

/**
 * A fill only PART of which was erased: subtract the erased AREA (the mask's
 * erased pixels, opened so thin erased lines lying over the fill don't count)
 * exactly. The fill is clipped to each rectangle of what remains; clipping all
 * rings to the same convex box preserves every point's winding number, so
 * nonzero and even-odd fills (holes included) come out exactly as the original
 * minus the erased area, all in ONE path (no seams between the pieces). The cut
 * follows pixel edges; curves in a cut fill are flattened.
 *   none — no erased area in the fill (only thin lines over it): keep it whole
 *   all  — the erased area covers it: remove it
 *   cut  — the remaining construction
 */
/**
 * Scanline rasterisation of rings (pixel space) into a w×h window at (ix0, iy0):
 * 1 where the pixel centre is inside under the fill rule. Pure; exported for tests.
 */
export function rasterizeRings(rings: Pt[][], ix0: number, iy0: number, w: number, h: number, evenOdd: boolean): Uint8Array {
  const out = new Uint8Array(w * h);
  const xs: Array<[number, number]> = [];
  for (let y = 0; y < h; y++) {
    const cy = iy0 + y + 0.5;
    xs.length = 0;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yj <= cy) !== (yi <= cy)) xs.push([xj + ((cy - yj) * (xi - xj)) / (yi - yj), yi > yj ? 1 : -1]);
      }
    }
    if (!xs.length) continue;
    xs.sort((a, b) => a[0] - b[0]);
    let wind = 0;
    for (let k = 0; k < xs.length - 1; k++) {
      wind += evenOdd ? 1 : xs[k][1];
      const inside = evenOdd ? (wind & 1) === 1 : wind !== 0;
      if (!inside) continue;
      const a = Math.max(0, Math.ceil(xs[k][0] - ix0 - 0.5)), b = Math.min(w - 1, Math.floor(xs[k + 1][0] - ix0 - 0.5));
      for (let x = a; x <= b; x++) out[y * w + x] = 1;
    }
  }
  return out;
}

function regionCut(subpaths: SubPath[], m: Mat, mask: EraseMask, evenOdd: boolean): { kind: "none" | "all" } | { kind: "cut"; text: string } | null {
  const inv = invert(m);
  if (!inv) return null;
  const rings = subpaths.map((sp) => flattenRing(sp, m));
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const ring of rings) for (const [x, y] of ring) {
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
  }
  const pad = REGION_OPEN_PX + 1;
  const ix0 = Math.max(0, Math.floor(bx0) - pad), iy0 = Math.max(0, Math.floor(by0) - pad);
  const ix1 = Math.min(mask.width, Math.ceil(bx1) + pad), iy1 = Math.min(mask.height, Math.ceil(by1) + pad);
  const w = ix1 - ix0, h = iy1 - iy0;
  if (w <= 0 || h <= 0) return { kind: "none" };
  const bits = new Uint8Array(w * h);
  let any = false;
  for (let y = 0; y < h; y++) {
    const row = (iy0 + y) * mask.width;
    for (let x = 0; x < w; x++) if (mask.state[row + ix0 + x] === STATE_ERASED) { bits[y * w + x] = 1; any = true; }
  }
  if (!any) return { kind: "none" };
  // Outside the fill counts as "erased" for the opening, so an erased stretch
  // of a THIN fill (a wide line drawn as a polygon) survives it, while a thin
  // erased line lying across the fill's interior is still opened away.
  const erasedBits = bits.slice();
  const inside = rasterizeRings(rings, ix0, iy0, w, h, evenOdd);
  // Inside the fill but showing no ink (white text or a wipeout drawn over it):
  // part of what the erase took when enclosed by it.
  // Hidden parts count only for a fill that is itself visible (inked over a
  // real share of its area).
  const hidden = new Uint8Array(w * h);
  let insideN = 0, insideInk = 0;
  for (let y = 0; y < h; y++) {
    const row = (iy0 + y) * mask.width;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!inside[i]) continue;
      insideN++;
      if (mask.state[row + ix0 + x] === STATE_NONE) hidden[i] = 1;
      else insideInk++;
    }
  }
  // A white fill (a wipeout) is never cut: the ink over it is other paths, and
  // holes in it would only reveal what it hides.
  if (insideInk < VISIBLE_FILL_SHARE * insideN) return { kind: "none" };
  for (let i = 0; i < w * h; i++) if (!inside[i] || hidden[i]) bits[i] = 1;
  const region = openBitmap(bits, w, h, REGION_OPEN_PX);
  // Subtract erased (and enclosed hidden) pixels only: the outside helped the
  // opening, but its pixel squares straddle the fill's edge and would shave it.
  for (let i = 0; i < w * h; i++) region[i] &= erasedBits[i] | hidden[i];
  // Hidden areas count only where they join the erase (a wipeout elsewhere on
  // a partly erased fill is not part of it).
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  let anyInside = false;
  for (let i0 = 0; i0 < w * h; i0++) {
    if (!region[i0] || seen[i0]) continue;
    const comp: number[] = [];
    let touchesErase = false;
    stack.push(i0); seen[i0] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      if (erasedBits[i]) touchesErase = true;
      const x = i % w, y = (i - x) / w;
      if (x > 0 && region[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x + 1 < w && region[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && region[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
      if (y + 1 < h && region[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
    }
    if (!touchesErase) for (const i of comp) region[i] = 0;
    else if (!anyInside) anyInside = comp.some((i) => inside[i]);
  }
  if (!anyInside) return { kind: "none" };
  // Grow the region by a pixel into anything that is not KEPT ink: the fill's
  // anti-aliased rim is too faint to count as ink, and left outside the cut it
  // would survive as a hairline sliver along the erase.
  const grown = region.slice();
  for (let y = 0; y < h; y++) {
    const row = (iy0 + y) * mask.width;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (region[i] || mask.state[row + ix0 + x] === STATE_KEPT) continue;
      if ((x > 0 && region[i - 1]) || (x + 1 < w && region[i + 1]) || (y > 0 && region[i - w]) || (y + 1 < h && region[i + w])) grown[i] = 1;
    }
  }
  region.set(grown);
  const pieces: Pt[][] = [];
  for (const [x0, y0, x1, y1] of complementRects(region, w, h)) {
    // Rects touching the window edge extend past the fill so its edge is not cut.
    const X0 = x0 === 0 ? bx0 - 1 : ix0 + x0, X1 = x1 === w ? bx1 + 1 : ix0 + x1;
    const Y0 = y0 === 0 ? by0 - 1 : iy0 + y0, Y1 = y1 === h ? by1 + 1 : iy0 + y1;
    for (const ring of rings) {
      const c = clipRingToBox(ring, X0, Y0, X1, Y1);
      let a = 0;
      for (let i = 0, j = c.length - 1; i < c.length; j = i++) a += (c[j][0] + c[i][0]) * (c[j][1] - c[i][1]);
      if (c.length >= 3 && Math.abs(a) > 1e-6) pieces.push(c);
    }
  }
  if (!pieces.length) return { kind: "all" };
  return {
    kind: "cut",
    text: pieces.map((ring) => ring.map((p, i) => `${P(tx(inv, p[0], p[1]))} ${i ? "l" : "m"}`).join(" ") + " h").join(" "),
  };
}

/**
 * Fill verdicts per overlap group: untouched groups stay, fully erased groups
 * go, a partly erased group has the erased area subtracted (regionCut); a
 * group that cannot be rewritten (clip, irregular) goes or stays by majority,
 * reporting any kept ink it removes.
 */
function fillGroups(path: PaintedPath, cx: Ctx, splittable: boolean, edges: boolean) {
  const m = path.ctm;
  const isFill = path.paint !== "S" && path.paint !== "s";
  const evenOdd = path.paint.endsWith("*");
  const groups = splittable ? overlapGroups(path.subpaths, m) : [path.subpaths.map((_, i) => i)];
  const parts: Array<{ first: number; text: string }> = [];
  let farKept = 0;
  let changed = false;
  for (const g of groups) {
    const sps = g.map((i) => path.subpaths[i]);
    let t = tallyUnit(sps, isFill, evenOdd, m, cx, edges);
    // Every sample hidden by later paint (often an identical copy drawn on
    // top): judge on what the page shows, as for strokes.
    if (t.kept + t.erased === 0 && cx.occluded) t = tallyUnit(sps, isFill, evenOdd, m, { ...cx, occluded: undefined, sample: (x, y) => sampleState(cx.mask, x, y), raw: (x, y) => rawState(cx.mask, x, y) }, edges);
    if (t.erased === 0) { parts.push({ first: g[0], text: sps.map(emitWhole).join(" ") }); continue; }
    // Fully erased: gone. Anything with kept ink left is cut by the erased
    // area where the path can be rewritten; majority only as a last resort.
    // (Kept ink only as a fringe within FAR_PX of the erase — the flood fill's
    // anti-aliased rim — counts as fully erased: cutting would leave a sliver.)
    if (t.kept === 0 || (t.farKept === 0 && erasedByMajority(t))) { changed = true; continue; }
    const far = farKeptOf(t);
    const cut = path.editable && !path.clip ? regionCut(sps, m, cx.mask, evenOdd) : null;
    if (cut?.kind === "cut") { changed = true; parts.push({ first: g[0], text: cut.text }); continue; }
    if (cut?.kind === "all") { changed = true; continue; }
    if (cut?.kind === "none") { parts.push({ first: g[0], text: sps.map(emitWhole).join(" ") }); continue; }
    if (erasedByMajority(t)) { changed = true; farKept += far; continue; }
    parts.push({ first: g[0], text: sps.map(emitWhole).join(" ") });
  }
  parts.sort((a, b) => a.first - b.first);
  return { construction: parts.map((p) => p.text).join(" "), anyKept: parts.length > 0, farKept, changed };
}

function wholeVerdict(path: PaintedPath, cx: Ctx): PathVerdict {
  const isFill = path.paint !== "S" && path.paint !== "s";
  const splittable = isFill && path.editable && !path.clip && path.subpaths.length > 1;
  const f = fillGroups(path, cx, splittable, true);
  if (!f.changed) return { kind: "keep" };
  if (!f.anyKept) return { kind: "erase", farKept: f.farKept };
  if (!path.editable || path.clip) return { kind: "keep" }; // cannot rewrite: keep, let verification judge
  return { kind: "rewrite", construction: f.construction, farKept: f.farKept };
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

/** True when a sample point is hidden under something painted LATER. */
export type Occluded = (x: number, y: number) => boolean;

interface Ctx {
  mask: EraseMask;
  /** Mask state at a point, NONE where a later paint hides this path. */
  sample: (x: number, y: number) => number;
  /** As `sample`, without borrowing neighbours' votes for a blank pixel. */
  raw: (x: number, y: number) => number;
  tolerate?: (x: number, y: number) => void;
  occluded?: Occluded;
}

function rawState(mask: EraseMask, x: number, y: number): number {
  const px = Math.floor(x), py = Math.floor(y);
  if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) return 0;
  return mask.state[py * mask.width + px];
}

/**
 * The verdict for one painted path. `occluded` (optional) says where paint
 * drawn after this path covers it: those samples do not vote, so a path is
 * judged only where it could be seen — a fill mostly covered by a later fill,
 * whose visible strip the user erased, is judged on that strip.
 */
export function decidePath(
  path: PaintedPath,
  mask: EraseMask,
  occluded?: Occluded,
  /** Told about erased pixels a KEPT stroke owns half of (see segmentStates). */
  tolerate?: (x: number, y: number) => void
): PathVerdict {
  const cx: Ctx = {
    mask,
    tolerate,
    occluded,
    sample: occluded
      ? (x, y) => (occluded(x, y) ? 0 : sampleState(mask, x, y))
      : (x, y) => sampleState(mask, x, y),
    raw: (x, y) => {
      const px = Math.floor(x), py = Math.floor(y);
      if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) return 0;
      if (occluded && occluded(x, y)) return 0;
      return mask.state[py * mask.width + px];
    },
  };
  if (!path.subpaths.length) return { kind: "keep" };
  const bbox = pathBBox(path);
  const PAD = 2;
  if (!anyErasedIn(mask, Math.floor(bbox[0] - PAD), Math.floor(bbox[1] - PAD), Math.ceil(bbox[2] + PAD), Math.ceil(bbox[3] + PAD))) {
    return { kind: "keep" };
  }
  let strokeOnly = path.paint === "S" || path.paint === "s";
  // A white fill (a wipeout, a label's knockout) is never cut or removed: it
  // shows nothing itself, and removing it would only reveal what it hides.
  const whiteFill = !!path.fillRGB && path.fillRGB.every((c) => c >= WHITE_COMPONENT);
  if (!strokeOnly && whiteFill && /^[fF]/.test(path.paint)) return { kind: "keep" };
  // A fill with no area to speak of (CAD paints plain lines with `b`, and some
  // exporters emit text strokes as zero-area `f` slivers) is linework: cut it
  // like a stroke. `b`/`B` are repainted with S; a sliver `f` keeps its operator.
  let paintOverride: string | undefined;
  if (!strokeOnly && path.editable && !path.clip) {
    let len = 0;
    for (const sp of path.subpaths) for (const sg of segsOf(sp)) len += segPixelLength(sg, path.ctm);
    if (pixelArea(path.subpaths, path.ctm) < 0.05 * Math.max(1, len)) {
      strokeOnly = true;
      paintOverride = /^[bB]/.test(path.paint) ? "S" : path.paint;
    }
  }
  if (path.clip || !path.editable) return wholeVerdict(path, cx);
  if (!strokeOnly && /^[bB]/.test(path.paint)) return fillAndStrokeVerdict(path, cx, whiteFill);
  if (!strokeOnly) return wholeVerdict(path, cx);

  const cut = cutStroke(path, cx);
  if (cut.allFull) return { kind: "keep" };
  if (!cut.anyKept) return { kind: "erase", farKept: cut.farKept };
  return paintOverride
    ? { kind: "rewrite", construction: cut.out.join(" "), farKept: cut.farKept, paint: paintOverride }
    : { kind: "rewrite", construction: cut.out.join(" "), farKept: cut.farKept };
}

/** Per-segment cut of stroked subpaths (see the module comment). */
function cutStroke(path: PaintedPath, cx: Ctx) {
  const { subpaths, ctm: m } = path;
  // Half the stroke's width in pixels (a hairline draws one pixel).
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const halfWidth = Math.max(0.5, (path.lineWidth ?? 1) * scale / 2 - 0.25);
  let anyKept = false;
  let allFull = true;
  const farKept = 0;
  const out: string[] = [];
  for (const sp of subpaths) {
    const segs = segsOf(sp);
    if (!segs.length) {
      // A bare moveto (a round-cap dot at most): goes only if its point was erased.
      const p = tx(m, sp.x0, sp.y0);
      if (cx.sample(p[0], p[1]) === STATE_ERASED) { allFull = false; continue; }
      anyKept = true;
      out.push(`${P([sp.x0, sp.y0])} m${sp.closed ? " h" : ""}`);
      continue;
    }
    const pieces = segs.map((seg) => {
      const { states, step } = segmentStates(seg, m, cx, halfWidth);
      // Kept samples swept into a removed stretch are only the short (< MIN_RUN_PX)
      // runs the smoothing flips next to erased ones; the page verification's
      // lost-ink check covers them at pixel level, so no farKept is reported here.
      const kept = keptIntervals(states, Math.max(1, Math.round(MIN_RUN_PX / Math.max(step, 1e-6))));
      return kept;
    });
    const full = pieces.every((p) => p.length === 1 && p[0][0] === 0 && p[0][1] === 1);
    if (!full) allFull = false;
    if (pieces.some((p) => p.length > 0)) {
      anyKept = true;
      out.push(emitSubpath(sp, segs, pieces));
    }
  }
  return { anyKept, allFull, farKept, out };
}

/**
 * Fill+stroke (B, B*, b, b*): the fill and the outline are judged SEPARATELY —
 * a grey pad whose black outline was element-erased keeps its fill and loses
 * the outline. The fill is judged on its interior (the outline's pixels belong
 * to the stroke), per overlap group; the stroke is cut per segment. The result
 * is re-emitted as `<kept fill> f` followed by `<kept outline> S`.
 */
function fillAndStrokeVerdict(path: PaintedPath, cx: Ctx, whiteFill: boolean): PathVerdict {
  const evenOdd = path.paint.endsWith("*");
  const fillOp = evenOdd ? "f*" : "f";
  const fill = whiteFill
    ? { construction: path.subpaths.map(emitWhole).join(" "), anyKept: true, farKept: 0, changed: false }
    : fillGroups(path, cx, path.subpaths.length > 1, false);
  // The stroke of b/b* closes the last subpath (the filter already marked it).
  const stroke = cutStroke(path, cx);
  const farKept = fill.farKept + stroke.farKept;
  if (!fill.changed && stroke.allFull) return { kind: "keep" };
  if (!fill.anyKept && !stroke.anyKept) return { kind: "erase", farKept };
  if (!stroke.anyKept) return { kind: "rewrite", construction: fill.construction, farKept, paint: fillOp };
  const strokePart = stroke.out.join(" ");
  if (!fill.anyKept) return { kind: "rewrite", construction: strokePart, farKept, paint: "S" };
  return { kind: "rewrite", construction: `${fill.construction} ${fillOp} ${strokePart}`, farKept, paint: "S" };
}
