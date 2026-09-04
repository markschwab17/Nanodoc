import { describe, it, expect } from "vitest";
import { parseScaleNotes, parseDistanceTokens, parseStations, parseBearings, parseSheetRefs, mergeMatchlineRefLabels } from "./tokens";
import type { Label } from "./types";

const L = (text: string, x = 0, y = 0, endX = 0, endY = 0): Label =>
  ({ text, x, y, endX: endX || x, endY: endY || y, angle: 0, h: 8, font: null });

describe("tokens", () => {
  it("parses stated scale notes incl. arch fractions", () => {
    expect(parseScaleNotes([L('1" = 20\'')])[0].ftPerIn).toBeCloseTo(20, 6);
    expect(parseScaleNotes([L('1/8" = 1\'-0"')])[0].ftPerIn).toBeCloseTo(8, 6);
  });

  it("parses decimal-feet and feet-inch distance tokens; rejects stations", () => {
    expect(parseDistanceTokens([L("105.49'")])[0].ft).toBeCloseTo(105.49, 6);
    expect(parseDistanceTokens([L("12'-6\"")])[0].ft).toBeCloseTo(12.5, 6);
    expect(parseDistanceTokens([L("10+36.00")])).toHaveLength(0);
  });

  it("parses station tokens to feet", () => {
    expect(parseStations([L("10+36.00")])[0].ft).toBeCloseTo(1036, 6);
  });

  it("parses a bearing+distance label to azimuth and distance", () => {
    const b = parseBearings([L("N89°55'47\"W 734.66'")])[0];
    expect(b.az).toBeCloseTo(270.07, 1);
    expect(b.ft).toBeCloseTo(734.66, 2);
  });

  it("classifies an edge sheet reference", () => {
    // view 2592x1728; label near the left edge
    const r = parseSheetRefs([L("SEE SHEET NO. 8", 50, 800)], [0, 0, 2592, 1728])[0];
    expect(r.sheet).toBe(8);
    expect(r.edge).toBe("left");
  });

  it("flags a matchline label with a station", () => {
    const r = parseSheetRefs([L("MATCHLINE 10+72.00", 1200, 20)], [0, 0, 2592, 1728])[0];
    expect(r.matchline).toBe(true);
    expect(r.station).toBe("10+72.00");
  });

  it("parses an alphanumeric discipline-code cross-reference", () => {
    const r = parseSheetRefs([L("MATCHLINE (SEE SHEET C5.4)", 50, 800)], [0, 0, 2592, 1728])[0];
    expect(r.sheetCode).toBe("C5.4");
    expect(r.sheet).toBeNull();
    expect(r.matchline).toBe(true);
    expect(r.edge).toBe("left");
  });
});

describe("strip refs", () => {
  const view: [number, number, number, number] = [0, 0, 1000, 800];
  const label = (text: string, x: number, y: number) =>
    ({ text, x, y, endX: x + 80, endY: y + 8, angle: 0, h: 8, font: null });

  it("SEE BELOW LEFT on the right edge parses as a strip ref", () => {
    const refs = parseSheetRefs([label("SEE BELOW LEFT", 950, 400)], view);
    expect(refs).toHaveLength(1);
    expect(refs[0].strip).toBe("below");
    expect(refs[0].stripSide).toBe("left");
    expect(refs[0].matchline).toBe(true);
    expect(refs[0].edge).toBe("right");
    expect(refs[0].sheet).toBeNull();
  });
  it("SEE ABOVE RIGHT parses symmetrically", () => {
    const refs = parseSheetRefs([label("SEE ABOVE RIGHT", 5, 400)], view);
    expect(refs[0].strip).toBe("above");
    expect(refs[0].stripSide).toBe("right");
  });
  it("plain SEE SHEET refs have strip null", () => {
    const refs = parseSheetRefs([label("SEE SHEET 12", 950, 400)], view);
    expect(refs[0].strip).toBeNull();
    expect(refs[0].sheet).toBe(12);
  });
  it("underscore-joined OCR output parses (SEE ABOVE_RIGHT)", () => {
    const refs = parseSheetRefs([label("SEE ABOVE_RIGHT", 5, 400)], view);
    expect(refs[0].strip).toBe("above");
    expect(refs[0].stripSide).toBe("right");
  });
  it("side word optional: 'SEE BELOW' alone parses with stripSide null", () => {
    const refs = parseSheetRefs([label("SEE BELOW", 950, 400)], view);
    expect(refs).toHaveLength(1);
    expect(refs[0].strip).toBe("below");
    expect(refs[0].stripSide).toBeNull();
    expect(refs[0].matchline).toBe(true);
  });
});

