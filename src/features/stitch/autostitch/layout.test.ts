import { describe, it, expect } from "vitest";
import { layoutPlacements, type PlacedSheetPose } from "./layout";

describe("layoutPlacements", () => {
  it("keeps the root sheet native size and repositions same-scale sheets", () => {
    const sheets: PlacedSheetPose[] = [
      { pageIndex: 0, scale: 20, sizePt: { w: 2592, h: 1728 }, posFt: { x: 0, y: 0 } },
      { pageIndex: 1, scale: 20, sizePt: { w: 2592, h: 1728 }, posFt: { x: 300, y: 0 } },
    ];
    const out = layoutPlacements(sheets, 20, { margin: 20 });
    const a = out.find((p) => p.pageIndex === 0)!;
    const b = out.find((p) => p.pageIndex === 1)!;
    expect(a.width).toBeCloseTo(2592, 6); // root unchanged
    expect(a.x).toBeCloseTo(20, 6);
    // 300 ft * (72/20) pt/ft = 1080 pt to the right
    expect(b.x - a.x).toBeCloseTo(1080, 6);
    expect(b.width).toBeCloseTo(2592, 6);
    expect(a.aligned && b.aligned).toBe(true);
  });

  it("enlarges a coarser-scale sheet to share the root frame", () => {
    const sheets: PlacedSheetPose[] = [
      { pageIndex: 0, scale: 20, sizePt: { w: 2592, h: 1728 }, posFt: { x: 0, y: 0 } },
      { pageIndex: 1, scale: 30, sizePt: { w: 2592, h: 1728 }, posFt: { x: 0, y: 0 } },
    ];
    const out = layoutPlacements(sheets, 20);
    const b = out.find((p) => p.pageIndex === 1)!;
    expect(b.width).toBeCloseTo(2592 * 1.5, 6); // 30/20 = 1.5
  });

  it("grid-drops unplaced sheets below the aligned cluster", () => {
    const sheets: PlacedSheetPose[] = [
      { pageIndex: 0, scale: 20, sizePt: { w: 1000, h: 800 }, posFt: { x: 0, y: 0 } },
      { pageIndex: 1, scale: 20, sizePt: { w: 1000, h: 800 }, posFt: null },
    ];
    const out = layoutPlacements(sheets, 20, { margin: 20 });
    const unplaced = out.find((p) => p.pageIndex === 1)!;
    expect(unplaced.aligned).toBe(false);
    expect(unplaced.y).toBeGreaterThan(20 + 800); // below the aligned tile
    expect(unplaced.width).toBeCloseTo(1000, 6); // native size, not rescaled
  });
});
