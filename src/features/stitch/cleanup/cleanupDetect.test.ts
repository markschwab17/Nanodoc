import { describe, it, expect } from "vitest";
import { detectTitleBlock, detectMatchMargins } from "./cleanupDetect";
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

  it("ignores a stray furniture label in the drawing area (strip stays at the right cluster)", () => {
    const furn = [
      L("RICK ENGINEERING", 2120, 200), L("REV 3  06/01/26", 2120, 400), L("SHEET C5.01", 2120, 1600),
      L("BENCHMARK NOTE 12", 700, 900), // a repeated label out in the drawing area, furniture-flagged
    ];
    const r = detectTitleBlock(base(furn), () => true);
    expect(r).not.toBeNull();
    // inner edge stays at the right cluster (~2120), NOT dragged left to the 700 outlier
    expect(r!.rect.x).toBeGreaterThan(2000);
    expect(r!.rect.w).toBeLessThan(700);
  });
});

describe("detectMatchMargins", () => {
  it("proposes the overlap strip between a match line and its paper edge", () => {
    // A MATCHLINE label near y=250 (y-down frame: this is near y0, so parseSheetRefs
    // classifies it edge="bottom" — see cleanupDetect.ts's detectMatchMargins comment),
    // plus the actual long horizontal match-line stroke at y=260.
    const label = { text: "MATCHLINE (SEE SHEET C5.01)", x: 900, y: 250, endX: 1400, endY: 250, angle: 0, h: 10, font: null };
    const line = { id: "m", pts: [[60, 260], [2500, 260]] as [number, number][], closed: false };
    const regions = detectMatchMargins({ view: VIEW, shxLabels: [], labels: [label], words: [label], geometry: [line] });
    expect(regions.length).toBe(1);
    expect(regions[0].kind).toBe("match-margin");
    // near-y0 ("bottom") edge: strip from y0=0 down to the line at 260
    expect(regions[0].rect.y).toBeCloseTo(0, 0);
    expect(regions[0].rect.h).toBeCloseTo(260, 0);
    expect(regions[0].rect.w).toBeCloseTo(2592, 0);
  });

  it("abstains when the match-line stroke isn't found", () => {
    const label = { text: "MATCHLINE (SEE SHEET C5.01)", x: 900, y: 250, endX: 1400, endY: 250, angle: 0, h: 10, font: null };
    expect(detectMatchMargins({ view: VIEW, shxLabels: [], labels: [label], words: [label], geometry: [] })).toEqual([]);
  });
});
