import { describe, it, expect } from "vitest";
import {
  LOUPE_SIZE_PX,
  buildSnapIndex,
  canvasToPagePoint,
  findSnapPoint,
  loupeCropRect,
  loupeDrawPlan,
  loupeMagnification,
  pagePointToCanvas,
  placeLoupe,
  planCropRender,
  snapRadiusPagePt,
  tileScaleFromPage,
} from "./loupeGeometry";
import type { TilePose } from "./stitchGeometry";

/** A 36x24 in sheet (2592x1728 pt) placed at half size on the canvas. */
const sheet: TilePose = { x: 100, y: 50, width: 1296, height: 864, rotation: 0 };
const page = { widthPt: 2592, heightPt: 1728 };

const apply = (
  m: [number, number, number, number, number, number],
  x: number,
  y: number
) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

describe("loupe crop maths", () => {
  it("maps a canvas point onto the source page and back", () => {
    const canvasPoint = { x: sheet.x + 300, y: sheet.y + 200 };
    const pt = canvasToPagePoint(canvasPoint, sheet, page)!;
    expect(pt.x).toBeCloseTo(600, 6); // 300 canvas units at 0.5 scale
    expect(pt.y).toBeCloseTo(400, 6);
    const back = pagePointToCanvas(pt, sheet, page);
    expect(back.x).toBeCloseTo(canvasPoint.x, 6);
    expect(back.y).toBeCloseTo(canvasPoint.y, 6);
  });

  it("round-trips through a rotated tile", () => {
    const rotated: TilePose = { ...sheet, rotation: 33 };
    const canvasPoint = { x: rotated.x + 511, y: rotated.y + 122 };
    const pt = canvasToPagePoint(canvasPoint, rotated, page)!;
    const back = pagePointToCanvas(pt, rotated, page);
    expect(back.x).toBeCloseTo(canvasPoint.x, 6);
    expect(back.y).toBeCloseTo(canvasPoint.y, 6);
  });

  it("sizes the crop from the magnification, centred on the cursor", () => {
    const k = tileScaleFromPage(sheet, page); // 0.5 canvas units per page pt
    expect(k).toBeCloseTo(0.5, 9);
    const crop = loupeCropRect({ x: 600, y: 400 }, sheet, page, 4);
    // 220 px / 4x = 55 canvas units across; / 0.5 = 110 page points.
    expect(crop.width).toBeCloseTo(110, 6);
    expect(crop.height).toBeCloseTo(110, 6);
    expect(crop.x).toBeCloseTo(600 - 55, 6);
    expect(crop.y).toBeCloseTo(400 - 55, 6);
  });

  it("magnifies relative to the current zoom, within bounds", () => {
    expect(loupeMagnification(1)).toBe(4);
    expect(loupeMagnification(0.1)).toBe(3); // floor
    expect(loupeMagnification(10)).toBe(16); // ceiling
    expect(loupeMagnification(0)).toBe(4); // degenerate zoom → treated as 1
  });

  it("puts the crop centre at the pixmap centre and only rasterises the crop", () => {
    const crop = { x: 100, y: 200, width: 36, height: 36 };
    const plan = planCropRender(crop, 144, 0);
    expect(plan.width).toBe(72);
    expect(plan.height).toBe(72);
    expect(plan.bbox).toEqual([0, 0, 72, 72]);
    const centre = apply(plan.matrix, 118, 218);
    expect(centre.x).toBeCloseTo(36, 6);
    expect(centre.y).toBeCloseTo(36, 6);
    const topLeft = apply(plan.matrix, 100, 200);
    expect(topLeft.x).toBeCloseTo(0, 6);
    expect(topLeft.y).toBeCloseTo(0, 6);
  });

  it("drops the dpi rather than the coverage when the crop would be huge", () => {
    const plan = planCropRender({ x: 0, y: 0, width: 1000, height: 1000 }, 300, 0, 1024);
    expect(plan.width).toBe(1024);
    expect(plan.height).toBe(1024);
    expect(plan.dpi).toBeLessThan(300);
    expect(plan.pixelsPerPoint).toBeCloseTo(1.024, 6);
  });

  it("rotates the crop the same way the tile is rotated on the canvas", () => {
    const plan = planCropRender({ x: 0, y: 0, width: 10, height: 10 }, 72, 90);
    expect(plan.width).toBe(10);
    expect(plan.height).toBe(10);
    // The crop's right edge midpoint lands at the bottom (clockwise, y-down).
    const right = apply(plan.matrix, 10, 5);
    expect(right.x).toBeCloseTo(5, 6);
    expect(right.y).toBeCloseTo(10, 6);
  });

  it("grows the pixmap so a rotated crop still covers the whole circle", () => {
    const plan = planCropRender({ x: 0, y: 0, width: 100, height: 100 }, 72, 45);
    expect(plan.width).toBe(Math.round(100 * Math.SQRT2));
  });

  it("centres the rendered bitmap in the loupe at the right scale", () => {
    const crop = { x: 0, y: 0, width: 110, height: 110 };
    const plan = planCropRender(crop, 300, 0);
    const draw = loupeDrawPlan(crop, plan);
    // Within a pixel of filling the circle: the pixmap is a whole number of pixels,
    // so the crop's own span fills it exactly and the rounding shows up here.
    expect(draw.width).toBeCloseTo(LOUPE_SIZE_PX, 0);
    expect(draw.left).toBeCloseTo(0, 0);
    expect(draw.top).toBeCloseTo(0, 0);
  });
});

