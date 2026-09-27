import { describe, expect, it } from "vitest";
import { filterContentStream, IDENTITY, matMul, type Mat, type PaintedPath, type PathVerdict } from "./contentFilter";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

function collect(src: string, base: Mat = IDENTITY, verdict: (p: PaintedPath, i: number) => PathVerdict = () => ({ kind: "keep" })) {
  const paths: PaintedPath[] = [];
  const res = filterContentStream(enc(src), base, {
    decide: (p) => { paths.push(p); return verdict(p, paths.length - 1); },
  });
  return { paths, out: dec(res.bytes), res };
}

describe("matMul", () => {
  it("applies the first matrix first (PDF cm order)", () => {
    const scale: Mat = [2, 0, 0, 2, 0, 0];
    const shift: Mat = [1, 0, 0, 1, 10, 0];
    // scale then shift: (1,0) → (2,0) → (12,0)
    const m = matMul(scale, shift);
    expect(m[0] * 1 + m[4]).toBe(12);
  });
});

describe("filterContentStream — reading paths", () => {
  it("reports each painted path with its geometry and paint operator", () => {
    const { paths } = collect("1 w 0 0 m 10 0 l 10 10 l S\n5 5 20 30 re f\n");
    expect(paths).toHaveLength(2);
    expect(paths[0].paint).toBe("S");
    expect(paths[0].subpaths[0]).toMatchObject({ x0: 0, y0: 0, closed: false });
    expect(paths[0].subpaths[0].segs.map((s) => s.pts)).toEqual([[10, 0], [10, 10]]);
    expect(paths[1].paint).toBe("f");
    expect(paths[1].subpaths[0]).toMatchObject({ x0: 5, y0: 5, closed: true });
    expect(paths[1].subpaths[0].segs).toHaveLength(3);
  });

  it("tracks the CTM through cm and q/Q", () => {
    const { paths } = collect("q 2 0 0 2 0 0 cm 0 0 m 1 1 l S Q 0 0 m 1 1 l S", [1, 0, 0, 1, 100, 0]);
    expect(paths[0].ctm).toEqual([2, 0, 0, 2, 100, 0]);
    expect(paths[1].ctm).toEqual([1, 0, 0, 1, 100, 0]);
  });

  it("expands v and y to full cubics and closes on s", () => {
    const { paths } = collect("0 0 m 1 1 2 2 v 3 3 4 4 y s");
    const sp = paths[0].subpaths[0];
    expect(sp.segs[0]).toEqual({ kind: "c", pts: [0, 0, 1, 1, 2, 2] });
    expect(sp.segs[1]).toEqual({ kind: "c", pts: [3, 3, 4, 4, 4, 4] });
    expect(sp.closed).toBe(true);
  });

  it("flags a clip and does not report W n (clip only, nothing painted)", () => {
    const { paths } = collect("0 0 m 5 5 l W n 0 0 m 1 0 l W S");
    expect(paths).toHaveLength(1);
    expect(paths[0].clip).toBe(true);
  });

  it("is not fooled by operator-looking bytes in strings, arrays, dicts and inline images", () => {
    const src =
      "BT /F1 12 Tf (0 0 m 5 5 l S) Tj [(S) -20 (f)] TJ ET\n" +
      "/OC <</Name (x S y) /A [1 2]>> BDC\n" +
      "BI /W 2 /H 1 /BPC 8 /CS /G ID \x00S f\nEI\n" +
      "EMC 0 0 m 3 3 l S";
    const { paths } = collect(src);
    expect(paths).toHaveLength(1);
    expect(paths[0].subpaths[0].segs[0].pts).toEqual([3, 3]);
  });

  it("marks a path with an illegal mid-path operator as not editable", () => {
    const { paths } = collect("0 0 m 1 1 l 0.5 w 2 2 l S");
    expect(paths[0].editable).toBe(false);
  });
});

