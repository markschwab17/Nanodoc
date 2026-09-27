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
import { anyErasedIn, inkWeight, sampleState, STATE_ERASED, STATE_KEPT, type EraseMask } from "./eraseMask";

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
    const looks: Array<[number, number, number]> = [
      [px, py, cx.sample(px, py)],
      [px + nx, py + ny, cx.raw(px + nx, py + ny)],
      [px - nx, py - ny, cx.raw(px - nx, py - ny)],
    ];
    for (const [sx, sy, st] of looks) {
      if (st === STATE_KEPT) k += inkWeight(cx.mask, sx, sy);
      else if (st === STATE_ERASED) e += inkWeight(cx.mask, sx, sy);
    }
    states[i] = e > k ? STATE_ERASED : k > 0 ? STATE_KEPT : 0;
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
    // Too thin for an interior sample: fall back to its edges.
    if (!edges && t.kept + t.erased === 0) return tallyUnit(subpaths, isFill, evenOdd, m, cx, true);
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

/**
 * The rings with an axis-aligned rectangle cut out: each ring clipped to the
 * four disjoint strips around the rectangle. Clipping every ring to the same
 * convex strip keeps each point's winding number, so nonzero and even-odd
 * fills (holes included) come out exactly as the original minus the rectangle.
 * Pure; exported for tests.
 */
export function ringsMinusRect(rings: Pt[][], r: [number, number, number, number]): Pt[][] {
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const ring of rings) for (const [x, y] of ring) {
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
  }
  const strips: Array<[number, number, number, number]> = [
    [bx0 - 1, by0 - 1, r[0], by1 + 1],
    [r[2], by0 - 1, bx1 + 1, by1 + 1],
    [r[0], by0 - 1, r[2], r[1]],
    [r[0], r[3], r[2], by1 + 1],
  ];
  const out: Pt[][] = [];
  for (const [x0, y0, x1, y1] of strips) {
    if (!(x1 > x0 && y1 > y0)) continue;
    for (const ring of rings) {
      const c = clipRingToBox(ring, x0, y0, x1, y1);
      let a = 0;
      for (let i = 0, j = c.length - 1; i < c.length; j = i++) a += (c[j][0] + c[i][0]) * (c[j][1] - c[i][1]);
      if (c.length >= 3 && Math.abs(a) > 1e-6) out.push(c);
    }
  }
  return out;
}

function invert(m: Mat): Mat | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

/** Fraction of an erase's voting samples that must agree for a rectangle cut. */
const RECT_CUT_AGREEMENT = 0.95;
const MAX_RECT_SAMPLES = 4000;

/**
 * A fill only PART of which was erased, where the erased part is an
 * axis-aligned rectangle of it (the rectangle content-delete on an unrotated
 * sheet): return its construction with that rectangle cut out, or null when
 * the erased part is not such a rectangle. Curves are flattened in the cut.
 */
