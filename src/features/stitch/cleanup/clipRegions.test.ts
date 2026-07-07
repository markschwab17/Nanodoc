import { describe, it, expect } from "vitest";
import { cssClipPathWithHoles } from "./clipRegions";

describe("cssClipPathWithHoles", () => {
  it("returns null with no holes", () => {
    expect(cssClipPathWithHoles(100, 100, [])).toBeNull();
  });
  it("produces a polygon that includes the outer rect and the hole corners", () => {
    const p = cssClipPathWithHoles(200, 100, [{ x: 50, y: 25, w: 50, h: 50 }]);
    expect(p).not.toBeNull();
    expect(p!.startsWith("polygon(")).toBe(true);
    // outer corners present
    expect(p).toContain("0% 0%");
    expect(p).toContain("100% 100%");
    // hole corners as percentages: x 50/200=25%, 100/200=50%; y 25/100=25%, 75/100=75%
    expect(p).toContain("25% 25%");
    expect(p).toContain("50% 75%");
  });
});
