import { describe, expect, test, it } from "vitest";
import { DEFAULT_SCALE_FT_PER_IN, MissingSheetScaleError, compositionFeetPerInch, isUniform, parseScaleInput, referenceBaseline, referenceScaleFor, resolvePageScale, tileSizeAtReference, newTileCanvasFactor, missingScalePages, typedCommitScales, missingScaleReason, assertEveryPageScaled, scaleSetFor, scaleSetKey } from "./pageScales";

describe("parseScaleInput", () => {
  test("plain numbers and decimals", () => {
    expect(parseScaleInput("20")).toBe(20);
    expect(parseScaleInput(" 12.5 ")).toBe(12.5);
  });
  test("architect-style notation", () => {
    expect(parseScaleInput('1"=40\'')).toBe(40);
    expect(parseScaleInput("1in=50ft")).toBe(50);
  });
  test("rejects empty, zero, negative and junk", () => {
    expect(parseScaleInput("")).toBeNull();
    expect(parseScaleInput("0")).toBeNull();
    expect(parseScaleInput("-3")).toBeNull();
    expect(parseScaleInput("abc")).toBeNull();
  });
});

describe("resolvePageScale", () => {
  const scales = new Map<number, number>([[2, 40]]);
  test("page scale wins over the uniform scale", () => {
    expect(resolvePageScale(2, scales, 20)).toBe(40);
  });
  test("falls back to the uniform scale", () => {
    expect(resolvePageScale(0, scales, 10)).toBe(10);
  });
  test("NEVER falls back to a default: a page with no scale throws instead of becoming 1\"=20'", () => {
    // The customer bug: four 1"=10' sheets left blank were silently sized as 1"=20'.
    expect(() => resolvePageScale(0, scales, null)).toThrow(MissingSheetScaleError);
    try {
      resolvePageScale(3, scales, null);
    } catch (e) {
      expect((e as MissingSheetScaleError).pages).toEqual([3]);
    }
  });
});

describe("isUniform", () => {
  test("true when every selected page resolves to one number", () => {
    expect(isUniform([0, 1, 3], new Map(), 20)).toBe(true);
    expect(isUniform([0, 1], new Map([[0, 20], [1, 20]]), null)).toBe(true);
  });
  test("false when one page differs", () => {
    expect(isUniform([0, 1, 2], new Map([[2, 40]]), 20)).toBe(false);
  });
});

describe("tileSizeAtReference", () => {
  test("a coarser sheet is drawn larger so feet match", () => {
    expect(tileSizeAtReference(612, 792, 40, 20)).toEqual({ width: 1224, height: 1584 });
  });
  test("same scale keeps native size", () => {
    expect(tileSizeAtReference(612, 792, 20, 20)).toEqual({ width: 612, height: 792 });
  });
});

describe("referenceScaleFor", () => {
  test("the explicit set scale wins when given, even if pages disagree", () => {
    expect(referenceScaleFor([0, 1], new Map([[1, 40]]), 20)).toBe(20);
  });
  test("with no set scale, falls back to the first selected page's own scale", () => {
    expect(referenceScaleFor([1, 0], new Map([[1, 40]]), null)).toBe(40);
    expect(() => referenceScaleFor([0, 1], new Map([[1, 40]]), null)).toThrow(MissingSheetScaleError);
  });
});

describe("referenceBaseline", () => {
  test("the typed value wins even with existing tiles and a disagreeing selection", () => {
    expect(
      referenceBaseline({ typed: 20, existing: 40, hasTiles: true, selection: [0, 1], pageScales: new Map([[1, 60]]) })
    ).toBe(20);
  });
  test("the existing reference wins when tiles are already on the canvas and nothing was typed", () => {
    expect(
      referenceBaseline({ typed: null, existing: 40, hasTiles: true, selection: [0, 1], pageScales: new Map([[0, 60]]) })
    ).toBe(40);
  });
  test("the selection decides on an empty canvas with nothing typed", () => {
    expect(
      referenceBaseline({ typed: null, existing: null, hasTiles: false, selection: [1, 0], pageScales: new Map([[1, 40]]) })
    ).toBe(40);
    expect(() =>
      referenceBaseline({ typed: null, existing: 40, hasTiles: false, selection: [0], pageScales: new Map() })
    ).toThrow(MissingSheetScaleError);
  });
});

