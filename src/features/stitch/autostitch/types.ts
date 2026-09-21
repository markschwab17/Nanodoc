export interface Label { text: string; x: number; y: number; endX: number; endY: number; angle: number; h: number; font: string | null; atoms?: number; }
/**
 * One captured path, flattened.
 *
 * `pts` is a FLAT `Float32Array` of x,y pairs — point `i` is
 * `(pts[2 * i], pts[2 * i + 1])`, and the path has `pts.length / 2` points.
 * The obvious `[number, number][]` shape costs ~56 B per point (a JS array
 * object with its header) plus a per-path string id; measured over five dense
 * civil sheets that was 239 MB of JS heap for 1.30 M points. Flat float pairs
 * and a numeric id are 8 B per point, and the whole page's geometry is one
 * allocation per path instead of one per point.
 *
 * Float32 resolves ~2e-4 pt at the far corner of a 36x24 in sheet, four orders
 * of magnitude finer than the 2 pt bins every consumer quantises to.
 */
export interface Geom { id: number; pts: Float32Array; closed: boolean; }

/**
 * Build a `Geom` from [x, y] pairs. For tests and fixtures — the capture device
 * fills the `Float32Array` directly as it walks the page.
 */
export function makeGeom(
  pts: readonly (readonly [number, number])[],
  closed = false,
  id = 0,
): Geom {
  const flat = new Float32Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    flat[i * 2] = pts[i][0];
    flat[i * 2 + 1] = pts[i][1];
  }
  return { id, pts: flat, closed };
}
export interface Atom { text: string; x: number; y: number; dirX: number; dirY: number; h: number; len: number; angle: number; font: string | null; }
export interface PageExtract { view: [number, number, number, number]; shxLabels: Label[]; labels: Label[]; words: Label[]; geometry: Geom[]; }
export interface Pt { x: number; y: number; }
