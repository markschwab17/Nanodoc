import { describe, expect, it } from "vitest";
import { anyErasedIn, buildEraseMask, sampleState, STATE_ERASED, STATE_KEPT, STATE_NONE, type EraseMask } from "./eraseMask";
import { decidePath, keptIntervals, ringsMinusRect, subCubic } from "./pathDecision";
import { IDENTITY, type Mat, type PaintedPath } from "./contentFilter";

/**
 * A synthetic W×H sheet: `ink(x, y)` says where the reference render has ink,
 * `erased(x, y)` where the stored raster was erased (alpha 0).
 */
function makeMask(W: number, H: number, ink: (x: number, y: number) => boolean, erased: (x: number, y: number) => boolean): EraseMask {
  const stored = new Uint8ClampedArray(W * H * 4);
  const ref = new Uint8ClampedArray(W * H * 3).fill(255);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (ink(x, y)) ref.fill(0, p * 3, p * 3 + 3);
      stored[p * 4 + 3] = ink(x, y) && !erased(x, y) ? 255 : 0;
    }
  }
  return buildEraseMask(stored, W, H, ref, W, H, 3);
}

const line = (x0: number, y0: number, x1: number, y1: number, ctm: Mat = IDENTITY, paint = "S"): PaintedPath => ({
  subpaths: [{ x0, y0, segs: [{ kind: "l", pts: [x1, y1] }], closed: false }],
  paint, clip: false, editable: true, ctm, lineWidth: 1,
});

describe("buildEraseMask", () => {
  it("classifies blank, kept-ink and erased-ink pixels", () => {
    const m = makeMask(4, 1, (x) => x >= 1, (x) => x === 3);
    expect(Array.from(m.state)).toEqual([STATE_NONE, STATE_KEPT, STATE_KEPT, STATE_ERASED]);
    expect(m.erasedCount).toBe(1);
    expect(m.keptCount).toBe(2);
  });

  it("treats alpha-0 blank pixels (white removed) as NONE, never erased", () => {
    const m = makeMask(3, 1, () => false, () => true);
    expect(m.erasedCount).toBe(0);
  });

  it("absorbs a reference render one pixel off the stored grid", () => {
    const stored = new Uint8ClampedArray(10 * 10 * 4); // all alpha 0
    const ref = new Uint8ClampedArray(11 * 11 * 3).fill(0); // all ink
    const m = buildEraseMask(stored, 10, 10, ref, 11, 11, 3);
    expect(m.erasedCount).toBe(100);
  });

  it("anyErasedIn rejects boxes away from erased pixels", () => {
    const m = makeMask(100, 100, () => true, (x, y) => x > 80 && y > 80);
    expect(anyErasedIn(m, 0, 0, 40, 40)).toBe(false);
    expect(anyErasedIn(m, 70, 70, 90, 90)).toBe(true);
  });
});

describe("sampleState", () => {
  it("lets the 4-neighbourhood vote when the pixel itself is blank, ties to KEPT", () => {
    const m = makeMask(3, 3, (x, y) => !(x === 1 && y === 1), (x) => x === 0);
    // neighbours: left erased, right kept, up/down kept → kept
    expect(sampleState(m, 1.5, 1.5)).toBe(STATE_KEPT);
    const m2 = makeMask(3, 3, (x, y) => (x === 0 || x === 2) && y === 1, () => true);
    expect(sampleState(m2, 1.5, 1.5)).toBe(STATE_ERASED);
  });
});

describe("keptIntervals", () => {
  it("keeps everything with no inked samples", () => {
    expect(keptIntervals([0, 0, 0], 2)).toEqual([[0, 1]]);
  });
  it("cuts out an erased stretch", () => {
    expect(keptIntervals([1, 1, 1, 1, 2, 2, 2, 2], 2)).toEqual([[0, 0.5]]);
  });
  it("ignores a short erased blip (a crossing) but honours a long one", () => {
    expect(keptIntervals([1, 1, 1, 2, 1, 1, 1, 1], 3)).toEqual([[0, 1]]);
    expect(keptIntervals([1, 1, 1, 2, 2, 2, 1, 1, 1], 3)).toEqual([[0, 3 / 9], [6 / 9, 1]]);
  });
  it("drops a short kept fringe beside an erased run", () => {
    expect(keptIntervals([2, 2, 2, 2, 2, 2, 1], 3)).toEqual([]);
  });
  it("fills blank samples from their neighbours (dash gaps)", () => {
    expect(keptIntervals([2, 0, 2, 0, 2, 0, 2, 0], 2)).toEqual([]);
    expect(keptIntervals([0, 1, 0, 1, 0, 2, 0, 2, 0, 2], 2)).toEqual([[0, 0.5]]);
  });
});

