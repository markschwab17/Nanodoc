import { describe, expect, test } from "vitest";
import { sliceExtract, stripFrames } from "./frameDetect";
import type { Geom, PageExtract } from "./types";

const page = (geometry: Geom[], extra: Partial<PageExtract> = {}): PageExtract => ({
  view: [0, 0, 2592, 1728], shxLabels: [], labels: [], words: [], geometry, ...extra,
});

describe("stripFrames", () => {
  const view: [number, number, number, number] = [0, 0, 2592, 1728];
  const lbl = (text: string, x: number, y: number) =>
    ({ text, x, y, endX: x + 80, endY: y + 10, angle: 0, h: 10, font: "ocr" });
  test("below+above strip refs split the page at their midpoint", () => {
    const f = stripFrames([lbl("SEE BELOW LEFT", 2500, 400), lbl("SEE ABOVE RIGHT", 10, 1200)], view);
    expect(f).toHaveLength(2);
    expect(f![0].bbox).toEqual([0, 0, 2592, 805]);   // midpoint of centers (405, 1205)
    expect(f![1].bbox).toEqual([0, 805, 2592, 1728]);
  });
  test("null without a matched pair", () => {
    expect(stripFrames([lbl("SEE BELOW LEFT", 2500, 400)], view)).toBeNull();
    expect(stripFrames([lbl("SEE SHEET 9", 2500, 400)], view)).toBeNull();
  });
  test("null when refs are inverted (below under above)", () => {
    expect(stripFrames([lbl("SEE BELOW LEFT", 2500, 1200), lbl("SEE ABOVE RIGHT", 10, 400)], view)).toBeNull();
  });
  test("null when the split would be implausibly near an edge", () => {
    expect(stripFrames([lbl("SEE BELOW LEFT", 2500, 100), lbl("SEE ABOVE RIGHT", 10, 300)], view)).toBeNull();
  });
});

describe("sliceExtract", () => {
  test("filters and normalizes to frame-local coordinates", () => {
    const inLbl  = { text: "SEE SHEET 9", x: 500, y: 770, endX: 580, endY: 778, angle: 0, h: 8, font: null };
    const outLbl = { text: "ELSEWHERE 1", x: 100, y: 100, endX: 180, endY: 108, angle: 0, h: 8, font: null };
    const inG: Geom  = { id: "a", pts: [[600, 900], [700, 900]], closed: false };
    const outG: Geom = { id: "b", pts: [[100, 100], [200, 100]], closed: false };
    const s = sliceExtract(page([inG, outG], { labels: [inLbl, outLbl] }), { bbox: [60, 760, 2300, 1560] });
    expect(s.view).toEqual([0, 0, 2240, 800]);
    expect(s.labels).toHaveLength(1);
    expect(s.labels[0].x).toBeCloseTo(440); // 500 - 60
    expect(s.labels[0].y).toBeCloseTo(10);  // 770 - 760
    expect(s.geometry).toHaveLength(1);
    expect(s.geometry[0].pts[0]).toEqual([540, 140]);
  });
});
