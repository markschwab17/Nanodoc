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

export interface SheetInput { id: string; no: number; scale: number; view: [number, number, number, number]; extract: PageExtract; }
export interface PairReport { i: number; j: number; channel: string | null; conf: string | null; dxFt: number | null; dyFt: number | null; weight: number; residFt: number | null; }
export interface StitchResult { root: number; placements: Map<number, { x: number; y: number }>; worstResidFt: number; pairs: PairReport[]; }

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

interface DriverSheet {
  id: string; no: number; scale: number; view: [number, number, number, number];
  raw: { shxLabels: Label[]; labels: Label[]; geometry: Geom[]; view: [number, number, number, number] };
  key: number; tok?: TokFeat[]; seg?: SegFeat[]; sheetCode?: string | null; segFine?: SegFeat[];
}

export function stitchSheets(inputs: SheetInput[]): StitchResult {
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
  for (const s of sheets) { s.tok = tokenFeats(s, furn); s.seg = segFeats(s); }

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

  const pairs: (PairReport & { _final?: { dx: number; dy: number } })[] = [];
  for (const uk of pairKeys) {
    const [ni, nj] = uk.split("-").map(Number);
    const si = byNo.get(ni)!, sj = byNo.get(nj)!;
    const span = Math.max(FT(si.view[2] - si.view[0], si.scale), FT(sj.view[2] - sj.view[0], sj.scale));
    const rel = relFor(ni, nj);
    const tok = tv(si, sj);
    const prior = matchlinePrior(si, sj);
    let win: { x0: number; x1: number; y0: number; y1: number };
    if (prior) win = { x0: prior.dx - 60, x1: prior.dx + 60, y0: prior.dy - 60, y1: prior.dy + 60 };
    else if (tok) win = { x0: tok.dx - 30, x1: tok.dx + 30, y0: tok.dy - 30, y1: tok.dy + 30 };
    else if (rel) win = windowFor(rel, span);
    else win = { x0: -span, x1: span, y0: -span, y1: span };
    const seg = segVote(si, sj, win);

    let final: { dx: number; dy: number } | null = null, channel: string | null = null, conf: string | null = null, w = 0;
    if (tok && seg && Math.hypot(tok.dx - seg.dx, tok.dy - seg.dy) < 5) {
      final = { dx: (tok.dx + seg.dx) / 2, dy: (tok.dy + seg.dy) / 2 }; channel = "token+segment"; conf = "high";
      w = tok.inliers / (tok.rmsFt ** 2 + 0.01) + seg.inliers / (seg.rmsFt ** 2 + 0.04);
    } else if (tok) { final = tok; channel = "token"; conf = "high"; w = tok.inliers / (tok.rmsFt ** 2 + 0.01); }
    else if (seg && prior) { final = seg; channel = "matchline+segment"; conf = seg.votes! >= 2 * seg.secondVotes! ? "high" : "medium"; w = seg.inliers / (seg.rmsFt ** 2 + 0.09); }
    else if (seg) { final = seg; channel = "segment(windowed)"; conf = seg.votes! >= 2 * seg.secondVotes! ? "medium" : "low"; w = 0.5 * seg.inliers / (seg.rmsFt ** 2 + 0.25); }
    else if (prior) { final = prior; channel = "matchline-label-only"; conf = "low"; w = 2; }

    pairs.push({
      i: ni, j: nj, channel, conf,
      dxFt: final ? +final.dx.toFixed(2) : null, dyFt: final ? +final.dy.toFixed(2) : null,
      weight: +w.toFixed(2), residFt: null, _final: final ?? undefined,
    });
  }

  const constraints = pairs.filter((r) => r._final && r.weight > 0)
    .map((r) => ({ i: r.i, j: r.j, dx: r._final!.dx, dy: r._final!.dy, weight: r.weight }));

  // Connected components over the constraint graph. Place the LARGEST component
  // and root it at that component's most-connected sheet — NOT blindly at
  // sheets[0], which on a real set is often a title/notes/details sheet with no
  // drawing tokens; rooting there leaves the entire real plan cluster unplaced.
  const adj = new Map<number, Set<number>>(keys.map((k) => [k, new Set<number>()]));
  for (const c of constraints) { adj.get(c.i)!.add(c.j); adj.get(c.j)!.add(c.i); }
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
    for (const k of main) {
      const deg = adj.get(k)!.size;
      if (deg > bestDeg || (deg === bestDeg && k < rootKey)) { bestDeg = deg; rootKey = k; }
    }
  }

  const { pos: coarsePos } = solveGlobal(keys, rootKey, constraints);

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

  return { root: rootKey, placements, worstResidFt: +worst.toFixed(3), pairs };
}
