import { describe, it, expect } from "vitest";
import { extractPageLabel, disciplineOf, classifySheetRole } from "./pageLabels";
import type { Label } from "./types";

const L = (text: string, x: number, y: number, h = 20): Label =>
  ({ text, x, y, endX: x + text.length * 10, endY: y, angle: 0, h, font: null });

const VIEW = [0, 0, 2592, 1728] as [number, number, number, number];

describe("extractPageLabel", () => {
  it("reads a title-block sheet code + discipline from a corner code (y-down frame)", () => {
    const page = {
      view: VIEW,
      labels: [
        L("C5.01", 2400, 1600, 28), // bottom-right title-block code (y-down: high x, high y)
        L("PRECISE GRADING PLAN", 2200, 1550, 22),
        L("BOUNDARY AVENUE", 800, 600, 12), // in-drawing label, not a code
      ],
    };
    const r = extractPageLabel(page);
    expect(r.sheetCode).toBe("C5.01");
    expect(r.discipline).toBe("C5");
    expect(r.confidence).toBe("high");
  });

  it("also reads a code near the TOP-right (y-up frame) — frame-agnostic", () => {
    const page = { view: VIEW, labels: [L("A2.01", 2400, 120, 28)] };
    expect(extractPageLabel(page).sheetCode).toBe("A2.01");
  });

  it("returns null when no title-block code is present", () => {
    const page = { view: VIEW, labels: [L("BUILDING D", 800, 600, 12), L("MERCURY AVENUE", 400, 900, 12)] };
    expect(extractPageLabel(page).sheetCode).toBeNull();
  });

  it("buckets disciplines from a code", () => {
    expect(disciplineOf("C5.1")).toBe("C5");
    expect(disciplineOf("L-6")).toBe("L6");
    expect(disciplineOf("A2.01")).toBe("A2");
    expect(disciplineOf(null)).toBeNull();
  });
});

describe("classifySheetRole", () => {
  it("titles that mark a sheet as not-a-tile", () => {
    expect(classifySheetRole("OVERALL SITE PLAN")).toBe("overall");
    expect(classifySheetRole("KEY PLAN")).toBe("keyplan");
    expect(classifySheetRole("SHEET INDEX")).toBe("index");
    expect(classifySheetRole("GENERAL NOTES 1")).toBe("notes");
    expect(classifySheetRole("LANDSCAPE DETAILS")).toBe("details");
    expect(classifySheetRole("DETAIL")).toBe("details");
  });

  it("a plan sheet is a tile", () => {
    expect(classifySheetRole("PRECISE GRADING PLAN")).toBe("tile");
    expect(classifySheetRole("DRAINAGE PLAN")).toBe("tile");
    expect(classifySheetRole(null)).toBe("tile"); // unknown ⇒ keep solving, as before
  });

  it("does not fire on a word that merely contains one of the terms", () => {
    expect(classifySheetRole("KEYNOTES PLAN")).toBe("tile");
  });

  it("a sheet drawn at 4x the set's median scale is an overall plan whatever its title", () => {
    // 1"=200' among 1"=20' tiles covers ten times the ground — it overlays them.
    expect(classifySheetRole("SITE PLAN", { scaleFtPerIn: 200, medianScaleFtPerIn: 20 })).toBe("overall");
    expect(classifySheetRole("SITE PLAN", { scaleFtPerIn: 40, medianScaleFtPerIn: 20 })).toBe("tile");
    expect(classifySheetRole("SITE PLAN", { scaleFtPerIn: 200 })).toBe("tile"); // no median ⇒ no call
  });
});