describe("filterContentStream — applying verdicts", () => {
  const src = "q 1 0 0 RG\n0 0 m 10 0 l S\n0 5 m 10 5 l S\nQ\n";

  it("keeps the stream byte-identical when nothing changes", () => {
    const { out, res } = collect(src);
    expect(out).toBe(src);
    expect(res.changed).toBe(false);
  });

  it("erase turns only that path's paint operator into n", () => {
    const { out } = collect(src, IDENTITY, (_p, i) => (i === 1 ? { kind: "erase" } : { kind: "keep" }));
    expect(out).toBe("q 1 0 0 RG\n0 0 m 10 0 l S\n0 5 m 10 5 l n\nQ\n");
  });

  it("rewrite replaces the construction and keeps the paint operator", () => {
    const { out } = collect(src, IDENTITY, (_p, i) => (i === 0 ? { kind: "rewrite", construction: "6 0 m 10 0 l" } : { kind: "keep" }));
    expect(out).toBe("q 1 0 0 RG\n6 0 m 10 0 l S\n0 5 m 10 5 l S\nQ\n");
  });

  it("never rewrites a clipping path's geometry (only keep/erase)", () => {
    const { out } = collect("0 0 m 10 0 l W S", IDENTITY, () => ({ kind: "rewrite", construction: "1 1 m" }));
    expect(out).toBe("0 0 m 10 0 l W S");
  });

  it("an erased close-and-stroke keeps a following path intact", () => {
    const { out } = collect("0 0 m 1 0 l 1 1 l s 2 2 m 3 3 l S", IDENTITY, (_p, i) => (i === 0 ? { kind: "erase" } : { kind: "keep" }));
    expect(out).toBe("0 0 m 1 0 l 1 1 l n 2 2 m 3 3 l S");
  });

  it("renames a Do target when onDo returns a replacement, passing the CTM", () => {
    const seen: Array<[string, Mat]> = [];
    const res = filterContentStream(enc("q 1 0 0 1 5 6 cm /Fm0 Do Q /Im1 Do"), IDENTITY, {
      decide: () => ({ kind: "keep" }),
      onDo: (name, ctm) => { seen.push([name, ctm]); return name === "Fm0" ? "Fm0_ve1" : null; },
    });
    expect(seen).toEqual([["Fm0", [1, 0, 0, 1, 5, 6]], ["Im1", [1, 0, 0, 1, 0, 0]]]);
    expect(dec(res.bytes)).toBe("q 1 0 0 1 5 6 cm /Fm0_ve1 Do Q /Im1 Do");
  });

  it("decodes #xx escapes in names", () => {
    const seen: string[] = [];
    filterContentStream(enc("/Fm#200 Do"), IDENTITY, { decide: () => ({ kind: "keep" }), onDo: (n) => { seen.push(n); return null; } });
    expect(seen).toEqual(["Fm 0"]);
  });
});

describe("filterContentStream — inline image data", () => {
  it("does not stop at an ' EI ' inside binary image data", () => {
    const pre = enc("BI /W 4 /H 1 /BPC 8 /CS /G /F /Fl ID ");
    const bin = new Uint8Array([0x78, 0x9c, 0x20, 0x45, 0x49, 0x20, 0x01, 0xff, 0x03, 0x02]); // contains " EI " then binary
    const post = enc(" EI\n0 0 m 5 5 l S");
    const b = new Uint8Array(pre.length + bin.length + post.length);
    b.set(pre); b.set(bin, pre.length); b.set(post, pre.length + bin.length);
    const paths: PaintedPath[] = [];
    filterContentStream(b, IDENTITY, { decide: (p) => { paths.push(p); return { kind: "keep" }; } });
    expect(paths).toHaveLength(1);
    expect(paths[0].subpaths[0].segs[0].pts).toEqual([5, 5]);
  });

  it("uses a declared /L length to skip the data exactly", () => {
    const pre = enc("BI /W 2 /H 1 /BPC 8 /CS /G /L 6 ID ");
    const bin = enc("S EI f");
    const post = enc(" EI 1 1 m 2 2 l S");
    const b = new Uint8Array(pre.length + bin.length + post.length);
    b.set(pre); b.set(bin, pre.length); b.set(post, pre.length + bin.length);
    const paths: PaintedPath[] = [];
    filterContentStream(b, IDENTITY, { decide: (p) => { paths.push(p); return { kind: "keep" }; } });
    expect(paths).toHaveLength(1);
    expect(paths[0].subpaths[0].x0).toBe(1);
  });

  it("tracks the line width through w and q/Q", () => {
    const { paths } = collect("q 3 w 0 0 m 1 1 l S Q 0 0 m 1 1 l S");
    expect(paths.map((p) => p.lineWidth)).toEqual([3, 1]);
  });
});
