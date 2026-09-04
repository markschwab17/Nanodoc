import { describe, it, expect, beforeEach, vi } from "vitest";
import { gridLayout, finalReferenceScale, MARGIN, GAP, TILES_PER_ROW, commitPlainAdd, commitAutoAlign } from "./commitPages";

// commitAutoAlign's honesty gate is a pure function of what the solver reported, so
// the solver is stubbed and the real thing under test is the demotion + reason logic.
vi.mock("./autostitch/autoStitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./autostitch/autoStitch")>();
  return { ...actual, autoStitch: vi.fn() };
});
import { AutoStitchAborted } from "./autostitch/autoStitch";
import { useStitchStore } from "@/shared/stores/stitchStore";

describe("gridLayout", () => {
  it("returns nothing for an empty selection", () => {
    expect(gridLayout([], MARGIN)).toEqual([]);
  });

  it("flows three tiles per row, gapped, starting at the left margin", () => {
    const sizes = [
      { w: 100, h: 50 },
      { w: 200, h: 50 },
      { w: 100, h: 50 },
    ];
    expect(gridLayout(sizes, MARGIN)).toEqual([
      { x: MARGIN, y: MARGIN },
      { x: MARGIN + 100 + GAP, y: MARGIN },
      { x: MARGIN + 100 + GAP + 200 + GAP, y: MARGIN },
    ]);
  });

  it("starts the second row below the tallest tile of the first", () => {
    const sizes = [
      { w: 100, h: 50 },
      { w: 100, h: 130 }, // tallest — sets the row height
      { w: 100, h: 40 },
      { w: 100, h: 20 },
    ];
    const out = gridLayout(sizes, MARGIN);
    expect(out.slice(0, TILES_PER_ROW).every((p) => p.y === MARGIN)).toBe(true);
    expect(out[3]).toEqual({ x: MARGIN, y: MARGIN + 130 + GAP });
  });

  it("stacks a third row below the second row's own tallest tile", () => {
    const sizes = [
      { w: 10, h: 100 }, { w: 10, h: 10 }, { w: 10, h: 10 },
      { w: 10, h: 60 }, { w: 10, h: 10 }, { w: 10, h: 10 },
      { w: 10, h: 10 },
    ];
    const out = gridLayout(sizes, MARGIN);
    expect(out[3].y).toBe(MARGIN + 100 + GAP);
    expect(out[6].y).toBe(MARGIN + 100 + GAP + 60 + GAP);
    expect(out[6].x).toBe(MARGIN);
  });

  it("honors a startY below existing canvas content", () => {
    const out = gridLayout([{ w: 10, h: 10 }], 640);
    expect(out[0]).toEqual({ x: MARGIN, y: 640 });
  });
});

describe("finalReferenceScale", () => {
  const base = {
    uniformScale: null as number | null,
    existingRef: null as number | null,
    hasTiles: false,
    isUniformSelection: true,
    refScale: 20,
    rootFtPerIn: 50,
  };

  it("lets a typed scale win over everything else", () => {
    expect(finalReferenceScale({ ...base, uniformScale: 30, existingRef: 40, hasTiles: true }))
      .toEqual({ value: 30, write: true });
  });

  it("keeps the canvas reference scale when the canvas already has sheets", () => {
    expect(finalReferenceScale({ ...base, existingRef: 40, hasTiles: true }))
      .toEqual({ value: 40, write: false });
  });

  it("ignores a stale reference scale when the canvas has no sheets", () => {
    expect(finalReferenceScale({ ...base, existingRef: 40, hasTiles: false }))
      .toEqual({ value: 20, write: false });
  });

  it("ignores a non-positive existing reference scale", () => {
    expect(finalReferenceScale({ ...base, existingRef: 0, hasTiles: true, isUniformSelection: false }))
      .toEqual({ value: 50, write: false });
  });

  it("roots a uniform selection on its own resolved scale", () => {
    expect(finalReferenceScale({ ...base, isUniformSelection: true }))
      .toEqual({ value: 20, write: true });
  });

  it("roots a mixed selection on the solver's rootFtPerIn", () => {
    expect(finalReferenceScale({ ...base, isUniformSelection: false }))
      .toEqual({ value: 50, write: true });
  });

  it("only writes when the user typed a scale or nothing is set yet", () => {
    expect(finalReferenceScale({ ...base, existingRef: null }).write).toBe(true);
    expect(finalReferenceScale({ ...base, existingRef: 40, hasTiles: true }).write).toBe(false);
    expect(finalReferenceScale({ ...base, existingRef: 40, hasTiles: false }).write).toBe(false);
    expect(finalReferenceScale({ ...base, uniformScale: 30, existingRef: 40, hasTiles: true }).write).toBe(true);
  });
});

