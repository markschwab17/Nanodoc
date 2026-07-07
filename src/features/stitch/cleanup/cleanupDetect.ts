import type { PageExtract, Label, Geom } from "@/features/stitch/autostitch/types";
import { parseSheetRefs } from "@/features/stitch/autostitch/tokens";

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
    // Inner edge from ONLY the furniture in the right region — a stray
    // furniture-flagged label out in the drawing area must not widen the strip
    // across the sheet (seen on Rose Hill C5.01/C7.01/C8.00: a lone left label
    // dragged innerX to ~33% width, hiding 2/3 of the drawing).
    const rightXs = xs.filter((x) => (x - x0) / W > 0.6);
    const innerX = Math.min(...(rightXs.length ? rightXs : xs));
    const snapped = snapVerticalBorder(page.geometry, innerX, y0, y1);
    const bx = snapped ?? innerX;
    return { rect: { x: bx, y: y0, w: x1 - bx, h: H }, kind: "title-block", confidence: snapped != null ? "high" : "medium" };
  }
  if (botFrac > 0.72 || botFrac < 0.14) {
    const bottom = botFrac >= 0.5;
    // Same robustness for a bottom/top strip: only cluster furniture near the edge.
    const bandYs = ys.filter((y) => (bottom ? (y - y0) / H > 0.6 : (y - y0) / H < 0.4));
    const src = bandYs.length ? bandYs : ys;
    const innerY = bottom ? Math.min(...src) : Math.max(...src);
    const snapped = snapHorizontalBorder(page.geometry, innerY, x0, x1);
    const by = snapped ?? innerY;
    const conf = snapped != null ? "high" : "medium";
    return bottom
      ? { rect: { x: x0, y: by, w: W, h: y1 - by }, kind: "title-block", confidence: conf }
      : { rect: { x: x0, y: y0, w: W, h: by - y0 }, kind: "title-block", confidence: conf };
  }
  return null;
}

/** Find the match-line stroke coordinate near a matchline label. `axis` = "h"
 *  (label near top/bottom → horizontal line, return its y) or "v" (left/right →
 *  vertical line, return its x). Searches within `band` of the label's cross-coord. */
function findMatchLineStroke(
  geometry: Geom[], axis: "h" | "v", labelCross: number, x0: number, y0: number, x1: number, y1: number, band = 80
): number | null {
  const W = x1 - x0, H = y1 - y0;
  let bestPos = 0, bestSpan = -1;
  eachSegment(geometry, (ax, ay, bx, by) => {
    if (axis === "h") {
      if (Math.abs(by - ay) > 3) return;               // horizontal stroke
      const y = (ay + by) / 2;
      if (Math.abs(y - labelCross) > band) return;
      const span = Math.abs(bx - ax);
      if (span < 0.4 * W) return;                        // dashed lines: this catches the longest dash; good enough for the edge
      if (span > bestSpan) { bestSpan = span; bestPos = y; }
    } else {
      if (Math.abs(bx - ax) > 3) return;
      const x = (ax + bx) / 2;
      if (Math.abs(x - labelCross) > band) return;
      const span = Math.abs(by - ay);
      if (span < 0.4 * H) return;
      if (span > bestSpan) { bestSpan = span; bestPos = x; }
    }
  });
  return bestSpan >= 0 ? bestPos : null;
}

export function detectMatchMargins(page: PageExtract): CleanupRegion[] {
  const [x0, y0, x1, y1] = page.view;
  const refs = parseSheetRefs([...page.shxLabels, ...page.labels], page.view)
    .filter((r) => r.matchline && r.edge !== "interior");
  const out: CleanupRegion[] = [];
  const seenEdges = new Set<string>();
  for (const r of refs) {
    if (seenEdges.has(r.edge)) continue;               // one margin per edge
    const horizontal = r.edge === "top" || r.edge === "bottom";
    const cross = horizontal ? r.at.y : r.at.x;
    const pos = findMatchLineStroke(page.geometry, horizontal ? "h" : "v", cross, x0, y0, x1, y1);
    if (pos == null) continue;
    seenEdges.add(r.edge);
    // parseSheetRefs edge (y-down frame): "top" => label near y1, "bottom" => near y0.
    let rect: Rect;
    if (r.edge === "top") rect = { x: x0, y: pos, w: x1 - x0, h: y1 - pos };
    else if (r.edge === "bottom") rect = { x: x0, y: y0, w: x1 - x0, h: pos - y0 };
    else if (r.edge === "right") rect = { x: pos, y: y0, w: x1 - pos, h: y1 - y0 };
    else rect = { x: x0, y: y0, w: pos - x0, h: y1 - y0 }; // left
    if (rect.w > 2 && rect.h > 2) out.push({ rect, kind: "match-margin", confidence: "medium" });
  }
  return out;
}
