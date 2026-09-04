import { describe, expect, test } from "vitest";
import { sliceExtract, stripFrames, detectDrawingFrame } from "./frameDetect";
import { makeGeom } from "./types";
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
    const inG: Geom  = makeGeom([[600, 900], [700, 900]]);
    const outG: Geom = makeGeom([[100, 100], [200, 100]]);
    const s = sliceExtract(page([inG, outG], { labels: [inLbl, outLbl] }), { bbox: [60, 760, 2300, 1560] });
    expect(s.view).toEqual([0, 0, 2240, 800]);
    expect(s.labels).toHaveLength(1);
    expect(s.labels[0].x).toBeCloseTo(440); // 500 - 60
    expect(s.labels[0].y).toBeCloseTo(10);  // 770 - 760
    expect(s.geometry).toHaveLength(1);
    expect(Array.from(s.geometry[0].pts.slice(0, 2))).toEqual([540, 140]);
  });
});

describe("detectDrawingFrame", () => {
  const view: [number, number, number, number] = [0, 0, 1000, 800];
  const vline = (_id: string, x: number, y0 = 0, y1 = 800) => makeGeom([[x, y0], [x, y1]]);
  const hline = (_id: string, y: number, x0 = 0, x1 = 1000) => makeGeom([[x0, y], [x1, y]]);

  test("finds a frame whose right border is inset 28% behind a notes column", () => {
    // The failure-D shape: the drawing is ruled [20,20]-[720,780] and the right 28%
    // of the sheet is the notes/title column, so page-relative edge rules never see
    // the callouts drawn on the drawing's own right border.
    const f = detectDrawingFrame(
      [vline("l", 20), vline("r", 720), hline("t", 20, 20, 720), hline("b", 780, 20, 720),
       // page border too — the detector must prefer the INNER right ruler
       vline("pl", 2), vline("pr", 998), hline("pt", 2), hline("pb", 798)],
      view,
    );
    expect(f).toEqual([20, 20, 720, 780]);
  });

  test("returns null for a sheet ruled at its page border (nothing to gain)", () => {
    const f = detectDrawingFrame([vline("l", 0), vline("r", 1000), hline("t", 0), hline("b", 800)], view);
    expect(f).toBeNull();
  });

  test("returns null with no geometry", () => {
    expect(detectDrawingFrame([], view)).toBeNull();
  });

  test("ignores a long interior line that would shrink the drawing to nothing", () => {
    // A full-height property line at 30% of the width is not the frame's edge: the
    // right border must be past 55% of the page, so this candidate is skipped and
    // the real border at 720 wins.
    const f = detectDrawingFrame(
      [vline("l", 20), vline("prop", 300), vline("r", 720), hline("t", 20, 20, 720), hline("b", 780, 20, 720)],
      view,
    );
    expect(f).toEqual([20, 20, 720, 780]);
  });
});