describe("commitPlainAdd cooperative abort", () => {
  const fakeDoc = {
    loadPage: () => ({ getBounds: () => [0, 0, 612, 792], destroy() {} }),
  };
  const fakeRenderer = {
    renderPage: async () => ({ imageData: null }),
    dispose() {},
  } as any;

  const run = (shouldAbort: () => boolean) =>
    commitPlainAdd({
      mupdf: {},
      doc: fakeDoc,
      pdfBytes: new Uint8Array([1]),
      fileName: "plan.pdf",
      selected: [0, 1, 2],
      pageScales: new Map(),
      uniformScale: 20,
      removeWhiteBackground: false,
      renderer: fakeRenderer,
      shouldAbort,
    });

  beforeEach(() => useStitchStore.getState().reset());

  it("throws AutoStitchAborted and adds NOTHING when aborted mid-run", async () => {
    let rendered = 0;
    const renderer = {
      renderPage: async () => {
        rendered++;
        return { imageData: null };
      },
    } as any;
    await expect(
      commitPlainAdd({
        mupdf: {},
        doc: fakeDoc,
        pdfBytes: new Uint8Array([1]),
        fileName: "plan.pdf",
        selected: [0, 1, 2],
        pageScales: new Map(),
        uniformScale: 20,
        removeWhiteBackground: false,
        renderer,
        // Abort once the first page has been rendered.
        shouldAbort: () => rendered >= 1,
      })
    ).rejects.toBeInstanceOf(AutoStitchAborted);
    // The whole point of aborting BEFORE addTiles: a cancelled run must not
    // leave a half-placed batch behind.
    expect(useStitchStore.getState().tiles).toEqual([]);
    expect(rendered).toBe(1);
  });

  it("commits every page when shouldAbort never fires (control)", async () => {
    const result = await run(() => false);
    expect(result.added).toBe(3);
    expect(useStitchStore.getState().tiles).toHaveLength(3);
  });
});

