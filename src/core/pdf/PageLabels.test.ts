import { describe, it, expect } from "vitest";
import { formatLabelValue, PAGE_LABEL_STYLE } from "./PageLabels";

describe("formatLabelValue", () => {
  it("formats decimal", () => {
    expect(formatLabelValue(PAGE_LABEL_STYLE.DECIMAL, 1)).toBe("1");
    expect(formatLabelValue(PAGE_LABEL_STYLE.DECIMAL, 42)).toBe("42");
  });
  it("formats lowercase roman", () => {
    expect(formatLabelValue(PAGE_LABEL_STYLE.ROMAN_LC, 1)).toBe("i");
    expect(formatLabelValue(PAGE_LABEL_STYLE.ROMAN_LC, 4)).toBe("iv");
    expect(formatLabelValue(PAGE_LABEL_STYLE.ROMAN_LC, 9)).toBe("ix");
  });
  it("formats uppercase roman", () => {
    expect(formatLabelValue(PAGE_LABEL_STYLE.ROMAN_UC, 14)).toBe("XIV");
  });
  it("formats lowercase alpha with wraparound (a..z, aa, bb)", () => {
    expect(formatLabelValue(PAGE_LABEL_STYLE.ALPHA_LC, 1)).toBe("a");
    expect(formatLabelValue(PAGE_LABEL_STYLE.ALPHA_LC, 26)).toBe("z");
    expect(formatLabelValue(PAGE_LABEL_STYLE.ALPHA_LC, 27)).toBe("aa");
    expect(formatLabelValue(PAGE_LABEL_STYLE.ALPHA_UC, 28)).toBe("BB");
  });
  it("returns empty string for NONE/unknown style", () => {
    expect(formatLabelValue(PAGE_LABEL_STYLE.NONE, 3)).toBe("");
    expect(formatLabelValue("?", 3)).toBe("");
  });
});
