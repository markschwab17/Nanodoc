/**
 * Strip-ref-based frame detection. A sheet's drawing area is split into 1–2
 * stacked frames via "SEE BELOW LEFT" / "SEE ABOVE RIGHT" labels (usually
 * OCR-recovered). The split line is the midpoint between the two labels'
 * centers. Returns [] when refs are absent or mismatched.
 */
import type { Label, PageExtract } from "./types";
import { parseSheetRefs } from "./tokens";

export interface Frame { bbox: [number, number, number, number] }

/**
 * Two-strip page detection from STRIP REFS ("SEE BELOW LEFT" / "SEE ABOVE
 * RIGHT" labels, usually OCR-recovered): a below-ref (on the top strip) above
 * an above-ref (on the bottom strip) declares two stacked strips; the split
 * line is the midpoint between the two labels' centers. Geometry border
 * detection is NOT used — on dense civil sheets it is unreliable (see the
 * 2026-07 PG_SITE diagnosis). Returns the two full-width frames, or null.
 */
export function stripFrames(labels: Label[], view: [number, number, number, number]): Frame[] | null {
  const [x0, y0, x1, y1] = view;
  const H = y1 - y0;
  const refs = parseSheetRefs(labels, view).filter((r) => r.strip && r.edge !== "interior");
  const below = refs.filter((r) => r.strip === "below").sort((a, b) => a.at.y - b.at.y)[0];
  const above = refs.filter((r) => r.strip === "above").sort((a, b) => b.at.y - a.at.y)[0];
  if (!below || !above) return null;
  if (below.at.y >= above.at.y) return null; // below-ref must sit on the UPPER strip
  const split = (below.at.y + above.at.y) / 2;
  if (split < y0 + 0.25 * H || split > y0 + 0.75 * H) return null; // implausible split
  return [
    { bbox: [x0, y0, x1, split] },
    { bbox: [x0, split, x1, y1] },
  ];
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
    const src = g.pts;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < src.length; i += 2) {
      const x = src[i], y = src[i + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (maxX < gx0 || minX > gx1 || maxY < gy0 || minY > gy1) continue;
    const shifted = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 2) {
      shifted[i] = src[i] - fx0;
      shifted[i + 1] = src[i + 1] - fy0;
    }
    geometry.push({ ...g, pts: shifted });
  }
  return {
    view: [0, 0, fx1 - fx0, fy1 - fy0],
    labels: extract.labels.filter(keepL).map(shift),
    shxLabels: extract.shxLabels.filter(keepL).map(shift),
    words: extract.words.filter(keepL).map(shift),
    geometry,
  };
}

/**
 * The DRAWING FRAME rectangle, from geometry alone.
 *
 * A civil sheet is not drawn edge to edge: the plan lives inside a ruled frame, and
 * on many sets a notes/title column takes the right quarter of the sheet, so the
 * drawing's own right border sits at ~72 % of the page width. Every edge rule in the
 * engine — the OCR band clips, and `parseSheetRefs`' 18 % edge-vs-interior test — is
 * measured from the PAGE, so a matchline callout drawn on that inner border reads as
 * `interior` and is ignored by `hasEdgeRefs`, `edgeRefsOf` and the matchline priors.
 * That is the investigation's failure D (Belcourt sheet 6's east callout).
 *
 * The frame is found from full-span ruled lines: axis-aligned strokes whose summed
 * length at one cross-coordinate reaches `spanFrac` of the perpendicular page
 * dimension. Of those, the frame's left/top edge is the INNERMOST candidate in the
 * outer quarter, and its right/bottom edge the INNERMOST candidate past `minExtent`
 * of the page — i.e. the first ruled divider the drawing actually ends at, which is
 * the notes-column line when there is one and the sheet border otherwise.
 *
 * Returns null (⇒ callers keep using the page) unless a frame was found that is
 * meaningfully inset on some side and still covers most of the sheet, so a stray
 * full-height property line cannot shrink the drawing area to nothing.
 *
 * Deliberately separate from `stripFrames`: that one splits a sheet into stacked
 * strips from LABELS and documents why it avoids geometry borders. This is the
 * different, simpler question of where the sheet's own ruled frame is.
 */