describe("compositionFeetPerInch", () => {
  test("uses the composition's reference scale", () => {
    expect(
      compositionFeetPerInch({ referenceScaleFeetPerInch: 20, compositionScaleFactor: 1 })
    ).toBe(20);
  });

  test("adjusts for a shrunk composition, like the manifest does", () => {
    expect(
      compositionFeetPerInch({ referenceScaleFeetPerInch: 20, compositionScaleFactor: 0.5 })
    ).toBe(40);
  });

  test("falls back to the sheet's own scale, then to the default", () => {
    expect(
      compositionFeetPerInch({
        referenceScaleFeetPerInch: null,
        compositionScaleFactor: 1,
        tileScaleFeetPerInch: 50,
      })
    ).toBe(50);
    expect(
      compositionFeetPerInch({ referenceScaleFeetPerInch: null, compositionScaleFactor: 1 })
    ).toBe(DEFAULT_SCALE_FT_PER_IN);
  });

  test("survives a zero or broken shrink factor", () => {
    expect(
      compositionFeetPerInch({ referenceScaleFeetPerInch: 20, compositionScaleFactor: 0 })
    ).toBe(20);
    expect(
      compositionFeetPerInch({ referenceScaleFeetPerInch: 20, compositionScaleFactor: NaN })
    ).toBe(20);
  });
});

describe("newTileCanvasFactor", () => {
  it("is 1 on an un-adjusted canvas whose reference matches the batch", () => {
    expect(newTileCanvasFactor({ compositionScaleFactor: 1, batchRef: 20, canvasRef: 20 })).toBe(1);
  });
  it("follows the composition adjustment (1\"=20' adjusted to 1\"=40' halves new sheets too)", () => {
    expect(newTileCanvasFactor({ compositionScaleFactor: 0.5, batchRef: 20, canvasRef: 20 })).toBe(0.5);
  });
  it("re-roots a batch expressed at a different feet-per-inch onto the canvas reference", () => {
    // Poses at 1"=40' onto a canvas that keeps 1"=20': everything is twice as big.
    expect(newTileCanvasFactor({ compositionScaleFactor: 1, batchRef: 40, canvasRef: 20 })).toBe(2);
  });
  it("combines both, and ignores a broken factor or reference", () => {
    expect(newTileCanvasFactor({ compositionScaleFactor: 0.5, batchRef: 40, canvasRef: 20 })).toBe(1);
    expect(newTileCanvasFactor({ compositionScaleFactor: NaN, batchRef: 0, canvasRef: 20 })).toBe(1);
  });
});

describe("missingScalePages", () => {
  const text = (entries: [number, string][]) => new Map<number, string>(entries);
  test("every selected page is missing when nothing was typed", () => {
    expect(missingScalePages([0, 2, 4], text([]), "")).toEqual([0, 2, 4]);
  });
  test("a set-wide scale covers every page left blank", () => {
    expect(missingScalePages([0, 2, 4], text([]), "10")).toEqual([]);
    expect(missingScalePages([0, 2, 4], text([]), '1"=10\'')).toEqual([]);
  });
  test("per-page scales cover only their own page", () => {
    expect(missingScalePages([0, 2, 4], text([[0, "10"], [4, "20"]]), "")).toEqual([2]);
  });
  test("unreadable text counts as missing, per page and set-wide", () => {
    expect(missingScalePages([0, 1], text([]), "abc")).toEqual([0, 1]);
    // A page whose own box holds junk is NOT quietly handed the set scale.
    expect(missingScalePages([0, 1], text([[1, "ten"]]), "10")).toEqual([1]);
    expect(missingScalePages([0], text([[0, "0"]]), "")).toEqual([0]);
  });
  test("whitespace-only is blank, not junk", () => {
    expect(missingScalePages([0], text([[0, "  "]]), "10")).toEqual([]);
  });
  test("pages that are not selected do not matter", () => {
    expect(missingScalePages([1], text([[0, "junk"]]), "10")).toEqual([]);
  });
});

