import { describe, it, expect } from "vitest";
import { tokenVote, stitchSheets, type SheetInput } from "./stitchCore";
import type { Label, PageExtract } from "./types";

const tok = (text: string, x: number, y: number) => ({ text, x, y });
const lbl = (text: string, x: number, y: number): Label =>
  ({ text, x, y, endX: x + 30, endY: y, angle: 0, h: 8, font: null });

describe("tokenVote", () => {
  it("finds the modal translation from shared tokens", () => {
    const A = { tok: Array.from({ length: 6 }, (_, i) => tok(`TC${i}00.0`, i * 100, 0)) };
    const B = { tok: A.tok.map((t) => ({ ...t, x: t.x + 100, y: t.y + 50 })) };
    const v = tokenVote(A, B, { minInliers: 5 });
    expect(v).not.toBeNull();
    expect(v!.dx).toBeCloseTo(-100, 1); // A - B
    expect(v!.dy).toBeCloseTo(-50, 1);
    expect(v!.inliers).toBeGreaterThanOrEqual(5);
  });
});

describe("stitchSheets", () => {
  it("places a second sheet at the token-implied feet offset from the root", () => {
    // scale 20 ft/in => 72 pt = 20 ft => 1080 pt = 300 ft
    const OFF_PT = (300 * 72) / 20; // 1080 pt in page space
    const texts = ["TC347.33", "TC348.10", "FL346.90", "TC349.55", "FL347.10", "TC350.02"];
    const aLabels = texts.map((t, i) => lbl(t, 400 + i * 120, 800 + (i % 2) * 60));
    const bLabels = texts.map((t, i) => lbl(t, 400 + i * 120 - OFF_PT, 800 + (i % 2) * 60));
    const mk = (id: string, no: number, labels: Label[]): SheetInput => ({
      id, no, scale: 20, view: [0, 0, 2592, 1728],
      extract: { view: [0, 0, 2592, 1728], shxLabels: labels, labels, words: labels, geometry: [] } as PageExtract,
    });
    const res = stitchSheets([mk("a", 1, aLabels), mk("b", 2, bLabels)]);
    expect(res.root).toBe(1);
    expect(res.placements.get(1)).toEqual({ x: 0, y: 0 });
    const p2 = res.placements.get(2)!;
    // sheet b tokens are shifted -1080pt in x => +300 ft on sheet b's origin
    expect(p2.x).toBeCloseTo(300, 0);
    expect(p2.y).toBeCloseTo(0, 0);
    expect(res.worstResidFt).toBeLessThan(0.1);
  });

  it("leaves a disconnected sheet out of placements", () => {
    const shared = ["AA111.1", "BB222.2", "CC333.3", "DD444.4", "EE555.5", "FF666.6"];
    const a = shared.map((t, i) => lbl(t, 400 + i * 120, 800));
    const b = shared.map((t, i) => lbl(t, 400 + i * 120 - 1080, 800));
    const loner = ["ZZ999.9", "YY888.8", "XX777.7"].map((t, i) => lbl(t, 100 + i * 50, 100));
    const mk = (id: string, no: number, labels: Label[]): SheetInput => ({
      id, no, scale: 20, view: [0, 0, 2592, 1728],
      extract: { view: [0, 0, 2592, 1728], shxLabels: labels, labels, words: labels, geometry: [] } as PageExtract,
    });
    const res = stitchSheets([mk("a", 1, a), mk("b", 2, b), mk("c", 3, loner)]);
    expect(res.placements.has(1)).toBe(true);
    expect(res.placements.has(2)).toBe(true);
    expect(res.placements.has(3)).toBe(false);
  });
});
