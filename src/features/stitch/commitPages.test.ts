import { describe, it, expect, beforeEach } from "vitest";
import { gridLayout, finalReferenceScale, MARGIN, GAP, TILES_PER_ROW, commitPlainAdd } from "./commitPages";
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