describe("typedCommitScales", () => {
  test("null until every selected page has a scale the user typed", () => {
    expect(typedCommitScales([0, 1], new Map(), "")).toBeNull();
    expect(typedCommitScales([0, 1], new Map([[0, "10"]]), "")).toBeNull();
  });
  test("every selected page is in the map — nothing is left for a default to fill", () => {
    const r = typedCommitScales([0, 1, 2], new Map([[1, "40"]]), "10")!;
    expect([...r.pageScales]).toEqual([[0, 10], [1, 40], [2, 10]]);
    expect(r.uniformScale).toBe(10);
    for (const i of [0, 1, 2]) expect(resolvePageScale(i, r.pageScales, r.uniformScale)).not.toBe(DEFAULT_SCALE_FT_PER_IN);
  });
  test("the customer set: four 1\"=10' sheets resolve to 10, not the old 20 default", () => {
    const r = typedCommitScales([0, 1, 2, 3], new Map(), "10")!;
    for (const i of [0, 1, 2, 3]) expect(resolvePageScale(i, r.pageScales, r.uniformScale)).toBe(10);
    expect(referenceScaleFor([0, 1, 2, 3], r.pageScales, r.uniformScale)).toBe(10);
  });
  test("per-page only (no set scale) keeps uniformScale null", () => {
    const r = typedCommitScales([0, 1], new Map([[0, "10"], [1, "10"]]), "")!;
    expect(r.uniformScale).toBeNull();
    expect(isUniform([0, 1], r.pageScales, r.uniformScale)).toBe(true);
  });
  test("an empty selection has nothing to commit", () => {
    expect(typedCommitScales([], new Map(), "10")).toBeNull();
  });
});

describe("missingScaleReason", () => {
  test("null when nothing is missing", () => {
    expect(missingScaleReason([])).toBeNull();
  });
  test("names pages 1-based", () => {
    expect(missingScaleReason([2])).toBe("Enter the scale for page 3");
    expect(missingScaleReason([2, 4])).toBe("Enter the scale for pages 3, 5");
  });
  test("a long list is shortened", () => {
    expect(missingScaleReason([0, 1, 2, 3, 4, 5, 6])).toBe("Enter the scale for pages 1, 2, 3, 4, 5 and 2 more");
  });
});

describe("assertEveryPageScaled", () => {
  test("throws naming every page with no scale", () => {
    expect(() => assertEveryPageScaled([0, 1, 2], new Map([[1, 10]]), null)).toThrow(MissingSheetScaleError);
    try {
      assertEveryPageScaled([0, 1, 2], new Map([[1, 10]]), null);
    } catch (e) {
      expect((e as MissingSheetScaleError).pages).toEqual([0, 2]);
    }
  });
  test("passes when a set scale or per-page scales cover everything", () => {
    expect(() => assertEveryPageScaled([0, 1], new Map(), 10)).not.toThrow();
    expect(() => assertEveryPageScaled([0, 1], new Map([[0, 10], [1, 20]]), null)).not.toThrow();
  });
});

describe("scaleSetFor / scaleSetKey — the scales a probe was asked at", () => {
  test("uniform when every page shares one scale, like the canvas probe set", () => {
    const set = scaleSetFor([2, 0], new Map([[0, 10], [2, 10], [5, 40]]));
    expect(set.pageIndices).toEqual([0, 2]);
    expect([...set.pageScales]).toEqual([[0, 10], [2, 10]]);
    expect(set.uniformScale).toBe(10);
  });
  test("mixed sets have no uniform scale", () => {
    expect(scaleSetFor([0, 1], new Map([[0, 10], [1, 40]])).uniformScale).toBeNull();
  });
  test("the key changes with any page's scale or the page set, and nothing else", () => {
    const k = (sel: number[], m: [number, number][]) => scaleSetKey(scaleSetFor(sel, new Map(m)));
    expect(k([0, 1], [[0, 10], [1, 10]])).toBe(k([1, 0], [[1, 10], [0, 10]]));
    expect(k([0, 1], [[0, 10], [1, 10]])).not.toBe(k([0, 1], [[0, 20], [1, 20]]));
    expect(k([0, 1], [[0, 10], [1, 10]])).not.toBe(k([0, 1], [[0, 10], [1, 40]]));
    expect(k([0, 1], [[0, 10], [1, 10]])).not.toBe(k([0, 2], [[0, 10], [2, 10]]));
  });
});