export function detectDrawingFrame(
  geometry: { pts: Float32Array; closed?: boolean }[],
  view: [number, number, number, number],
  { spanFrac = 0.9, minExtent = 0.55, minArea = 0.5, minInsetFrac = 0.02 } = {},
): [number, number, number, number] | null {
  const [x0, y0, x1, y1] = view;
  const W = x1 - x0, H = y1 - y0;
  if (!(W > 0 && H > 0) || !geometry.length) return null;
  const BIN = 2;
  const vSpans = new Map<number, number>(); // x-bin -> summed vertical length
  const hSpans = new Map<number, number>(); // y-bin -> summed horizontal length
  for (const g of geometry) {
    const pts = g.pts;
    if (!pts || pts.length < 4) continue;
    const np = pts.length / 2;
    const n = np - 1 + (g.closed ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const ai = i * 2, bi = ((i + 1) % np) * 2;
      const ax = pts[ai], ay = pts[ai + 1], bx = pts[bi], by = pts[bi + 1];
      const dx = bx - ax, dy = by - ay;
      if (Math.abs(dx) <= 3 && Math.abs(dy) > 3) {
        const k = Math.round(((ax + bx) / 2) / BIN);
        vSpans.set(k, (vSpans.get(k) || 0) + Math.abs(dy));
      } else if (Math.abs(dy) <= 3 && Math.abs(dx) > 3) {
        const k = Math.round(((ay + by) / 2) / BIN);
        hSpans.set(k, (hSpans.get(k) || 0) + Math.abs(dx));
      }
    }
  }
  const rulers = (spans: Map<number, number>, dim: number): number[] =>
    [...spans.entries()].filter(([, tot]) => tot >= spanFrac * dim).map(([k]) => k * BIN).sort((a, b) => a - b);
  // low edge: the innermost ruler inside the outer quarter (of the PAGE — that is
  // where a border can be). high edge: the FIRST ruler past minExtent — the drawing
  // ends at the first full divider, the notes-column line when one exists and the
  // sheet border otherwise.
  const lowEdge = (rs: number[], lo: number, dim: number) => {
    const c = rs.filter((v) => v <= lo + 0.25 * dim);
    return c.length ? c[c.length - 1] : lo;
  };
  const highEdge = (rs: number[], lo: number, dim: number, fallback: number) => {
    const c = rs.filter((v) => v >= lo + minExtent * dim);
    return c.length ? c[0] : fallback;
  };
  // A frame's borders span the FRAME, not the page: on a sheet whose drawing stops
  // at 72 % of the width, its top and bottom rules are 0.72 W long and a page-width
  // span test rejects them outright. So solve once against the page to size the
  // frame, then again requiring each ruler to span the frame it just found. One
  // refinement is enough — the second pass only ever admits more rulers, and the
  // outer-quarter / minExtent placement tests stay page-relative.
  const solve = (reqW: number, reqH: number): [number, number, number, number] => {
    const vs = rulers(vSpans, reqH), hs = rulers(hSpans, reqW);
    return [lowEdge(vs, x0, W), lowEdge(hs, y0, H), highEdge(vs, x0, W, x1), highEdge(hs, y0, H, y1)];
  };
  const first = solve(W, H);
  const [fx0, fy0, fx1, fy1] = solve(first[2] - first[0], first[3] - first[1]);
  const fw = fx1 - fx0, fh = fy1 - fy0;
  if (fw <= 0 || fh <= 0) return null;
  if (fw * fh < minArea * W * H) return null;                       // implausibly small
  const inset = Math.max(fx0 - x0, x1 - fx1, fy0 - y0, y1 - fy1);
  if (inset < minInsetFrac * Math.min(W, H)) return null;           // no real frame — use the page
  return [fx0, fy0, fx1, fy1];
}
