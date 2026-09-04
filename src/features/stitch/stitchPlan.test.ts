import { describe, it, expect } from "vitest";
import { parseStitchPlan } from "./stitchPlan";

const takeoff = (scaleFeetPerInch: number | null, label = "C-1") => ({
  kind: "takeoff",
  pageUuid: "uuid-" + label,
  scaleFeetPerInch,
  label,
});

const plan = (entries: unknown[], mode: "auto" | "manual" = "auto") => ({
  version: 1,
  mode,
  entries,
});

describe("parseStitchPlan", () => {
  it("reads the mode and one page index per entry", () => {
    const parsed = parseStitchPlan(plan([takeoff(20), takeoff(20)], "manual"), 2);
    expect(parsed?.mode).toBe("manual");
    expect(parsed?.pageIndices).toEqual([0, 1]);
  });

  it("round-trips the auto mode", () => {
    expect(parseStitchPlan(plan([takeoff(20)], "auto"), 1)?.mode).toBe("auto");
  });

  it("collapses a uniformly-scaled plan to one uniform scale", () => {
    const parsed = parseStitchPlan(plan([takeoff(20), takeoff(20), takeoff(20)]), 3);
    expect(parsed?.uniformScale).toBe(20);
    expect(parsed?.pageScales).toEqual(new Map([[0, 20], [1, 20], [2, 20]]));
  });

  it("keeps a mixed-scale plan per-page with no uniform scale", () => {
    const parsed = parseStitchPlan(plan([takeoff(20), takeoff(40)]), 2);
    expect(parsed?.uniformScale).toBeNull();
    expect(parsed?.pageScales).toEqual(new Map([[0, 20], [1, 40]]));
  });

  it("leaves blank scales out of the map and off the uniform path", () => {
    const parsed = parseStitchPlan(plan([takeoff(20), takeoff(null)]), 2);
    expect(parsed?.pageScales.has(1)).toBe(false);
    expect(parsed?.pageScales.get(0)).toBe(20);
    // Page 1 has no scale, so the set is not uniform even though every scale
    // present is 20 — the commit must resolve page 1 on its own.
    expect(parsed?.uniformScale).toBeNull();
  });

  it("treats an absent scaleFeetPerInch like an explicit null", () => {
    const parsed = parseStitchPlan(
      plan([{ kind: "document", documentId: "d1", documentPage: 0, label: "A" }]),
      1
    );
    expect(parsed?.pageIndices).toEqual([0]);
    expect(parsed?.pageScales.size).toBe(0);
  });

  it("truncates entries past the document's page count", () => {
    const parsed = parseStitchPlan(plan([takeoff(20), takeoff(40), takeoff(50)]), 2);
    expect(parsed?.pageIndices).toEqual([0, 1]);
    expect(parsed?.pageScales).toEqual(new Map([[0, 20], [1, 40]]));
  });

  it("commits only the pages the plan describes when the PDF has more", () => {
    const parsed = parseStitchPlan(plan([takeoff(20)]), 5);
    expect(parsed?.pageIndices).toEqual([0]);
  });

  it("returns null when the document has no pages", () => {
    expect(parseStitchPlan(plan([takeoff(20)]), 0)).toBeNull();
  });

  it("returns null for a version this build does not understand", () => {
    expect(parseStitchPlan({ ...plan([takeoff(20)]), version: 2 }, 1)).toBeNull();
  });

  it("returns null for a malformed plan", () => {
    expect(parseStitchPlan(null, 3)).toBeNull();
    expect(parseStitchPlan("not a plan", 3)).toBeNull();
    expect(parseStitchPlan([takeoff(20)], 3)).toBeNull();
    expect(parseStitchPlan(plan([]), 3)).toBeNull();
    expect(parseStitchPlan({ version: 1, mode: "sideways", entries: [takeoff(20)] }, 3)).toBeNull();
    expect(parseStitchPlan({ version: 1, mode: "auto", entries: "nope" }, 3)).toBeNull();
    expect(parseStitchPlan(plan(["not an entry"]), 3)).toBeNull();
  });

  it("treats an unusable scale as no scale instead of rejecting the plan", () => {
    // One bad scale in a big plan must not throw the whole set back to the picker;
    // the page simply resolves its scale the way any uncalibrated page does.
    for (const bad of [0, -20, Number.NaN, Number.POSITIVE_INFINITY]) {
      const parsed = parseStitchPlan(plan([takeoff(20), takeoff(bad as number)]), 2);
      expect(parsed?.pageIndices).toEqual([0, 1]);
      expect(parsed?.pageScales).toEqual(new Map([[0, 20]]));
      expect(parsed?.uniformScale).toBeNull();
    }
    const strung = parseStitchPlan(
      plan([{ kind: "takeoff", pageUuid: "u", scaleFeetPerInch: "20" }]),
      1
    );
    expect(strung?.pageIndices).toEqual([0]);
    expect(strung?.pageScales.size).toBe(0);
  });

  it("ignores a malformed entry that the page count truncates away", () => {
    const parsed = parseStitchPlan(plan([takeoff(20), "garbage"]), 1);
    expect(parsed?.pageIndices).toEqual([0]);
  });
});

describe("parseStitchPlan — sheet codes from the labels", () => {
  const plan = (labels: unknown[]) => ({
    version: 1, mode: "auto",
    entries: labels.map((label) => ({ scaleFeetPerInch: 20, label })),
  });

  it("takes the leading sheet code of each label", () => {
    const p = parseStitchPlan(plan(["C5.00 — GRADING PLAN", "C-5.01 GRADING PLAN", "C 502 PLAN"]), 3)!;
    expect([...p.pageCodes]).toEqual([[0, "C5.00"], [1, "C-5.01"], [2, "C502"]]);
  });

  it("takes a bare printed number", () => {
    const p = parseStitchPlan(plan(["6", "7 GRADING"]), 2)!;
    expect([...p.pageCodes]).toEqual([[0, "6"], [1, "7"]]);
  });

  it("ignores a label that does not START with a code", () => {
    const p = parseStitchPlan(plan(["GRADING PLAN", "PLAN SHEET 6", "2ND FLOOR PLAN"]), 3)!;
    expect(p.pageCodes.size).toBe(0);
  });

  it("a missing, empty or non-string label is simply a page with no known identity", () => {
    const p = parseStitchPlan({
      version: 1, mode: "auto",
      entries: [{ scaleFeetPerInch: 20 }, { scaleFeetPerInch: 20, label: "" }, { scaleFeetPerInch: 20, label: 42 }],
    }, 3)!;
    expect(p).not.toBeNull();
    expect(p.pageCodes.size).toBe(0);
  });

  it("upper-cases so it compares with a title-block code", () => {
    const p = parseStitchPlan(plan(["c5.00 grading plan"]), 1)!;
    expect(p.pageCodes.get(0)).toBe("C5.00");
  });
});