describe("commitAutoAlign honesty gate", () => {
  const fakeDoc = { loadPage: () => ({ getBounds: () => [0, 0, 612, 792], destroy() {} }) };
  const fakeRenderer = { renderPage: async () => ({ imageData: null }), dispose() {} } as any;
  const placement = (pageIndex: number, aligned: boolean) =>
    ({ pageIndex, x: pageIndex * 100, y: 0, width: 100, height: 100, aligned });
  const seam = (a: number, b: number, status: string, channel = "anchor+segment") =>
    ({ i: a + 1, j: b + 1, pageIndexes: [a, b] as [number, number], status, detail: { channel } });

  const solverSays = async (over: Record<string, unknown>) => {
    const { autoStitch } = await import("./autostitch/autoStitch");
    (autoStitch as any).mockResolvedValue({
      placements: [], rootFtPerIn: 20, alignedCount: 0, unplacedCount: 0, worstResidFt: 0,
      method: "geometric", poses: [], refPageIndices: [0, 1, 2], skipped: [], scaleWarnings: [],
      ...over,
    });
  };
  const run = (selected: number[]) =>
    commitAutoAlign({
      mupdf: {}, doc: fakeDoc, pdfBytes: new Uint8Array([1]), fileName: "plan.pdf",
      selected, pageScales: new Map(), uniformScale: 20,
      removeWhiteBackground: false, renderer: fakeRenderer,
    });

  beforeEach(() => { useStitchStore.getState().reset(); vi.clearAllMocks(); });

  it("a fully verified run reports ok and aligns everything", async () => {
    await solverSays({
      placements: [placement(0, true), placement(1, true)],
      alignmentVerdict: "verified", seamReport: [seam(0, 1, "verified")],
    });
    const res = await run([0, 1]);
    expect(res.reason).toBe("ok");
    expect(res.verdict).toBe("verified");
    expect(res.unalignedIds).toHaveLength(0);
  });

  it("a sheet whose ONLY seam is suspect is left unaligned, not committed as aligned", async () => {
    await solverSays({
      placements: [placement(0, true), placement(1, true), placement(2, true)],
      alignmentVerdict: "unverified",
      seamReport: [seam(0, 1, "verified"), seam(1, 2, "suspect")],
    });
    const res = await run([0, 1, 2]);
    // Page 2 has one seam and it is suspect. Page 1 also touches that seam but is
    // anchored by a verified one, so it stays aligned.
    expect(res.unalignedIds).toHaveLength(1);
    expect(res.reason).toBe("unverified");
  });

  it("a sheet bonded only through the band-seam channel is left unaligned", async () => {
    await solverSays({
      placements: [placement(0, true), placement(1, true)],
      alignmentVerdict: "partial",
      seamReport: [seam(0, 1, "plausible", "seam")],
    });
    const res = await run([0, 1]);
    expect(res.unalignedIds).toHaveLength(2);
    expect(res.reason).toBe("unverified");
  });

  it("nothing placed and no page carrying a reference -> no_refs", async () => {
    await solverSays({ placements: [placement(0, false), placement(1, false)], method: "none", refPageIndices: [] });
    const res = await run([0, 1]);
    expect(res.reason).toBe("no_refs");
    expect(res.pagesWithoutRefs).toEqual([0, 1]);
  });

  it("nothing placed but the sheets ARE readable -> not_adjacent", async () => {
    await solverSays({ placements: [placement(0, false), placement(1, false)], method: "none", refPageIndices: [0, 1] });
    expect((await run([0, 1])).reason).toBe("not_adjacent");
  });

  it("a placed sheet that is not ALONG-anchored is left unaligned", async () => {
    // Every cross-seam residual is sub-foot and the seam verifies — and page 2 was
    // never pinned along the matchline, so it can sit tens of feet out. Placed
    // below, selected, and named, rather than committed into the composite.
    await solverSays({
      placements: [placement(0, true), placement(1, true), placement(2, true)],
      alignmentVerdict: "verified",
      seamReport: [seam(0, 1, "verified"), seam(1, 2, "verified")],
      alongAnchored: [0, 1],
      worstAlongUncertaintyFt: 42,
    });
    const res = await run([0, 1, 2]);
    expect(res.unalignedIds).toHaveLength(1);
    expect(res.reason).toBe("along_unresolved");
    expect(res.message).toContain("±42 ft along");
  });

  it("names ONLY the placed-but-unpinned pages as along-unresolved", async () => {
    // Page 3 was never placed at all, so it does not "meet the matchline correctly" —
    // only page 2 does. Subtracting the anchored set from the whole selection, which
    // is what the caller used to do, told the user about sheets the run never matched.
    await solverSays({
      placements: [placement(0, true), placement(1, true), placement(2, true), placement(3, false)],
      alignmentVerdict: "verified",
      seamReport: [seam(0, 1, "verified"), seam(1, 2, "verified")],
      alongAnchored: [0, 1],
      worstAlongUncertaintyFt: 42,
    });
    const res = await run([0, 1, 2, 3]);
    expect(res.alongUnresolvedPages).toEqual([2]);
  });

  it("reports no along-unresolved list at all when the solver sent no along data", async () => {
    await solverSays({
      placements: [placement(0, true), placement(1, true)],
      alignmentVerdict: "verified", seamReport: [seam(0, 1, "verified")],
    });
    expect((await run([0, 1])).alongUnresolvedPages).toBeUndefined();
  });

  it("a fully along-anchored run is still ok", async () => {
    await solverSays({
      placements: [placement(0, true), placement(1, true)],
      alignmentVerdict: "verified", seamReport: [seam(0, 1, "verified")],
      alongAnchored: [0, 1],
    });
    const res = await run([0, 1]);
    expect(res.reason).toBe("ok");
    expect(res.unalignedIds).toHaveLength(0);
  });

  it("ANY suspect seam with no verified one demotes the sheet", async () => {
    // Was: only a sheet whose seams are ALL suspect. One seam the solver positively
    // believes is wrong is enough — a plausible sibling is not evidence of anything.
    await solverSays({
      placements: [placement(0, true), placement(1, true), placement(2, true)],
      alignmentVerdict: "unverified",
      seamReport: [seam(0, 1, "plausible"), seam(1, 2, "suspect")],
      alongAnchored: [0, 1, 2],
    });
    const res = await run([0, 1, 2]);
    expect(res.unalignedIds).toHaveLength(2); // pages 1 and 2, both on the suspect seam
  });

  it("carries the skipped sheets and the per-seam quality through to the caller", async () => {
    await solverSays({
      placements: [placement(0, true), placement(1, true)],
      alignmentVerdict: "partial",
      seamReport: [{ ...seam(0, 1, "plausible"), detail: { channel: "anchor+segment", residFt: 1.25, perpDeltaFt: 0.13 } }],
      skipped: [{ pageIndex: 4, role: "overall", reason: "an overall plan" }],
    });
    const res = await run([0, 1]);
    expect(res.skipped).toEqual([{ pageIndex: 4, role: "overall" }]);
    expect(res.seams).toEqual([{ pageIndexes: [0, 1], status: "plausible", residFt: 1.25, perpDeltaFt: 0.13 }]);
  });
});

