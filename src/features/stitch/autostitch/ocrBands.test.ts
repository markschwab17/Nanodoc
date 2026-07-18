import { describe, expect, test } from "vitest";
import { pageEdgeBands, sheetNoBand, rotateRaw, wordsToLabels, parseSheetNumber, mergeWords } from "./ocrBands";
import type { OcrWord } from "./ocrService";

describe("pageEdgeBands", () => {
  test("inward bands at spike-validated fractions", () => {
    const b = pageEdgeBands([0, 0, 1000, 500]);
    const by = Object.fromEntries(b.map((s) => [s.edge, s.clip]));
    expect(by.top).toEqual([0, 0, 1000, 75]);
    expect(by.bottom).toEqual([0, 425, 1000, 500]);
    expect(by.left).toEqual([0, 0, 120, 500]);
    expect(by.right).toEqual([880, 0, 1000, 500]);
  });
});

describe("sheetNoBand", () => {
  test("bottom-right corner cell", () => {
    const s = sheetNoBand([0, 0, 1000, 800]);
    expect(s.edge).toBe("bottom");
    expect(s.clip).toEqual([800, 704, 1000, 800]); // right 20% x bottom 12%
  });
});

describe("rotateRaw", () => {
  // 2x3 image, distinct pixel values in the red channel
  const src = { width: 2, height: 3, data: new Uint8ClampedArray(2 * 3 * 4) };
  // red channel row-major: [[1,2],[3,4],[5,6]]
  [1, 2, 3, 4, 5, 6].forEach((v, i) => { src.data[i * 4] = v; src.data[i * 4 + 3] = 255; });
  const red = (img: { width: number; height: number; data: Uint8ClampedArray }) =>
    Array.from({ length: img.height }, (_, y) =>
      Array.from({ length: img.width }, (_, x) => img.data[(y * img.width + x) * 4]));

  test("90 (clockwise): first src row becomes last dst column", () => {
    const d = rotateRaw(src, 90);
    expect(d.width).toBe(3); expect(d.height).toBe(2);
    expect(red(d)).toEqual([[5, 3, 1], [6, 4, 2]]);
  });
  test("270 (counter-clockwise)", () => {
    const d = rotateRaw(src, 270);
    expect(red(d)).toEqual([[2, 4, 6], [1, 3, 5]]);
  });
});