describe("split matchline callouts (CAD emits two runs)", () => {
  const view: [number, number, number, number] = [0, 0, 2592, 1728];
  // One run per text, positioned by its CENTRE, so co-location is explicit.
  const run = (text: string, cx: number, cy: number, w = 60, h = 10, angle = 0): Label =>
    ({ text, x: cx - w / 2, y: cy - h / 2, endX: cx + w / 2, endY: cy + h / 2, angle, h, font: null });

  it("merges a co-located MATCH LINE run with its SEE SHEET run into ONE ref", () => {
    const labels = [run("MATCH LINE", 100, 800), run("SEE SHEET C-302", 175, 800)];
    const refs = parseSheetRefs(labels, view);
    expect(refs).toHaveLength(1);                    // one callout, not two
    expect(refs[0].matchline).toBe(true);            // the flag matchlineStrokePrior needs
    expect(refs[0].sheetCode).toBe("C-302");         // and the reference, on the SAME ref
    expect(refs[0].edge).toBe("left");
  });

  it("merges a numeric split callout too", () => {
    const refs = parseSheetRefs([run("MATCH LINE", 100, 800), run("SEE SHEET 6", 170, 800)], view);
    expect(refs).toHaveLength(1);
    expect(refs[0].matchline).toBe(true);
    expect(refs[0].sheet).toBe(6);
  });

  it("does NOT merge runs that are far apart", () => {
    // 900 pt apart, ~90x the text height: two unrelated callouts.
    const refs = parseSheetRefs([run("MATCH LINE", 100, 800), run("SEE SHEET 6", 1000, 800)], view);
    expect(refs).toHaveLength(2);
    expect(refs.find((r) => r.matchline && r.sheet != null)).toBeUndefined();
  });

  it("does NOT merge runs drawn at different angles", () => {
    const refs = parseSheetRefs([run("MATCH LINE", 100, 800, 60, 10, 0), run("SEE SHEET 6", 170, 800, 60, 10, 90)], view);
    expect(refs).toHaveLength(2);
  });

  it("leaves an already-complete callout and unrelated labels untouched", () => {
    const labels = [run("MATCH LINE SEE SHEET 6", 100, 800), run("TC 347.33", 120, 810)];
    expect(mergeMatchlineRefLabels(labels)).toBe(labels); // same array, no copy
  });

  it("consumes each run at most once (two callouts, two refs)", () => {
    const labels = [
      run("MATCH LINE", 100, 200), run("SEE SHEET 6", 170, 200),
      run("MATCH LINE", 100, 1500), run("SEE SHEET 8", 170, 1500),
    ];
    const refs = parseSheetRefs(labels, view);
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.sheet).sort()).toEqual([6, 8]);
    expect(refs.every((r) => r.matchline)).toBe(true);
  });
});

describe("fuzzy OCR spellings of the callout vocabulary", () => {
  const view: [number, number, number, number] = [0, 0, 2592, 1728];
  const at = (text: string, x: number, y: number): Label =>
    ({ text, x, y, endX: x + 200, endY: y + 12, angle: 0, h: 12, font: "ocr" });

  // Every string below is verbatim tesseract output from the Belcourt set.
  it("'MATCH LINE SEE SHEEET 6' (doubled E) parses as a matchline ref to 6", () => {
    const r = parseSheetRefs([at("MATCH LINE SEE SHEEET 6 |", 50, 800)], view)[0];
    expect(r.sheet).toBe(6);
    expect(r.matchline).toBe(true);
  });

  it("'SE. SHEET 7' inside a run of grading text parses as a ref to 7", () => {
    const r = parseSheetRefs([at("GFF 293. SE. SHEET 7 95", 50, 800)], view)[0];
    expect(r.sheet).toBe(7);
  });

  it("'MA TCH LINE' (split MATCH) is still a matchline", () => {
    const r = parseSheetRefs([at("MA TCH LINE", 1200, 20)], view)[0];
    expect(r.matchline).toBe(true);
  });

  it("'MATCH LIME' (N read as M) is still a matchline", () => {
    const r = parseSheetRefs([at("MATCH LIME SEE SHEET 8", 1200, 20)], view)[0];
    expect(r.matchline).toBe(true);
    expect(r.sheet).toBe(8);
  });

  it("does not fire on ordinary drawing text containing 'SE'", () => {
    expect(parseSheetRefs([at("REUSE SHEET FLOW PER PLAN", 50, 800)], view)).toHaveLength(0);
    expect(parseSheetRefs([at("PHASE SHEETING DETAIL", 50, 800)], view)).toHaveLength(0);
  });
});
