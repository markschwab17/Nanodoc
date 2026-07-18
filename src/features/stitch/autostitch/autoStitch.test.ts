import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolvePrintedNos } from "./autoStitch";

describe("resolvePrintedNos", () => {
  // Collision repair logs a warning; keep test output quiet.
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("(a) out-of-range OCR number is discarded -> page-order fallback", () => {
    // pageCount 3 -> valid range [1, 6]. 99 is a misread.
    const map = resolvePrintedNos(
      [
        { pageIndex: 0, printedNo: 99, source: "ocr" },
        { pageIndex: 1, printedNo: 2, source: "text" },
      ],
      3
    );
    expect(map.get(0)).toBe(1); // discarded -> pageIndex+1
    expect(map.get(1)).toBe(2); // text trusted as-is
  });

  it("(a2) non-integer / null OCR number is discarded -> page-order fallback", () => {
    const map = resolvePrintedNos(
      [
        { pageIndex: 0, printedNo: 2.5, source: "ocr" },
        { pageIndex: 1, printedNo: null, source: "ocr" },
      ],
      5
    );
    expect(map.get(0)).toBe(1);
    expect(map.get(1)).toBe(2);
  });

  it("(b) two pages colliding: OCR-sourced reset to pageIndex+1, text-sourced untouched", () => {
    const map = resolvePrintedNos(
      [
        { pageIndex: 0, printedNo: 5, source: "ocr" },
        { pageIndex: 1, printedNo: 5, source: "ocr" },
        { pageIndex: 2, printedNo: 5, source: "text" },
      ],
      6
    );
    expect(map.get(0)).toBe(1); // OCR reset
    expect(map.get(1)).toBe(2); // OCR reset
    expect(map.get(2)).toBe(5); // text kept
  });

  it("(c) 3+ pages colliding: all OCR-sourced reset, no residual collision among reset group", () => {
    const map = resolvePrintedNos(
      [
        { pageIndex: 0, printedNo: 3, source: "ocr" },
        { pageIndex: 1, printedNo: 3, source: "ocr" },
        { pageIndex: 2, printedNo: 3, source: "ocr" },
      ],
      6
    );
    const resets = [map.get(0), map.get(1), map.get(2)];
    expect(resets).toEqual([1, 2, 3]); // each -> pageIndex+1
    expect(new Set(resets).size).toBe(3); // no residual collision within the group
  });

  it("(d) valid unique OCR numbers pass through unchanged", () => {
    const map = resolvePrintedNos(
      [
        { pageIndex: 0, printedNo: 3, source: "ocr" },
        { pageIndex: 1, printedNo: 5, source: "ocr" },
        { pageIndex: 2, printedNo: 6, source: "ocr" },
      ],
      3
    );
    expect(map.get(0)).toBe(3);
    expect(map.get(1)).toBe(5);
    expect(map.get(2)).toBe(6);
  });

  it("does not reset a collision group with no OCR member (two text pages left as-is)", () => {
    const map = resolvePrintedNos(
      [
        { pageIndex: 0, printedNo: 4, source: "text" },
        { pageIndex: 1, printedNo: 4, source: "text" },
      ],
      6
    );
    expect(map.get(0)).toBe(4);
    expect(map.get(1)).toBe(4); // only OCR-sourced collisions are repaired
  });
});