describe("subCubic", () => {
  it("returns the piece of the curve between t0 and t1", () => {
    // A straight-line cubic from (0,0) to (3,0) is parameterised linearly.
    const [a, , , d] = subCubic([0, 0], [1, 0], [2, 0], [3, 0], 0.25, 0.75);
    expect(a[0]).toBeCloseTo(0.75);
    expect(d[0]).toBeCloseTo(2.25);
  });
});

describe("decidePath", () => {
  // 200×100 sheet with a horizontal line at y=20 and one at y=60.
  const onLine = (_x: number, y: number) => y === 20 || y === 60;

  it("keeps a path far from any erase without sampling it", () => {
    const m = makeMask(200, 100, onLine, (x, y) => y === 60 && x > 150);
    expect(decidePath(line(10, 20.5, 190, 20.5), m)).toEqual({ kind: "keep" });
  });

  it("erases a fully erased line (element erase)", () => {
    const m = makeMask(200, 100, onLine, (_x, y) => y === 60);
    expect(decidePath(line(10, 60.5, 190, 60.5), m)).toEqual({ kind: "erase", farKept: 0 });
    expect(decidePath(line(10, 20.5, 190, 20.5), m)).toEqual({ kind: "keep" });
  });

  it("cuts a line crossing a rectangle erase at the rectangle edge", () => {
    const m = makeMask(200, 100, onLine, (x) => x >= 100 && x < 150);
    const v = decidePath(line(10, 20.5, 190, 20.5), m);
    expect(v.kind).toBe("rewrite");
    const nums = (v as { construction: string }).construction.split(" ").filter((t) => !/[a-z]/.test(t)).map(Number);
    // two pieces: 10→~100 and ~150→190
    expect(nums[0]).toBe(10);
    expect(nums[2]).toBeGreaterThan(98);
    expect(nums[2]).toBeLessThan(102);
    expect(nums[4]).toBeGreaterThan(148);
    expect(nums[4]).toBeLessThan(152);
    expect(nums[6]).toBe(190);
  });

  it("does not nick a kept line where an erased line crossed it", () => {
    const ink = (x: number, y: number) => y === 20 || x === 100;
    const m = makeMask(200, 100, ink, (x) => x === 100); // the vertical line was erased
    expect(decidePath(line(10, 20.5, 190, 20.5), m)).toEqual({ kind: "keep" });
  });

  it("maps user space through the CTM, including a rotated page transform", () => {
    // User space is y-up and rotated 90°: user (u, v) → pixel (v, u).
    const rot: Mat = [0, 1, 1, 0, 0, 0];
    const m = makeMask(200, 100, onLine, (_x, y) => y === 60);
    expect(decidePath(line(60.5, 10, 60.5, 190, rot), m)).toEqual({ kind: "erase", farKept: 0 });
    expect(decidePath(line(20.5, 10, 20.5, 190, rot), m)).toEqual({ kind: "keep" });
  });

  it("judges fills whole, by majority of their inked samples", () => {
    const box = (x: number, y: number) => x >= 20 && x < 80 && y >= 20 && y < 80;
    const fill = (x0: number, y0: number, x1: number, y1: number): PaintedPath => ({
      subpaths: [{ x0, y0, closed: true, segs: [{ kind: "l", pts: [x1, y0] }, { kind: "l", pts: [x1, y1] }, { kind: "l", pts: [x0, y1] }] }],
      paint: "f", clip: false, editable: true, ctm: IDENTITY, lineWidth: 1,
    });
    // A rectangle erase over part of the fill cuts the fill at the rectangle.
    const most = makeMask(100, 100, box, (x) => x < 65);
    const v = decidePath(fill(20, 20, 80, 80), most) as { kind: string; construction: string };
    expect(v.kind).toBe("rewrite");
    const xs = v.construction.split(" ").filter((_t, i, a) => a[i + 2] === "m" || a[i + 2] === "l").map(Number);
    expect(Math.min(...xs)).toBeGreaterThan(63);
    expect(Math.min(...xs)).toBeLessThan(66);
    expect(Math.max(...xs)).toBe(80);
    // A partial erase that is NOT a rectangle cannot be cut: removed by majority
    // but the kept ink it carries is reported, so the caller refuses the clean.
    const diag = makeMask(100, 100, box, (x, y) => x + y < 125);
    const d = decidePath(fill(20, 20, 80, 80), diag);
    expect(d.kind).toBe("erase");
    expect((d as { farKept: number }).farKept).toBeGreaterThan(0);
    const all = makeMask(100, 100, box, () => true);
    expect(decidePath(fill(20, 20, 80, 80), all)).toEqual({ kind: "erase", farKept: 0 });
    const little = makeMask(100, 100, box, (x) => x >= 70);
    const l = decidePath(fill(20, 20, 80, 80), little) as { kind: string; construction: string };
    expect(l.kind).toBe("rewrite");
    expect(l.construction.startsWith("20 20 m")).toBe(true);
    // A sliver of erase that is not a rectangle of the fill (a line's worth
    // crossing its middle diagonally) leaves the fill whole.
    const sliver = makeMask(100, 100, box, (x, y) => Math.abs(x - y) < 2);
    expect(decidePath(fill(20, 20, 80, 80), sliver)).toEqual({ kind: "keep" });
  });

  it("never rewrites a clip path, only erases it whole", () => {
    const m = makeMask(200, 100, onLine, (x) => x >= 100);
    const p = { ...line(10, 20.5, 190, 20.5), clip: true };
    expect(decidePath(p, m).kind).not.toBe("rewrite");
  });

  it("drops only the erased leg of a polyline", () => {
    const ink = (x: number, y: number) => (y === 20 && x >= 10 && x <= 100) || (x === 100 && y >= 20 && y <= 90);
    const m = makeMask(200, 100, ink, (x, y) => x === 100 && y > 21);
    const poly: PaintedPath = {
      subpaths: [{ x0: 10, y0: 20.5, closed: false, segs: [{ kind: "l", pts: [100.5, 20.5] }, { kind: "l", pts: [100.5, 90] }] }],
      paint: "S", clip: false, editable: true, ctm: IDENTITY, lineWidth: 1,
    };
    const v = decidePath(poly, m);
    expect(v).toEqual({ kind: "rewrite", construction: "10 20.5 m 100.5 20.5 l", farKept: 0 });
  });

  it("drops only the erased parts of a multi-part fill", () => {
    const sq = (x: number) => ({ x0: x, y0: 20, closed: true, segs: [{ kind: "l" as const, pts: [x + 20, 20] }, { kind: "l" as const, pts: [x + 20, 40] }, { kind: "l" as const, pts: [x, 40] }] });
    const ink = (x: number, y: number) => y >= 20 && y < 40 && ((x >= 10 && x < 30) || (x >= 50 && x < 70) || (x >= 90 && x < 110));
    const m = makeMask(130, 60, ink, (x) => x < 80); // first two squares erased
    const p: PaintedPath = { subpaths: [sq(10), sq(50), sq(90)], paint: "f", clip: false, editable: true, ctm: IDENTITY, lineWidth: 1 };
    expect(decidePath(p, m)).toEqual({ kind: "rewrite", construction: "90 20 m 110 20 l 110 40 l 90 40 l h", farKept: 0 });
  });

  it("keeps a hole with its outline (overlapping subpaths are one group), also through a cut", () => {
    const ring = (a: number, b: number) => ({ x0: a, y0: a, closed: true, segs: [{ kind: "l" as const, pts: [b, a] }, { kind: "l" as const, pts: [b, b] }, { kind: "l" as const, pts: [a, b] }] });
    const ink = (x: number, y: number) => x >= 10 && x < 50 && y >= 10 && y < 50 && !(x >= 20 && x < 40 && y >= 20 && y < 40);
    // Untouched: kept as is.
    const p: PaintedPath = { subpaths: [ring(10, 50), ring(20, 40)], paint: "f*", clip: false, editable: true, ctm: IDENTITY, lineWidth: 1 };
    expect(decidePath(p, makeMask(60, 60, ink, () => false))).toEqual({ kind: "keep" });
    // Rectangle-erased across the hole: the cut keeps the hole (even-odd preserved).
    const v = decidePath(p, makeMask(60, 60, ink, (x) => x >= 45)) as { kind: string; construction: string };
    expect(v.kind).toBe("rewrite");
    expect(v.construction).toContain("20 20 m"); // the hole ring survives intact on the kept side
  });

  it("re-joins a cut closed ring through its start point", () => {
    // Square ring starting at (10,10); the erase takes the middle of the far side.
    const ink = (x: number, y: number) => (x >= 10 && x <= 90 && (y === 10 || y === 90)) || (y >= 10 && y <= 90 && (x === 10 || x === 90));
    const m = makeMask(100, 100, ink, (x, y) => x === 90 && y > 30 && y < 70);
    const p: PaintedPath = {
      subpaths: [{ x0: 10.5, y0: 10.5, closed: true, segs: [{ kind: "l", pts: [90.5, 10.5] }, { kind: "l", pts: [90.5, 90.5] }, { kind: "l", pts: [10.5, 90.5] }] }],
      paint: "S", clip: false, editable: true, ctm: IDENTITY, lineWidth: 1,
    };
    const v = decidePath(p, m) as { kind: string; construction: string };
    expect(v.kind).toBe("rewrite");
    // One run only (a single moveto): from the cut, round through (10.5,10.5), back to the cut.
    expect(v.construction.match(/ m/g)).toHaveLength(1);
    expect(v.construction).toContain("10.5 10.5 l");
  });
});

