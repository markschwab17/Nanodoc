/**
 * Where paint drawn LATER covers a point: a spatial index of opaque fills in
 * paint order, so a path's samples can skip what the user never saw of it.
 *
 * Only fills qualify (a later stroke hides a line or two of pixels at most),
 * and only near the erase (the caller filters), which keeps the index small on
 * 200k-path sheets. Fills are assumed opaque: a translucent or pattern fill
 * over a line makes that line's samples abstain rather than vote, which can
 * only keep more — and the page verification catches what is then left over.
 *
 * Pure. Exported for tests.
 */
import type { Mat, PaintedPath } from "./contentFilter";
import { flattenRing, insideRings } from "./pathDecision";

type Pt = [number, number];

interface Occluder {
  order: number;
  rings: Pt[][];
  evenOdd: boolean;
  box: [number, number, number, number];
}

const FILL_OPS = new Set(["f", "F", "f*", "B", "B*", "b", "b*"]);

/** Pixel-space rings of a painted path's subpaths. */
export function pathRings(path: PaintedPath): Pt[][] {
  return path.subpaths.map((sp) => flattenRing(sp, path.ctm as Mat));
}

export class OccluderIndex {
  private cells = new Map<number, Occluder[]>();
  private readonly cell: number;
  count = 0;

  constructor(cellPx = 32) {
    this.cell = cellPx;
  }

  /** True when this painted path is a fill that can hide what is under it. */
  static isOccluder(path: PaintedPath): boolean {
    return FILL_OPS.has(path.paint) && path.subpaths.some((sp) => sp.segs.length >= 2);
  }

  add(order: number, rings: Pt[][], evenOdd: boolean): void {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let area = 0;
    for (const r of rings) {
      let a = 0;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
        const [x, y] = r[i];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      area += Math.abs(a) / 2;
    }
    if (!(area >= 4)) return; // slivers hide nothing
    const occ: Occluder = { order, rings, evenOdd, box: [x0, y0, x1, y1] };
    const c = this.cell;
    for (let cy = Math.floor(y0 / c); cy <= Math.floor(y1 / c); cy++) {
      for (let cx = Math.floor(x0 / c); cx <= Math.floor(x1 / c); cx++) {
        const k = cy * 100003 + cx;
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(occ);
      }
    }
    this.count++;
  }

  /**
   * Is (x, y) covered by an occluder painted after `order`? Exact point test: a
   * line lying along a later fill's edge is judged by its looks to either side
   * (see pathDecision), so no dilation here — dilating hid thin kept lines
   * running just outside a later fill.
   */
  coveredAfter(order: number, x: number, y: number): boolean {
    if (!this.count) return false;
    const c = this.cell;
    const list = this.cells.get(Math.floor(y / c) * 100003 + Math.floor(x / c));
    if (!list) return false;
    for (const o of list) {
      if (o.order <= order) continue;
      const b = o.box;
      if (x < b[0] - 0.5 || x > b[2] + 0.5 || y < b[1] - 0.5 || y > b[3] + 0.5) continue;
      if (insideRings(o.rings, x, y, o.evenOdd)) return true;
    }
    return false;
  }
}
