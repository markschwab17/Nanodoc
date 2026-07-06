import { describe, it, expect } from "vitest";
import { extractPageLabel, disciplineOf } from "./pageLabels";
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
