import { describe, expect, test } from "vitest";
import { detectFrames, sliceExtract } from "./frameDetect";
import type { Geom, PageExtract } from "./types";

let gid = 0;
/** Dashed axis-aligned rectangle border as individual dash segments. */
function dashedRect(x0: number, y0: number, x1: number, y1: number, dash = 20, gap = 10): Geom[] {
  const out: Geom[] = [];
  const seg = (ax: number, ay: number, bx: number, by: number) =>
    out.push({ id: `g${gid++}`, pts: [[ax, ay], [bx, by]], closed: false });
  for (let x = x0; x < x1; x += dash + gap) seg(x, y0, Math.min(x + dash, x1), y0);
  for (let x = x0; x < x1; x += dash + gap) seg(x, y1, Math.min(x + dash, x1), y1);
  for (let y = y0; y < y1; y += dash + gap) seg(x0, y, x0, Math.min(y + dash, y1));
  for (let y = y0; y < y1; y += dash + gap) seg(x1, y, x1, Math.min(y + dash, y1));
  return out;
}
const page = (geometry: Geom[], extra: Partial<PageExtract> = {}): PageExtract => ({
  view: [0, 0, 2592, 1728], shxLabels: [], labels: [], words: [], geometry, ...extra,
});

describe("detectFrames", () => {
  test("single frame sheet", () => {
    const f = detectFrames(page(dashedRect(80, 60, 2200, 1600)));
    expect(f).toHaveLength(1);
    const [x0, y0, x1, y1] = f[0].bbox;
    expect(x0).toBeCloseTo(80, -1); expect(y0).toBeCloseTo(60, -1);
    expect(x1).toBeCloseTo(2200, -1); expect(y1).toBeCloseTo(1600, -1);
  });
  test("two stacked strips, different widths (PG_SITE p1 shape)", () => {
    const f = detectFrames(page([
      ...dashedRect(80, 40, 1500, 700),   // top strip, narrower
      ...dashedRect(60, 760, 2300, 1560), // bottom strip, wider
    ]));
    expect(f).toHaveLength(2);
    expect(f[0].bbox[3]).toBeLessThan(f[1].bbox[1]); // top-first
    expect(f[0].bbox[2]).toBeCloseTo(1500, -1);      // per-frame right edge, NOT global max
    expect(f[1].bbox[2]).toBeCloseTo(2300, -1);
  });
  test("interior long line does not split a single frame", () => {
    const road: Geom[] = [{ id: "road", pts: [[100, 800], [2100, 800]], closed: false }];
    const f = detectFrames(page([...dashedRect(80, 60, 2200, 1600), ...road]));
    expect(f).toHaveLength(1);
  });
  test("no frame (notes sheet) returns []", () => {
    const f = detectFrames(page([{ id: "x", pts: [[100, 100], [300, 100]], closed: false }]));
    expect(f).toEqual([]);
  });
});

describe("sliceExtract", () => {
  test("filters and normalizes to frame-local coordinates", () => {
    const inLbl  = { text: "SEE SHEET 9", x: 500, y: 770, endX: 580, endY: 778, angle: 0, h: 8, font: null };
    const outLbl = { text: "ELSEWHERE 1", x: 100, y: 100, endX: 180, endY: 108, angle: 0, h: 8, font: null };
    const inG: Geom  = { id: "a", pts: [[600, 900], [700, 900]], closed: false };
    const outG: Geom = { id: "b", pts: [[100, 100], [200, 100]], closed: false };
    const s = sliceExtract(page([inG, outG], { labels: [inLbl, outLbl] }), { bbox: [60, 760, 2300, 1560] });
    expect(s.view).toEqual([0, 0, 2240, 800]);
    expect(s.labels).toHaveLength(1);
    expect(s.labels[0].x).toBeCloseTo(440); // 500 - 60
    expect(s.labels[0].y).toBeCloseTo(10);  // 770 - 760
    expect(s.geometry).toHaveLength(1);
    expect(s.geometry[0].pts[0]).toEqual([540, 140]);
  });
});
