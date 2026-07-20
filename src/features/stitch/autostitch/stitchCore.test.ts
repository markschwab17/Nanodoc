import { describe, it, test, expect } from "vitest";
import { tokenVote, stitchSheets, refineOffset, solveGlobal, buildGeomFurnitureFilter, matchlineStrokePrior, matchlinePrior, bandSeamPrior, seamCrossings, crossingConsensus, FT, type SheetInput, type SegFeat } from "./stitchCore";
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
    // Offset ≥0.75*H (600ft) to satisfy stricter bandSeamPrior floor
    const gA = [...drawing(400, 1650), ...boiler];
    const gB = [...drawing(400, 0), ...boiler];
    const mk = (no: number, geometry: Geom[]): SheetInput => ({
      id: String(no), no, scale: 20, view: VIEW,
      extract: { view: VIEW, shxLabels: [], labels: [], words: [], geometry } as PageExtract,
    });
    const res = stitchSheets([mk(1, gA), mk(2, gB)]);
    expect(res.placements.size).toBe(2); // both placed via geometry-only pairing
    const p2 = res.placements.get(2)!;
    // aligned on the DRAWING offset (~FT(1650)=458ft), NOT the boilerplate self-match at 0
    expect(Math.abs(p2.y)).toBeGreaterThan(400);
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

describe("solveGlobal per-axis weights", () => {
  it("a single-axis (wx:0) constraint constrains only its trustworthy axis", () => {
    // 1-2 pins both axes; 2-3 has a GARBAGE dx (999) but a valid dy (50) and
    // declares wx:0 so the x pass ignores it. Node 3's x is then unconstrained
    // (pulls to the tiny anchor, ~0) and must NOT be dragged toward pos2.x+999.
    const keys = [1, 2, 3];
    const cons = [
      { i: 1, j: 2, dx: 100, dy: 0, weight: 10 },
      { i: 2, j: 3, dx: 999, dy: 50, weight: 10, wx: 0 },
    ];
    const { pos } = solveGlobal(keys, 1, cons);
    const p2 = pos.get(2)!, p3 = pos.get(3)!;
    expect(p3.y).toBeCloseTo(p2.y + 50, 1); // valid dy propagates
    expect(Math.abs(p3.x - p2.x)).toBeLessThan(100); // NOT dragged toward 999
  });
});

describe("matchline label single-axis integration", () => {
  const VIEW: [number, number, number, number] = [0, 0, 2592, 1728]; // 720x480 ft @ 20
  const lbl = (text: string, x: number, y: number): Label =>
    ({ text, x, y, endX: x + 30, endY: y, angle: 0, h: 8, font: null });
  const ftToPt = (ft: number) => (ft / 20) * 72;

  it("keeps only the trustworthy (perpendicular) axis of a horizontal-matchline label pair", () => {
    // Sheet 1's bottom-of-page frame carries a matchline on its TOP edge; sheet 2's
    // on its BOTTOM edge — a horizontal matchline (labels pin dy, not dx). The label
    // x positions differ wildly (100pt vs 2000pt → ~528ft apart) while the TRUE
    // drawing offset is (dx=30ft, dy=430ft). segVote's ±60 window sits around the
    // garbage label dx (~-528ft) and misses the true dx, so the loose x axis must be
    // dropped; only dy (≈430) is trusted. With the OLD 2-D label-only constraint the
    // solve would lock x into that false basin. dx is underdetermined here (single
    // pair) → not asserted; only dy is guaranteed.
    const m1 = lbl("MATCHLINE (SEE SHEET 2)", 100, 1680);  // top edge (y1=1728)
    const m2 = lbl("MATCHLINE (SEE SHEET 1)", 2000, 132);  // bottom edge (y0=0)
    // Modest overlap linework (true world offset 30,430) that segVote's wrong
    // window misses — proves the loose axis can't be pinned from the label prior.
    const world: [number, number][] = [[60, 440], [95, 470], [130, 435], [170, 465], [120, 450], [200, 475]];
    const geomAt = (id: string, ox: number, oy: number): Geom =>
      ({ id, closed: false, pts: world.map(([wx, wy]): [number, number] => [ftToPt(wx - ox), ftToPt(wy - oy)]) });
    const mk = (no: number, labels: Label[], g: Geom): SheetInput => ({
      id: String(no), no, scale: 20, view: VIEW,
      extract: { view: VIEW, shxLabels: labels, labels, words: labels, geometry: [g] } as PageExtract,
    });
    const res = stitchSheets([
      mk(1, [m1], geomAt("g1", 0, 0)),      // sheet 1 frame origin at world (0,0)
      mk(2, [m2], geomAt("g2", 30, 430)),   // sheet 2 frame origin at world (30,430)
    ]);
    const p1 = res.placements.get(1)!, p2 = res.placements.get(2)!;
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    expect(p2.y - p1.y).toBeCloseTo(430, 0); // trustworthy axis correct (±10)
    const pair = res.pairs.find((r) => (r.i === 1 && r.j === 2) || (r.i === 2 && r.j === 1))!;
    expect(pair.channel).toBe("matchline-label-only"); // resolved via the matchline path
  });
});

