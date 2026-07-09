import { describe, it, expect } from "vitest";
import { tokenVote, stitchSheets, refineOffset, buildGeomFurnitureFilter, matchlineStrokePrior, type SheetInput, type SegFeat } from "./stitchCore";
import type { Label, PageExtract, Geom } from "./types";

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

  it("stitches two sheets by geometry alone (no tokens/matchlines) past identical boilerplate", () => {
    const VIEW: [number, number, number, number] = [0, 0, 3024, 2160];
    const seg = (id: string, x1: number, y1: number, x2: number, y2: number): Geom => ({ id, pts: [[x1, y1], [x2, y2]], closed: false });
    // A distinctive drawing shape — VARIED lengths/angles so each segment's
    // (len,angle) signature is unique and segVote matches by index (each ≥8ft).
    const SHAPE: [number, number][] = [[90, 0], [0, 70], [110, 35], [45, -55], [75, 25], [0, 95], [60, 60], [130, 15], [30, 80], [85, -40], [50, 50], [0, 120], [100, 65], [40, -70], [95, 30], [70, 90], [120, -25], [55, 45]];
    const drawing = (ox: number, oy: number) => SHAPE.map(([dx, dy], i) => seg(`d${i}`, ox + i * 90, oy + i * 20, ox + i * 90 + dx, oy + i * 20 + dy));
    // Identical boilerplate (title-block column) at the SAME position on both sheets.
    const boiler = Array.from({ length: 14 }, (_, i) => seg(`b${i}`, 2700, 100 + i * 130, 2700, 100 + i * 130 + 90));
    // Same drawing on both, offset vertically (adjacent tiles); boilerplate identical.
    const gA = [...drawing(400, 1650), ...boiler];
    const gB = [...drawing(400, 250), ...boiler];
    const mk = (no: number, geometry: Geom[]): SheetInput => ({
      id: String(no), no, scale: 20, view: VIEW,
      extract: { view: VIEW, shxLabels: [], labels: [], words: [], geometry } as PageExtract,
    });
    const res = stitchSheets([mk(1, gA), mk(2, gB)]);
    expect(res.placements.size).toBe(2); // both placed via geometry-only pairing
    const p2 = res.placements.get(2)!;
    // aligned on the DRAWING offset (~FT(1400)=389ft), NOT the boilerplate self-match at 0
    expect(Math.abs(p2.y)).toBeGreaterThan(300);
    expect(res.worstResidFt).toBeLessThan(1);
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

  const VIEW: [number, number, number, number] = [0, 0, 2592, 1728];
  const mkSheet = (no: number, labels: Label[]): SheetInput => ({
    id: String(no), no, scale: 20, view: VIEW,
    extract: { view: VIEW, shxLabels: labels, labels, words: labels, geometry: [] } as PageExtract,
  });

  it("does NOT bond two sheets whose opposite-edge matchlines reference OTHER sheets", () => {
    // Sheet 1's right-edge matchline points to sheet 99 (absent); sheet 2's
    // left-edge matchline to 88 (absent). Opposite edges but NO mutual reference,
    // no shared tokens, no geometry — they must not bond (previously they got a
    // garbage matchline-label-only offset, resid ~680ft on a real 35-sheet set).
    const m1 = lbl("MATCHLINE (SEE SHEET 99)", 2450, 850); // near right edge
    const m2 = lbl("MATCHLINE (SEE SHEET 88)", 60, 850);   // near left edge
    const res = stitchSheets([mkSheet(1, [m1]), mkSheet(2, [m2])]);
    expect(res.placements.size).toBe(0); // no spurious bond
  });

  it("bonds two sheets whose matchlines DO reference each other (label-only)", () => {
    const m1 = lbl("MATCHLINE (SEE SHEET 2)", 2450, 850);
    const m2 = lbl("MATCHLINE (SEE SHEET 1)", 60, 850);
    const res = stitchSheets([mkSheet(1, [m1]), mkSheet(2, [m2])]);
    expect(res.placements.size).toBe(2); // referenced matchlines still bond
  });
});

describe("matchlineStrokePrior", () => {
  it("takes the perpendicular offset from the matchline STROKES, not the labels", () => {
    const VIEW: [number, number, number, number] = [0, 0, 2592, 1728];
    const hstroke = (id: string, y: number): Geom => ({ id, pts: [[40, y], [2550, y]], closed: false });
    // Sheet 1: matchline near the y1 edge (label at y=1600), stroke at y=1550.
    // Sheet 2: matchline near the y0 edge (label at y=120), stroke at y=170.
    // Labels sit at DIFFERENT offsets from their strokes (50 vs 50 but opposite),
    // so a label-based offset would differ from the stroke-based one.
    const s1 = { no: 1, scale: 20, sheetCode: null, raw: { shxLabels: [lbl("MATCHLINE (SEE SHEET 2)", 1200, 1600)], view: VIEW, geometry: [hstroke("a", 1550)] } };
    const s2 = { no: 2, scale: 20, sheetCode: null, raw: { shxLabels: [lbl("MATCHLINE (SEE SHEET 1)", 1200, 120)], view: VIEW, geometry: [hstroke("b", 170)] } };
    const r = matchlineStrokePrior(s1, s2);
    expect(r).not.toBeNull();
    expect(r!.perp).toBe("y");
    // dy from strokes: FT(1550) - FT(170) = (1550-170)/72*20
    expect(r!.dy).toBeCloseTo(((1550 - 170) / 72) * 20, 1);
  });

  it("returns null when the matchlines don't cross-reference", () => {
    const VIEW: [number, number, number, number] = [0, 0, 2592, 1728];
    const hstroke = (id: string, y: number): Geom => ({ id, pts: [[40, y], [2550, y]], closed: false });
    const s1 = { no: 1, scale: 20, sheetCode: null, raw: { shxLabels: [lbl("MATCHLINE (SEE SHEET 99)", 1200, 1600)], view: VIEW, geometry: [hstroke("a", 1550)] } };
    const s2 = { no: 2, scale: 20, sheetCode: null, raw: { shxLabels: [lbl("MATCHLINE (SEE SHEET 88)", 1200, 120)], view: VIEW, geometry: [hstroke("b", 170)] } };
    expect(matchlineStrokePrior(s1, s2)).toBeNull();
  });
});

describe("buildGeomFurnitureFilter", () => {
  it("flags boilerplate repeated at the same page position, not unique drawing", () => {
    const boilerPts: [number, number][] = [[100, 100], [300, 100], [300, 200]];
    const sheet = (key: number, unique: [number, number][]) => ({
      key,
      raw: { geometry: [{ id: "b", pts: boilerPts.map((p) => [...p] as [number, number]), closed: false }, { id: "u", pts: unique, closed: false }] },
    });
    const sheets = [
      sheet(1, [[500, 500], [600, 600]]),
      sheet(2, [[700, 800], [800, 900]]),
      sheet(3, [[900, 100], [950, 200]]),
      sheet(4, [[120, 700], [220, 760]]),
    ];
    const gf = buildGeomFurnitureFilter(sheets, 3);
    expect(gf.isFurniture({ id: "x", pts: boilerPts.map((p) => [...p] as [number, number]), closed: false })).toBe(true);
    expect(gf.isFurniture({ id: "y", pts: [[500, 500], [600, 600]], closed: false })).toBe(false);
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
