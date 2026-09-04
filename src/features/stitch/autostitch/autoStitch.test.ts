import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolvePrintedNos, autoStitch, AutoStitchAborted } from "./autoStitch";

// autoStitch's per-page capture and band raster are mupdf-bound; mock them so the
// abort-checkpoint behaviour is testable without wasm. Pages carry NO edge refs,
// so the edge-band OCR path runs (exercising the OCR channel + abort inside it).
vi.mock("./captureDevice", () => ({
  capturePage: vi.fn(() => ({
    view: [0, 0, 1000, 800] as [number, number, number, number],
    shxLabels: [],
    labels: [],
    words: [],
    geometry: [],
  })),
}));
vi.mock("./bandRender", () => ({
  renderBand: vi.fn(() => ({
    image: { width: 10, height: 10, data: new Uint8ClampedArray(10 * 10 * 4) },
    scale: 1,
  })),
}));

describe("autoStitch cooperative abort", () => {
  // The control test runs the full pipeline over fake pages; its key-map/solve
  // steps log caught warnings on the stub geometry. Keep test output quiet.
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("stops between pages: aborting after page 2 throws AutoStitchAborted and does no further page work", async () => {
    const { capturePage } = await import("./captureDevice");
    const fakeDoc = { loadPage: vi.fn(() => ({ destroy: vi.fn() })) };
    const ocr = vi.fn(async () => []);
    // Abort once two pages have fully completed (onProgress fires at each page end).
    let completed = 0;
    const promise = autoStitch({} as any, fakeDoc as any, [0, 1, 2, 3], {
      ocr,
      shouldAbort: () => completed >= 2,
      onProgress: () => { completed++; },
    });
    await expect(promise).rejects.toBeInstanceOf(AutoStitchAborted);
    // Page 3's checkAbort (top of loop) throws BEFORE capture/OCR — only 2 pages ran.
    expect(capturePage).toHaveBeenCalledTimes(2);
    expect(fakeDoc.loadPage).toHaveBeenCalledTimes(2);
    // The OCR counter is frozen at the page-2 total: no band OCR happens on page 3.
    const callsAtAbort = ocr.mock.calls.length;
    await Promise.resolve();
    expect(ocr.mock.calls.length).toBe(callsAtAbort);
  });

  it("without shouldAbort, runs every page (control)", async () => {
    const { capturePage } = await import("./captureDevice");
    const fakeDoc = { loadPage: vi.fn(() => ({ destroy: vi.fn() })) };
    const ocr = vi.fn(async () => []);
    await autoStitch({} as any, fakeDoc as any, [0, 1, 2], { ocr });
    expect(capturePage).toHaveBeenCalledTimes(3);
  });
});

describe("resolvePrintedNos", () => {
  // Collision repair logs a warning; keep test output quiet.
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("(a) out-of-range OCR number is discarded -> page-order fallback", () => {
    // pageCount 3 -> valid range [1, 6]. 99 is a misread.
    const map = resolvePrintedNos(
      [
        { pageIndex: 0, printedNo: 99, source: "ocr" },
        { pageIndex: 1, printedNo: 2, source: "text" },
      ],
      3
    );
    expect(map.get(0)).toBe(1); // discarded -> pageIndex+1
    expect(map.get(1)).toBe(2); // text trusted as-is
  });

  it("(a2) non-integer / null OCR number is discarded -> page-order fallback", () => {
    const map = resolvePrintedNos(
      [
        { pageIndex: 0, printedNo: 2.5, source: "ocr" },
        { pageIndex: 1, printedNo: null, source: "ocr" },
      ],
      5
    );
    expect(map.get(0)).toBe(1);
    expect(map.get(1)).toBe(2);
  });

  it("(b) two pages colliding: OCR-sourced reset to pageIndex+1, text-sourced untouched", () => {
    const map = resolvePrintedNos(
      [
        { pageIndex: 0, printedNo: 5, source: "ocr" },
        { pageIndex: 1, printedNo: 5, source: "ocr" },
        { pageIndex: 2, printedNo: 5, source: "text" },
      ],
      6
    );
    expect(map.get(0)).toBe(1); // OCR reset
    expect(map.get(1)).toBe(2); // OCR reset
    expect(map.get(2)).toBe(5); // text kept
  });

  it("(c) 3+ pages colliding: all OCR-sourced reset, no residual collision among reset group", () => {
    const map = resolvePrintedNos(
      [
        { pageIndex: 0, printedNo: 3, source: "ocr" },
        { pageIndex: 1, printedNo: 3, source: "ocr" },
        { pageIndex: 2, printedNo: 3, source: "ocr" },
      ],
      6
    );
    const resets = [map.get(0), map.get(1), map.get(2)];
    expect(resets).toEqual([1, 2, 3]); // each -> pageIndex+1
    expect(new Set(resets).size).toBe(3); // no residual collision within the group
  });

  it("(d) valid unique OCR numbers pass through unchanged", () => {
    const map = resolvePrintedNos(
      [
        { pageIndex: 0, printedNo: 3, source: "ocr" },
        { pageIndex: 1, printedNo: 5, source: "ocr" },
        { pageIndex: 2, printedNo: 6, source: "ocr" },
      ],
      3
    );
    expect(map.get(0)).toBe(3);
    expect(map.get(1)).toBe(5);
    expect(map.get(2)).toBe(6);
  });

  it("does not reset a collision group with no OCR member (two text pages left as-is)", () => {
    const map = resolvePrintedNos(
      [
        { pageIndex: 0, printedNo: 4, source: "text" },
        { pageIndex: 1, printedNo: 4, source: "text" },
      ],
      6
    );
    expect(map.get(0)).toBe(4);
    expect(map.get(1)).toBe(4); // only OCR-sourced collisions are repaired
  });
});

