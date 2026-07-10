import { describe, expect, it } from "vitest";
import { buildExportFileName, formatPageRanges } from "./exportSelection";

describe("formatPageRanges", () => {
  it("compresses consecutive runs into 1-based ranges", () => {
    expect(formatPageRanges([1, 2, 3, 6])).toBe("2-4_7");
  });

  it("handles a single page", () => {
    expect(formatPageRanges([0])).toBe("1");
  });

  it("sorts and dedupes input", () => {
    expect(formatPageRanges([4, 1, 4, 2])).toBe("2-3_5");
  });
});

describe("buildExportFileName", () => {
  it("strips .pdf case-insensitively and appends the ranges", () => {
    expect(buildExportFileName("PlanSet.PDF", [1, 2, 3, 4])).toBe("PlanSet_pages_2-5.pdf");
  });

  it("keeps names without a .pdf suffix intact", () => {
    expect(buildExportFileName("drawings", [0, 2])).toBe("drawings_pages_1_3.pdf");
  });
});
