import { describe, it, expect } from "vitest";
import { moveRegion, resizeRegion, clampRegion, deleteAt, clampOffset, type FRect } from "./regionEdit";

const R = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
// field-wise approx equality (fraction math carries floating-point noise)
const expectRect = (r: FRect, e: FRect) => {
  expect(r.x).toBeCloseTo(e.x); expect(r.y).toBeCloseTo(e.y);
  expect(r.w).toBeCloseTo(e.w); expect(r.h).toBeCloseTo(e.h);
};

describe("moveRegion", () => {
  it("translates by fraction delta", () => {
    expectRect(moveRegion(R, 0.1, -0.1), { x: 0.5, y: 0.3, w: 0.2, h: 0.2 });
  });
  it("clamps inside the tile, preserving size", () => {
    expectRect(moveRegion(R, 1, 1), { x: 0.8, y: 0.8, w: 0.2, h: 0.2 });
    expectRect(moveRegion(R, -1, -1), { x: 0, y: 0, w: 0.2, h: 0.2 });
  });
});

describe("resizeRegion", () => {
  it("east handle grows width, fixes left edge", () => {
    expectRect(resizeRegion(R, "e", 0.1, 0, 0.02, 0.02), { x: 0.4, y: 0.4, w: 0.3, h: 0.2 });
  });
  it("north handle moves top, fixes bottom", () => {
    const r = resizeRegion(R, "n", 0, -0.1, 0.02, 0.02);
    expect(r.y).toBeCloseTo(0.3);
    expect(r.h).toBeCloseTo(0.3); // bottom (0.6) fixed
  });
  it("nw corner resizes both, opposite corner fixed", () => {
    const r = resizeRegion(R, "nw", -0.1, -0.1, 0.02, 0.02);
    expect(r.x).toBeCloseTo(0.3);
    expect(r.y).toBeCloseTo(0.3);
    expect(r.w).toBeCloseTo(0.3);
    expect(r.h).toBeCloseTo(0.3);
  });
  it("enforces min size on the dragged edge", () => {
    const r = resizeRegion(R, "e", -1, 0, 0.05, 0.05); // collapse width
    expect(r.x).toBeCloseTo(0.4); // left fixed
    expect(r.w).toBeCloseTo(0.05); // min width
  });
  it("clamps a growing edge to the tile bound", () => {
    const r = resizeRegion(R, "e", 1, 0, 0.02, 0.02);
    expect(r.x + r.w).toBeCloseTo(1);
  });
});

describe("clampRegion", () => {
  it("floors size to min and keeps inside [0,1]", () => {
    expectRect(clampRegion({ x: 0.95, y: 0.5, w: 0.5, h: 0.01 }, 0.05, 0.05), { x: 0.5, y: 0.5, w: 0.5, h: 0.05 });
  });
});

describe("deleteAt", () => {
  it("removes the index", () => {
    expect(deleteAt([1, 2, 3], 1)).toEqual([1, 3]);
  });
});

describe("clampOffset", () => {
  it("passes an in-bounds offset through", () => {
    const o = clampOffset(R, 0.1, -0.1);
    expect(o.dx).toBeCloseTo(0.1);
    expect(o.dy).toBeCloseTo(-0.1);
  });
  it("clamps so the rect can't leave the left/top edge", () => {
    const o = clampOffset(R, -1, -1);
    expect(o.dx).toBeCloseTo(-0.4); // x0 (0.4) → 0
    expect(o.dy).toBeCloseTo(-0.4);
  });
  it("clamps so the rect can't leave the right/bottom edge", () => {
    const o = clampOffset(R, 1, 1);
    expect(o.dx).toBeCloseTo(1 - 0.2 - 0.4); // 0.4 → 0.8 (x1 = 1)
    expect(o.dy).toBeCloseTo(1 - 0.2 - 0.4);
  });
});
