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
});
