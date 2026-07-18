import { describe, it, expect } from "vitest";
import { parseScaleNotes, parseDistanceTokens, parseStations, parseBearings, parseSheetRefs } from "./tokens";
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
});