describe("commitAutoAlign cached probe", () => {
  const fakeDoc = { loadPage: () => ({ getBounds: () => [0, 0, 612, 792], destroy() {} }) };
  const fakeRenderer = { renderPage: async () => ({ imageData: null }), dispose() {} } as any;
  const placement = (pageIndex: number, aligned: boolean) =>
    ({ pageIndex, x: pageIndex * 100, y: 0, width: 100, height: 100, aligned });

  beforeEach(() => { useStitchStore.getState().reset(); vi.clearAllMocks(); });

  it("runs the honesty gate on the cached path too", async () => {
    // The modal reuses the probe it already paid for. Before the payload travelled
    // with it there was no seam report here, so the demotion silently did nothing and
    // this path committed placements the plan path would have held back.
    const { autoStitch } = await import("./autostitch/autoStitch");
    const res = await commitAutoAlign({
      mupdf: {}, doc: fakeDoc, pdfBytes: new Uint8Array([1]), fileName: "plan.pdf",
      selected: [0, 1], pageScales: new Map(), uniformScale: 20,
      removeWhiteBackground: false, renderer: fakeRenderer,
      cached: {
        placements: [placement(0, true), placement(1, true)],
        rootFtPerIn: 20, worstResidFt: 1.33, method: "geometric",
        alignmentVerdict: "partial",
        seamReport: [{ i: 1, j: 2, pageIndexes: [0, 1], status: "suspect", detail: { channel: "anchor+segment" } }] as any,
        alongAnchored: [0, 1],
        refPageIndices: [0, 1],
      },
    });
    expect(autoStitch).not.toHaveBeenCalled();
    expect(res.unalignedIds).toHaveLength(2);
    expect(res.reason).toBe("unverified");
  });

  it("a cached run with placements reports a geometric method, not 'none'", async () => {
    const res = await commitAutoAlign({
      mupdf: {}, doc: fakeDoc, pdfBytes: new Uint8Array([1]), fileName: "plan.pdf",
      selected: [0, 1], pageScales: new Map(), uniformScale: 20,
      removeWhiteBackground: false, renderer: fakeRenderer,
      cached: { placements: [placement(0, true), placement(1, true)], rootFtPerIn: 20, worstResidFt: 0 },
    });
    // Without `method` this reported reason "no_refs" — "no sheet numbers were
    // found" — on a run that had just aligned both sheets.
    expect(res.reason).toBe("ok");
  });
});
