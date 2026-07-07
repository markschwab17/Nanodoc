import { describe, it, expect } from "vitest";
import { detectTitleBlock } from "./cleanupDetect";
import type { PageExtract, Label, Geom } from "@/features/stitch/autostitch/types";

const L = (text: string, x: number, y: number): Label =>
  ({ text, x, y, endX: x + 120, endY: y, angle: 0, h: 10, font: null });
const VIEW = [0, 0, 2592, 1728] as [number, number, number, number];
const base = (labels: Label[], geometry: Geom[] = []): PageExtract =>
  ({ view: VIEW, shxLabels: [], labels, words: labels, geometry });

describe("detectTitleBlock", () => {
  it("finds a right-edge title-block strip and snaps to the border line", () => {
    // furniture clustered on the right margin (x ~ 2100-2400)
    const furn = [L("RICK ENGINEERING", 2120, 200), L("REV 3  06/01/26", 2120, 400), L("SHEET C5.01", 2120, 1600)];
    // a long vertical border stroke at x=2080 (the title-block frame line)
    const border: Geom = { id: "b", pts: [[2080, 40], [2080, 1690]], closed: false };
    const r = detectTitleBlock(base(furn, [border]), () => true);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("title-block");
    // right strip from the snapped border to the page edge
    expect(r!.rect.x).toBeCloseTo(2080, 0);
    expect(r!.rect.w).toBeCloseTo(2592 - 2080, 0);
    expect(r!.rect.h).toBeCloseTo(1728, 0);
    expect(r!.confidence).toBe("high");
  });

  it("abstains when there is no furniture cluster", () => {
    expect(detectTitleBlock(base([L("BUILDING D", 800, 600)]), () => false)).toBeNull();
  });
});
