import type { PageExtract, Label, Geom } from "@/features/stitch/autostitch/types";
import { parseSheetRefs } from "@/features/stitch/autostitch/tokens";

export interface Rect { x: number; y: number; w: number; h: number; }
export type CleanupKind = "title-block" | "match-margin" | "manual";
export interface CleanupRegion { rect: Rect; kind: CleanupKind; confidence: "high" | "medium"; }

const cx = (l: Label) => (l.x + l.endX) / 2;
const cy = (l: Label) => (l.y + l.endY) / 2;

/** Iterate a page's straight segments (endpoints), calling back with each. */
function eachSegment(geometry: Geom[], cb: (ax: number, ay: number, bx: number, by: number) => void) {
  for (const g of geometry) {
    const pts = g.pts; if (!pts || pts.length < 2) continue;
    const n = pts.length - 1 + (g.closed ? 1 : 0);
    for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; cb(a[0], a[1], b[0], b[1]); }
  }
}

/**
 * Find the title-block's precise inner border on one edge, given the inner edge
 * of the furniture cluster (`furnInner`, the coordinate of the furniture furthest
 * from the sheet edge). Walks full-span parallel border lines INWARD from the
 * sheet edge, bridging the title-block grid (first prominent border within
 * `maxFrac`, then consecutive borders within `gapFrac`) until a big gap = open
 * drawing. Returns the walked border ONLY if it encloses the furniture cluster —
 * otherwise the walk was trapped on the outer sheet frame (a wide right strip
 * whose inner boundary is horizontal dividers, not one tall vertical line), so we
 * snap to the nearest full-span line to `furnInner`, and failing that return null
 * (caller falls back to `furnInner` itself). This captures a tall FOOTER band
 * (whose small text sits only at the very edge, but whose top border is a
 * closely-spaced grid line) yet still handles a wide right column with no full-
 * height inner border, without over-extending into the drawing.
 */
function findTitleBlockBorder(
  geometry: Geom[], edge: "right" | "left" | "top" | "bottom",
  x0: number, y0: number, x1: number, y1: number, furnInner: number,
  maxFrac = 0.4, gapFrac = 0.12, minSpanFrac = 0.5,
): number | null {
  const W = x1 - x0, H = y1 - y0;
  const vertical = edge === "right" || edge === "left";
  const dim = vertical ? W : H;
  const minSpan = minSpanFrac * (vertical ? H : W);
  const edgeCoord = edge === "right" ? x1 : edge === "left" ? x0 : edge === "bottom" ? y1 : y0;
  const furnInnerDist = Math.abs(furnInner - edgeCoord);
  const coords: number[] = [];
  eachSegment(geometry, (ax, ay, bx, by) => {
    if (vertical) {
      if (Math.abs(bx - ax) > 3 || Math.abs(by - ay) < minSpan) return; // full-height vertical
      coords.push((ax + bx) / 2);
    } else {
      if (Math.abs(by - ay) > 3 || Math.abs(bx - ax) < minSpan) return; // full-width horizontal
      coords.push((ay + by) / 2);
    }
  });
  // Bound the search to the title block: no further than maxFrac of the sheet, and
  // no more than gapFrac past the furniture inner edge (stops runaway into the drawing).
  const cap = Math.min(maxFrac * dim, furnInnerDist + gapFrac * dim);
  const cand = coords
    .map((c) => ({ c, dist: Math.abs(c - edgeCoord) }))
    .filter((o) => o.dist > 2 && o.dist <= cap)
    .sort((a, b) => a.dist - b.dist);

  // Walk inward through the grid.
  let border: number | null = null, prevDist = 0;
  for (const o of cand) {
    const allowed = border === null ? maxFrac * dim : gapFrac * dim;
    if (o.dist - prevDist > allowed) break;
    border = o.c; prevDist = o.dist;
  }
  // Accept the walk only if it reaches (encloses) the furniture cluster.
  if (border != null && prevDist >= furnInnerDist - 0.04 * dim) return border;

  // Trapped (or no grid): snap to the full-span line nearest the furniture inner edge.
  let best: number | null = null, bestD = Infinity;
  for (const o of cand) {
    const d = Math.abs(o.dist - furnInnerDist);
    if (d < bestD && d <= gapFrac * dim) { bestD = d; best = o.c; }
  }
  return best;
}

/**
 * Detect title-block strips on a sheet. Returns MULTIPLE regions because plan
 * sheets are commonly L-shaped: a right (or left) column AND a bottom footer
 * strip (the architect's-name band). The old single-region, median-based
 * detector saw only the dominant edge — on an L-shape the right column's labels
 * outvote the footer in the median, so the footer was never proposed.
 *
 * Each edge is detected independently from the furniture hugging it, with a
 * discriminator that separates a genuine perpendicular strip from the *corner
 * overlap* of the other strip: a right column must have furniture spanning the
 * height (labels above the footer band), and a bottom footer must have furniture
 * left of the column (not just the column's own bottom row).
 */
export function detectTitleBlocks(page: PageExtract, isFurniture: (l: Label) => boolean): CleanupRegion[] {
  const [x0, y0, x1, y1] = page.view;
  const W = x1 - x0, H = y1 - y0;
  const furn = [...page.shxLabels, ...page.labels].filter(isFurniture);
  if (furn.length < 3) return [];
  const fx = (l: Label) => (cx(l) - x0) / W; // 0 = left edge, 1 = right edge
  const fy = (l: Label) => (cy(l) - y0) / H; // 0 = top edge,  1 = bottom edge
  const out: CleanupRegion[] = [];

  // RIGHT column — furniture in the right band, spanning the height (≥2 labels
  // above the footer band, so a footer's right end alone can't trigger it).
  const rightHug = furn.filter((l) => fx(l) > 0.6);
  if (rightHug.length >= 3 && rightHug.filter((l) => fy(l) < 0.85).length >= 2) {
    const furnInnerX = Math.min(...rightHug.map(cx)); // stray drawing labels (fx≤0.6) excluded
    const border = findTitleBlockBorder(page.geometry, "right", x0, y0, x1, y1, furnInnerX);
    const bx = border ?? furnInnerX;
    out.push({ rect: { x: bx, y: y0, w: x1 - bx, h: H }, kind: "title-block", confidence: border != null ? "high" : "medium" });
  }

  // BOTTOM footer — furniture hugging the bottom edge, with ≥2 labels LEFT of the
  // right column (distinguishes a real full-width footer from the column's bottom).
  const bottomHug = furn.filter((l) => fy(l) > 0.85);
  if (bottomHug.length >= 3 && bottomHug.filter((l) => fx(l) < 0.6).length >= 2) {
    const furnInnerY = Math.min(...bottomHug.map(cy));
    const border = findTitleBlockBorder(page.geometry, "bottom", x0, y0, x1, y1, furnInnerY);
    const by = border ?? furnInnerY;
    out.push({ rect: { x: x0, y: by, w: W, h: y1 - by }, kind: "title-block", confidence: border != null ? "high" : "medium" });
  }

  return out;
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
