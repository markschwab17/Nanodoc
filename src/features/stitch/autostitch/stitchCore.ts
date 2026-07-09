/**
 * stitch-core — deterministic sheet-to-sheet placement primitives, factored out
 * of stitch2.js so they are testable and tag-agnostic. Zero models.
 *
 * World-feet frame (scale-aware). Convention for a pair delta d(i->j):
 *     d = posFt_j - posFt_i           (so posFt_j = posFt_i + d)
 * i.e. d is what you ADD to sheet i's origin to reach sheet j's origin.
 *
 * Channels:
 *   1. TOKEN VOTE  — exact shared SHX strings, 2-D translation histogram, with
 *      TITLE-BLOCK FURNITURE removed first (boilerplate text sitting at the same
 *      page-local position across the set drowns real drawing overlaps otherwise).
 *   2. MATCHLINE PRIOR — facing MATCHLINE labels anchor a coarse prior.
 *   3. SEGMENT VOTE (windowed) — (len,angle)-signatured strokes vote a translation,
 *      gated by a prior/token/edge window so periodic lot geometry can't alias.
 */

import { parseSheetRefs } from "./tokens";
import { extractPageLabel } from "./pageLabels";
import type { Label, Geom, PageExtract } from "./types";

export const FT = (pt: number, scale: number): number => (pt / 72) * scale; // pts -> world feet at sheet scale

export interface TokFeat { text: string; x: number; y: number; }
export interface SegFeat { mx: number; my: number; len: number; ang: number; }
export interface Vote { dx: number; dy: number; inliers: number; rmsFt: number; votes?: number; secondVotes?: number; tokens?: string[]; }

// ---------------------------------------------------------------- furniture
/**
 * Title-block furniture = a token VALUE that appears at (nearly) the same
 * page-LOCAL position on >= minSheets sheets. These are drawn at fixed page
 * coordinates (revision dates, file paths, RCE/TM numbers, north-symbol N) and
 * would otherwise pin a token histogram at (0,0). Returns a predicate over the
 * raw shxLabels of any sheet.
 */
export function buildFurnitureFilter(sheets: any[], minSheets: number): { size: number; isFurniture(l: Label): boolean } {
  const BIN = 40; // pt bins on the page (~0.55 in) — tolerant of tiny per-sheet jitter
  const seen = new Map<string, Set<any>>(); // `${text}@${gx},${gy}` -> Set(sheetKey)
  for (const s of sheets) {
    for (const l of s.raw.shxLabels) {
      if (!(l.text.length >= 6 && /\d/.test(l.text))) continue;
      const gx = Math.round((l.x + l.endX) / 2 / BIN);
      const gy = Math.round((l.y + l.endY) / 2 / BIN);
      const k = `${l.text}@${gx},${gy}`;
      (seen.get(k) || seen.set(k, new Set()).get(k)!).add(s.key);
    }
  }
  const furn = new Set<string>();
  for (const [k, set] of seen) if (set.size >= minSheets) furn.add(k);
  return {
    size: furn.size,
    isFurniture(l: Label) {
      const gx = Math.round((l.x + l.endX) / 2 / BIN);
      const gy = Math.round((l.y + l.endY) / 2 / BIN);
      return furn.has(`${l.text}@${gx},${gy}`);
    },
  };
}

/**
 * Geometry furniture = a path whose quantized signature (page-local bbox center +
 * size + point count) repeats at the SAME place on >= minSheets sheets. On a
 * multi-sheet set that's the identical boilerplate drawn at fixed page coords on
 * every sheet — the key map, legend/keynote symbols, title-block frame. Like
 * token furniture it would otherwise let segVote lock onto the repeated columns
 * instead of the real drawing overlap. Uses page-LOCAL position, so genuinely
 * shared drawing content (which sits at DIFFERENT page positions on two
 * overlapping sheets) is never flagged. Returns a predicate over a Geom.
 */
export function buildGeomFurnitureFilter(sheets: any[], minSheets: number): { size: number; isFurniture(g: Geom): boolean } {
  const sigOf = (g: Geom): string => {
    const pts = g.pts;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
    const q = (v: number) => Math.round(v / 8); // 8pt page bins
    return `${q((minX + maxX) / 2)},${q((minY + maxY) / 2)},${q(maxX - minX)},${q(maxY - minY)},${pts.length}`;
  };
  const seen = new Map<string, Set<any>>();
  for (const s of sheets) {
    const local = new Set<string>();
    for (const g of s.raw.geometry as Geom[]) {
      const sig = sigOf(g);
      if (!local.has(sig)) { local.add(sig); (seen.get(sig) || seen.set(sig, new Set()).get(sig)!).add(s.key); }
    }
  }
  const furn = new Set<string>();
  for (const [sig, set] of seen) if (set.size >= minSheets) furn.add(sig);
  return { size: furn.size, isFurniture: (g: Geom) => furn.has(sigOf(g)) };
}

