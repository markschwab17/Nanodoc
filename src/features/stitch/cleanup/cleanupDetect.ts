import type { PageExtract, Label, Geom } from "@/features/stitch/autostitch/types";

export interface Rect { x: number; y: number; w: number; h: number; }
export type CleanupKind = "title-block" | "match-margin" | "manual";
export interface CleanupRegion { rect: Rect; kind: CleanupKind; confidence: "high" | "medium"; }

const cx = (l: Label) => (l.x + l.endX) / 2;
const cy = (l: Label) => (l.y + l.endY) / 2;
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/** Iterate a page's straight segments (endpoints), calling back with each. */
function eachSegment(geometry: Geom[], cb: (ax: number, ay: number, bx: number, by: number) => void) {
  for (const g of geometry) {
    const pts = g.pts; if (!pts || pts.length < 2) continue;
    const n = pts.length - 1 + (g.closed ? 1 : 0);
    for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; cb(a[0], a[1], b[0], b[1]); }
  }
}

/** Longest near-vertical stroke whose x is within `band` of nearX and which spans most of [y0,y1]. Returns its x or null. */
function snapVerticalBorder(geometry: Geom[], nearX: number, y0: number, y1: number, band = 120): number | null {
  const H = y1 - y0; let bestX: number | null = null, bestSpan = -1;
  eachSegment(geometry, (ax, ay, bx, by) => {
    if (Math.abs(bx - ax) > 3) return;                 // vertical
    const x = (ax + bx) / 2;
    if (Math.abs(x - nearX) > band) return;
    const span = Math.abs(by - ay);
    if (span < 0.5 * H) return;                          // spans most of the sheet
    if (span > bestSpan) { bestSpan = span; bestX = x; }
  });
  return bestX;
}

/** Longest near-horizontal stroke near nearY spanning most of [x0,x1]. Returns its y or null. */
function snapHorizontalBorder(geometry: Geom[], nearY: number, x0: number, x1: number, band = 120): number | null {
  const W = x1 - x0; let bestY: number | null = null, bestSpan = -1;
  eachSegment(geometry, (ax, ay, bx, by) => {
    if (Math.abs(by - ay) > 3) return;                 // horizontal
    const y = (ay + by) / 2;
    if (Math.abs(y - nearY) > band) return;
    const span = Math.abs(bx - ax);
    if (span < 0.5 * W) return;
    if (span > bestSpan) { bestSpan = span; bestY = y; }
  });
  return bestY;
}

export function detectTitleBlock(page: PageExtract, isFurniture: (l: Label) => boolean): CleanupRegion | null {
  const [x0, y0, x1, y1] = page.view;
  const W = x1 - x0, H = y1 - y0;
  const furn = [...page.shxLabels, ...page.labels].filter(isFurniture);
  if (furn.length < 3) return null;
  const xs = furn.map(cx), ys = furn.map(cy);
  const rightFrac = (median(xs) - x0) / W, botFrac = (median(ys) - y0) / H;

  if (rightFrac > 0.72) {
    const innerX = Math.min(...xs);
    const snapped = snapVerticalBorder(page.geometry, innerX, y0, y1);
    const bx = snapped ?? innerX;
    return { rect: { x: bx, y: y0, w: x1 - bx, h: H }, kind: "title-block", confidence: snapped != null ? "high" : "medium" };
  }
  if (botFrac > 0.72 || botFrac < 0.14) {
    const bottom = botFrac >= 0.5;
    const innerY = bottom ? Math.min(...ys) : Math.max(...ys);
    const snapped = snapHorizontalBorder(page.geometry, innerY, x0, x1);
    const by = snapped ?? innerY;
    const conf = snapped != null ? "high" : "medium";
    return bottom
      ? { rect: { x: x0, y: by, w: W, h: y1 - by }, kind: "title-block", confidence: conf }
      : { rect: { x: x0, y: y0, w: W, h: by - y0 }, kind: "title-block", confidence: conf };
  }
  return null;
}
