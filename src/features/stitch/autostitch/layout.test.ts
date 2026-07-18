import { describe, it, expect, test } from "vitest";
import { layoutPlacements, frameMask, type PlacedSheetPose } from "./layout";

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

describe("frame-anchored layout", () => {
  test("page origin is offset so the FRAME lands at the solved position", () => {
    // Two units, same scale: root frame at (0,0)ft, second at (100,0)ft.
    // Frames are inset 100pt from their page origins → page tiles must sit
    // 100*si pt left of where a whole-page pose would.
    const poses = [
      { pageIndex: 0, scale: 20, sizePt: { w: 720, h: 480 }, posFt: { x: 0, y: 0 }, frame: [100, 50, 700, 450] as [number, number, number, number] },
      { pageIndex: 1, scale: 20, sizePt: { w: 720, h: 480 }, posFt: { x: 100, y: 0 }, frame: [100, 50, 700, 450] as [number, number, number, number] },
    ];
    const out = layoutPlacements(poses, 20, { margin: 0 });
    // P = 72/20 = 3.6 pt/ft; si = 1
    expect(out[0].x).toBeCloseTo(-100);       // 0*P - frameX*si
    expect(out[0].y).toBeCloseTo(-50);
    expect(out[1].x).toBeCloseTo(100 * 3.6 - 100);
    expect(out[0].sourceFrame).toEqual([100, 50, 700, 450]);
  });
  test("two units of one page yield two placements for that pageIndex", () => {
    const poses = [
      { pageIndex: 3, scale: 20, sizePt: { w: 720, h: 480 }, posFt: { x: 0, y: 0 }, frame: [50, 40, 700, 220] as [number, number, number, number] },
      { pageIndex: 3, scale: 20, sizePt: { w: 720, h: 480 }, posFt: { x: 0, y: 60 }, frame: [50, 260, 700, 440] as [number, number, number, number] },
    ];
    const out = layoutPlacements(poses, 20, { margin: 0 });
    expect(out.filter((p) => p.pageIndex === 3)).toHaveLength(2);
    expect(out[0].aligned && out[1].aligned).toBe(true);
  });
});

describe("frameMask", () => {
  test("complement of an inset frame is 4 fractional bands", () => {
    const m = frameMask([100, 50, 700, 450], 720, 480);
    expect(m).toEqual([
      { x: 0, y: 0, w: 1, h: 50 / 480 },                    // top
      { x: 0, y: 450 / 480, w: 1, h: 1 - 450 / 480 },       // bottom
      { x: 0, y: 0, w: 100 / 720, h: 1 },                   // left
      { x: 700 / 720, y: 0, w: 1 - 700 / 720, h: 1 },       // right
    ]);
  });
  test("full-page frame yields no masks", () => {
    expect(frameMask([0, 0, 720, 480], 720, 480)).toEqual([]);
  });
});