describe("bandSeamPrior", () => {
  const VIEW: [number, number, number, number] = [0, 0, 3024, 2160]; // W=840ft H=600ft @ scale 20
  const shape = (myBase: number): SegFeat[] => Array.from({ length: 14 }, (_, i) => ({ mx: 120 + i * 45, my: myBase + (i % 5) * 12, len: 22 + (i % 7) * 4, ang: (i * 23) % 180 }));
  const mk = (seg: SegFeat[]) => ({ view: VIEW, scale: 20, seg });
  it("finds an axis-aligned vertical seam between abutting tiles", () => {
    // A's bottom-band content (my≈480) matches B's top-band content (my≈0): a
    // vertical seam, offset dy≈480, dx≈0. Updated to ≥0.75*H to satisfy new floor.
    const r = bandSeamPrior(mk(shape(480)), mk(shape(0)));
    expect(r).not.toBeNull();
    expect(Math.abs(r!.dx)).toBeLessThan(45); // axis-aligned (no horizontal shift)
    expect(r!.dy).toBeGreaterThan(450); // ≥0.75*H=450
  });
  it("returns null when the edge bands don't match", () => {
    const other = Array.from({ length: 14 }, (_, i) => ({ mx: 200 + i * 50, my: 70, len: 30 + i * 5, ang: (i * 40) % 180 }));
    expect(bandSeamPrior(mk(shape(480)), mk(other))).toBeNull();
  });
});

