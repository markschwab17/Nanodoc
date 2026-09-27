import { describe, expect, it } from "vitest";
import { decodeHex, decodeLiteral, parseTJArray, showText, type TextState } from "./textShow";
import { filterContentStream, IDENTITY } from "./contentFilter";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

describe("string and TJ parsing", () => {
  it("decodes literal escapes, octal and nesting", () => {
    const b = enc("(a\\(b\\)\\101\\n(x))");
    expect(Array.from(decodeLiteral(b, 0, b.length))).toEqual([97, 40, 98, 41, 65, 10, 40, 120, 41]);
  });
  it("decodes hex with whitespace and an odd digit count", () => {
    const b = enc("<41 42 4>");
    expect(Array.from(decodeHex(b, 0, b.length))).toEqual([0x41, 0x42, 0x40]);
  });
  it("parses TJ arrays of strings and numbers", () => {
    const b = enc("[(AB) -120 <43> 5.5(D)]");
    const el = parseTJArray(b, 0, b.length)!;
    expect(el.map((e) => (e.kind === "num" ? e.v : dec(e.bytes)))).toEqual(["AB", -120, "C", 5.5, "D"]);
  });
});

describe("showText", () => {
  const ts: TextState = { Tc: 1, Tw: 2, Th: 1, TL: 0, Ts: 0, font: "F1", Tfs: 10 };
  const font = { bytesPerCode: 1 as const, width: () => 500 };
  it("replaces a removed glyph by exactly its advance, keeping later glyphs in place", () => {
    // Glyph advance = (500/1000 * 10 + Tc 1) = 6; space adds Tw 2.
    const origins: number[] = [];
    const r = showText([{ kind: "str", bytes: enc("A B") }], ts, [1, 0, 0, 1, 0, 0], IDENTITY, font, (x) => { origins.push(x); return x === 6; });
    expect(origins).toEqual([0, 6, 14]);
    // The space (at x=6) goes: TJ adjustment -(5 + 1 + 2) * 1000 / 10 = -800.
    expect(r.replacement).toBe("[<41> -800 <42>]");
    expect(r.tm[4]).toBe(20);
  });
  it("returns no replacement when nothing is erased", () => {
    expect(showText([{ kind: "str", bytes: enc("AB") }], ts, [1, 0, 0, 1, 0, 0], IDENTITY, font, () => false).replacement).toBeNull();
  });
});

describe("filterContentStream text edits", () => {
  it("removes one glyph from Tj and leaves the rest of the stream as it was", () => {
    const src = "BT /F1 10 Tf 1 0 0 1 100 200 Tm (ABC) Tj ET 0 0 m 1 1 l S";
    const res = filterContentStream(enc(src), IDENTITY, {
      decide: () => ({ kind: "keep" }),
      font: () => ({ bytesPerCode: 1, width: () => 600 }),
      eraseGlyph: (x, y) => Math.abs(x - 106) < 0.5 && Math.abs(y - 200) < 0.5, // the "B"
    });
    expect(dec(res.bytes)).toBe("BT /F1 10 Tf 1 0 0 1 100 200 Tm [<41> -600 <43>] TJ ET 0 0 m 1 1 l S");
    expect(res.stats.glyphsRemoved).toBe(1);
  });
  it("keeps positions across Td / T* / ' and TJ kerning", () => {
    const seen: Array<[number, number]> = [];
    filterContentStream(enc("BT /F1 10 Tf 12 TL 5 5 Td [(A) -1000 (B)] TJ T* (C) Tj (D) ' ET"), IDENTITY, {
      decide: () => ({ kind: "keep" }),
      font: () => ({ bytesPerCode: 1, width: () => 500 }),
      eraseGlyph: (x, y) => { seen.push([x, y]); return false; },
    });
    expect(seen).toEqual([[5, 5], [20, 5], [5, -7], [5, -19]]);
  });
});
