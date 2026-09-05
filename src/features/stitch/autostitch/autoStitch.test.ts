import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolvePrintedNos, autoStitch, AutoStitchAborted, resolveSheetCodes } from "./autoStitch";

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
