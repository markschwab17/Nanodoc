import { describe, expect, it } from "vitest";
import { anyErasedIn, buildEraseMask, sampleState, STATE_ERASED, STATE_KEPT, STATE_NONE, type EraseMask } from "./eraseMask";
import { decidePath, keptIntervals, subCubic } from "./pathDecision";
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
  paint, clip: false, editable: true, ctm,
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
    expect(decidePath(line(10, 60.5, 190, 60.5), m)).toEqual({ kind: "erase" });
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
    expect(decidePath(line(60.5, 10, 60.5, 190, rot), m)).toEqual({ kind: "erase" });
    expect(decidePath(line(20.5, 10, 20.5, 190, rot), m)).toEqual({ kind: "keep" });
  });

  it("judges fills whole, by majority of their inked samples", () => {
    const box = (x: number, y: number) => x >= 20 && x < 80 && y >= 20 && y < 80;
    const fill = (x0: number, y0: number, x1: number, y1: number): PaintedPath => ({
      subpaths: [{ x0, y0, closed: true, segs: [{ kind: "l", pts: [x1, y0] }, { kind: "l", pts: [x1, y1] }, { kind: "l", pts: [x0, y1] }] }],
      paint: "f", clip: false, editable: true, ctm: IDENTITY,
    });
    const most = makeMask(100, 100, box, (x) => x < 65);
    expect(decidePath(fill(20, 20, 80, 80), most)).toEqual({ kind: "erase" });
    const little = makeMask(100, 100, box, (x) => x >= 70);
    expect(decidePath(fill(20, 20, 80, 80), little)).toEqual({ kind: "keep" });
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
      paint: "S", clip: false, editable: true, ctm: IDENTITY,
    };
    const v = decidePath(poly, m);
    expect(v).toEqual({ kind: "rewrite", construction: "10 20.5 m 100.5 20.5 l" });
  });
});