// ---------------------------------------------------------------- features
export function tokenFeats(s: any, furn: { isFurniture(l: Label): boolean } | null): TokFeat[] {
  const counts = new Map<string, number>();
  for (const l of s.raw.shxLabels) counts.set(l.text, (counts.get(l.text) || 0) + 1);
  return s.raw.shxLabels
    .filter((l: Label) => l.text.length >= 6 && /\d/.test(l.text) && (counts.get(l.text) || 0) <= 2 && !(furn && furn.isFurniture(l)))
    .map((l: Label) => ({ text: l.text, x: FT((l.x + l.endX) / 2, s.scale), y: FT((l.y + l.endY) / 2, s.scale) }));
}
export function segFeats(s: any, minLenFt = 8): SegFeat[] {
  const out: SegFeat[] = [];
  for (const g of s.raw.geometry as Geom[]) {
    const pts = g.pts;
    if (!pts || pts.length < 2) continue;
    const n = pts.length - 1 + (g.closed ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      if (FT(len, s.scale) < minLenFt) continue;
      let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
      ang = ((ang % 180) + 180) % 180;
      out.push({
        mx: FT((a[0] + b[0]) / 2, s.scale), my: FT((a[1] + b[1]) / 2, s.scale),
        len: FT(len, s.scale), ang,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- channels
export function tokenVote(si: { tok: TokFeat[] }, sj: { tok: TokFeat[] }, { minInliers = 6, minMag = 15 }: { minInliers?: number; minMag?: number } = {}): Vote | null {
  const byText = new Map<string, TokFeat[]>();
  for (const f of sj.tok) (byText.get(f.text) || byText.set(f.text, []).get(f.text)!).push(f);
  const deltas: { dx: number; dy: number; text: string }[] = [];
  for (const a of si.tok) for (const b of byText.get(a.text) || []) deltas.push({ dx: a.x - b.x, dy: a.y - b.y, text: a.text });
  if (!deltas.length) return null;
  const BIN = 2; // ft
  const bins = new Map<string, number>();
  for (const d of deltas) {
    const k = `${Math.round(d.dx / BIN)},${Math.round(d.dy / BIN)}`;
    bins.set(k, (bins.get(k) || 0) + 1);
  }
  let best: { kx: number; ky: number; n9: number } | null = null;
  for (const [k] of bins) {
    const [kx, ky] = k.split(',').map(Number);
    let n9 = 0;
    for (let ux = -1; ux <= 1; ux++) for (let uy = -1; uy <= 1; uy++) n9 += bins.get(`${kx + ux},${ky + uy}`) || 0;
    if (!best || n9 > best.n9) best = { kx, ky, n9 };
  }
  if (!best) return null;
  const cx = best.kx * BIN, cy = best.ky * BIN;
  const inl = deltas.filter((d) => Math.hypot(d.dx - cx, d.dy - cy) <= 2 * BIN);
  if (inl.length < minInliers) return null;
  const mx = inl.reduce((s, d) => s + d.dx, 0) / inl.length;
  const my = inl.reduce((s, d) => s + d.dy, 0) / inl.length;
  if (Math.hypot(mx, my) < minMag) return null; // static furniture / self-overlap
  const rms = Math.sqrt(inl.reduce((s, d) => s + (d.dx - mx) ** 2 + (d.dy - my) ** 2, 0) / inl.length);
  return { dx: mx, dy: my, inliers: inl.length, rmsFt: rms, tokens: [...new Set(inl.map((d) => d.text))].slice(0, 4) };
}

export function matchlinePrior(si: any, sj: any): { dx: number; dy: number; sameSta: boolean } | null {
  const get = (s: any) => parseSheetRefs(s.raw.shxLabels, s.raw.view)
    .filter((r) => r.matchline && r.edge !== 'interior')
    .map((r) => ({ ...r, xf: FT(r.at.x, s.scale), yf: FT(r.at.y, s.scale) }));
  const mi = get(si), mj = get(sj);
  const OPP: Record<string, string> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
  for (const a of mi) {
    for (const b of mj) {
      if (OPP[a.edge] !== b.edge) continue;
      const sameSta = !!(a.station && b.station && a.station === b.station);
      return { dx: a.xf - b.xf, dy: a.yf - b.yf, sameSta };
    }
  }
  return null;
}

/**
 * Locate a matchline STROKE near a label's cross-coord (page pts): axis "h" → a
 * horizontal line, returns its y; "v" → vertical, returns its x. Matchlines are
 * usually DASHED, so we bin collinear segments by cross-coord and sum their
 * spans — the cross-coord whose dashes cover >= minTotalFrac of the perpendicular
 * sheet dimension is the matchline. Returns null if none.
 */
function findEdgeStroke(
  geometry: Geom[], axis: "h" | "v", cross: number,
  view: [number, number, number, number], band = 100, minTotalFrac = 0.3
): number | null {
  const [x0, y0, x1, y1] = view; const W = x1 - x0, H = y1 - y0;
  const perpDim = axis === "h" ? W : H;
  const BIN = 2;
  const spans = new Map<number, number>(); // rounded cross-coord -> summed dash span
  for (const g of geometry) {
    const pts = g.pts; if (!pts || pts.length < 2) continue;
    const n = pts.length - 1 + (g.closed ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const cc = axis === "h" ? (a[1] + b[1]) / 2 : (a[0] + b[0]) / 2;
      if (Math.abs((axis === "h" ? b[1] - a[1] : b[0] - a[0])) > 3) continue; // must be axis-aligned
      if (Math.abs(cc - cross) > band) continue;
      const span = axis === "h" ? Math.abs(b[0] - a[0]) : Math.abs(b[1] - a[1]);
      const k = Math.round(cc / BIN);
      spans.set(k, (spans.get(k) || 0) + span);
    }
  }
  let bestKey: number | null = null, bestTot = -1;
  for (const [k, tot] of spans) if (tot > bestTot) { bestTot = tot; bestKey = k; }
  return bestKey != null && bestTot >= minTotalFrac * perpDim ? bestKey * BIN : null;
}

/**
 * Precise matchline offset from the physical matchline STROKES, for two sheets
 * whose matchlines cross-reference each other. The stroke gives the PERPENDICULAR
 * component exactly (label positions do not — they sit at inconsistent offsets
 * from the line); the PARALLEL component is a coarse label estimate (segVote,
 * windowed tight on the perp axis, refines it). Returns { dx, dy, perp } where
 * `perp` is the precise axis ("y" for a top/bottom matchline, "x" for left/right).
 */
export function matchlineStrokePrior(si: any, sj: any): { dx: number; dy: number; perp: "x" | "y" } | null {
  const OPP: Record<string, string> = { left: "right", right: "left", top: "bottom", bottom: "top" };
  const refsI = parseSheetRefs(si.raw.shxLabels, si.raw.view).filter((r) => r.matchline && r.edge !== "interior");
  const refsJ = parseSheetRefs(sj.raw.shxLabels, sj.raw.view).filter((r) => r.matchline && r.edge !== "interior");
  const refs = (r: any, other: any) =>
    (r.sheet != null && r.sheet === other.no) ||
    (r.sheetCode && other.sheetCode && r.sheetCode.toUpperCase() === other.sheetCode.toUpperCase());
  for (const a of refsI) for (const b of refsJ) {
    if (OPP[a.edge] !== b.edge) continue;
    if (!(refs(a, sj) || refs(b, si))) continue; // only trust cross-referenced matchlines
    const horiz = a.edge === "top" || a.edge === "bottom";
    const axis = horiz ? "h" : "v";
    const as = findEdgeStroke(si.raw.geometry, axis, horiz ? a.at.y : a.at.x, si.raw.view);
    const bs = findEdgeStroke(sj.raw.geometry, axis, horiz ? b.at.y : b.at.x, sj.raw.view);
    if (as == null || bs == null) continue;
    return horiz
      ? { dx: FT(a.at.x, si.scale) - FT(b.at.x, sj.scale), dy: FT(as, si.scale) - FT(bs, sj.scale), perp: "y" }
      : { dx: FT(as, si.scale) - FT(bs, sj.scale), dy: FT(a.at.y, si.scale) - FT(b.at.y, sj.scale), perp: "x" };
  }
  return null;
}

export function segVote(si: any, sj: any, win: { x0: number; x1: number; y0: number; y1: number }): Vote | null {
  const idx = new Map<string, SegFeat[]>();
  const key = (s: SegFeat) => `${Math.round(s.len / 0.5)}:${Math.round(s.ang / 1.5)}`;
  for (const s of sj.seg as SegFeat[]) (idx.get(key(s)) || idx.set(key(s), []).get(key(s))!).push(s);
  const BIN = 1.5; // ft
  const bins = new Map<string, number>();
  const deltas: { dx: number; dy: number }[] = [];
  for (const a of si.seg as SegFeat[]) {
    const cand = idx.get(key(a)) || [];
    if (cand.length > 10) continue;
    for (const c of cand) {
      const dx = a.mx - c.mx, dy = a.my - c.my;
      if (dx < win.x0 || dx > win.x1 || dy < win.y0 || dy > win.y1) continue;
      deltas.push({ dx, dy });
      const k = `${Math.round(dx / BIN)},${Math.round(dy / BIN)}`;
      bins.set(k, (bins.get(k) || 0) + 1);
    }
  }
  let best: { kx: number; ky: number; n9: number; nSelf?: number } | null = null;
  for (const [k] of bins) {
    const [kx, ky] = k.split(',').map(Number);
    let n9 = 0;
    for (let ux = -1; ux <= 1; ux++) for (let uy = -1; uy <= 1; uy++) n9 += bins.get(`${kx + ux},${ky + uy}`) || 0;
    if (!best || n9 > best.n9) best = { kx, ky, n9, nSelf: bins.get(k) };
  }
  if (!best || best.n9 < 8) return null;
  const cx = best.kx * BIN, cy = best.ky * BIN;
  const inl = deltas.filter((d) => Math.hypot(d.dx - cx, d.dy - cy) <= 2 * BIN);
  const mx = inl.reduce((s, d) => s + d.dx, 0) / inl.length;
  const my = inl.reduce((s, d) => s + d.dy, 0) / inl.length;
  const rms = Math.sqrt(inl.reduce((s, d) => s + (d.dx - mx) ** 2 + (d.dy - my) ** 2, 0) / inl.length);
  let second = 0;
  for (const [k] of bins) {
    const [kx, ky] = k.split(',').map(Number);
    if (Math.hypot(kx * BIN - cx, ky * BIN - cy) <= 6 * BIN) continue;
    let n9 = 0;
    for (let ux = -1; ux <= 1; ux++) for (let uy = -1; uy <= 1; uy++) n9 += bins.get(`${kx + ux},${ky + uy}`) || 0;
    second = Math.max(second, n9);
  }
  return { dx: mx, dy: my, inliers: inl.length, rmsFt: rms, votes: best.n9, secondVotes: second };
}

// facing-edge windows in feet
export function windowFor(rel: string, span: number): { x0: number; x1: number; y0: number; y1: number } {
  const M: Record<string, { x0: number; x1: number; y0: number; y1: number }> = {
    right: { x0: 150, x1: span, y0: -150, y1: 150 },
    left: { x0: -span, x1: -150, y0: -150, y1: 150 },
    below: { x0: -200, x1: 200, y0: -span, y1: -100 },
    above: { x0: -200, x1: 200, y0: 100, y1: span },
  };
  return M[rel];
}

// ---------------------------------------------------------------- global solve
/**
 * Weighted least-squares placement over ALL pairwise translation constraints,
 * with iteratively-reweighted (Huber) robustness so a constraint that disagrees
 * with the globally-consistent layout (e.g. an aliased segment vote) is
 * automatically down-weighted instead of dragging a sheet off. Fixes rootKey at
 * the origin. Separable in x and y (translations only). Returns { pos, resid }.
 */
export function solveGlobal(
  keys: number[],
  rootKey: number,
  constraints: { i: number; j: number; dx: number; dy: number; weight: number }[],
  { huberFt = 2.0, iters = 8 }: { huberFt?: number; iters?: number } = {}
): { pos: Map<number, { x: number; y: number }>; resid: any[] } {
  const free = keys.filter((k) => k !== rootKey);
  const idx = new Map(free.map((k, i) => [k, i]));
  const N = free.length;
  const pos = new Map<number, { x: number; y: number }>(keys.map((k) => [k, { x: 0, y: 0 }]));
  if (!N) return { pos, resid: [] };

  const solveAxis = (get: (c: any) => number, w: (c: any) => number) => {
    // Build weighted Laplacian L (N x N) and rhs b, root pinned at 0.
    const L = Array.from({ length: N }, () => new Float64Array(N));
    const b = new Float64Array(N);
    for (const c of constraints) {
      const wc = w(c);
      if (wc <= 0) continue;
      const ii = idx.has(c.i) ? idx.get(c.i)! : -1;
      const jj = idx.has(c.j) ? idx.get(c.j)! : -1;
      const d = get(c); // observed x_j - x_i
      if (ii >= 0) { L[ii][ii] += wc; b[ii] -= wc * d; }
      if (jj >= 0) { L[jj][jj] += wc; b[jj] += wc * d; }
      if (ii >= 0 && jj >= 0) { L[ii][jj] -= wc; L[jj][ii] -= wc; }
    }
    // tiny anchor so isolated/degenerate nodes stay finite
    for (let i = 0; i < N; i++) L[i][i] += 1e-9;
    return gaussSolve(L, b);
  };
  const baseW = (c: any) => c.weight;
  let x = solveAxis((c) => c.dx, baseW);
  let y = solveAxis((c) => c.dy, baseW);
  const write = () => { for (const k of free) pos.set(k, { x: x[idx.get(k)!], y: y[idx.get(k)!] }); };
  write();

  // IRLS: Huber down-weighting by residual to the current solution
  for (let it = 0; it < iters; it++) {
    const rw = (c: any) => {
      const r = residual(c, pos);
      const h = r <= huberFt ? 1 : huberFt / r;
      return c.weight * h;
    };
    x = solveAxis((c) => c.dx, rw);
    y = solveAxis((c) => c.dy, rw);
    write();
  }
  const resid = constraints.map((c) => ({ i: c.i, j: c.j, residFt: residual(c, pos) }));
  return { pos, resid };
}
export function residual(c: { i: number; j: number; dx: number; dy: number }, pos: Map<number, { x: number; y: number }>): number {
  const pi = pos.get(c.i), pj = pos.get(c.j);
  if (!pi || !pj) return 0;
  return Math.hypot(pj.x - pi.x - c.dx, pj.y - pi.y - c.dy);
}
function gaussSolve(A: Float64Array[] | number[][], b: Float64Array): Float64Array {
  const n = b.length;
  const M = A.map((row, i) => Float64Array.from([...row, b[i]]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      if (!f) continue;
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = M[i][n] / (M[i][i] || 1e-12);
  return x;
}

// ---------------------------------------------------------------- driver

export type StitchMethod = "keymap" | "geometric" | "none";

export interface SheetInput { id: string; no: number; scale: number; view: [number, number, number, number]; extract: PageExtract; }
export interface PairReport { i: number; j: number; channel: string | null; conf: string | null; dxFt: number | null; dyFt: number | null; weight: number; residFt: number | null; }
export interface StitchResult { root: number; placements: Map<number, { x: number; y: number }>; worstResidFt: number; pairs: PairReport[]; method: StitchMethod; }

/**
 * FINE seam registration: the precise translation that best overlays sheet j's
 * dense linework onto sheet i's, searched in a TIGHT window around a coarse
 * offset d0 (from the global solve — already in the correct basin because the
 * solve is anchored by the precise token pairs). Matches (len,angle)-signatured
 * segments and votes their midpoint deltas into 0.25 ft bins, returning the
 * inlier-mean. This turns a token-poor seam (matchline-only, few-foot precision)
 * into a sub-foot lock; the inlier count is the confidence used to re-weight it.
 * A no-op when a sheet carries no geometry (returns null). Exported for tests.
 */
export function refineOffset(
  fineA: SegFeat[], fineB: SegFeat[], d0: { dx: number; dy: number },
  { window = 6, bin = 0.25, lenTol = 0.5, angTol = 1.5, minInliers = 12 } = {}
): { dx: number; dy: number; inliers: number; rms: number } | null {
  const idx = new Map<string, SegFeat[]>();
  const key = (s: SegFeat) => `${Math.round(s.len / lenTol)}:${Math.round(s.ang / angTol)}`;
  for (const s of fineB) (idx.get(key(s)) || idx.set(key(s), []).get(key(s))!).push(s);
  const bins = new Map<string, number>();
  const deltas: { dx: number; dy: number }[] = [];
  for (const a of fineA) {
    const cand = idx.get(key(a));
    if (!cand || cand.length > 25) continue; // skip signatures that alias everywhere
    for (const c of cand) {
      const dx = a.mx - c.mx, dy = a.my - c.my;
      if (Math.abs(dx - d0.dx) > window || Math.abs(dy - d0.dy) > window) continue;
      deltas.push({ dx, dy });
      const k = `${Math.round(dx / bin)},${Math.round(dy / bin)}`;
      bins.set(k, (bins.get(k) || 0) + 1);
    }
  }
  if (deltas.length < minInliers) return null;
  let best: { kx: number; ky: number; n9: number } | null = null;
  for (const [k] of bins) {
    const [kx, ky] = k.split(",").map(Number);
    let n9 = 0;
    for (let ux = -1; ux <= 1; ux++) for (let uy = -1; uy <= 1; uy++) n9 += bins.get(`${kx + ux},${ky + uy}`) || 0;
    if (!best || n9 > best.n9) best = { kx, ky, n9 };
  }
  if (!best) return null;
  const cx = best.kx * bin, cy = best.ky * bin;
  const inl = deltas.filter((d) => Math.hypot(d.dx - cx, d.dy - cy) <= 2 * bin);
  if (inl.length < minInliers) return null;
  const mx = inl.reduce((s, d) => s + d.dx, 0) / inl.length;
  const my = inl.reduce((s, d) => s + d.dy, 0) / inl.length;
  const rms = Math.sqrt(inl.reduce((s, d) => s + (d.dx - mx) ** 2 + (d.dy - my) ** 2, 0) / inl.length);
  return { dx: mx, dy: my, inliers: inl.length, rms };
}

/**
 * Band-seam matchline detector — the geometric adjacency signal for sheets whose
 * matchline references are unreadable (outlined to vector, no text) and share no
 * tokens. Adjacent TILES overlap only in a strip at their touching edges, so we
 * match the outer edge BANDS, NOT whole sheets: A's bottom band vs B's top band,
 * etc. (whole-sheet matching false-matches on repeated interior content — parking,
 * curbs, buildings). A true grid seam is AXIS-ALIGNED: a vertical seam shifts by
 * ≈ one sheet HEIGHT with ~0 horizontal offset; a horizontal seam by ≈ WIDTH with
 * ~0 vertical — which rejects the diagonal false matches. Requires boilerplate
 * already segment-filtered. Returns the best (most-inliers) seam, or null.
 * `s.seg` holds the filtered segFeats. Exported for tests.
 */
export function bandSeamPrior(si: any, sj: any): { dx: number; dy: number; inliers: number; rmsFt: number } | null {
  const BAND = 0.28, AX = 45; // edge-band fraction; axis-alignment tolerance (ft)
  const Wi = FT(si.view[2] - si.view[0], si.scale), Hi = FT(si.view[3] - si.view[1], si.scale);
  const Wj = FT(sj.view[2] - sj.view[0], sj.scale), Hj = FT(sj.view[3] - sj.view[1], sj.scale);
  const bnd = (seg: SegFeat[], W: number, H: number, which: string) => {
    const bx = BAND * W, by = BAND * H;
    return seg.filter((g) => which === "top" ? g.my < by : which === "bottom" ? g.my > H - by : which === "left" ? g.mx < bx : g.mx > W - bx);
  };
  const win = { x0: -Wi * 1.3, x1: Wi * 1.3, y0: -Hi * 1.3, y1: Hi * 1.3 };
  const trials: [SegFeat[], SegFeat[], "v" | "h", number][] = [
    [bnd(si.seg, Wi, Hi, "bottom"), bnd(sj.seg, Wj, Hj, "top"), "v", (Hi + Hj) / 2],
    [bnd(si.seg, Wi, Hi, "top"), bnd(sj.seg, Wj, Hj, "bottom"), "v", (Hi + Hj) / 2],
    [bnd(si.seg, Wi, Hi, "right"), bnd(sj.seg, Wj, Hj, "left"), "h", (Wi + Wj) / 2],
    [bnd(si.seg, Wi, Hi, "left"), bnd(sj.seg, Wj, Hj, "right"), "h", (Wi + Wj) / 2],
  ];
  let best: { dx: number; dy: number; inliers: number; rmsFt: number } | null = null;
  for (const [sa, sb, axis, dim] of trials) {
    if (sa.length < 8 || sb.length < 8) continue;
    const v = segVote({ seg: sa }, { seg: sb }, win);
    if (!v || v.inliers < 10 || (v.rmsFt ?? 9) >= 1.5) continue;
    const perp = axis === "v" ? Math.abs(v.dx) : Math.abs(v.dy);
    const par = axis === "v" ? Math.abs(v.dy) : Math.abs(v.dx);
    if (perp > AX || par < 0.5 * dim || par > 1.15 * dim) continue; // axis-aligned + abutting
    if (!best || v.inliers > best.inliers) best = { dx: v.dx, dy: v.dy, inliers: v.inliers, rmsFt: v.rmsFt ?? 0 };
  }
  return best;
}

interface DriverSheet {
  id: string; no: number; scale: number; view: [number, number, number, number];
  raw: { shxLabels: Label[]; labels: Label[]; geometry: Geom[]; view: [number, number, number, number] };
  key: number; tok?: TokFeat[]; seg?: SegFeat[]; sheetCode?: string | null; segFine?: SegFeat[];
}

export function stitchSheets(inputs: SheetInput[], grid?: Map<number, { col: number; row: number }>): StitchResult {
  const sheets: DriverSheet[] = inputs.map((s) => {
    // Channel-agnostic: use BOTH text channels (invisible SHX + visible). Some
    // sets are pure-SHX (Santee), some pure-visible (Rose Hill), some mixed — and
    // the invisible channel often carries stray single-glyph garbage that a
    // "shx.length < 8 ? labels" fallback fails to reject, hiding the good visible
    // labels AND the visible MATCHLINE/SEE-SHEET refs. Unioning is safe because
    // the consumers filter: tokenFeats requires len>=6 + a digit, parseSheetRefs
    // matches "SEE SHEET"/"MATCHLINE" regexes, and the furniture filter needs
    // len>=6 + a digit — single-char garbage survives none of these.
    const text = [...(s.extract.shxLabels || []), ...(s.extract.labels || [])];
    // Each sheet's OWN title-block discipline code (e.g. "C2.01"), used to resolve
    // discipline-code cross-references ("SEE SHEET C2.01") into adjacency edges.
    const label = extractPageLabel({ labels: s.extract.labels || [], shxLabels: s.extract.shxLabels || [], view: s.view });
    return {
      id: s.id, no: s.no, scale: s.scale, view: s.view,
      raw: { shxLabels: text, labels: s.extract.labels || [], geometry: s.extract.geometry || [], view: s.view },
      key: s.no, sheetCode: label.sheetCode,
    };
  });
  const byNo = new Map(sheets.map((s) => [s.no, s]));
  const keys = sheets.map((s) => s.no);
  // sheet-code -> sheet no, for resolving "SEE SHEET C2.01" cross-references.
  const codeToNo = new Map<string, number>();
  for (const s of sheets) if (s.sheetCode) codeToNo.set(s.sheetCode.toUpperCase(), s.no);

  const FURN_MIN = Math.max(2, Math.min(3, sheets.length));
  const furn = buildFurnitureFilter(sheets, FURN_MIN);
  // Drop repeated boilerplate GEOMETRY (identical on ≥25% of a 4+ sheet set: key
  // map, legend, title-block frame) before feature extraction — it makes segVote
  // lock onto the identical columns instead of the real drawing overlap, and it
  // ~halves the geometry on boilerplate-heavy sets.
  if (sheets.length >= 4) {
    const gfurn = buildGeomFurnitureFilter(sheets, Math.max(3, Math.ceil(0.25 * sheets.length)));
    if (gfurn.size) for (const s of sheets) s.raw.geometry = (s.raw.geometry as Geom[]).filter((g) => !gfurn.isFurniture(g));
  }
  for (const s of sheets) { s.tok = tokenFeats(s, furn); s.seg = segFeats(s); }
  // Segment-level boilerplate filter: a segment at the same feet-position on
  // >= min sheets is repeated title-block / notes / legend / key-map geometry.
  // It makes segVote lock onto the identical columns (offset ≈ 0) instead of the
  // drawing overlap. The path-level filter above misses it — the boilerplate is
  // drawn as differently-grouped paths whose SEGMENTS still coincide. This is what
  // lets two sheets stitch on geometry alone (e.g. matchline refs outlined to vector).
  if (sheets.length >= 2) {
    const segSig = (s: SegFeat) => `${Math.round(s.mx / 5)},${Math.round(s.my / 5)},${Math.round(s.len / 3)},${Math.round(s.ang / 3)}`;
    const cnt = new Map<string, number>();
    for (const s of sheets) { const seen = new Set<string>(); for (const seg of s.seg!) { const sig = segSig(seg); if (!seen.has(sig)) { seen.add(sig); cnt.set(sig, (cnt.get(sig) || 0) + 1); } } }
    const min = sheets.length <= 3 ? sheets.length : Math.max(3, Math.ceil(0.4 * sheets.length));
    const boiler = new Set([...cnt].filter(([, c]) => c >= min).map(([sig]) => sig));
    if (boiler.size) for (const s of sheets) s.seg = s.seg!.filter((seg) => !boiler.has(segSig(seg)));
  }

  // ── KEY-MAP GRID PLACEMENT ──────────────────────────────────────────────────
  // When the caller supplies the site grid (from each sheet's key map — see
  // keymap.ts), the topology is KNOWN. The drawing geometry is too self-similar to
  // pin per-pair offsets, but the grid is REGULAR, so we estimate one column and
  // one row spacing from the clean abutting seams and place every sheet at
  // (col·sx, row·sy). This resolves sets whose matchline refs are outlined text.
  if (grid && grid.size >= 2) {
    const byNoG = new Map(sheets.map((s) => [s.no, s]));
    const W = FT(sheets[0].view[2] - sheets[0].view[0], sheets[0].scale);
    const H = FT(sheets[0].view[3] - sheets[0].view[1], sheets[0].scale);
    // strongest abutting, perpendicular-constrained seam between two neighbours
    const seamOffset = (a: DriverSheet, b: DriverSheet, axis: "H" | "V"): number | null => {
      const wins = axis === "H"
        ? [{ x0: 0.35 * W, x1: 1.1 * W, y0: -120, y1: 120 }, { x0: -1.1 * W, x1: -0.35 * W, y0: -120, y1: 120 }]
        : [{ x0: -120, x1: 120, y0: 0.35 * H, y1: 1.1 * H }, { x0: -120, x1: 120, y0: -1.1 * H, y1: -0.35 * H }];
      let best: Vote | null = null;
      for (const w of wins) { const v = segVote(a, b, w); if (v && (!best || v.inliers > best.inliers)) best = v; }
      return best ? (axis === "H" ? best.dx : best.dy) : null;
    };
    const hx: number[] = [], vy: number[] = [];
    for (const [ni, gi] of grid) for (const [nj, gj] of grid) {
      const a = byNoG.get(ni), b = byNoG.get(nj);
      if (!a || !b) continue;
      if (gj.col === gi.col + 1 && gj.row === gi.row) { const d = seamOffset(a, b, "H"); if (d != null) hx.push(d); }
      else if (gj.row === gi.row + 1 && gj.col === gi.col) { const d = seamOffset(a, b, "V"); if (d != null) vy.push(d); }
    }
    // sign-consistent median (a few pairs mismatch on the self-similar interior).
    const consensus = (vals: number[], fallback: number): number => {
      if (!vals.length) return fallback;
      const pos = vals.filter((v) => v > 0), neg = vals.filter((v) => v < 0);
      const side = pos.length >= neg.length ? pos : neg;
      const s = side.sort((a, b) => a - b);
      return s.length ? s[Math.floor(s.length / 2)] : fallback;
    };
    const sx = consensus(hx, 0.82 * W), sy = consensus(vy, 0.82 * H);
    const placements = new Map<number, { x: number; y: number }>();
    for (const [ni, g] of grid) if (byNoG.has(ni)) placements.set(ni, { x: g.col * sx, y: g.row * sy });
    const rootKey = [...grid.keys()].find((k) => byNoG.has(k)) ?? sheets[0].no;
    return { root: rootKey, placements, worstResidFt: 0, pairs: [], method: "keymap" };
  }

  const EDGE2REL: Record<string, string> = { left: "left", right: "right", top: "above", bottom: "below" };
  const OPPREL: Record<string, string> = { left: "right", right: "left", above: "below", below: "above" };
  const relOf = new Map<string, string>();
  for (const s of sheets) {
    const refs = parseSheetRefs(s.raw.shxLabels, s.raw.view).filter((r) => r.edge !== "interior");
    for (const r of refs) {
      // resolve the neighbor: numeric sheet number, else discipline-code -> that page.
      let target: number | null = null;
      if (r.sheet != null && byNo.has(r.sheet) && r.sheet !== s.no) target = r.sheet;
      else if (r.sheetCode) {
        const t = codeToNo.get(r.sheetCode.toUpperCase());
        if (t != null && t !== s.no) target = t;
      }
      if (target != null && !relOf.has(`${s.no}-${target}`)) relOf.set(`${s.no}-${target}`, EDGE2REL[r.edge]);
    }
  }
  const relFor = (ni: number, nj: number): string | null =>
    relOf.get(`${ni}-${nj}`) ?? (relOf.has(`${nj}-${ni}`) ? OPPREL[relOf.get(`${nj}-${ni}`)!] : null);

  const tv = (si: DriverSheet, sj: DriverSheet) => tokenVote({ tok: si.tok! }, { tok: sj.tok! }, { minInliers: 5 });

  const pairKeys = new Set<string>();
  for (const k of relOf.keys()) { const [a, b] = k.split("-").map(Number); pairKeys.add(a < b ? `${a}-${b}` : `${b}-${a}`); }
  for (let a = 0; a < sheets.length; a++) for (let b = a + 1; b < sheets.length; b++) {
    const si = sheets[a], sj = sheets[b];
    const span = Math.max(FT(si.view[2] - si.view[0], si.scale), FT(sj.view[2] - sj.view[0], sj.scale)) * 1.4;
    const t = tv(si, sj);
    if (t && Math.hypot(t.dx, t.dy) < span) { pairKeys.add(`${si.no}-${sj.no}`); continue; }
    // Facing MATCHLINE labels are also candidates. Match-lined sets often
    // reference neighbors by discipline code ("MATCHLINE (SEE SHEET C2.01)"),
    // which the numeric SEE-SHEET adjacency can't resolve — but matchlinePrior
    // pairs facing labels directly, and the windowed segment vote gates out
    // spurious (non-adjacent) matchline pairs whose geometry doesn't agree.
    if (matchlinePrior(si, sj)) pairKeys.add(`${si.no}-${sj.no}`);
  }

  // Band-seam matchline detector for sheets with no token/matchline candidate
  // (matchline refs outlined to vector). bandSeamPrior matches axis-aligned edge
  // BANDS — interior repeats (parking, curbs) can't false-match. Each orphan adopts
  // only its STRONGEST seam: edge content is itself somewhat repetitive across a
  // plan set, so accepting every seam pollutes the solve; the best-per-orphan keeps
  // the graph clean. The constraint loop uses the seam offset directly.
  {
    const paired = new Set<number>();
    for (const k of pairKeys) { const [a, b] = k.split("-").map(Number); paired.add(a); paired.add(b); }
    for (const si of sheets.filter((s) => !paired.has(s.no))) {
      let best: { key: string; inl: number } | null = null;
      for (const sj of sheets) {
        if (sj.no === si.no) continue;
        const key = si.no < sj.no ? `${si.no}-${sj.no}` : `${sj.no}-${si.no}`;
        if (pairKeys.has(key)) continue;
        const seam = bandSeamPrior(si, sj);
        if (seam && (!best || seam.inliers > best.inl)) best = { key, inl: seam.inliers };
      }
      if (best) pairKeys.add(best.key);
    }
  }

  const pairs: (PairReport & { _final?: { dx: number; dy: number } })[] = [];
  for (const uk of pairKeys) {
    const [ni, nj] = uk.split("-").map(Number);
    const si = byNo.get(ni)!, sj = byNo.get(nj)!;
    const span = Math.max(FT(si.view[2] - si.view[0], si.scale), FT(sj.view[2] - sj.view[0], sj.scale));
    const rel = relFor(ni, nj);
    const tok = tv(si, sj);
    const stroke = matchlineStrokePrior(si, sj);
    const prior = matchlinePrior(si, sj);
    const seam = bandSeamPrior(si, sj);
    // segVote only with a prior window (stroke/matchline/token/reference). Pure-
    // geometry pairs use the band-seam match instead of a full-window vote, which
    // would false-match repeated interior content.
    let seg: Vote | null = null;
    if (stroke) {
      // Perp axis is precise (from the stroke) → tight; parallel axis is free →
      // wide, so segVote resolves it even from a small drawing overlap.
      const P = 20;
      seg = segVote(si, sj, stroke.perp === "y"
        ? { x0: stroke.dx - span, x1: stroke.dx + span, y0: stroke.dy - P, y1: stroke.dy + P }
        : { x0: stroke.dx - P, x1: stroke.dx + P, y0: stroke.dy - span, y1: stroke.dy + span });
    }
    else if (prior) seg = segVote(si, sj, { x0: prior.dx - 60, x1: prior.dx + 60, y0: prior.dy - 60, y1: prior.dy + 60 });
    else if (tok) seg = segVote(si, sj, { x0: tok.dx - 30, x1: tok.dx + 30, y0: tok.dy - 30, y1: tok.dy + 30 });
    else if (rel) seg = segVote(si, sj, windowFor(rel, span));

    let final: { dx: number; dy: number } | null = null, channel: string | null = null, conf: string | null = null, w = 0;
    if (tok && seg && Math.hypot(tok.dx - seg.dx, tok.dy - seg.dy) < 5) {
      final = { dx: (tok.dx + seg.dx) / 2, dy: (tok.dy + seg.dy) / 2 }; channel = "token+segment"; conf = "high";
      w = tok.inliers / (tok.rmsFt ** 2 + 0.01) + seg.inliers / (seg.rmsFt ** 2 + 0.04);
    } else if (tok) { final = tok; channel = "token"; conf = "high"; w = tok.inliers / (tok.rmsFt ** 2 + 0.01); }
    else if (seg && (stroke || prior)) { final = seg; channel = "matchline+segment"; conf = seg.votes! >= 2 * seg.secondVotes! ? "high" : "medium"; w = seg.inliers / (seg.rmsFt ** 2 + 0.09); }
    // Band-seam: axis-aligned edge-band match between two tiles (no readable
    // matchline/tokens). The seam offset is the true adjacency, not the interior.
    else if (seam) { final = { dx: seam.dx, dy: seam.dy }; channel = "seam"; conf = seam.inliers >= 20 ? "high" : "medium"; w = seam.inliers / (seam.rmsFt ** 2 + 0.09); }
    else if (seg) { final = seg; channel = "segment(windowed)"; conf = seg.votes! >= 2 * seg.secondVotes! ? "medium" : "low"; w = 0.5 * seg.inliers / (seg.rmsFt ** 2 + 0.25); }
    // Cross-referenced matchline STROKES: the perpendicular offset is exact (from
    // the physical line); the parallel is a coarse label estimate segVote couldn't
    // refine (no drawing overlap). Far better than label-only — used when seg fails.
    else if (stroke) { final = { dx: stroke.dx, dy: stroke.dy }; channel = "matchline-stroke"; conf = "medium"; w = 8; }
    // Label-only matchline is trusted ONLY when the two sheets actually reference
    // each other (`rel` from a "SEE SHEET"/"MATCHLINE" number/code). Two sheets
    // that merely have opposite-edge matchlines pointing at OTHER neighbors must be
    // confirmed by the segment vote above — otherwise they'd bond with a garbage
    // offset (observed resid ~680ft on a 35-sheet street set). No rel + no seg = drop.
    else if (prior && rel) { final = prior; channel = "matchline-label-only"; conf = "low"; w = 2; }

    pairs.push({
      i: ni, j: nj, channel, conf,
      dxFt: final ? +final.dx.toFixed(2) : null, dyFt: final ? +final.dy.toFixed(2) : null,
      weight: +w.toFixed(2), residFt: null, _final: final ?? undefined,
    });
  }

  let constraints = pairs.filter((r) => r._final && r.weight > 0)
    .map((r) => ({ i: r.i, j: r.j, dx: r._final!.dx, dy: r._final!.dy, weight: r.weight }));

  // Connected components over the constraint graph. Place the LARGEST component
  // and root it at that component's most-connected sheet — NOT blindly at
  // sheets[0], which on a real set is often a title/notes/details sheet with no
  // drawing tokens; rooting there leaves the entire real plan cluster unplaced.
  const placeFrom = (cons: { i: number; j: number; dx: number; dy: number; weight: number }[]) => {
    const adj = new Map<number, Set<number>>(keys.map((k) => [k, new Set<number>()]));
    for (const c of cons) { adj.get(c.i)!.add(c.j); adj.get(c.j)!.add(c.i); }
    const seen = new Set<number>();
    const components: number[][] = [];
    for (const k of keys) {
      if (seen.has(k)) continue;
      const comp: number[] = []; const stack = [k]; seen.add(k);
      while (stack.length) {
        const u = stack.pop()!; comp.push(u);
        for (const v of adj.get(u)!) if (!seen.has(v)) { seen.add(v); stack.push(v); }
      }
      components.push(comp);
    }
    components.sort((a, b) => b.length - a.length);
    const main = components[0] && components[0].length >= 2 ? components[0] : [];
    const mainSet = new Set(main);
    let rootKey = sheets[0].no;
    if (main.length) {
      let bestDeg = -1;
      for (const k of main) { const deg = adj.get(k)!.size; if (deg > bestDeg || (deg === bestDeg && k < rootKey)) { bestDeg = deg; rootKey = k; } }
    }
    return { main, mainSet, rootKey, pos: solveGlobal(keys, rootKey, cons).pos };
  };

  let { main, mainSet, rootKey, pos: coarsePos } = placeFrom(constraints);
  // Outlier rejection: a geometry match can align two sheets at a plausible-but-
  // wrong offset (repeated site features). Drop constraints grossly inconsistent
  // with the solve and re-place, so one bad seam doesn't drag the layout. One pass.
  const OUTLIER_FT = 30;
  const clean = constraints.filter((c) => !(mainSet.has(c.i) && mainSet.has(c.j)) || residual(c, coarsePos) <= OUTLIER_FT);
  if (clean.length < constraints.length) {
    constraints = clean;
    ({ main, mainSet, rootKey, pos: coarsePos } = placeFrom(constraints));
  }

  // ── FINE REGISTRATION ──────────────────────────────────────────────────────
  // The coarse solve (anchored by the precise token pairs) lands each seam in the
  // correct basin, but token-poor seams inherit matchline/segment coarseness.
  // Refine each placed pair's delta by densely registering the overlap linework in
  // a TIGHT window around the coarse offset, then re-solve with the precise,
  // inlier-weighted geometry locks so every seam tightens to sub-foot. No-op when
  // sheets carry no geometry (refineOffset returns null → constraint unchanged).
  let pos = coarsePos;
  if (mainSet.size >= 2) {
    for (const s of sheets) if (mainSet.has(s.no) && !s.segFine) s.segFine = segFeats(s, 2);
    const refinedConstraints = constraints.map((c) => {
      if (!mainSet.has(c.i) || !mainSet.has(c.j)) return c;
      const si = byNo.get(c.i)!, sj = byNo.get(c.j)!;
      const pi = coarsePos.get(c.i)!, pj = coarsePos.get(c.j)!;
      const r = refineOffset(si.segFine!, sj.segFine!, { dx: pj.x - pi.x, dy: pj.y - pi.y });
      if (r && r.rms < 1) {
        return { i: c.i, j: c.j, dx: r.dx, dy: r.dy, weight: r.inliers / (r.rms ** 2 + 0.01) };
      }
      return c;
    });
    pos = solveGlobal(keys, rootKey, refinedConstraints).pos;
  }

  // worst residual over the PLACED component's token pairs only (a floating,
  // out-of-component pair would otherwise report a huge spurious residual).
  const refCons = pairs.filter((r) => r._final && /token/.test(String(r.channel)) && mainSet.has(r.i) && mainSet.has(r.j))
    .map((r) => ({ i: r.i, j: r.j, dx: r._final!.dx, dy: r._final!.dy }));
  let worst = 0;
  for (const c of refCons) { const rr = residual(c, pos); if (rr > worst) worst = rr; }
  for (const r of pairs) {
    if (r._final) r.residFt = +residual({ i: r.i, j: r.j, dx: r._final.dx, dy: r._final.dy }, pos).toFixed(3);
    delete r._final;
  }

  const placements = new Map<number, { x: number; y: number }>();
  for (const k of main) placements.set(k, pos.get(k)!);

  return { root: rootKey, placements, worstResidFt: +worst.toFixed(3), pairs, method: main.length ? "geometric" : "none" };
}
