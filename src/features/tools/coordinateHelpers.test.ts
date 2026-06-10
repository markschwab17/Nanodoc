import { describe, expect, it } from "vitest";
import { capCaptureScale, normalizeSelectionToRect } from "./coordinateHelpers";

describe("capCaptureScale", () => {
  it("leaves small pages at the ideal scale", () => {
    // Letter: 612x792 pt — 4x is ~7.7 MP, inside every budget
    expect(capCaptureScale(612, 792, 100, 100, 4)).toBe(4);
  });

  it("caps Arch D construction sheets below the ideal scale", () => {
    // 24x36" = 2592x1728 pt. Uncapped 4x would be ~71 MP (the tab-freeze case).
    const scale = capCaptureScale(2592, 1728, 400, 300, 4);
    expect(scale).toBeLessThan(4);
    const pixels = 2592 * scale * (1728 * scale);
    expect(pixels).toBeLessThanOrEqual(32_000_000);
  });

  it("hard-caps huge site plans to the 8 MP budget", () => {
    // 36x48" = 2592x3456 pt
    const scale = capCaptureScale(2592, 3456, 400, 300, 4);
    const pixels = 2592 * scale * (3456 * scale);
    expect(pixels).toBeLessThanOrEqual(8_000_001);
  });

  it("bounds the crop region's pixels even on small pages", () => {
    const scale = capCaptureScale(612, 792, 2000, 2000, 4);
    const cropPixels = 2000 * scale * (2000 * scale);
    expect(cropPixels).toBeLessThanOrEqual(8_000_001);
  });

  it("never returns more than the ideal scale", () => {
    expect(capCaptureScale(100, 100, 10, 10, 2)).toBeLessThanOrEqual(2);
  });
});

describe("normalizeSelectionToRect", () => {
  it("normalizes any drag direction to bottom-left + extents", () => {
    const rect = normalizeSelectionToRect({ x: 50, y: 80 }, { x: 10, y: 20 });
    expect(rect).toEqual({ x: 10, y: 20, width: 40, height: 60 });
  });
});
