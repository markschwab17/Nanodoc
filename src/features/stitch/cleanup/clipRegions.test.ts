import { describe, it, expect } from "vitest";
import { cssClipPathWithHoles, cssClipToRect, disjointRects } from "./clipRegions";

describe("cssClipPathWithHoles", () => {
  it("returns null with no holes", () => {
    expect(cssClipPathWithHoles(100, 100, [])).toBeNull();
  });
  it("produces a polygon that includes the outer rect and the hole corners", () => {
    const p = cssClipPathWithHoles(200, 100, [{ x: 50, y: 25, w: 50, h: 50 }]);
    expect(p).not.toBeNull();
    expect(p!.startsWith("polygon(")).toBe(true);
    // outer corners present
    expect(p).toContain("0% 0%");
    expect(p).toContain("100% 100%");
    // hole corners as percentages: x 50/200=25%, 100/200=50%; y 25/100=25%, 75/100=75%
    expect(p).toContain("25% 25%");
    expect(p).toContain("50% 75%");
  });
});

describe("cssClipToRect", () => {
  it("returns a 4-corner polygon covering only the rect", () => {
    // rect x 50/200=25%, x2 100/200=50%; y 25/100=25%, y2 75/100=75%
    const p = cssClipToRect(200, 100, { x: 50, y: 25, w: 50, h: 50 });
    expect(p).toBe("polygon(25% 25%, 50% 25%, 50% 75%, 25% 75%)");
  });
  it("returns null for a zero-size tile", () => {
    expect(cssClipToRect(0, 100, { x: 0, y: 0, w: 1, h: 1 })).toBeNull();
  });
});

// ── Even-odd coverage harness ────────────────────────────────────────────────
// The recorded Apply-mask bug ("2 hidden" but the title column still rendered)
// is a *fill-rule* bug, not a geometry one, so testing the emitted string is not
// enough — these tests parse the polygon back and evaluate it the way a
// rasterizer does: cast a ray and count crossings under the even-odd rule.
function parsePolygon(p: string): { x: number; y: number }[] {
  const inner = p.replace(/^polygon\(/, "").replace(/\)$/, "");
  const body = inner.replace(/^\s*evenodd\s*,/, "");
  return body.split(",").map((pair) => {
    const [x, y] = pair.trim().split(/\s+/).map((v) => parseFloat(v));
    return { x, y };
  });
}
/** True when (px,py) — in PERCENT units — is painted under the even-odd rule. */
function coveredEvenOdd(pts: { x: number; y: number }[], px: number, py: number): boolean {
  let crossings = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (a.y === b.y) continue; // horizontal edges never cross a horizontal ray
    if (py < Math.min(a.y, b.y) || py >= Math.max(a.y, b.y)) continue;
    const xAt = a.x + ((py - a.y) / (b.y - a.y)) * (b.x - a.x);
    if (xAt > px) crossings++; // ray to the right
  }
  return crossings % 2 === 1;
}

describe("cssClipPathWithHoles — even-odd coverage", () => {
  const cover = (holes: { x: number; y: number; w: number; h: number }[], px: number, py: number) => {
    const p = cssClipPathWithHoles(100, 100, holes);
    return p === null ? true : coveredEvenOdd(parsePolygon(p), px, py);
  };

  it("hides the inside of a single hole and keeps the rest of the tile", () => {
    const hole = [{ x: 20, y: 20, w: 30, h: 30 }];
    expect(cover(hole, 35, 35)).toBe(false); // inside the hole → masked
    expect(cover(hole, 80, 80)).toBe(true);  // elsewhere → still painted
    expect(cover(hole, 35, 10)).toBe(true);  // above the hole
    expect(cover(hole, 70, 35)).toBe(true);  // right of the hole
  });

  it("REGRESSION: two IDENTICAL hide-boxes still mask (they used to cancel out)", () => {
    // The recorded symptom: a manual box added twice reported "2 hidden" and
    // masked nothing, because an even number of even-odd holes fills back in.
    const twice = [
      { x: 20, y: 20, w: 30, h: 30 },
      { x: 20, y: 20, w: 30, h: 30 },
    ];
    expect(cover(twice, 35, 35)).toBe(false);
    expect(cover(twice, 80, 80)).toBe(true);
  });

  it("REGRESSION: partially overlapping boxes mask their whole union", () => {
    const two = [
      { x: 10, y: 10, w: 40, h: 40 },
      { x: 30, y: 30, w: 40, h: 40 },
    ];
    expect(cover(two, 40, 40)).toBe(false); // the OVERLAP — used to show through
    expect(cover(two, 15, 15)).toBe(false); // only in the first
    expect(cover(two, 65, 65)).toBe(false); // only in the second
    expect(cover(two, 90, 90)).toBe(true);  // in neither
  });

  it("REGRESSION: frameMask-style bands mask the corners they overlap at", () => {
    // frameMask emits full-width top/bottom bands AND full-height side bands,
    // which overlap at all four corners.
    const bands = [
      { x: 0, y: 0, w: 100, h: 10 },   // top
      { x: 0, y: 90, w: 100, h: 10 },  // bottom
      { x: 0, y: 0, w: 10, h: 100 },   // left
      { x: 90, y: 0, w: 10, h: 100 },  // right
    ];
    expect(cover(bands, 5, 5)).toBe(false);   // top-left corner
    expect(cover(bands, 95, 5)).toBe(false);  // top-right
    expect(cover(bands, 5, 95)).toBe(false);  // bottom-left
    expect(cover(bands, 95, 95)).toBe(false); // bottom-right
    expect(cover(bands, 50, 50)).toBe(true);  // the frame interior survives
  });
});

describe("disjointRects", () => {
  it("leaves non-overlapping rects alone", () => {
    const rs = [{ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 10, h: 10 }];
    expect(disjointRects(rs)).toEqual(rs);
  });
  it("collapses an exact duplicate to one rect", () => {
    const r = { x: 5, y: 5, w: 10, h: 10 };
    expect(disjointRects([r, { ...r }])).toEqual([r]);
  });
  it("keeps the union's area while removing every overlap", () => {
    const out = disjointRects([
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 5, y: 5, w: 10, h: 10 },
    ]);
    // union area = 100 + 100 − 25 overlap = 175, and no two pieces intersect
    expect(out.reduce((s, r) => s + r.w * r.h, 0)).toBe(175);
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i], b = out[j];
        const ov =
          Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
          Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        expect(ov).toBe(0);
      }
  });
  it("drops a rect fully covered by an earlier one", () => {
    const out = disjointRects([
      { x: 0, y: 0, w: 20, h: 20 },
      { x: 5, y: 5, w: 5, h: 5 },
    ]);
    expect(out).toEqual([{ x: 0, y: 0, w: 20, h: 20 }]);
  });
  it("ignores zero-size rects", () => {
    expect(disjointRects([{ x: 0, y: 0, w: 0, h: 10 }])).toEqual([]);
  });
});