describe("loupe placement", () => {
  const viewport = { left: 0, top: 0, width: 1200, height: 800 };

  it("sits up and to the right of the cursor", () => {
    const { left, top } = placeLoupe({ x: 400, y: 400 }, viewport);
    expect(left).toBe(418);
    expect(top).toBe(400 - 18 - LOUPE_SIZE_PX);
  });

  it("flips to the left near the right edge", () => {
    const { left } = placeLoupe({ x: 1190, y: 400 }, viewport);
    expect(left).toBe(1190 - 18 - LOUPE_SIZE_PX);
  });

  it("flips below near the top edge", () => {
    const { top } = placeLoupe({ x: 400, y: 10 }, viewport);
    expect(top).toBe(28);
  });

  it("stays inside a viewport that is offset in the page", () => {
    const offset = { left: 300, top: 120, width: 500, height: 400 };
    const { left, top } = placeLoupe({ x: 780, y: 140 }, offset);
    expect(left).toBeGreaterThanOrEqual(offset.left);
    expect(left + LOUPE_SIZE_PX).toBeLessThanOrEqual(offset.left + offset.width);
    expect(top).toBeGreaterThanOrEqual(offset.top);
    expect(top + LOUPE_SIZE_PX).toBeLessThanOrEqual(offset.top + offset.height);
  });
});

describe("snapping to captured lines", () => {
  const path = (...xy: number[]) => ({ pts: Float32Array.from(xy) });

  it("finds a polyline endpoint inside the radius", () => {
    const index = buildSnapIndex([path(10, 10, 60, 10)]);
    const hit = findSnapPoint(index, { x: 12, y: 11 }, 5);
    expect(hit).toEqual({ x: 10, y: 10, kind: "endpoint" });
  });

  it("returns nothing when the nearest feature is outside the radius", () => {
    const index = buildSnapIndex([path(10, 10, 60, 10)]);
    expect(findSnapPoint(index, { x: 35, y: 40 }, 5)).toBeNull();
  });

  it("finds where two strokes cross", () => {
    const index = buildSnapIndex([path(0, 50, 100, 50), path(50, 0, 50, 100)]);
    const hit = findSnapPoint(index, { x: 52, y: 51 }, 6);
    expect(hit?.kind).toBe("intersection");
    expect(hit?.x).toBeCloseTo(50, 6);
    expect(hit?.y).toBeCloseTo(50, 6);
  });

  it("prefers an endpoint to an intersection at the same distance", () => {
    // Endpoint of the short stroke and the crossing both sit 2 units from the cursor.
    const index = buildSnapIndex([
      path(0, 50, 100, 50),
      path(50, 0, 50, 100),
      path(48, 48, 20, 20),
    ]);
    const hit = findSnapPoint(index, { x: 49, y: 49 }, 6);
    expect(hit?.kind).toBe("endpoint");
    expect(hit?.x).toBeCloseTo(48, 6);
  });

  it("ignores parallel strokes that never meet", () => {
    const index = buildSnapIndex([path(0, 0, 100, 0), path(0, 40, 100, 40)]);
    expect(findSnapPoint(index, { x: 50, y: 20 }, 6)).toBeNull();
  });

  it("converts the 6 px snap radius into page points at the current zoom", () => {
    // 0.5 canvas units per page pt, zoom 2 → 1 screen px per page pt.
    expect(snapRadiusPagePt(sheet, page, 2)).toBeCloseTo(6, 6);
    expect(snapRadiusPagePt(sheet, page, 1)).toBeCloseTo(12, 6);
  });
});
