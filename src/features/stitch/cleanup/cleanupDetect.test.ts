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

  it("captures a full FOOTER band up to its top border, above the low-sitting text", () => {
    // Constant footer fields sit at the very bottom edge (y ~ 1690), but the
    // footer's TOP border is a full-width grid line 140pt higher (y = 1548).
    // The strip must reach the top border, not stop at the text or the frame.
    const furn = [L("PROJECT 194786001", 1100, 1690), L("04/28/2026", 1900, 1695), L("30850 DATE PALM DR", 900, 1700)];
    const topBorder: Geom = { id: "t", pts: [[20, 1548], [2570, 1548]], closed: false }; // footer top
    const frame: Geom = { id: "f", pts: [[20, 1691], [2570, 1691]], closed: false };      // outer sheet frame
    const r = detectTitleBlock(base(furn, [topBorder, frame]), () => true);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("title-block");
    expect(r!.rect.x).toBeCloseTo(0, 0);
    expect(r!.rect.w).toBeCloseTo(2592, 0);
    expect(r!.rect.y).toBeCloseTo(1548, 0);       // reaches the top border, not the 1691 frame
    expect(r!.rect.h).toBeCloseTo(1728 - 1548, 0);
    expect(r!.confidence).toBe("high");
  });

  it("falls back to the furniture inner edge for a wide right strip with no inner border line", () => {
    // A right-column title block whose inner boundary is horizontal dividers, not
    // one tall vertical line — the only full-height vertical is the outer frame.
    // The walk would trap on the frame; it must fall back to the furniture edge.
    const furn = [L("RICK ENGINEERING", 1855, 300), L("VICINITY MAP", 2000, 800), L("SHEET C1.0", 2200, 1400)];
    const frame: Geom = { id: "f", pts: [[2556, 40], [2556, 1690]], closed: false }; // outer frame only
    const r = detectTitleBlock(base(furn, [frame]), () => true);
    expect(r).not.toBeNull();
    // innermost furniture CENTER (label at x=1855, cx = 1855 + 60), NOT trapped at the 2556 frame
    expect(r!.rect.x).toBeCloseTo(1915, 0);
    expect(r!.rect.w).toBeCloseTo(2592 - 1915, 0);
    expect(r!.confidence).toBe("medium");          // no inner border to snap to
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
