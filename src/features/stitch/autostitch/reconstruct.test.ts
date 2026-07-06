import { describe, it, expect } from "vitest";
import { reconstruct } from "./reconstruct";
import type { Atom } from "./types";

/** A horizontal glyph run: chars at ascending x, height h, advance = adv. */
function glyphs(chars: string, x0: number, adv: number, h = 10): Atom[] {
  return [...chars].map((c, i) => ({
    text: c, x: x0 + i * adv, y: 0, dirX: 1, dirY: 0, h, len: adv, angle: 0, font: null,
  }));
}

describe("reconstruct", () => {
  it("glues adjacent glyphs into one word", () => {
    // adv == char width, gaps == 0 -> all glued
    const { labels, words } = reconstruct(glyphs("347", 0, 6));
    expect(labels).toHaveLength(1);
    expect(labels[0].text).toBe("347");
    expect(words.map((w) => w.text)).toEqual(["347"]);
  });

  it("splits a wide gap into a space-joined label with two words", () => {
    // "34" then a big gap (2 em) then "7" -> one label "34 7", two words
    const a = glyphs("34", 0, 6, 10);
    const b = glyphs("7", 6 * 2 + 10 * 1.0, 6, 10); // gap ~= 1.0*h (< GAP_SPACE 2.2*h, > GAP_GLUE 0.18*h)
    const { labels, words } = reconstruct([...a, ...b]);
    expect(labels).toHaveLength(1);
    expect(labels[0].text).toBe("34 7");
    expect(words.map((w) => w.text).sort()).toEqual(["34", "7"]);
  });

  it("keeps runs on different baselines as separate labels", () => {
    const top = glyphs("ABC", 0, 6, 10).map((g) => ({ ...g, y: 100 }));
    const bot = glyphs("XYZ", 0, 6, 10).map((g) => ({ ...g, y: 0 }));
    const { labels } = reconstruct([...top, ...bot]);
    expect(labels.map((l) => l.text).sort()).toEqual(["ABC", "XYZ"]);
  });

  it("drops whitespace-only and non-finite atoms", () => {
    const noisy: Atom[] = [
      ...glyphs("5", 0, 6),
      { text: " ", x: 6, y: 0, dirX: 1, dirY: 0, h: 10, len: 6, angle: 0, font: null },
      { text: "6", x: NaN, y: 0, dirX: 1, dirY: 0, h: 10, len: 6, angle: 0, font: null },
    ];
    const { labels } = reconstruct(noisy);
    expect(labels).toHaveLength(1);
    expect(labels[0].text).toBe("5");
  });
});
