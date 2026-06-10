/**
 * The scale bar is a measurement reference: the distance from the first tick
 * (0) to the last tick (feetPerInch) must be EXACTLY 1 inch when the stamp is
 * placed at its canonical size (tile width = getScaleStampDimensions().widthPt).
 */

import { describe, expect, test } from "vitest";
import {
  getScaleBarGeometry,
  getScaleStampDimensions,
  PX_PER_PT,
} from "./scaleStamp";
import { PT_PER_INCH } from "./stitchConstants";

describe("getScaleBarGeometry", () => {
  test.each([5, 10, 20, 30, 40, 50, 100])(
    "tick span is exactly 1 inch for 1\"=%i'",
    (feetPerInch) => {
      const geom = getScaleBarGeometry(feetPerInch);
      expect(geom.spanPx).toBe(PT_PER_INCH * PX_PER_PT);
    }
  );

  test("image pixel grid maps 1:1 onto the canonical tile size (PX_PER_PT)", () => {
    const { widthPt, heightPt } = getScaleStampDimensions(20);
    const geom = getScaleBarGeometry(20);
    expect(geom.imageWidthPx).toBe(Math.round(widthPt * PX_PER_PT));
    expect(geom.imageHeightPx).toBe(Math.round(heightPt * PX_PER_PT));
  });

  test("span is horizontally centered and inside the image", () => {
    const geom = getScaleBarGeometry(20);
    expect(geom.spanLeftPx).toBeGreaterThanOrEqual(0);
    expect(geom.spanLeftPx + geom.spanPx).toBeLessThanOrEqual(geom.imageWidthPx);
    const rightGap = geom.imageWidthPx - (geom.spanLeftPx + geom.spanPx);
    expect(Math.abs(rightGap - geom.spanLeftPx)).toBeLessThanOrEqual(1);
  });
});
