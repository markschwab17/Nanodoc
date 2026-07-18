/**
 * Plan-frame detection. A sheet's drawing area is bounded by a long (usually
 * dashed) axis-aligned border. We accumulate per-cross-coordinate dash-span
 * sums (the findEdgeStroke trick, page-wide), keep near-full-span lines, and
 * assemble 1–2 stacked frames. Strip sheets (two frames) pair consecutive
 * horizontal borders; per-frame vertical borders are re-picked from the lines
 * that actually span that frame's y-range, so strips of different widths get
 * their true edges. Returns [] when no border exists (cover/notes/details).
 */
import type { Geom, Label, PageExtract } from "./types";

export interface Frame { bbox: [number, number, number, number] }

const BIN = 4;            // pt cross-coordinate bins
const AXIS_TOL = 3;       // pt deviation for "axis-aligned"
const MIN_SPAN_FRAC = 0.5;   // a border line's dash-span sum vs its extent
const MIN_FRAME_H_FRAC = 0.18; // min frame height vs page
const MIN_FRAME_W_FRAC = 0.4;  // min frame width vs page

interface Line { cross: number; lo: number; hi: number; span: number }

/** Sum axis-aligned dash spans per cross-coordinate bin; return strong lines. */
function strongLines(geometry: Geom[], axis: "h" | "v", minExtent: number): Line[] {
  const acc = new Map<number, { span: number; lo: number; hi: number }>();
  for (const g of geometry) {
    const pts = g.pts;
    if (!pts || pts.length < 2) continue;
    const n = pts.length - 1 + (g.closed ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const dCross = axis === "h" ? b[1] - a[1] : b[0] - a[0];
      if (Math.abs(dCross) > AXIS_TOL) continue;
      const cross = axis === "h" ? (a[1] + b[1]) / 2 : (a[0] + b[0]) / 2;
      const lo = axis === "h" ? Math.min(a[0], b[0]) : Math.min(a[1], b[1]);
      const hi = axis === "h" ? Math.max(a[0], b[0]) : Math.max(a[1], b[1]);
      if (hi - lo < 1) continue;
      const k = Math.round(cross / BIN);
      const e = acc.get(k) || { span: 0, lo: Infinity, hi: -Infinity };
      e.span += hi - lo;
      e.lo = Math.min(e.lo, lo); e.hi = Math.max(e.hi, hi);
      acc.set(k, e);
    }
  }
  // merge adjacent bins (a border wobbles across a bin boundary)
  const keys = [...acc.keys()].sort((a, b) => a - b);
  const lines: Line[] = [];
  let cur: { k0: number; k1: number; span: number; lo: number; hi: number } | null = null;
  for (const k of keys) {
    const e = acc.get(k)!;
    if (cur && k - cur.k1 <= 1) {
      cur.k1 = k; cur.span += e.span; cur.lo = Math.min(cur.lo, e.lo); cur.hi = Math.max(cur.hi, e.hi);
    } else {
      if (cur) lines.push({ cross: ((cur.k0 + cur.k1) / 2) * BIN, lo: cur.lo, hi: cur.hi, span: cur.span });
      cur = { k0: k, k1: k, span: e.span, lo: e.lo, hi: e.hi };
    }
  }
  if (cur) lines.push({ cross: ((cur.k0 + cur.k1) / 2) * BIN, lo: cur.lo, hi: cur.hi, span: cur.span });
  return lines.filter((l) => l.hi - l.lo >= minExtent && l.span >= MIN_SPAN_FRAC * (l.hi - l.lo));
}

export function detectFrames(extract: PageExtract): Frame[] {
  const [vx0, vy0, vx1, vy1] = extract.view;
  const W = vx1 - vx0, H = vy1 - vy0;
  const hLines = strongLines(extract.geometry, "h", MIN_FRAME_W_FRAC * W)
    .sort((a, b) => a.cross - b.cross);
  const vAll = strongLines(extract.geometry, "v", MIN_FRAME_H_FRAC * H);
  if (hLines.length < 2 || vAll.length < 2) return [];

  // Pair horizontal borders into candidate frames greedily from the top, max 2
  // frames. Smallest-height-first pairing: the NEAREST bottom border that has
  // its own covering vertical borders wins, so two stacked strips pair as
  // (top1,bot1) then (top2,bot2) rather than one giant (top1,bot2) rect. An
  // interior long line (a street) fails the vertical-coverage check and is
  // skipped as a bottom candidate; as a top candidate it starts no frame.
  const frames: Frame[] = [];
  let i = 0;
  while (i < hLines.length - 1 && frames.length < 2) {
    let matched = false;
    for (let j = i + 1; j < hLines.length; j++) {
      const top = hLines[i], bot = hLines[j];
      const h = bot.cross - top.cross;
      if (h < MIN_FRAME_H_FRAC * H) continue;
      // vertical borders that cover ≥60% of this y-range
      const cover = vAll.filter((v) => {
        const lo = Math.max(v.lo, top.cross), hi = Math.min(v.hi, bot.cross);
        return hi - lo >= 0.6 * h;
      });
      if (cover.length < 2) continue;
      const left = Math.min(...cover.map((v) => v.cross));
      const right = Math.max(...cover.map((v) => v.cross));
      if (right - left < MIN_FRAME_W_FRAC * W) continue;
      frames.push({ bbox: [left, top.cross, right, bot.cross] });
      i = j + 1; // next frame starts below this one
      matched = true;
      break;
    }
    if (!matched) i++;
  }
  return frames;
}

/**
 * Contents of `extract` inside `frame` grown by `marginPt` (matchline labels sit
 * ON the border), re-based to frame-local coordinates with view = [0,0,w,h].
 */
export function sliceExtract(extract: PageExtract, frame: Frame, marginPt = 36): PageExtract {
  const [fx0, fy0, fx1, fy1] = frame.bbox;
  const gx0 = fx0 - marginPt, gy0 = fy0 - marginPt, gx1 = fx1 + marginPt, gy1 = fy1 + marginPt;
  const inside = (x: number, y: number) => x >= gx0 && x <= gx1 && y >= gy0 && y <= gy1;
  const shift = (l: Label): Label => ({ ...l, x: l.x - fx0, y: l.y - fy0, endX: l.endX - fx0, endY: l.endY - fy0 });
  const keepL = (l: Label) => inside((l.x + l.endX) / 2, (l.y + l.endY) / 2);
  const geometry: typeof extract.geometry = [];
  for (const g of extract.geometry) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of g.pts) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
    if (maxX < gx0 || minX > gx1 || maxY < gy0 || minY > gy1) continue;
    geometry.push({ ...g, pts: g.pts.map((p) => [p[0] - fx0, p[1] - fy0] as [number, number]) });
  }
  return {
    view: [0, 0, fx1 - fx0, fy1 - fy0],
    labels: extract.labels.filter(keepL).map(shift),
    shxLabels: extract.shxLabels.filter(keepL).map(shift),
    words: extract.words.filter(keepL).map(shift),
    geometry,
  };
}