describe("discipline-code reciprocal anchors", () => {
  // The reciprocal-anchor pass used to resolve NUMERIC refs only, so a set whose
  // sheets reference each other by discipline code ("MATCH LINE SEE SHEET C-302")
  // never reached the strong anchor channels. Each page's own code comes from its
  // title block, exactly as stitchCore already resolves code cross-references.
  const VIEW: [number, number, number, number] = [0, 0, 1000, 800];
  const lab = (text: string, cx: number, cy: number, w = 70, h = 10) =>
    ({ text, x: cx - w / 2, y: cy - h / 2, endX: cx + w / 2, endY: cy + h / 2, angle: 0, h, font: null });
  // Title-block code in the bottom-right corner (what extractPageLabel scores), plus
  // a facing matchline callout on the shared edge.
  const page = (ownCode: string | null, refText: string, refAt: [number, number]) => ({
    view: VIEW, words: [], geometry: [],
    shxLabels: [],
    labels: [
      ...(ownCode ? [lab(ownCode, 900, 720, 40, 14)] : []),
      lab(refText, refAt[0], refAt[1], 120, 10),
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const run = async (pages: ReturnType<typeof page>[]) => {
    const { capturePage } = await import("./captureDevice");
    let n = 0;
    (capturePage as any).mockImplementation(() => pages[n++]);
    const fakeDoc = { loadPage: vi.fn(() => ({ destroy: vi.fn() })) };
    let debug: any = null;
    await autoStitch({} as any, fakeDoc as any, [0, 1], {
      ocr: async () => [], userScale: 20, onDebug: (d) => { debug = d; },
    });
    return debug;
  };

  it("anchors two sheets that reference each other by discipline code", async () => {
    const debug = await run([
      page("C-301", "MATCH LINE SEE SHEET C-302", [910, 400]), // right edge
      page("C-302", "MATCH LINE SEE SHEET C-301", [90, 400]),  // left edge
    ]);
    expect(debug.anchors).toHaveLength(1);
    expect(debug.anchors[0].perp).toBe("x"); // a left/right ref pins x
  });

  it("normalises the separator: 'C302' in the title block matches 'SEE SHEET C-302'", async () => {
    const debug = await run([
      page("C301", "MATCH LINE SEE SHEET C-302", [910, 400]),
      page("C302", "MATCH LINE SEE SHEET C-301", [90, 400]),
    ]);
    expect(debug.anchors).toHaveLength(1);
  });

  it("no anchor when the pages carry no title-block code to resolve the refs against", async () => {
    const debug = await run([
      page(null, "MATCH LINE SEE SHEET C-302", [910, 400]),
      page(null, "MATCH LINE SEE SHEET C-301", [90, 400]),
    ]);
    expect(debug.anchors).toHaveLength(0);
  });

  it("no anchor when the codes do not reciprocate", async () => {
    const debug = await run([
      page("C-301", "MATCH LINE SEE SHEET C-999", [910, 400]),
      page("C-302", "MATCH LINE SEE SHEET C-888", [90, 400]),
    ]);
    expect(debug.anchors).toHaveLength(0);
  });

  it("a SPLIT code callout (two runs) still anchors", async () => {
    // CAD emitted "MATCH LINE" and "SEE SHEET C-302" as separate runs; the
    // pre-parse merge rejoins them so the ref carries both facts.
    const split = (ownCode: string, refCode: string, cx: number) => ({
      view: VIEW, words: [], geometry: [], shxLabels: [],
      labels: [lab(ownCode, 900, 720, 40, 14), lab("MATCH LINE", cx, 400, 60, 10), lab(`SEE SHEET ${refCode}`, cx + 75, 400, 80, 10)],
    });
    const debug = await run([split("C-301", "C-302", 880), split("C-302", "C-301", 60)]);
    expect(debug.anchors).toHaveLength(1);
  });
});
