import { describe, expect, test } from "vitest";
import { DEFAULT_SCALE_FT_PER_IN, isUniform, parseScaleInput, resolvePageScale, tileSizeAtReference } from "./pageScales";

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
  test("falls back to the uniform scale, then the default", () => {
    expect(resolvePageScale(0, scales, 20)).toBe(20);
    expect(resolvePageScale(0, scales, null)).toBe(DEFAULT_SCALE_FT_PER_IN);
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