describe("occlusion, fill+stroke split, rectangle cuts", () => {
  const sq = (x0: number, y0: number, x1: number, y1: number) => ({
    x0, y0, closed: true,
    segs: [{ kind: "l" as const, pts: [x1, y0] }, { kind: "l" as const, pts: [x1, y1] }, { kind: "l" as const, pts: [x0, y1] }],
  });

  it("judges a fill only where it is not hidden by later paint", () => {
    // Fill 10..90 × 10..50; a later fill covers all but its bottom strip (y 44..50),
    // which is exactly what the user erased.
    const ink = (x: number, y: number) => x >= 10 && x < 90 && y >= 10 && y < 50;
    const m = makeMask(100, 60, ink, (_x, y) => y >= 44);
    const p: PaintedPath = { subpaths: [sq(10, 10, 90, 50)], paint: "f", clip: false, editable: true, ctm: IDENTITY, lineWidth: 1 };
    const hidden = (_x: number, y: number) => y < 44;
    // Without occlusion it is a majority-kept fill; with it, the visible strip is all erased.
    expect(decidePath(p, m, hidden)).toEqual({ kind: "erase", farKept: 0 });
  });

  it("drops an erased outline from a fill+stroke path and keeps its fill", () => {
    // 20..80 square; its outline ring (1 px) erased, interior kept.
    const onEdge = (x: number, y: number) => (x === 20 || x === 79 || y === 20 || y === 79) && x >= 20 && x <= 79 && y >= 20 && y <= 79;
    const ink = (x: number, y: number) => x >= 20 && x <= 79 && y >= 20 && y <= 79;
    const m = makeMask(100, 100, ink, onEdge);
    const p: PaintedPath = { subpaths: [sq(20.5, 20.5, 79.5, 79.5)], paint: "b", clip: false, editable: true, ctm: IDENTITY, lineWidth: 1 };
    expect(decidePath(p, m)).toEqual({ kind: "rewrite", construction: "20.5 20.5 m 79.5 20.5 l 79.5 79.5 l 20.5 79.5 l h", farKept: 0, paint: "f" });
  });

  it("ringsMinusRect cuts a rectangle out of a square", () => {
    const pieces = ringsMinusRect([[[0, 0], [10, 0], [10, 10], [0, 10]]], [3, -5, 6, 15]);
    const area = (r: number[][]) => Math.abs(r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
    expect(pieces.reduce((a, r) => a + area(r), 0)).toBeCloseTo(70);
  });

  it("a line painted as a zero-area fill+stroke is cut like a stroke", () => {
    const m = makeMask(200, 100, (_x, y) => y === 20, (x) => x >= 100);
    const p: PaintedPath = {
      subpaths: [{ x0: 10, y0: 20.5, closed: true, segs: [{ kind: "l", pts: [190, 20.5] }] }],
      paint: "b", clip: false, editable: true, ctm: IDENTITY, lineWidth: 1,
    };
    const v = decidePath(p, m) as { kind: string; paint?: string };
    expect(v.kind).toBe("rewrite");
    expect(v.paint).toBe("S");
  });
});