describe("wordsToLabels", () => {
  const word = (text: string, x0: number, y0: number, x1: number, y1: number, confidence = 90) =>
    ({ text, confidence, bbox: { x0, y0, x1, y1 } });
  test("unrotated band maps px back to page pts", () => {
    const band = { edge: "top" as const, clip: [100, 140, 1100, 260] as [number, number, number, number] };
    // scale 2 px/pt; word at image px (40, 20)-(120, 36)
    const ls = wordsToLabels([word("SEE", 40, 20, 120, 36)], band, 2, 2000, 240, 0);
    expect(ls).toHaveLength(1);
    expect(ls[0].x).toBeCloseTo(120);  // 100 + 40/2
    expect(ls[0].y).toBeCloseTo(150);  // 140 + 20/2
    expect(ls[0].endX).toBeCloseTo(160);
    expect(ls[0].endY).toBeCloseTo(158);
    expect(ls[0].text).toBe("SEE");
  });
  test("rot-90 band maps through the inverse rotation", () => {
    // left band clip [40,200]-[160,900], scale 1 → image 120x700, rotated CW → 700x120.
    const band = { edge: "left" as const, clip: [40, 200, 160, 900] as [number, number, number, number] };
    // In the ROTATED image a word occupies (10, 30)-(50, 46).
    // Inverse of CW90: srcX = y, srcY = (rotW - 1) - x  where rotW = 700.
    const ls = wordsToLabels([word("SHEET", 10, 30, 50, 46)], band, 1, 120, 700, 90);
    expect(ls).toHaveLength(1);
    // corners map to src: (30, 689) and (46, 649) → bbox src x:[30,46] y:[649,689]
    expect(ls[0].x).toBeCloseTo(40 + 30);
    expect(ls[0].endX).toBeCloseTo(40 + 46);
    expect(ls[0].y).toBeCloseTo(200 + 649);
    expect(ls[0].endY).toBeCloseTo(200 + 689);
  });
  test("low-confidence words are dropped", () => {
    const band = { edge: "top" as const, clip: [0, 0, 100, 10] as [number, number, number, number] };
    expect(wordsToLabels([word("junk", 0, 0, 5, 5, 30)], band, 1, 100, 10, 0)).toEqual([]);
  });
  test("rot-90 side band merges two image-space words BEFORE mapping (regression)", () => {
    // The real bug: on a rotated side band, mapping first stacks words
    // VERTICALLY in page space, so a page-space phrase merge never joins them.
    // Merging in the (horizontal) OCR image joins "SEE"+"BELOW" into one label.
    const band = { edge: "left" as const, clip: [40, 200, 160, 900] as [number, number, number, number] };
    // Two words on ONE line of the rotated image (imgW=120, imgH=700, rot=90).
    const ls = wordsToLabels(
      [word("SEE", 10, 30, 40, 46), word("BELOW", 46, 30, 90, 46)],
      band, 1, 120, 700, 90,
    );
    expect(ls).toHaveLength(1);
    expect(ls[0].text).toBe("SEE BELOW");
    // Union bbox (10,30)-(90,46) maps via inverse CW90 [y, 699 - x]:
    //   x from y-range [30,46]; y from (699 - x)-range [609,689].
    expect(ls[0].x).toBeCloseTo(40 + 30);    // 70
    expect(ls[0].endX).toBeCloseTo(40 + 46); // 86
    expect(ls[0].y).toBeCloseTo(200 + 609);  // 809
    expect(ls[0].endY).toBeCloseTo(200 + 689); // 889
  });
});

describe("parseSheetNumber", () => {
  const w = (text: string) => ({ text, confidence: 80, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } });
  test("reads 'SHEET 2 OF 22' shapes", () => {
    expect(parseSheetNumber([w("SHEET"), w("2"), w("OF"), w("22")])).toBe(2);
  });
  test("reads a joined '2 OF 22'", () => {
    expect(parseSheetNumber([w("2 OF 22")])).toBe(2);
  });
  test("null when absent", () => {
    expect(parseSheetNumber([w("ADKAN"), w("ENGINEERS")])).toBeNull();
  });
});

describe("mergeWords", () => {
  const W = (text: string, x0: number, y0: number, x1: number, y1: number, confidence = 90): OcrWord =>
    ({ text, confidence, bbox: { x0, y0, x1, y1 } });
  test("adjacent words on one line merge into a phrase", () => {
    const m = mergeWords([W("SEE", 100, 50, 130, 60), W("SHEET", 136, 50, 180, 60), W("9", 186, 50, 194, 60)]);
    expect(m).toHaveLength(1);
    expect(m[0].text).toBe("SEE SHEET 9");
    expect(m[0].bbox.x0).toBe(100); expect(m[0].bbox.x1).toBe(194);
  });
  test("words far apart stay separate", () => {
    const m = mergeWords([W("SEE", 100, 50, 130, 60), W("WTR", 400, 50, 430, 60)]);
    expect(m).toHaveLength(2);
  });
  test("different lines stay separate", () => {
    const m = mergeWords([W("SEE", 100, 50, 130, 60), W("SHEET", 100, 80, 150, 90)]);
    expect(m).toHaveLength(2);
  });
  test("mixed-height words on one line merge deterministically", () => {
    const m = mergeWords([W("9", 186, 50, 194, 62), W("SEE", 100, 51, 130, 60), W("SHEET", 136, 49, 180, 61)]);
    expect(m).toHaveLength(1);
    expect(m[0].text).toBe("SEE SHEET 9");
  });
  test("merged confidence is the min of the parts", () => {
    const m = mergeWords([W("SEE", 100, 50, 130, 60, 88), W("BELOW", 136, 50, 190, 60, 61)]);
    expect(m).toHaveLength(1);
    expect(m[0].confidence).toBe(61);
  });
});
