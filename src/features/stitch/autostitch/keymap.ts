/**
 * Key-map grid detector.
 *
 * Plan sets whose matchline references are outlined to vector (unreadable as
 * text) and whose drawing geometry is self-similar cannot be stitched by geometry
 * alone — but each sheet carries a KEY MAP: a small diagram of the whole site grid
 * with THIS sheet's cell highlighted (gray-filled). That highlighted cell's grid
 * position is the sheet's (col,row) — an unambiguous adjacency signal.
 *
 * We can't read the cell CODES (also outlined), but the highlight is a `fillPath`
 * rectangle, so we detect it directly. Across all sheets the highlighted cells map
 * out the grid; clustering their centres yields each sheet's (col,row).
 *
 * Heuristic: the key map sits in the bottom-right area (the common convention).
 */

const apply = (m: number[], x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

interface Cell { cx: number; cy: number; wf: number; hf: number; }

/** Bounding boxes of all FILLED paths on a page, as fractions of the page. */
function fillCells(mupdf: any, page: any): Cell[] {
  const bounds = page.getBounds();
  const W = bounds[2] - bounds[0] || 1, H = bounds[3] - bounds[1] || 1;
  const out: Cell[] = [];
  const walk = (path: any, ctm: number[]) => {
    let pts: [number, number][] = [];
    const flush = () => {
      if (pts.length >= 3) {
        let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
        for (const [x, y] of pts) { if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y; }
        out.push({ cx: ((a + c) / 2 - bounds[0]) / W, cy: ((b + d) / 2 - bounds[1]) / H, wf: (c - a) / W, hf: (d - b) / H });
      }
      pts = [];
    };
    path.walk({
      moveTo(x: number, y: number) { flush(); pts = [apply(ctm, x, y)]; },
      lineTo(x: number, y: number) { pts.push(apply(ctm, x, y)); },
      curveTo() { /* key-map cells are rectangles — ignore curves */ },
      closePath() { /* bbox already covers it */ },
    });
    flush();
  };
  const dev = new mupdf.Device({ fillPath: (p: any, _eo: any, ctm: any) => walk(p, ctm as number[]) });
  page.run(dev, mupdf.Matrix.identity);
  (dev as any).close?.();
  (dev as any).destroy?.();
  return out;
}

/** 1-D single-linkage clustering; returns sorted cluster centres. */
function cluster1d(vals: number[], tol: number): number[] {
  const s = [...vals].sort((a, b) => a - b);
  const centres: number[] = [];
  let group: number[] = [];
  for (const v of s) {
    if (group.length && v - group[group.length - 1] > tol) { centres.push(group.reduce((a, b) => a + b, 0) / group.length); group = []; }
    group.push(v);
  }
  if (group.length) centres.push(group.reduce((a, b) => a + b, 0) / group.length);
  return centres;
}

const nearest = (v: number, centres: number[]): number =>
  centres.reduce((bi, _, i) => (Math.abs(centres[i] - v) < Math.abs(centres[bi] - v) ? i : bi), 0);

/**
 * Detect the site grid from the sheets' key maps. Returns a map pageIndex →
 * {col,row}, or null when there's no consistent key-map grid (→ caller falls back
 * to the geometric stitch).
 */
export function detectKeymapGrid(mupdf: any, doc: any, pageIndices: number[]): Map<number, { col: number; row: number }> | null {
  // Per page, the highlighted cell(s) in the bottom-right key-map area.
  const perPage = new Map<number, Cell>();
  for (const pi of pageIndices) {
    const page = doc.loadPage(pi);
    let cells: Cell[];
    try { cells = fillCells(mupdf, page); } finally { page.destroy?.(); }
    // key-map cell: small square-ish fill in the bottom-right key-map box (right of
    // the drawing, near the title block — the key-map convention). The highlight is
    // drawn as a few overlapping paths at one spot, and no OTHER cell in this box is
    // filled (unhighlighted cells are stroked), so their average IS the cell centre.
    const km = cells.filter((r) => r.cx > 0.78 && r.cx < 0.92 && r.cy > 0.76 && r.cy < 0.95 && r.wf > 0.02 && r.wf < 0.08 && r.hf > 0.02 && r.hf < 0.08);
    if (!km.length) continue;
    perPage.set(pi, { cx: km.reduce((s, o) => s + o.cx, 0) / km.length, cy: km.reduce((s, o) => s + o.cy, 0) / km.length, wf: km[0].wf, hf: km[0].hf });
  }
  if (perPage.size < pageIndices.length * 0.6) return null; // most sheets must have a key-map cell

  const pts = [...perPage.values()];
  const cols = cluster1d(pts.map((p) => p.cx), 0.015);
  const rows = cluster1d(pts.map((p) => p.cy), 0.015);
  if (cols.length * rows.length < pageIndices.length * 0.6) return null; // not a real grid

  // Assign (col,row). The highlighted cells should be DISTINCT (one per sheet); a
  // collision means a noise fill was picked for some page — skip it rather than
  // discard the whole grid.
  const grid = new Map<number, { col: number; row: number }>();
  const used = new Set<string>();
  for (const [pi, c] of perPage) {
    const col = nearest(c.cx, cols);
    const row = nearest(c.cy, rows); // row 0 = smallest cy = top of the key map (north)
    const key = `${col},${row}`;
    if (used.has(key)) continue;
    used.add(key);
    grid.set(pi, { col, row });
  }
  return grid.size >= pageIndices.length * 0.6 ? grid : null;
}