function rectCut(subpaths: SubPath[], m: Mat, cx: Ctx, evenOdd: boolean): string | null {
  const inv = invert(m);
  if (!inv) return null;
  const rings = subpaths.map((sp) => flattenRing(sp, m));
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const ring of rings) for (const [x, y] of ring) {
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
  }
  const gs = Math.max(0.75, Math.sqrt(Math.max(1, (bx1 - bx0) * (by1 - by0)) / MAX_RECT_SAMPLES));
  const samples: Array<[number, number, number]> = [];
  let ex0 = Infinity, ey0 = Infinity, ex1 = -Infinity, ey1 = -Infinity;
  for (let y = by0 + gs / 2; y < by1; y += gs) {
    for (let x = bx0 + gs / 2; x < bx1; x += gs) {
      if (!insideRings(rings, x, y, evenOdd)) continue;
      const st = cx.sample(x, y);
      if (st !== STATE_KEPT && st !== STATE_ERASED) continue;
      samples.push([x, y, st]);
      if (st === STATE_ERASED) {
        if (x < ex0) ex0 = x; if (x > ex1) ex1 = x; if (y < ey0) ey0 = y; if (y > ey1) ey1 = y;
      }
    }
  }
  if (ex0 === Infinity) return null;
  // The erased rectangle, snapped out past the fill's edge where it reaches to
  // within a sample step of it (the grid never samples the edge itself).
  const r: [number, number, number, number] = [
    ex0 - gs < bx0 ? bx0 - 1 : ex0 - gs / 2,
    ey0 - gs < by0 ? by0 - 1 : ey0 - gs / 2,
    ex1 + gs > bx1 ? bx1 + 1 : ex1 + gs / 2,
    ey1 + gs > by1 ? by1 + 1 : ey1 + gs / 2,
  ];
  let eIn = 0, kIn = 0, eOut = 0, kOut = 0;
  for (const [x, y, st] of samples) {
    const inR = x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
    if (inR) { if (st === STATE_ERASED) eIn++; else kIn++; }
    else if (st === STATE_ERASED) eOut++;
    else kOut++;
  }
  if (kOut === 0 || eIn < RECT_CUT_AGREEMENT * (eIn + kIn) || eOut > (1 - RECT_CUT_AGREEMENT) * (eOut + kOut)) return null;
  const pieces = ringsMinusRect(rings, r);
  if (!pieces.length) return null;
  return pieces
    .map((ring) => ring.map((p, i) => `${P(tx(inv, p[0], p[1]))} ${i ? "l" : "m"}`).join(" ") + " h")
    .join(" ");
}

/**
 * Fill verdicts per overlap group: untouched groups stay, fully erased groups
 * go, a group erased by an axis-aligned rectangle is cut by it; anything else
 * partly erased goes or stays by majority, reporting any kept ink it removes.
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
    const t = tallyUnit(sps, isFill, evenOdd, m, cx, edges);
    if (t.erased === 0) { parts.push({ first: g[0], text: sps.map(emitWhole).join(" ") }); continue; }
    const far = farKeptOf(t);
    if (erasedByMajority(t) && far === 0) { changed = true; continue; }
    const cut = path.editable && !path.clip ? rectCut(sps, m, cx, evenOdd) : null;
    if (cut != null) { changed = true; parts.push({ first: g[0], text: cut }); continue; }
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
}

/**
 * The verdict for one painted path. `occluded` (optional) says where paint
 * drawn after this path covers it: those samples do not vote, so a path is
 * judged only where it could be seen — a fill mostly covered by a later fill,
 * whose visible strip the user erased, is judged on that strip.
 */
export function decidePath(path: PaintedPath, mask: EraseMask, occluded?: Occluded): PathVerdict {
  const cx: Ctx = {
    mask,
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
  if (!strokeOnly && /^[bB]/.test(path.paint)) return fillAndStrokeVerdict(path, cx);
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
  const mask = cx.mask;
  // Half the stroke's width in pixels (a hairline draws one pixel).
  const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const halfWidth = Math.max(0.5, (path.lineWidth ?? 1) * scale / 2 - 0.25);
  let anyKept = false;
  let allFull = true;
  let farKept = 0;
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
      const kept = keptIntervals(states, Math.max(1, Math.round(MIN_RUN_PX / Math.max(step, 1e-6))));
      // Kept ink the smoothing swept into a removed stretch must lie by the erase.
      const n = states.length;
      for (let i = 0; i < n; i++) {
        if (states[i] !== STATE_KEPT) continue;
        const t = (i + 0.5) / n;
        if (kept.some(([a, b]) => t >= a && t <= b)) continue;
        const p = pointAt(seg, t);
        const q = tx(m, p[0], p[1]);
        if (farFromErased(mask, q[0], q[1])) farKept++;
      }
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
function fillAndStrokeVerdict(path: PaintedPath, cx: Ctx): PathVerdict {
  const evenOdd = path.paint.endsWith("*");
  const fillOp = evenOdd ? "f*" : "f";
  const fill = fillGroups(path, cx, path.subpaths.length > 1, false);
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
