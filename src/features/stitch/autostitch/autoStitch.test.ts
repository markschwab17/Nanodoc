import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolvePrintedNos, autoStitch, AutoStitchAborted, resolveSheetCodes } from "./autoStitch";
import { makeGeom } from "./types";

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

  it("hands every read ONE abort signal for the run, and trips it when the run aborts", async () => {
    const fakeDoc = { loadPage: vi.fn(() => ({ destroy: vi.fn() })) };
    const signals: (AbortSignal | undefined)[] = [];
    let loaded = 0;
    const ocr = vi.fn(async (_img: any, o?: { signal?: AbortSignal }) => { signals.push(o?.signal); return []; });
    const promise = autoStitch({} as any, fakeDoc as any, [0, 1, 2, 3], {
      ocr,
      shouldAbort: () => loaded >= 2,
      onProgress: () => { loaded++; },
    });
    await expect(promise).rejects.toBeInstanceOf(AutoStitchAborted);
    expect(signals.length).toBeGreaterThan(0);
    expect(new Set(signals).size).toBe(1);   // one signal, shared by every read
    // Aborting is what pulls the reads still QUEUED in the pool: without it they
    // would each be OCR'd in full for a run that has already given up.
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe("autoStitch concurrent OCR", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  // The stub page is 1000x800 with no geometry, so `pageEdgeBands` yields the four
  // page bands: top + bottom (one read each) + left + right (two rotations each) +
  // the sheet-number band = seven reads per page.
  const READS_PER_PAGE = 7;

  it("issues a page's reads in one burst, overlaps the next page, and stops at two pages", async () => {
    const { capturePage } = await import("./captureDevice");
    const fakeDoc = { loadPage: vi.fn(() => ({ destroy: vi.fn() })) };
    let outstanding = 0, peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ocr = vi.fn(async () => {
      outstanding++;
      peak = Math.max(peak, outstanding);
      await gate;
      outstanding--;
      return [];
    });

    const run = autoStitch({} as any, fakeDoc as any, [0, 1, 2, 3], { ocr });
    // Wait for the pipeline to fill on the CONDITION, not on the clock: a fixed
    // sleep is a race on a loaded machine (too short) and dead time otherwise.
    // Extraction cannot get past two pages while the gate is shut, so once two
    // pages' reads are issued the pipeline is at its ceiling by construction.
    const deadline = Date.now() + 5000;
    while (ocr.mock.calls.length < 2 * READS_PER_PAGE && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(ocr).toHaveBeenCalledTimes(2 * READS_PER_PAGE);
    // Give a third page every chance to slip through before asserting it did not.
    await new Promise((r) => setTimeout(r, 20));

    // Two pages' worth in flight, seven reads each: the whole page goes at once
    // (sequentially this was 1), and page 2 was extracted without waiting for
    // page 1's answers. And no further: backpressure holds extraction at two
    // pages so a long selection cannot pile every band raster into the queue.
    expect(peak).toBe(2 * READS_PER_PAGE);
    expect(capturePage).toHaveBeenCalledTimes(2);

    release();
    await run;
    expect(ocr).toHaveBeenCalledTimes(4 * READS_PER_PAGE);
    expect(capturePage).toHaveBeenCalledTimes(4);
  });

  it("an abort while the backpressure gate is shut rasters nothing more", async () => {
    const { capturePage } = await import("./captureDevice");
    const { renderBand } = await import("./bandRender");
    const fakeDoc = { loadPage: vi.fn(() => ({ destroy: vi.fn() })) };
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const ocr = vi.fn(async () => { await gate; return []; });
    let aborting = false;

    const run = autoStitch({} as any, fakeDoc as any, [0, 1, 2, 3], {
      ocr,
      shouldAbort: () => aborting,
    });
    const deadline = Date.now() + 5000;
    while (ocr.mock.calls.length < 2 * READS_PER_PAGE && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1));
    }
    // Page 3 is parked inside the gate, PAST its own top-of-loop checkpoint.
    expect(capturePage).toHaveBeenCalledTimes(2);
    const rendersAtGate = (renderBand as any).mock.calls.length;

    aborting = true;
    release();
    await expect(run).rejects.toBeInstanceOf(AutoStitchAborted);

    // Without a checkpoint after the gate, waking up here would have captured the
    // page and rastered its whole band set — tens of MB of pixmaps — before the
    // next iteration's checkpoint got a chance to fire.
    expect(capturePage).toHaveBeenCalledTimes(2);
    expect((renderBand as any).mock.calls.length).toBe(rendersAtGate);
  });

  it("aborts the OCR signal when the run ends, even on the success path", async () => {
    const fakeDoc = { loadPage: vi.fn(() => ({ destroy: vi.fn() })) };
    const signals: (AbortSignal | undefined)[] = [];
    const ocr = vi.fn(async (_img: any, o?: { signal?: AbortSignal }) => { signals.push(o?.signal); return []; });
    await autoStitch({} as any, fakeDoc as any, [0, 1], { ocr });
    // The run returned normally, so nothing tripped checkAbort — the wrapper's
    // `finally` is the only thing that can drop reads still queued behind it.
    expect(signals[0]?.aborted).toBe(true);
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

  it("(e) two pages claiming one number from the SAME source both fall back", () => {
    // Neither reading can be preferred, and leaving both is the worse failure:
    // byPrinted.get(4) would return two pages and every "SEE SHEET 4" would anchor
    // both. Distinct page-order fallbacks are wrong in a way that cannot fan out.
    const map = resolvePrintedNos(
      [
        { pageIndex: 0, printedNo: 4, source: "text" },
        { pageIndex: 1, printedNo: 4, source: "text" },
      ],
      6
    );
    expect(map.get(0)).toBe(1);
    expect(map.get(1)).toBe(2);
  });

  it("(f) two caller-supplied numbers colliding are repaired the same way", () => {
    const map = resolvePrintedNos(
      [
        { pageIndex: 0, printedNo: 7, source: "cto" },
        { pageIndex: 1, printedNo: 7, source: "cto" },
        { pageIndex: 2, printedNo: 9, source: "cto" },
      ],
      6
    );
    expect([map.get(0), map.get(1), map.get(2)]).toEqual([1, 2, 9]);
  });

  it("(g) a weaker source colliding with a stronger one loses alone", () => {
    const map = resolvePrintedNos(
      [
        { pageIndex: 0, printedNo: 4, source: "text" },
        { pageIndex: 1, printedNo: 4, source: "ocr" },
      ],
      6
    );
    expect(map.get(0)).toBe(4); // the PDF's own text is kept
    expect(map.get(1)).toBe(2); // the OCR read falls back
  });

  it("(h) a page-order GUESS colliding with a real read is moved off it", () => {
    // Page 0's title cell is unreadable, so it guesses 1 — and page 2 actually SAYS
    // it is sheet 1. The reset loop cannot fix this: page 0's page-order value IS the
    // collision. Left alone, byPrinted.get(1) returns two pages and every "SEE SHEET
    // 1" anchors the guess alongside the sheet. The guess moves; the read never does.
    const map = resolvePrintedNos(
      [
        { pageIndex: 0, printedNo: null, source: "ocr" },
        { pageIndex: 1, printedNo: 2, source: "text" },
        { pageIndex: 2, printedNo: 1, source: "text" },
      ],
      6
    );
    expect(map.get(2)).toBe(1); // the read is untouched
    expect(map.get(1)).toBe(2);
    expect(map.get(0)).toBe(3); // the lowest number nobody claims
    expect(new Set([...map.values()]).size).toBe(3);
  });

  it("(h2) two guesses colliding with reads both move, and not onto each other", () => {
    const map = resolvePrintedNos(
      [
        { pageIndex: 0, printedNo: null, source: "ocr" },
        { pageIndex: 1, printedNo: null, source: "ocr" },
        { pageIndex: 2, printedNo: 1, source: "text" },
        { pageIndex: 3, printedNo: 2, source: "text" },
      ],
      8
    );
    expect(map.get(2)).toBe(1);
    expect(map.get(3)).toBe(2);
    expect(new Set([...map.values()]).size).toBe(4);
  });

  it("(h3) a guess that collides with nothing is left exactly where it was", () => {
    const map = resolvePrintedNos(
      [
        { pageIndex: 0, printedNo: null, source: "ocr" },
        { pageIndex: 1, printedNo: 7, source: "text" },
      ],
      8
    );
    expect(map.get(0)).toBe(1);
    expect(map.get(1)).toBe(7);
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

describe("sheet roles and scale warnings in the result", () => {
  const VIEW: [number, number, number, number] = [0, 0, 1000, 800];
  const lab = (text: string, cx: number, cy: number, w = 90, h = 14) =>
    ({ text, x: cx - w / 2, y: cy - h / 2, endX: cx + w / 2, endY: cy + h / 2, angle: 0, h, font: null });
  // Title-block cell (bottom-right corner is what pickTitle scores), plus an optional
  // scale note anywhere on the sheet.
  const sheet = (title: string, scaleNote?: string) => ({
    view: VIEW, words: [], geometry: [], shxLabels: [],
    labels: [lab(title, 880, 740), ...(scaleNote ? [lab(scaleNote, 500, 400)] : [])],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const run = async (pages: ReturnType<typeof sheet>[], userScale = 20) => {
    const { capturePage } = await import("./captureDevice");
    let n = 0;
    (capturePage as any).mockImplementation(() => pages[n++]);
    const fakeDoc = { loadPage: vi.fn(() => ({ destroy: vi.fn() })) };
    return await autoStitch({} as any, fakeDoc as any, pages.map((_, i) => i), { ocr: async () => [], userScale });
  };

  it("reports the non-tile sheets it kept out of the tiling, by page and reason", async () => {
    const res = await run([
      sheet("PRECISE GRADING PLAN"), sheet("GENERAL NOTES 1"),
      sheet("OVERALL SITE PLAN"), sheet("LANDSCAPE DETAILS"),
    ]);
    expect(res.skipped.map((s) => [s.pageIndex, s.role])).toEqual([[1, "notes"], [2, "overall"], [3, "details"]]);
    expect(res.skipped[0].reason).toMatch(/notes/i);
  });

  it("no skips on a set of plan sheets", async () => {
    const res = await run([sheet("GRADING PLAN"), sheet("DRAINAGE PLAN")]);
    expect(res.skipped).toEqual([]);
  });

  it("warns when a sheet's own scale note disagrees with the scale in use by >25%", async () => {
    const res = await run([sheet("GRADING PLAN", '1" = 20\''), sheet("ENLARGED PLAN", '1/8" = 1\'-0"')], 20);
    expect(res.scaleWarnings).toEqual([{ pageIndex: 1, usedFtPerIn: 20, statedFtPerIn: 8 }]);
  });

  it("an agreeing scale note is not a warning", async () => {
    const res = await run([sheet("GRADING PLAN", '1" = 20\'')], 20);
    expect(res.scaleWarnings).toEqual([]);
  });
});

describe("sheet identity supplied by the caller (the CTO hand-off)", () => {
  const VIEW: [number, number, number, number] = [0, 0, 1000, 800];
  const lab = (text: string, cx: number, cy: number, w = 120, h = 12) =>
    ({ text, x: cx - w / 2, y: cy - h / 2, endX: cx + w / 2, endY: cy + h / 2, angle: 0, h, font: null });
  // No title-block code of its own: exactly the outlined-text case where
  // extractPageLabel finds nothing and the aligner has to OCR the title cell.
  const codeless = (refText: string, refAt: [number, number]) => ({
    view: VIEW, words: [], geometry: [], shxLabels: [], labels: [lab(refText, refAt[0], refAt[1])],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const run = async (pages: { view: [number, number, number, number]; words: unknown[]; geometry: unknown[]; shxLabels: unknown[]; labels: unknown[] }[], pageCodes?: Map<number, string>) => {
    const { capturePage } = await import("./captureDevice");
    let n = 0;
    (capturePage as any).mockImplementation(() => pages[n++]);
    const fakeDoc = { loadPage: vi.fn(() => ({ destroy: vi.fn() })) };
    let debug: any = null;
    await autoStitch({} as any, fakeDoc as any, pages.map((_, i) => i), {
      ocr: async () => [], userScale: 20, pageCodes, onDebug: (d) => { debug = d; },
    });
    return debug;
  };

  it("a supplied discipline code resolves the code refs the sheets carry", async () => {
    const pages = [
      codeless("MATCH LINE SEE SHEET C-302", [910, 400]),
      codeless("MATCH LINE SEE SHEET C-301", [90, 400]),
    ];
    expect((await run(pages)).anchors).toHaveLength(0); // no identity -> nothing resolves
    const debug = await run(pages, new Map([[0, "C-301"], [1, "C-302"]]));
    expect(debug.anchors).toHaveLength(1);
  });

  it("a supplied bare number becomes the printed number", async () => {
    const pages = [
      codeless("MATCH LINE SEE SHEET 6", [910, 400]),
      codeless("MATCH LINE SEE SHEET 5", [90, 400]),
    ];
    // Page order would make these sheets 1 and 2, so "SEE SHEET 6" resolves to nothing.
    expect((await run(pages)).anchors).toHaveLength(0);
    const debug = await run(pages, new Map([[0, "5"], [1, "6"]]));
    expect(debug.anchors).toHaveLength(1);
    expect(debug.inputs.map((i: any) => i.printedNo)).toEqual([5, 6]);
  });

  it("the PDF's own 'SHEET n OF m' text outranks the supplied number", async () => {
    const pages = [
      { ...codeless("MATCH LINE SEE SHEET 6", [910, 400]), shxLabels: [lab("SHEET 5 OF 30", 500, 700)] },
      { ...codeless("MATCH LINE SEE SHEET 5", [90, 400]), shxLabels: [lab("SHEET 6 OF 30", 500, 700)] },
    ];
    const debug = await run(pages, new Map([[0, "11"], [1, "12"]]));
    expect(debug.inputs.map((i: any) => i.printedNo)).toEqual([5, 6]);
  });

  it("a supplied code nothing corroborates is ignored end to end", async () => {
    // The sheets reference each other as CD102/CD103; the caller says A1/B3. Trusting
    // the caller would make "SEE SHEET CD103" resolve to nothing AND put a bogus code
    // on each page — worse than having none.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pages = [
      codeless("MATCH LINE SEE SHEET CD103", [910, 400]),
      codeless("MATCH LINE SEE SHEET CD102", [90, 400]),
    ];
    const good = await run(pages, new Map([[0, "CD102"], [1, "CD103"]]));
    expect(good.anchors).toHaveLength(1); // corroborated by the neighbours' callouts
    const bad = await run(pages, new Map([[0, "A1"], [1, "B3"]]));
    expect(bad.anchors).toHaveLength(0);
    expect(warn.mock.calls.flat().join(" ")).toContain('ignoring supplied sheet code "A1"');
  });

  it("a supplied number is trusted as given, outside the OCR sanity range", async () => {
    // Two pages committed out of a 30-sheet set are legitimately sheets 21 and 22 —
    // the [1, 2*pageCount] rule that catches an OCR misread must not apply here.
    const pages = [codeless("MATCH LINE SEE SHEET 22", [910, 400]), codeless("MATCH LINE SEE SHEET 21", [90, 400])];
    const debug = await run(pages, new Map([[0, "21"], [1, "22"]]));
    expect(debug.inputs.map((i: any) => i.printedNo)).toEqual([21, 22]);
    expect(debug.anchors).toHaveLength(1);
  });
});

describe("resolveSheetCodes — a supplied code has to be corroborated", () => {
  const page = (pageIndex: number, over: Partial<Parameters<typeof resolveSheetCodes>[0][0]> = {}) =>
    ({ pageIndex, ctoCode: null, titleCode: null, ownTokens: [] as string[], refTargets: [] as string[], ...over });
  const warn = () => { /* silent */ };

  it("trusts a supplied code the sheet itself carries, uniquely", () => {
    const out = resolveSheetCodes([
      page(0, { ctoCode: "CD102", ownTokens: ["CD102", "G-007"] }),
      page(1, { ownTokens: ["G-007"] }),
    ], warn);
    expect(out.codes.get(0)).toBe("CD102");
  });

  it("a token every sheet carries is NOT corroboration", () => {
    // Every CAD sheet prints a border coordinate grid — A1, B1, B2, B3 — so finding
    // "A1" on a sheet says nothing about which sheet it is. Both Coast Guard sheets
    // carry A1 AND B3, which is exactly the pair the extraction had guessed.
    const msgs: string[] = [];
    const out = resolveSheetCodes([
      page(0, { ctoCode: "A1", ownTokens: ["A1", "B1", "B2", "B3"] }),
      page(1, { ctoCode: "B3", ownTokens: ["A1", "A3", "B1", "B3", "C1"] }),
    ], (m) => msgs.push(m));
    expect(out.codes.size).toBe(0);
    expect(msgs.join(" ")).toContain('ignoring supplied sheet code "A1"');
    expect(msgs.join(" ")).toContain('ignoring supplied sheet code "B3"');
  });

  it("trusts a supplied code its own title block agrees with", () => {
    const out = resolveSheetCodes([page(0, { ctoCode: "CD-102", titleCode: "CD102", ownTokens: [] })], warn);
    expect(out.codes.get(0)).toBe("CD102");
  });

  it("trusts a supplied code another selected sheet points at", () => {
    // The sheet's own title block is unreadable, but its neighbour's matchline names
    // it — that is corroboration from the drawings too.
    const out = resolveSheetCodes([
      page(0, { ctoCode: "CD102" }),
      page(1, { titleCode: "CD103", refTargets: ["CD-102"] }),
    ], warn);
    expect(out.codes.get(0)).toBe("CD102");
  });

  it("IGNORES a supplied code nothing on the drawings agrees with, and says so", () => {
    // The real case: an extraction wrote "B3" for a sheet whose title block reads
    // CD103. A wrong code is worse than none — every callout resolving through it
    // anchors the wrong pair.
    const msgs: string[] = [];
    const out = resolveSheetCodes([page(0, { ctoCode: "B3", titleCode: "CD103", ownTokens: ["CD103"] })], (m) => msgs.push(m));
    expect(out.codes.get(0)).toBe("CD103"); // falls back to what the sheet says
    expect(msgs.join(" ")).toContain('ignoring supplied sheet code "B3"');
  });

  it("falls back to nothing when the sheet says nothing either", () => {
    const out = resolveSheetCodes([page(0, { ctoCode: "B3" })], warn);
    expect(out.codes.has(0)).toBe(false);
  });

  it("compares separator-insensitively", () => {
    expect(resolveSheetCodes([page(0, { ctoCode: "CD-102", ownTokens: ["CD 102"] })], warn).codes.get(0)).toBe("CD102");
  });

  it("drops a code two pages both claim, and REPORTS the drop", () => {
    // The Coast Guard pair: the title-block picker returns "A1" for BOTH sheets. One
    // callout resolving through it would anchor two different pages.
    const msgs: string[] = [];
    const out = resolveSheetCodes([page(0, { titleCode: "A1" }), page(1, { titleCode: "A1" })], (m) => msgs.push(m));
    expect(out.codes.size).toBe(0);
    expect(msgs.join(" ")).toContain("claimed by pages 0, 1");
    // The drop has to be CARRIED, not just performed: a page whose code was dropped
    // must never have it re-derived from its own title block further down.
    expect([...out.dropped].sort()).toEqual([0, 1]);
  });

  it("does not mark a merely uncorroborated code as dropped", () => {
    // Different outcome, different meaning: this page simply has no code yet, and a
    // strip-local title-block read downstream is allowed to find one.
    const out = resolveSheetCodes([page(0, { ctoCode: "B3" })], warn);
    expect(out.codes.has(0)).toBe(false);
    expect(out.dropped.size).toBe(0);
  });

  it("leaves distinct codes alone", () => {
    const out = resolveSheetCodes([page(0, { titleCode: "C-1" }), page(1, { titleCode: "C-2" })], warn);
    expect([...out.codes.values()].sort()).toEqual(["C1", "C2"]);
  });
});

describe("reciprocal strip scan: known rotation, first-hit chunks", () => {
  // Page i is band-scanned for the reciprocal "SEE SHEET <j>" label that the
  // referencing sheet's one-sided edge ref implies. Two things are under test: the
  // scan runs at the ONE rotation page i's edge bands already proved its vertical
  // text reads at (both only when that is unknown), and strips go out
  // `ocrConcurrency` at a time with the LOWEST-index hit winning — which is the
  // answer the old strip-at-a-time loop gave.
  const VIEW: [number, number, number, number] = [0, 0, 1000, 800];
  const lab = (text: string, cx: number, cy: number, w = 120, h = 10) =>
    ({ text, x: cx - w / 2, y: cy - h / 2, endX: cx + w / 2, endY: cy + h / 2, angle: 0, h, font: null });

  // Page i needs real vector density: the reciprocal pass prunes pages below
  // PLAN_GEOMETRY_MIN (5000), because the anchor confirms via a segment vote.
  const DENSE = Array.from({ length: 5000 }, (_, i) => makeGeom([[400 + (i % 7), 300], [401 + (i % 7), 301]], false, i));

  // Strip origins for a LEFT-edge ref on a 1000-wide view: [0.45W, 0.98W) stepped by
  // 120 → 450, 570, 690, 810, 930.
  const STRIP_STARTS = [450, 570, 690, 810, 930];

  /**
   * Every band raster the mock hands out is 2x1: a RED pixel then a BLUE one, both
   * carrying the band's tag in the green channel. `rotateRaw` puts RED first for 90
   * and BLUE first for 270, so the OCR stub reads BOTH the rotation and which band
   * it is looking at off the image it is actually given — never from call order,
   * which concurrency makes meaningless.
   */
  const raster = (tag: number) => ({
    image: { width: 2, height: 1, data: new Uint8ClampedArray([255, tag, 0, 255, 0, tag, 255, 255]) },
    scale: 1,
  });
  const rotOf = (img: any): 0 | 90 | 270 => (img.width === 2 ? 0 : img.data[0] === 255 ? 90 : 270);
  const tagOf = (img: any): number => img.data[1];
  const EDGE_BAND = 200; // any tag that is not a strip index

  // One word. wordsToLabels keeps >= 60 and merges runs into phrases; `rotScore`
  // counts confidence mass above 50, so one word at 90 is worth 40 to its rotation.
  const words = (text: string, confidence = 90) => [{ text, confidence, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }];
  const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  /**
   * Two pages. Page 1 carries a LEFT-edge "MATCH LINE SEE SHEET 1" in its text
   * channels (so it is ref-bearing and takes the no-OCR path); page 0 carries no
   * edge ref at all (so its edge bands ARE read, which is what can teach the scan a
   * rotation) and is the page the reciprocal scan then walks.
   *
   * `edgeRot` is the rotation the OCR stub gives its confidence mass to on page 0's
   * side bands: 90/270 makes the scan's rotation KNOWN, null leaves both scoring
   * zero — a dead tie, which is the "learned nothing" case.
   *
   * `hitStrips` names, by strip index in scan order, the strips whose OCR answers
   * with the reciprocal label.
   */
  const run = async (opts: {
    edgeRot: 90 | 270 | null; hitStrips: number[]; ocrConcurrency: number;
    /** Confidence the winning edge-band rotation reads at (two side bands, so its
     *  rotMass is 2x(conf-50)), and what the LOSING rotation reads — `null` means it
     *  answered with NO WORDS AT ALL, which is what a timed-out pool job looks like
     *  from here. The default 51 is a real but worthless read: below wordsToLabels'
     *  own 60-confidence cutoff, so it makes no labels, worth 1 per band. */
    edgeConf?: number; edgeOtherConf?: number | null;
    /** Strips whose OCR rejects, and strips whose OCR answers late — the two
     *  together let a test make completion order disagree with index order. */
    throwStrips?: number[]; slowStrips?: number[];
  }) => {
    const { capturePage } = await import("./captureDevice");
    const { renderBand } = await import("./bandRender");
    const pages = [
      { view: VIEW, words: [], geometry: DENSE, shxLabels: [], labels: [] },
      { view: VIEW, words: [], geometry: [], shxLabels: [], labels: [lab("MATCH LINE SEE SHEET 1", 90, 400)] },
    ];
    let n = 0;
    (capturePage as any).mockImplementation(() => pages[n++]);
    (renderBand as any).mockImplementation((_m: any, _p: any, clip: number[]) => {
      const strip = STRIP_STARTS.findIndex((x) => Math.abs(x - clip[0]) < 0.5);
      return raster(strip >= 0 ? strip : EDGE_BAND);
    });

    const fakeDoc = { loadPage: vi.fn(() => ({ destroy: vi.fn() })) };
    const rotsByStrip = new Map<number, (0 | 90 | 270)[]>();
    let stripReads = 0;
    const ocr = vi.fn(async (img: any) => {
      const tag = tagOf(img);
      if (tag === EDGE_BAND) {
        // Page 0's edge bands. "ZZZ" can never parse as a sheet ref, so the recovered
        // labels cannot hand page 0 the reciprocal edge ref and skip the very scan
        // under test; only where the CONFIDENCE lands matters here.
        if (opts.edgeRot == null) return [];
        if (rotOf(img) === opts.edgeRot) return words("ZZZ", opts.edgeConf ?? 90);
        const other = opts.edgeOtherConf === undefined ? 51 : opts.edgeOtherConf;
        return other == null ? [] : words("ZZZ", other);
      }
      stripReads++;
      (rotsByStrip.get(tag) ?? rotsByStrip.set(tag, []).get(tag)!).push(rotOf(img));
      if (opts.slowStrips?.includes(tag)) await tick(20);
      if (opts.throwStrips?.includes(tag)) throw new Error(`strip ${tag} exploded`);
      return opts.hitStrips.includes(tag) ? words("MATCH LINE SEE SHEET 2") : [];
    });

    let debug: any = null;
    await autoStitch({} as any, fakeDoc as any, [0, 1], {
      ocr, userScale: 20, ocrConcurrency: opts.ocrConcurrency, onDebug: (d) => { debug = d; },
    });
    return { debug, rotsByStrip, stripReads };
  };

  it("scans ONLY the rotation the edge bands proved, and both when they proved nothing", async () => {
    // Same pages, same strips, same (empty) answer — the only difference is whether
    // page 0's edge bands came out with a rotation.
    const known = await run({ edgeRot: 270, hitStrips: [], ocrConcurrency: 3 });
    const unknown = await run({ edgeRot: null, hitStrips: [], ocrConcurrency: 3 });

    expect([...known.rotsByStrip.keys()].sort()).toEqual([0, 1, 2, 3, 4]);
    expect([...known.rotsByStrip.values()]).toEqual([[270], [270], [270], [270], [270]]);
    expect(known.stripReads).toBe(5);    // 5 strips, one read each
    expect(unknown.stripReads).toBe(10); // 5 strips, both rotations
    // Rotation order WITHIN a strip is preserved when both are scanned: 90 first,
    // 270 only once 90 has found nothing.
    expect([...unknown.rotsByStrip.values()]).toEqual([[90, 270], [90, 270], [90, 270], [90, 270], [90, 270]]);
    // …and neither run finds an anchor, so halving the reads changed no answer.
    expect(known.debug.anchors).toHaveLength(0);
    expect(unknown.debug.anchors).toHaveLength(0);
  });

  it("takes the LOWEST-index hit when two strips in the same chunk both match", async () => {
    // Chunk 0 is strips 0-2. Strips 1 and 2 both answer; the sequential scan would
    // have returned strip 1 and stopped, so the chunked scan must return strip 1 too.
    const only1 = await run({ edgeRot: 270, hitStrips: [1], ocrConcurrency: 3 });
    const only2 = await run({ edgeRot: 270, hitStrips: [2], ocrConcurrency: 3 });
    const both = await run({ edgeRot: 270, hitStrips: [1, 2], ocrConcurrency: 3 });

    // dx carries the matching label's x, so it says WHICH strip won.
    expect(only1.debug.anchors).toHaveLength(1);
    expect(only2.debug.anchors).toHaveLength(1);
    expect(only1.debug.anchors[0].dx).not.toBe(only2.debug.anchors[0].dx);
    expect(both.debug.anchors).toHaveLength(1);
    expect(both.debug.anchors[0].dx).toBe(only1.debug.anchors[0].dx);
  });

  it("issues strips in chunks of ocrConcurrency and stops issuing once one has hit", async () => {
    // A hit on strip 0 still costs the whole chunk it travelled in — that overshoot
    // is the trade — but nothing beyond it.
    const wide = await run({ edgeRot: 270, hitStrips: [0], ocrConcurrency: 3 });
    expect(wide.stripReads).toBe(3);
    const narrow = await run({ edgeRot: 270, hitStrips: [0], ocrConcurrency: 1 });
    expect(narrow.stripReads).toBe(1);
    // Same anchor either way: the width of the batch cannot change the answer.
    expect(wide.debug.anchors[0].dx).toBe(narrow.debug.anchors[0].dx);
    // A hit in the SECOND chunk leaves the third unissued: 5 strips in chunks of 2 →
    // strips 0-1, 2-3, 4; a hit on strip 2 stops the scan after four reads.
    const second = await run({ edgeRot: 270, hitStrips: [2], ocrConcurrency: 2 });
    expect(second.stripReads).toBe(4);
  });

  it("a throwing strip cannot sink a LOWER-index hit in the same chunk", async () => {
    // The sequential loop rendered strip 1 only once strip 0 had missed, so a throw
    // on strip 1 could not even exist once strip 0 had hit. Running them together
    // must not change that: `Promise.all` would have rejected the whole chunk and,
    // since nothing catches `searchReciprocal`, killed the run.
    const ok = await run({ edgeRot: 270, hitStrips: [0], throwStrips: [1], ocrConcurrency: 3 });
    expect(ok.debug.anchors).toHaveLength(1);
    const clean = await run({ edgeRot: 270, hitStrips: [0], ocrConcurrency: 3 });
    expect(ok.debug.anchors[0].dx).toBe(clean.debug.anchors[0].dx);
  });

  it("rethrows a strip that failed BEFORE any hit, and the LOWEST-index one at that", async () => {
    // Strip 0 throws and strip 1 would have hit: the sequential loop never reached
    // strip 1, so the run still dies here.
    await expect(run({ edgeRot: 270, hitStrips: [1], throwStrips: [0], ocrConcurrency: 3 }))
      .rejects.toThrow("strip 0 exploded");
    // Both throw, and strip 0 is made the SLOW one so completion order and index
    // order disagree. The old loop's error was always the lowest-index one;
    // `Promise.all` would have surfaced strip 1's, which rejected first in time.
    await expect(run({ edgeRot: 270, hitStrips: [], throwStrips: [0, 1], slowStrips: [0], ocrConcurrency: 3 }))
      .rejects.toThrow("strip 0 exploded");
  });

  it("locks the rotation only on real evidence: a floor and a margin over the loser", async () => {
    // The default fixture reads one word at confidence 90 on each of the two side
    // bands, and a worthless 51 the other way: rotMass 80 vs 2, which clears both
    // tests and locks.
    const locked = await run({ edgeRot: 270, hitStrips: [], ocrConcurrency: 3 });
    expect(locked.stripReads).toBe(5);

    // FLOOR. A single misread fragment at confidence 55 is worth 5 per band, 10 for
    // the page — a 10-vs-2 landslide made entirely of noise. It must not lock.
    const noise = await run({ edgeRot: 270, hitStrips: [], edgeConf: 55, ocrConcurrency: 3 });
    expect(noise.stripReads).toBe(10);

    // MARGIN. Plenty of mass, but the other rotation read almost as much — which is
    // what a dense sheet rasterised sideways actually does. 80 vs 70 is not a
    // decision, so both rotations are still scanned.
    const even = await run({ edgeRot: 270, hitStrips: [], edgeConf: 90, edgeOtherConf: 85, ocrConcurrency: 3 });
    expect(even.stripReads).toBe(10);

    // …and a clear 2x margin over a loser that DID read something still locks.
    const clear = await run({ edgeRot: 270, hitStrips: [], edgeConf: 95, edgeOtherConf: 60, ocrConcurrency: 3 });
    expect(clear.stripReads).toBe(5);
  });

  it("a band where ONE rotation came back empty is left out of the tally", async () => {
    // A side band's two rotations are two separate pool jobs. One can time out
    // while the other returns, and `recognize` collapses OCR_NO_RESULT and a
    // wordless read into the same `[]` — so a 20 s hiccup on one crop used to hand
    // the survivor an unopposed landslide and lock the page to whichever rotation
    // happened not to hang.
    const answered = await run({ edgeRot: 270, hitStrips: [], edgeConf: 90, edgeOtherConf: 51, ocrConcurrency: 3 });
    expect(answered.stripReads).toBe(5);   // 80 vs 2 — a real, opposed win: locks

    // Identical winning read; the other rotation returned nothing at all.
    const halfDead = await run({ edgeRot: 270, hitStrips: [], edgeConf: 90, edgeOtherConf: null, ocrConcurrency: 3 });
    expect(halfDead.stripReads).toBe(10);  // no tally, no lock, both rotations scanned
  });
});

/**
 * The retry: a band whose read came back a NON-ANSWER (the pool's job budget
 * expired) is read a second time as overlapping sub-clips. Every band that answers
 * at all — including one that answers with no words — is read exactly as before.
 *
 * The view is 2592 x 1000 pt so the TOP and BOTTOM bands are over budget
 * (7200 px wide → 4 sub-clips of 918 pt stepping 558 pt) and the side bands are not
 * (2778 px). Horizontal bands also keep `wordsToLabels` honest and readable: at
 * rot 0 a word at local x maps to page `clipX0 + x`.
 */
describe("a timed-out edge band is retried as overlapping sub-clips", () => {
  const VIEW: [number, number, number, number] = [0, 0, 2592, 1000];
  const SUB_X = [0, 558, 1116, 1674];  // sub-clip origins along a top/bottom band
  const SUB_LEN = 918;
  const lab = (text: string, cx: number, cy: number, w = 60, h = 14) =>
    ({ text, x: cx - w / 2, y: cy - h / 2, endX: cx + w / 2, endY: cy + h / 2, angle: 0, h, font: null });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  /** Where a rendered clip came from, recovered from the raster the OCR stub is given. */
  interface Meta { page: number; x0: number; y0: number; w: number; h: number }

  const setup = async () => {
    const { capturePage } = await import("./captureDevice");
    const { renderBand } = await import("./bandRender");
    const meta = new Map<number, Meta>();
    let seq = 0;
    // Both pixels carry the clip id in GREEN, which survives rotateRaw; RED-first
    // after rotation means 90, BLUE-first 270, and a 2-wide image was never rotated.
    (renderBand as any).mockImplementation((_m: any, pg: any, clip: number[]) => {
      const id = ++seq;
      meta.set(id, { page: pg.idx, x0: clip[0], y0: clip[1], w: clip[2] - clip[0], h: clip[3] - clip[1] });
      return { image: { width: 2, height: 1, data: new Uint8ClampedArray([255, id, 0, 255, 0, id, 255, 255]) }, scale: 1 };
    });
    (capturePage as any).mockImplementation((_m: any, pg: any) => ({
      view: VIEW, words: [], geometry: [], shxLabels: [],
      labels: [lab(pg.idx === 0 ? "C-301" : "C-302", 2300, 940, 50, 16)], // title-block code only
    }));
    const fakeDoc = { loadPage: vi.fn((i: number) => ({ idx: i, destroy: vi.fn() })) };
    const at = (img: any) => meta.get(img.data[1])!;
    /** Which horizontal band a clip belongs to: they are the only over-budget ones. */
    const edgeOf = (m: Meta): "top" | "bottom" | null =>
      (m.w > 2000 || Math.abs(m.w - SUB_LEN) < 1) ? (m.y0 === 0 ? "top" : "bottom") : null;
    /** True for the WHOLE band read (2592 pt wide), false for one of its sub-clips. */
    const isWhole = (m: Meta) => m.w > 2000;
    /** The sub-clip's index along its band, or -1 if this is not a sub-clip. */
    const subIndex = (m: Meta) =>
      (edgeOf(m) && !isWhole(m) ? SUB_X.findIndex((x) => Math.abs(x - m.x0) < 0.5) : -1);
    return { renderBand, fakeDoc, at, edgeOf, isWhole, subIndex, meta };
  };

  const word = (text: string, x0: number, confidence = 90) =>
    ({ text, confidence, bbox: { x0, y0: 0, x1: x0 + 60, y1: 12 } });

  it("re-reads a band that answered nothing, and the sub-clips' labels reach the page's recovered set", async () => {
    const { renderBand, fakeDoc, at, edgeOf, isWhole, subIndex } = await setup();
    // Page 0's BOTTOM edge and page 1's TOP edge face each other. Both horizontal
    // bands answer nothing on both pages; the side bands and the sheet-number cell
    // answer with no words, which is an ANSWER and must not be retried.
    const ocr = vi.fn(async (img: any, o?: { onNoResult?: () => void }) => {
      const m = at(img);
      if (edgeOf(m) && isWhole(m)) { o?.onNoResult?.(); return []; }
      const facing = m.page === 0 ? "bottom" : "top";
      if (subIndex(m) === 2 && edgeOf(m) === facing) {
        return [word(m.page === 0 ? "MATCH LINE SEE SHEET C-302" : "MATCH LINE SEE SHEET C-301", 600)];
      }
      return [];
    });
    let debug: any = null;
    await autoStitch({} as any, fakeDoc as any, [0, 1], { ocr, userScale: 20, onDebug: (d) => { debug = d; } });

    // The retry loaded its own page handle — the caller's was destroyed when the
    // reads were merely ISSUED. Two pages, each opened once to extract and once
    // per retried band (top and bottom both answer nothing → 2 retries each).
    expect(fakeDoc.loadPage.mock.calls.length).toBeGreaterThan(2);
    // Sub-clips were rastered, in order along the band, and only for the top/bottom
    // bands: the side bands are inside the budget and were never cut.
    const subs = (renderBand as any).mock.calls.map((c: any[]) => c[2] as number[])
      .filter((c: number[]) => Math.abs(c[2] - c[0] - SUB_LEN) < 1);
    expect(subs.length).toBe(2 /* pages */ * 2 /* horizontal bands */ * 4 /* sub-clips */);
    expect(subs.slice(0, 4).map((c: number[]) => c[0])).toEqual(SUB_X);

    // …and the recovered label landed at the SUB-CLIP's own origin plus the word's
    // offset in it (1116 + 600), not at the band's.
    const recovered = debug.inputs[0].extract.labels.filter((l: any) => l.font === "ocr");
    expect(recovered.map((l: any) => l.text)).toContain("MATCH LINE SEE SHEET C-302");
    expect(recovered.find((l: any) => l.text === "MATCH LINE SEE SHEET C-302").x).toBeCloseTo(1716, 6);
    // …on the BOTTOM band, which is where page 0's callout was returned.
    expect(recovered.find((l: any) => l.text === "MATCH LINE SEE SHEET C-302").y).toBeCloseTo(850, 6);
    // The two pages now reference each other by code, entirely out of the retry.
    expect(debug.anchors).toHaveLength(1);
    expect(debug.anchors[0].perp).toBe("y"); // a top/bottom ref pins y
  });

  it("collapses a callout the overlap made two sub-clips read", async () => {
    const { fakeDoc, at, edgeOf, isWhole, subIndex } = await setup();
    // Sub-clips 2 and 3 overlap on pages 1674..2034. The same callout is returned by
    // both, at each one's own local offset, so both map to page x 1716.
    const ocr = vi.fn(async (img: any, o?: { onNoResult?: () => void }) => {
      const m = at(img);
      if (edgeOf(m) && isWhole(m)) { o?.onNoResult?.(); return []; }
      if (edgeOf(m) !== "top") return [];
      const j = subIndex(m);
      if (j === 2) return [word("MATCH LINE SEE SHEET C-302", 600)];
      if (j === 3) return [word("MATCH LINE SEE SHEET C-302", 42)];
      return [];
    });
    let debug: any = null;
    await autoStitch({} as any, fakeDoc as any, [0, 1], { ocr, userScale: 20, onDebug: (d) => { debug = d; } });
    const hits = debug.inputs[0].extract.labels.filter((l: any) => l.text === "MATCH LINE SEE SHEET C-302");
    expect(hits).toHaveLength(1);
    expect(hits[0].x).toBeCloseTo(1716, 6);
  });

  it("does NOT retry a band that answered — an empty read is an answer", async () => {
    const { renderBand, fakeDoc } = await setup();
    // Same bands, same (empty) result, but nothing reports a non-answer.
    const ocr = vi.fn(async () => []);
    await autoStitch({} as any, fakeDoc as any, [0, 1], { ocr, userScale: 20 });
    const clips = (renderBand as any).mock.calls.map((c: any[]) => c[2] as number[]);
    expect(clips.some((c: number[]) => Math.abs(c[2] - c[0] - SUB_LEN) < 1)).toBe(false);
    // 4 edge bands + the sheet-number cell, per page. Nothing more.
    expect(clips).toHaveLength(2 * 5);
    // 7 reads per page: top, bottom, left x2 rotations, right x2, sheet number.
    expect(ocr).toHaveBeenCalledTimes(2 * 7);
  });

  it("an abort landing while the reads are in flight cancels the retry", async () => {
    const { renderBand, fakeDoc, at, edgeOf, isWhole } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let aborting = false;
    // The shape this test has to hit is narrow, so it is worth spelling out. Page 0's
    // whole burst is issued SYNCHRONOUSLY, and each read's first act is `checkAbort`
    // — so the abort must not be armed until every one of those 7 calls has been
    // made, or one of them throws, the first-pass `Promise.all` rejects, and the
    // retry decision is never reached at all (which would make this test vacuous).
    //
    // So: every page-0 read succeeds. Its top and bottom bands answer NOTHING (both
    // would be retried), its LEFT band parks on a gate so the page's `Promise.all`
    // cannot settle, and the abort is armed one microtask after issuing — early
    // enough for page 1's top-of-iteration checkpoint (which waits on a macrotask
    // `yieldToMain`) to trip the run's OCR signal, late enough to throw nothing.
    const ocr = vi.fn(async (img: any, o?: { onNoResult?: () => void }) => {
      const m = at(img);
      if (m.page === 0 && edgeOf(m) && isWhole(m)) {
        await Promise.resolve();
        aborting = true;      // …after the burst was issued, before page 1's check
        o?.onNoResult?.();
        return [];
      }
      if (m.page === 0 && Math.abs(m.x0) < 0.5 && m.h > 900) await gate;  // left band
      return [];
    });
    const run = autoStitch({} as any, fakeDoc as any, [0, 1], { ocr, userScale: 20, shouldAbort: () => aborting });
    await expect(run).rejects.toBeInstanceOf(AutoStitchAborted);
    // Page 0's reads were all ISSUED and none of them threw: the retry decision is
    // genuinely reached below, it is the abort that declines it.
    expect(ocr).toHaveBeenCalledTimes(7);
    const rendersBefore = (renderBand as any).mock.calls.length;

    release();
    // Let the parked page's reads settle and its retry decision be taken.
    await new Promise((r) => setTimeout(r, 20));
    const clips = (renderBand as any).mock.calls.map((c: any[]) => c[2] as number[]);
    expect(clips.some((c: number[]) => Math.abs(c[2] - c[0] - SUB_LEN) < 1)).toBe(false);
    // Nothing at all was rastered after the abort — not one sub-clip, not one page.
    expect((renderBand as any).mock.calls.length).toBe(rendersBefore);
    expect(fakeDoc.loadPage).toHaveBeenCalledTimes(1); // the retry never re-opened it
  });
});

/**
 * The rotation tally across a retry. A side band's rotation is a property of the
 * BAND, and the tally is what locks the reciprocal strip scan to one rotation — so a
 * band whose evidence is not whole must not vote. `stripReads` is what a lock looks
 * like from outside: 5 strips at one rotation, or 10 at both.
 *
 * View 1000 x 2592 pt: the SIDE bands are over budget (7200 px tall → 4 sub-clips of
 * 918 pt stepping 558) and the horizontal ones are not.
 */
describe("rotation tally when a side band had to be retried", () => {
  const VIEW: [number, number, number, number] = [0, 0, 1000, 2592];
  const SUB_Y = [0, 558, 1116, 1674];
  const SUB_LEN = 918;
  const STRIP_STARTS = [450, 570, 690, 810, 930];
  const DENSE = Array.from({ length: 5000 }, (_, i) => makeGeom([[400 + (i % 7), 300], [401 + (i % 7), 301]], false, i));
  const lab = (text: string, cx: number, cy: number, w = 120, h = 10) =>
    ({ text, x: cx - w / 2, y: cy - h / 2, endX: cx + w / 2, endY: cy + h / 2, angle: 0, h, font: null });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  /**
   * `answer(sub, rot)` speaks for the side bands of page 0: `sub` is -1 for the
   * WHOLE-band read and 0-3 for a sub-clip. `null` means a non-answer (the read
   * reports `onNoResult` and resolves []), a number is that word's confidence, and
   * `undefined` is a genuine empty read.
   */
  const run = async (answer: (sub: number, rot: 90 | 270) => number | null | undefined) => {
    const { capturePage } = await import("./captureDevice");
    const { renderBand } = await import("./bandRender");
    const pages = [
      { view: VIEW, words: [], geometry: DENSE, shxLabels: [], labels: [] },
      { view: VIEW, words: [], geometry: [], shxLabels: [], labels: [lab("MATCH LINE SEE SHEET 1", 90, 1300)] },
    ];
    const meta = new Map<number, { x0: number; h: number }>();
    const metaSub = new Map<number, number>();
    let seq = 0;
    (renderBand as any).mockImplementation((_m: any, _p: any, clip: number[]) => {
      const id = ++seq;
      meta.set(id, { x0: clip[0], h: clip[3] - clip[1] });
      const y0 = clip[1];
      // Green carries the id (survives rotateRaw); red-first after rotation = 90.
      const sub = Math.abs((clip[3] - clip[1]) - SUB_LEN) < 1 ? SUB_Y.findIndex((y) => Math.abs(y - y0) < 0.5) : -1;
      metaSub.set(id, sub);
      return { image: { width: 2, height: 1, data: new Uint8ClampedArray([255, id, 0, 255, 0, id, 255, 255]) }, scale: 1 };
    });
    let n = 0;
    (capturePage as any).mockImplementation(() => pages[n++]);

    const fakeDoc = { loadPage: vi.fn(() => ({ destroy: vi.fn() })) };
    let stripReads = 0;
    const ocr = vi.fn(async (img: any, o?: { onNoResult?: () => void }) => {
      const m = meta.get(img.data[1])!;
      const rot: 0 | 90 | 270 = img.width === 2 ? 0 : (img.data[0] === 255 ? 90 : 270);
      if (STRIP_STARTS.some((x) => Math.abs(x - m.x0) < 0.5)) { stripReads++; return []; }
      const side = (Math.abs(m.x0) < 0.5 || Math.abs(m.x0 - 880) < 0.5) && (m.h > 2000 || Math.abs(m.h - SUB_LEN) < 1);
      if (!side || rot === 0) return [];
      const a = answer(metaSub.get(img.data[1])!, rot);
      if (a === null) { o?.onNoResult?.(); return []; }
      // "ZZZ" can never parse as a sheet ref, so these reads cannot hand page 0 the
      // reciprocal edge ref and skip the very scan under test.
      return a === undefined ? [] : [{ text: "ZZZ", confidence: a, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }];
    });
    await autoStitch({} as any, fakeDoc as any, [0, 1], { ocr, userScale: 20, ocrConcurrency: 3 });
    const subRenders = (renderBand as any).mock.calls
      .filter((c: any[]) => Math.abs((c[2][3] - c[2][1]) - SUB_LEN) < 1).length;
    return { stripReads, subRenders };
  };

  it("a band that needed the retry votes with its RETRIED mass, summed over the sub-clips", async () => {
    // Both rotations of the whole band are non-answers, so the band is re-read. In
    // the retry 270 reads a confident word on sub-clip 0 and 90 a worthless 51 on
    // sub-clip 3: 40 vs 1 per band, 80 vs 2 over the page's two side bands — real,
    // opposed evidence, which clears the floor and the 2x margin.
    const locked = await run((sub, rot) =>
      sub < 0 ? null : (rot === 270 && sub === 0) ? 90 : (rot === 90 && sub === 3) ? 51 : undefined);
    expect(locked.subRenders).toBe(2 /* side bands */ * 4 /* sub-clips */);
    expect(locked.stripReads).toBe(5);
  });

  it("…but not if a sub-clip of the retry was itself a non-answer", async () => {
    // Identical to above except one of 90's sub-clips also blew its budget. The
    // band's evidence is no longer whole in both directions, so it does not vote —
    // exactly the guard that stops one 20 s hiccup locking a page's rotation.
    const unlocked = await run((sub, rot) =>
      sub < 0 ? null
        : (rot === 90 && sub === 1) ? null
        : (rot === 270 && sub === 0) ? 90
        : (rot === 90 && sub === 3) ? 51 : undefined);
    expect(unlocked.subRenders).toBe(8); // it WAS retried…
    expect(unlocked.stripReads).toBe(10); // …but the retry does not get to vote
  });

  it("a band with ONE surviving rotation is not retried at all — a whole read beats a cut one", async () => {
    // 270 read the band fine; only 90 was lost. The band therefore already HAS a
    // whole-raster reading, and cutting it could only make that reading worse (a
    // callout across a cut is truncated, or misread into a different valid-looking
    // target). So nothing is re-rastered…
    const survived = await run((sub, rot) => (sub < 0 ? (rot === 270 ? 90 : null) : undefined));
    expect(survived.subRenders).toBe(0);
    // …and the band still does not vote: one rotation is a non-answer, so counting
    // the survivor would be counting it unopposed.
    expect(survived.stripReads).toBe(10);
  });
});
