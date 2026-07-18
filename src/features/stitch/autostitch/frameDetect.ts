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