describe("bandSeamPrior abutment floor", () => {
  /** Sheet stub for bandSeamPrior: view + pre-filtered segFeats in FEET. */
  function seamSheet(segs: { mx: number; my: number; len: number; ang: number }[]) {
    // 2592x1728pt at 20 ft/in = 720x480 ft
    return { view: [0, 0, 2592, 1728] as [number, number, number, number], scale: 20, seg: segs };
  }
  /** A distinctive L-shaped cluster of ≥10 segments centered at (cx, cy) ft. */
  function cluster(cx: number, cy: number) {
    const out = [];
    for (let i = 0; i < 6; i++) out.push({ mx: cx + i * 3, my: cy, len: 10 + i, ang: 0 });
    for (let i = 0; i < 6; i++) out.push({ mx: cx, my: cy + i * 3, len: 10 + i, ang: 90 });
    return out;
  }

  it("rejects a half-sheet-offset vertical match (PG_SITE false seam)", () => {
    // A's cluster at my=460 sits fully inside A's bottom band (my>345.6=0.72*H);
    // B's cluster at my=115 sits fully inside B's top band (my<134.4=0.28*H) —
    // "fully inside" matters: the cluster helper spans [cy, cy+15], and a cy
    // too close to the 134.4 boundary clips points out of the band, starving
    // segVote below its inliers>=10 floor and short-circuiting the trial before
    // the abutment-floor check ever runs. With both clusters fully banded, all
    // 12 points vote and the bottom-of-A vs top-of-B trial reaches the
    // abutment-floor check with dy = 460-115 = 345 ft = 71.9% of the 480ft
    // sheet height, i.e. an implausible 28.1% claimed overlap. The old 0.5*H
    // floor (240) would ACCEPT this false seam (345>=240); the new 0.75*H
    // floor (360) must REJECT it (345<360).
    const a = seamSheet(cluster(360, 460));
    const b = seamSheet(cluster(360, 115));
    expect(bandSeamPrior(a, b)).toBeNull();
  });
  it("accepts a true abutting vertical seam (~0.85*H)", () => {
    const a = seamSheet(cluster(360, 470));
    const b = seamSheet(cluster(360, 62)); // dy = 408 = 0.85*H, within top band
    const v = bandSeamPrior(a, b);
    expect(v).not.toBeNull();
    expect(Math.abs(v!.dy)).toBeGreaterThan(400);
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

describe("stitchSheets method", () => {
  const mk = (id: string, no: number, labels: Label[]): SheetInput => ({
    id, no, scale: 20, view: [0, 0, 2592, 1728],
    extract: { view: [0, 0, 2592, 1728], shxLabels: labels, labels, words: labels, geometry: [] } as PageExtract,
  });

  it("reports 'geometric' when sheets stitch by shared tokens", () => {
    const OFF_PT = (300 * 72) / 20;
    const texts = ["TC347.33", "TC348.10", "FL346.90", "TC349.55", "FL347.10", "TC350.02"];
    const a = texts.map((t, i) => lbl(t, 400 + i * 120, 800 + (i % 2) * 60));
    const b = texts.map((t, i) => lbl(t, 400 + i * 120 - OFF_PT, 800 + (i % 2) * 60));
    const res = stitchSheets([mk("a", 1, a), mk("b", 2, b)]);
    expect(res.placements.size).toBe(2);
    expect(res.method).toBe("geometric");
  });

  it("reports 'none' when nothing connects", () => {
    const m1 = lbl("MATCHLINE (SEE SHEET 99)", 2450, 850);
    const m2 = lbl("MATCHLINE (SEE SHEET 88)", 60, 850);
    const res = stitchSheets([mk("1", 1, [m1]), mk("2", 2, [m2])]);
    expect(res.placements.size).toBe(0);
    expect(res.method).toBe("none");
  });

  it("reports 'keymap' when a site grid is supplied", () => {
    const grid = new Map([[1, { col: 0, row: 0 }], [2, { col: 1, row: 0 }]]);
    const res = stitchSheets([mk("1", 1, []), mk("2", 2, [])], grid);
    expect(res.method).toBe("keymap");
    expect(res.placements.size).toBe(2);
  });
});

describe("stitchSheets anchor channel", () => {
  const VIEW: [number, number, number, number] = [0, 0, 2592, 1728]; // 720x480 ft @ 20
  const SCALE = 20;
  const ftToPt = (ft: number) => (ft / SCALE) * 72;
  const frac = (v: number) => v - Math.floor(v);
  // A distinctive zigzag in FEET with genuinely distinct per-segment (len,angle)
  // signatures (24 vertices, every dx>=8ft so no segment is dropped by the minLen
  // floor). Distinctness keeps segVote's alias cap from skipping repeats.
  const zigFt = (): [number, number][] => {
    const pts: [number, number][] = [];
    let x = 0, y = 0;
    for (let i = 0; i < 24; i++) {
      const t = i + 1;
      x += 8 + frac(Math.sin(t * 12.9898) * 43758.5453) * 14;
      y += (frac(Math.sin(t * 78.233) * 12543.129) - 0.5) * 44;
      pts.push([400 + x, 240 + y]);
    }
    return pts;
  };
  const Z = zigFt();
  // Materialize Z shifted by (dxFt,dyFt) in local feet, converted to page pts.
  const shifted = (dxFt: number, dyFt: number, id: string): Geom =>
    ({ id, closed: false, pts: Z.map(([x, y]): [number, number] => [ftToPt(x - dxFt), ftToPt(y - dyFt)]) });
  const mk = (no: number, geometry: Geom[]): SheetInput => ({
    id: String(no), no, scale: SCALE, view: VIEW,
    extract: { view: VIEW, shxLabels: [], labels: [], words: [], geometry } as PageExtract,
  });

  it("resolves the true seam in the anchored basin past a decoy alias", () => {
    // Sheet 1 carries zigzag Z. Sheet 2 carries a TRUE copy at Z-(500,10) AND a
    // DECOY copy at Z-(150,10) — the decoy is a full-zigzag alias at dx=150 that a
    // window-free segment vote could bond on. The ±30ft window around the anchor
    // (dx=495) admits only the true basin.
    const g1 = [shifted(0, 0, "z1")];
    const g2 = [shifted(500, 10, "z2-true"), shifted(150, 10, "z2-decoy")];
    const res = stitchSheets([mk(1, g1), mk(2, g2)], undefined, [{ i: 1, j: 2, dx: 495 }]);
    const p1 = res.placements.get(1)!, p2 = res.placements.get(2)!;
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    const dx = p2.x - p1.x;
    expect(dx).toBeGreaterThanOrEqual(470);
    expect(dx).toBeLessThanOrEqual(530);
    const pair = res.pairs.find((r) => (r.i === 1 && r.j === 2) || (r.i === 2 && r.j === 1))!;
    expect(pair.channel).toBe("anchor+segment");
  });

  it("resolves a VERTICAL (perp:'y') anchor past a decoy alias", () => {
    // A top/bottom matchline pins dy: sheet 2 carries a TRUE copy at Z-(10,500)
    // and a DECOY at Z-(10,150). The perp:'y' anchor (dy=495) windows segVote tight
    // on y (admits only the dy≈500 basin) and free on x, so the vertical seam
    // resolves in the true basin — the symmetric counterpart of the horizontal case.
    const g1 = [shifted(0, 0, "z1")];
    const g2 = [shifted(10, 500, "z2-true"), shifted(10, 150, "z2-decoy")];
    const res = stitchSheets([mk(1, g1), mk(2, g2)], undefined, [{ i: 1, j: 2, dy: 495, perp: "y" }]);
    const p1 = res.placements.get(1)!, p2 = res.placements.get(2)!;
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();
    const dy = p2.y - p1.y;
    expect(dy).toBeGreaterThanOrEqual(470);
    expect(dy).toBeLessThanOrEqual(530);
    const pair = res.pairs.find((r) => (r.i === 1 && r.j === 2) || (r.i === 2 && r.j === 1))!;
    expect(pair.channel).toBe("anchor+segment");
  });

  it("rejects an anchor below the abutment floor (0.25×dim), accepts one at 0.8×dim", () => {
    // Matchline-adjacent units nearly abut, so a perp:'y' anchor's offset must lie
    // in [0.5·H, 1.15·H] = [240, 552] ft for this 480 ft-tall sheet. An anchor
    // implying only 0.25·H = 120 ft of separation means ~75% overlap — impossible
    // for abutting sheets (this is the row 2↔3 collapse regression) — so the anchor
    // is rejected and the pair carries NO anchor channel. A 0.8·H = 384 ft anchor
    // is a legitimate near-abutting seam and resolves as "anchor+segment".
    const H = FT(VIEW[3] - VIEW[1], SCALE); // 480 ft
    // REJECTED: anchor dy = 0.25·H = 120 ft, below the 240 ft floor.
    const rej = stitchSheets(
      [mk(1, [shifted(0, 0, "z1")]), mk(2, [shifted(10, 0.25 * H, "z2")])],
      undefined,
      [{ i: 1, j: 2, dy: 0.25 * H, perp: "y" }],
    );
    const rejPair = rej.pairs.find((r) => (r.i === 1 && r.j === 2) || (r.i === 2 && r.j === 1));
    expect(rejPair?.channel ?? null).not.toBe("anchor+segment");
    // ACCEPTED: anchor dy = 0.8·H = 384 ft, a valid near-abutting seam.
    const acc = stitchSheets(
      [mk(1, [shifted(0, 0, "z1")]), mk(2, [shifted(10, 0.8 * H, "z2")])],
      undefined,
      [{ i: 1, j: 2, dy: 0.8 * H, perp: "y" }],
    );
    const accPair = acc.pairs.find((r) => (r.i === 1 && r.j === 2) || (r.i === 2 && r.j === 1))!;
    expect(accPair.channel).toBe("anchor+segment");
  });

  it("a precise (stroke-refined) anchor emits its perp-axis constraint even when segVote finds nothing", () => {
    // Sheet 2's linework is far from any plausible seam window (no drawing overlap at
    // the matchline), so segVote returns null. A LABEL-only anchor would drop out
    // here — but the physical matchline STROKE is ground truth for the perp axis, so
    // a precise anchor still emits a single-axis "anchor-stroke" constraint that pins
    // the perpendicular (x) offset; the along-axis is left to the graph.
    const STROKE = 500; // in [0.5·W, 1.15·W] = [360, 828] → clears the abutment floor
    const res = stitchSheets(
      [mk(1, [shifted(0, 0, "z1")]), mk(2, [shifted(9999, 5000, "z-faraway")])],
      undefined,
      [{ i: 1, j: 2, dx: STROKE, perp: "x", precise: true }],
    );
    const pair = res.pairs.find((r) => (r.i === 1 && r.j === 2) || (r.i === 2 && r.j === 1))!;
    expect(pair.channel).toBe("anchor-stroke");
    const dx = res.placements.get(2)!.x - res.placements.get(1)!.x;
    expect(Math.abs(dx - STROKE)).toBeLessThanOrEqual(3);
  });

  it("a precise anchor overrides a segVote perp that a decoy alias pulled off the true matchline", () => {
    // The densest linework overlap sits at 490 (segVote's peak — the periodic module
    // draws the seam content one alias off the true matchline). The matchline STROKE
    // is at 500. A precise anchor PINS the perp to the 500 stroke (crisp seam); a
    // plain label anchor follows segVote to the aliased 490 (the visible ghost).
    const STROKE = 500, LINEWORK = 490; // 10 ft apart, both inside the ±30 ft anchor window
    const g1 = [shifted(0, 0, "z1")];
    const g2 = [shifted(LINEWORK, 0, "z-content")];
    const precise = stitchSheets([mk(1, g1), mk(2, g2)], undefined, [{ i: 1, j: 2, dx: STROKE, perp: "x", precise: true }]);
    const pp = precise.pairs.find((r) => (r.i === 1 && r.j === 2) || (r.i === 2 && r.j === 1))!;
    expect(pp.channel).toBe("anchor+segment");
    expect(pp.dxFt!).toBeGreaterThan(498); // pinned to the 500 stroke
    expect(pp.dxFt!).toBeLessThan(502);
    expect(Math.abs((precise.placements.get(2)!.x - precise.placements.get(1)!.x) - STROKE)).toBeLessThanOrEqual(3);
    // A non-precise (label) anchor at the same nominal offset follows segVote's peak.
    const label = stitchSheets([mk(1, g1), mk(2, g2)], undefined, [{ i: 1, j: 2, dx: STROKE, perp: "x" }]);
    const lp = label.pairs.find((r) => (r.i === 1 && r.j === 2) || (r.i === 2 && r.j === 1))!;
    expect(lp.dxFt!).toBeGreaterThan(487); // aliased toward the 490 linework peak
    expect(lp.dxFt!).toBeLessThan(493);
  });
});

describe("seamCrossings + crossingConsensus", () => {
  // A vertical matchline at x=cross; a horizontal (transverse) segment crosses it.
  const seg = (id: string, pts: [number, number][]): Geom => ({ id, closed: false, pts });

  it("records a transverse crossing's along-station and excludes parallel linework", () => {
    // Vertical matchline (axis "v") at x=1000 pt. A horizontal street segment ending
    // at the line at y=720 pt (world y = FT(720,20)=200 ft) → one crossing at 200 ft.
    // A near-parallel (vertical) segment along the matchline must NOT register.
    const geom: Geom[] = [
      seg("street", [[900, 720], [995, 720]]),      // horizontal, ends 5pt short of the line
      seg("matchdash", [[1000, 400], [1000, 480]]), // vertical dash ON the matchline (parallel)
    ];
    const cr = seamCrossings(geom, "v", 1000, 20);
    expect(cr.length).toBe(1);
    expect(cr[0]).toBeCloseTo(200, 0); // FT(720,20)
  });

  it("collapses one street's coincident linework into a single station", () => {
    // A street crossing x=1000 is drawn as several near-coincident long lines (two
    // curbs + centerline) at y≈360 pt (world 100 ft). All are ≥12 ft and land within
    // the dedup tolerance, so they must vote ONCE, not three times.
    const lines: Geom[] = [360, 362, 364].map((y, i) =>
      seg(`d${i}`, [[900, y], [985, y]])); // 85 pt ≈ 23.6 ft each, ends 15 pt short of the line
    const cr = seamCrossings(lines, "v", 1000, 20);
    expect(cr.length).toBe(1);
    expect(cr[0]).toBeCloseTo(100, 0);
  });

  it("consensus picks the true offset over a periodic decoy 45 ft off", () => {
    // Six shared crossings at APERIODIC stations give a clean peak at the true along
    // offset (+20 ft). A periodic decoy (stations 45 ft apart, matching at +65 ft)
    // makes a competing peak — but with fewer inliers, so the true +20 wins.
    const TRUE = 20;
    const trueI = [0, 17, 39, 68, 102, 141];          // aperiodic real stations on sheet i
    const trueJ = trueI.map((s) => s - TRUE);          // same world features on sheet j
    const decoyI = [200, 245, 290];                    // periodic decoy (45 ft pitch)
    const decoyJ = decoyI.map((s) => s - (TRUE + 45)); // matches at +65 ft
    const c = crossingConsensus([...trueI, ...decoyI], [...trueJ, ...decoyJ], TRUE);
    expect(c).not.toBeNull();
    expect(c!.along).toBeCloseTo(TRUE, 0);
    expect(c!.inliers).toBeGreaterThanOrEqual(5);
  });

  it("returns null when no peak is decisive vs the runner-up", () => {
    // Two equal-strength offsets (0 and 30) → no 1.5× dominance → not decisive.
    const aI = [0, 40, 80], aJ0 = [0, 40, 80], aJ30 = [-30, 10, 50];
    const c = crossingConsensus([...aI], [...aJ0, ...aJ30], 15);
    expect(c).toBeNull();
  });

  it("is scale-invariant: the same consensus at half the scale is exactly halved", () => {
    const I20 = [0, 17, 39, 68, 102], J20 = I20.map((s) => s - 20);
    const c20 = crossingConsensus(I20, J20, 20, { window: FT(216, 20), bin: FT(7.2, 20) });
    const c10 = crossingConsensus(I20.map((s) => s / 2), J20.map((s) => s / 2), 10, { window: FT(216, 10), bin: FT(7.2, 10) });
    expect(c20).not.toBeNull();
    expect(c10).not.toBeNull();
    expect(c10!.along).toBeCloseTo(c20!.along / 2, 1);
  });
});

describe("stitchSheets fully-2D-precise (crossing) anchor", () => {
  const VIEW: [number, number, number, number] = [0, 0, 2592, 1728]; // 720x480 ft @20
  const SCALE = 20;
  const ftToPt = (ft: number) => (ft / SCALE) * 72;
  const frac = (v: number) => v - Math.floor(v);
  const zigFt = (): [number, number][] => {
    const pts: [number, number][] = [];
    let x = 0, y = 0;
    for (let i = 0; i < 24; i++) {
      const t = i + 1;
      x += 8 + frac(Math.sin(t * 12.9898) * 43758.5453) * 14;
      y += (frac(Math.sin(t * 78.233) * 12543.129) - 0.5) * 44;
      pts.push([400 + x, 240 + y]);
    }
    return pts;
  };
  const Z = zigFt();
  const shifted = (dxFt: number, dyFt: number, id: string): Geom =>
    ({ id, closed: false, pts: Z.map(([x, y]): [number, number] => [ftToPt(x - dxFt), ftToPt(y - dyFt)]) });
  const mk = (no: number, geometry: Geom[]): SheetInput => ({
    id: String(no), no, scale: SCALE, view: VIEW,
    extract: { view: VIEW, shxLabels: [], labels: [], words: [], geometry } as PageExtract,
  });

  it("pins BOTH axes (perp stroke + crossing along) and survives refine past a nearby decoy", () => {
    // Fully-2D-precise anchor: perp (x) = 500 ft stroke, along (y) = 30 ft crossing
    // consensus. Sheet 2 carries the TRUE linework at (500,30) AND a DENSER decoy at
    // (500,35) — 5 ft off ALONG the matchline, inside refineOffset's ~6 ft window, so
    // an unexempted refine would pull the along axis to 35. Because the anchor is
    // fully precise, its constraint is EXEMPT from refine and the along stays at 30.
    const g1 = [shifted(0, 0, "z1")];
    const g2 = [shifted(500, 30, "z-true"), shifted(500, 35, "z-decoy-a"), shifted(500, 35, "z-decoy-b")];
    const res = stitchSheets([mk(1, g1), mk(2, g2)], undefined,
      [{ i: 1, j: 2, dx: 500, perp: "x", precise: true, along: 30, alongPrecise: true }]);
    const pair = res.pairs.find((r) => (r.i === 1 && r.j === 2) || (r.i === 2 && r.j === 1))!;
    expect(pair.channel).toBe("anchor+cross");
    const dx = res.placements.get(2)!.x - res.placements.get(1)!.x;
    const dy = res.placements.get(2)!.y - res.placements.get(1)!.y;
    expect(Math.abs(dx - 500)).toBeLessThanOrEqual(3); // perp pinned to the stroke
    expect(Math.abs(dy - 30)).toBeLessThanOrEqual(3);  // along pinned to the crossing (not the 35 decoy)
  });
});

describe("scale-invariance (pt-derived windows)", () => {
  // The solver's acceptance windows are page-point-derived, so the SAME page
  // geometry solved at different ft/in scales must yield placements that scale
  // EXACTLY linearly with the scale — no scale-dependent basin/alias flips.
  // A 1600pt-wide sheet keeps the OFFSET_PT=900 anchor above the abutment floor
  // (0.5·1600 = 800 pt): these two copies are a legitimately near-abutting seam.
  const VIEW: [number, number, number, number] = [0, 0, 1600, 1080];
  const frac = (v: number) => v - Math.floor(v);
  // Zigzag in PAGE POINTS (scale-independent); each segment ≥40pt so it clears the
  // (now pt-derived, constant 28.8pt) minimum-length floor at every scale.
  const zigPt = (): [number, number][] => {
    const pts: [number, number][] = [];
    let x = 0, y = 0;
    for (let i = 0; i < 24; i++) {
      const t = i + 1;
      x += 40 + frac(Math.sin(t * 12.9898) * 43758.5453) * 40;
      y += (frac(Math.sin(t * 78.233) * 12543.129) - 0.5) * 80;
      pts.push([300 + x, 200 + y]);
    }
    return pts;
  };
  const Zpt = zigPt();
  const OFFSET_PT = 900; // fixed page-point separation between the two sheets' copies
  const shiftPt = (dxPt: number, dyPt: number, id: string): Geom =>
    ({ id, closed: false, pts: Zpt.map(([x, y]): [number, number] => [x - dxPt, y - dyPt]) });
  const mk = (no: number, scale: number, geometry: Geom[]): SheetInput => ({
    id: String(no), no, scale, view: VIEW,
    extract: { view: VIEW, shxLabels: [], labels: [], words: [], geometry } as PageExtract,
  });
  const run = (scale: number) =>
    stitchSheets(
      [mk(1, scale, [shiftPt(0, 0, "z1")]), mk(2, scale, [shiftPt(OFFSET_PT, 40, "z2")])],
      undefined,
      [{ i: 1, j: 2, dx: FT(OFFSET_PT - 20, scale) }], // anchor near the true offset, in feet at this scale
    );

  it("places identically (up to the scale factor) at scale 10 and scale 40", () => {
    const r10 = run(10), r40 = run(40);
    const a10 = r10.placements.get(2)!, a40 = r40.placements.get(2)!;
    expect(a10).toBeDefined();
    expect(a40).toBeDefined();
    // scale 40 is 4× scale 10; the placement (world feet) must scale by exactly 4×.
    expect(a40.x / a10.x).toBeCloseTo(4, 3);
    expect(a10.x).toBeCloseTo(FT(OFFSET_PT, 10), 0); // ≈ the true page-point offset in feet @10
    // both channels resolved the same way (identical topology decision)
    const c10 = r10.pairs.find((p) => p.channel)!.channel;
    const c40 = r40.pairs.find((p) => p.channel)!.channel;
    expect(c40).toBe(c10);
    expect(c10).toBe("anchor+segment");
  });
});

describe("matchlinePrior strip exclusion", () => {
  const VIEW: [number, number, number, number] = [0, 0, 2592, 1728];
  const mkS = (no: number, labels: Label[], siblingKey?: number) =>
    ({ no, scale: 20, siblingKey, sheetCode: null, raw: { shxLabels: labels, view: VIEW } });

  it("ignores a strip ref for a non-sibling pair, honors it for the sibling", () => {
    // A: a strip ref ("SEE BELOW RIGHT") on its right edge. B: a plain MATCHLINE on
    // its left edge (opposite edge). A strip label points only at A's OWN facing
    // frame — it must never anchor an unrelated sheet B.
    const stripA = () => [lbl("SEE BELOW RIGHT", 2450, 850)];
    const matchB = () => [lbl("MATCHLINE", 60, 850)];
    // non-siblings → strip ref dropped → no facing pair
    expect(matchlinePrior(mkS(1, stripA()), mkS(2, matchB()))).toBeNull();
    // siblings (frames of the same page) → strip ref honored → facing pair
    expect(matchlinePrior(mkS(1, stripA(), 2), mkS(2, matchB(), 1))).not.toBeNull();
  });
});

describe("unit stitching (frames + printed numbers + strip refs)", () => {
  // Strip-plan chain, all horizontal (west→east) so the test does not depend
  // on the solver's vertical-axis naming convention:
  //   unit1 = top strip of printed sheet 2 ("SEE BELOW LEFT" on its right edge)
  //   unit2 = bottom strip of sheet 2 (continues east; "SEE ABOVE RIGHT" left
  //           edge, "SEE SHEET 9" right edge)
  //   unit3 = printed sheet 9 ("SEE SHEET 2" on its left edge)
  // World layout (feet): unit1 at (0,0); unit2 at (170,10); unit3 at (340,20).
  // Each adjacent pair shares a distinctive zigzag polyline in its ~30ft overlap.
  const view: [number, number, number, number] = [0, 0, 720, 480]; // 200x133 ft at scale 20
  const lbl = (text: string, x: number, y: number) =>
    ({ text, x, y, endX: x + 60, endY: y + 8, angle: 0, h: 8, font: null, atoms: 3 });
  const SCALE = 20;
  const ftToPt = (ft: number) => (ft / SCALE) * 72;
  const frac = (v: number) => v - Math.floor(v);
  /**
   * Irregular polyline with genuinely DISTINCT per-segment (len,angle)
   * signatures, keyed by `seed` so two zigzags with different seeds share no
   * signatures. Distinctness matters twice: within one zigzag it keeps segVote's
   * alias cap (`cand.length > 10`) from skipping a repeated signature, and across
   * zigzags it stops non-adjacent units (unit1's zA vs unit3's zB) from
   * alias-bonding. Every dx >= 8ft so no segment is dropped by the minLen floor.
   */
  const zig = (worldX0: number, worldY0: number, seed: number): [number, number][] => {
    const pts: [number, number][] = [];
    let x = 0, y = 0;
    for (let i = 0; i < 14; i++) {
      const t = (i + 1) * seed;
      x += 8 + frac(Math.sin(t * 12.9898) * 43758.5453) * 14;
      y += (frac(Math.sin(t * 78.233) * 12543.129) - 0.5) * 44;
      pts.push([worldX0 + x, worldY0 + y]);
    }
    return pts;
  };
  /** Materialize a world-ft polyline into a unit whose frame origin sits at (ox, oy) world-ft. */
  const geomFor = (id: string, world: [number, number][], ox: number, oy: number) => [{
    id, closed: false,
    pts: world.map(([wx, wy]): [number, number] => [ftToPt(wx - ox), ftToPt(wy - oy)]),
  }];
  const zA = zig(175, 15, 1);  // in the unit1/unit2 overlap band
  const zB = zig(345, 25, 2);  // in the unit2/unit3 overlap band
  const unit1: SheetInput = {
    id: "p1f0", no: 1, printedNo: 2, pageIndex: 1, siblingKey: 2, scale: SCALE, view,
    frame: [100, 60, 820, 540],
    extract: { view, words: [], shxLabels: [],
      labels: [lbl("SEE BELOW LEFT", 640, 300)],
      geometry: geomFor("zA1", zA, 0, 0) },
  };
  const unit2: SheetInput = {
    id: "p1f1", no: 2, printedNo: 2, pageIndex: 1, siblingKey: 1, scale: SCALE, view,
    frame: [100, 620, 820, 1100],
    extract: { view, words: [], shxLabels: [],
      labels: [lbl("SEE ABOVE RIGHT", 5, 100), lbl("SEE SHEET 9", 640, 200)],
      geometry: [...geomFor("zA2", zA, 170, 10), ...geomFor("zB2", zB, 170, 10)] },
  };
  const unit3: SheetInput = {
    id: "p8f0", no: 3, printedNo: 9, pageIndex: 8, scale: SCALE, view,
    frame: [100, 60, 820, 540],
    extract: { view, words: [], shxLabels: [],
      labels: [lbl("SEE SHEET 2", 5, 200)],
      geometry: geomFor("zB3", zB, 340, 20) },
  };

  test("strip + numeric refs place the chain west-to-east", () => {
    const res = stitchSheets([unit1, unit2, unit3]);
    expect(res.method).toBe("geometric");
    const p1 = res.placements.get(1)!, p2 = res.placements.get(2)!, p3 = res.placements.get(3)!;
    expect(p1).toBeDefined(); expect(p2).toBeDefined(); expect(p3).toBeDefined();
    expect(p2.x - p1.x).toBeGreaterThan(150); expect(p2.x - p1.x).toBeLessThan(190);
    expect(Math.abs(p2.y - p1.y)).toBeLessThan(30);
    expect(p3.x - p1.x).toBeGreaterThan(320); expect(p3.x - p1.x).toBeLessThan(360);
    expect(Math.abs(p3.y - p1.y)).toBeLessThan(40);
  });
});
