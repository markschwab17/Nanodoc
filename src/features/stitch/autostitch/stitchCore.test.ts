import { describe, it, expect } from "vitest";
import { tokenVote, stitchSheets, refineOffset, type SheetInput, type SegFeat } from "./stitchCore";
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

  // Regression (Bug A): visible-text sets carry stray render-mode-3 glyphs, so
  // the invisible channel is >=8 single-char garbage. The driver must union the
  // channels and use the good VISIBLE labels, not the garbage. (Old code did
  // `shx.length < 8 ? labels : shx` and used the garbage -> nothing aligned.)
  it("uses the visible channel even when the invisible channel is >=8 stray glyphs", () => {
    const OFF_PT = (300 * 72) / 20;
    const texts = ["TC347.33", "TC348.10", "FL346.90", "TC349.55", "FL347.10", "TC350.02"];
    // 10 single-char invisible glyphs (>= the 8 threshold) — real tokens live only in `labels`
    const garbage: Label[] = "ABCDEFGHIJ".split("").map((c, i) => lbl(c, 50 + i * 7, 50));
    const mk = (id: string, no: number, x0: number): SheetInput => {
      const labels = texts.map((t, i) => lbl(t, 400 + i * 120 - x0, 800 + (i % 2) * 60));
      return {
        id, no, scale: 20, view: [0, 0, 2592, 1728],
        extract: { view: [0, 0, 2592, 1728], shxLabels: garbage, labels, words: labels, geometry: [] } as PageExtract,
      };
    };
    const res = stitchSheets([mk("a", 1, 0), mk("b", 2, OFF_PT)]);
    expect(res.placements.has(1)).toBe(true);
    expect(res.placements.has(2)).toBe(true);
    expect(res.placements.get(2)!.x).toBeCloseTo(300, 0);
  });

  // Regression (Bug B): placement must root at the LARGEST connected component,
  // not blindly at sheets[0]. On a real set sheets[0] is often a title/notes
  // sheet with no drawing tokens; rooting there dropped the whole plan cluster.
  it("roots at the largest component, not an isolated sheets[0] title sheet", () => {
    const OFF_PT = (300 * 72) / 20;
    const shared = ["TC347.33", "TC348.10", "FL346.90", "TC349.55", "FL347.10", "TC350.02"];
    const b = shared.map((t, i) => lbl(t, 400 + i * 120, 800));
    const c = shared.map((t, i) => lbl(t, 400 + i * 120 - OFF_PT, 800));
    const title = ["COVER1.0", "INDEX2.0", "NOTES3.0"].map((t, i) => lbl(t, 100 + i * 60, 100));
    const mk = (id: string, no: number, labels: Label[]): SheetInput => ({
      id, no, scale: 20, view: [0, 0, 2592, 1728],
      extract: { view: [0, 0, 2592, 1728], shxLabels: labels, labels, words: labels, geometry: [] } as PageExtract,
    });
    // sheet 1 = isolated title sheet (first); 2 & 3 = the connected plan sheets
    const res = stitchSheets([mk("t", 1, title), mk("b", 2, b), mk("c", 3, c)]);
    expect(res.placements.has(1)).toBe(false);
    expect(res.placements.has(2)).toBe(true);
    expect(res.placements.has(3)).toBe(true);
    expect([2, 3]).toContain(res.root);
  });
});

describe("refineOffset", () => {
  // Fine registration: sheet B's linework is sheet A's shifted by a known offset.
  // Starting from a nearby coarse estimate, it must recover the offset to sub-foot.
  it("recovers a precise translation from matching linework", () => {
    const OFF = { dx: 5.3, dy: -2.1 }; // A - B = OFF (so B = A - OFF)
    const fineA: SegFeat[] = Array.from({ length: 30 }, (_, i) => ({
      mx: (i * 37) % 400, my: (i * 53) % 300, len: 3 + i * 0.7, ang: (i * 11) % 180,
    }));
    const fineB: SegFeat[] = fineA.map((s) => ({ ...s, mx: s.mx - OFF.dx, my: s.my - OFF.dy }));
    const r = refineOffset(fineA, fineB, { dx: 5, dy: -2 }); // coarse start, within the window
    expect(r).not.toBeNull();
    expect(r!.dx).toBeCloseTo(5.3, 1);
    expect(r!.dy).toBeCloseTo(-2.1, 1);
    expect(r!.inliers).toBeGreaterThanOrEqual(12);
    expect(r!.rms).toBeLessThan(0.1);
  });

  it("returns null when the true offset is outside the tight search window", () => {
    const fineA: SegFeat[] = Array.from({ length: 30 }, (_, i) => ({
      mx: (i * 37) % 400, my: (i * 53) % 300, len: 3 + i * 0.7, ang: (i * 11) % 180,
    }));
    const fineB: SegFeat[] = fineA.map((s) => ({ ...s, mx: s.mx - 50, my: s.my })); // 50 ft off
    expect(refineOffset(fineA, fineB, { dx: 0, dy: 0 })).toBeNull(); // 50 >> window (6)
  });

  it("no-ops (null) with no geometry", () => {
    expect(refineOffset([], [], { dx: 0, dy: 0 })).toBeNull();
  });
});
