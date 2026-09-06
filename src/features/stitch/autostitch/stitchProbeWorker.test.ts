// @vitest-environment jsdom
/**
 * The probe worker's message plumbing — specifically its cooperative-abort
 * bookkeeping, which is the one piece of worker state that outlives a request and
 * therefore the one piece unit tests can get wrong for real.
 *
 * The worker installs `self.onmessage` at import time, so each test re-imports it
 * against a fresh module registry and a fresh `postMessage` spy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const stitch = vi.hoisted(() => ({
  /** Every `shouldAbort` the worker has handed to autoStitch, newest last. */
  shouldAborts: [] as (() => boolean)[],
  /** Every `ocr` callback (the RPC shim) it has handed to autoStitch, newest last. */
  ocrs: [] as ((image: any, opts?: any) => Promise<any>)[],
  /** Resolves the pending autoStitch call, so a probe can be held open. */
  release: null as null | (() => void),
}));

vi.mock("./autoStitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./autoStitch")>();
  return {
    ...actual,
    autoStitch: vi.fn((_m: any, _d: any, _p: any, opts: any) => {
      stitch.shouldAborts.push(opts.shouldAbort);
      stitch.ocrs.push(opts.ocr);
      return new Promise((resolve) => {
        stitch.release = () => resolve({
          placements: [], rootFtPerIn: 20, alignedCount: 0, unplacedCount: 0,
          worstResidFt: 0, method: "none", poses: [], refPageIndices: [],
          skipped: [], scaleWarnings: [],
          ocrStats: { calls: 9, nonAnswers: 1, retries: 1, unknown: 0, withheldVotes: 0 },
        });
      });
    }),
  };
});
vi.mock("mupdf", () => ({
  default: { Document: { openDocument: () => ({ destroy() { /* noop */ } }) } },
}));

const sent: any[] = [];
const post = (data: any) => (self as any).onmessage({ data } as MessageEvent);
const request = (docId: number) => ({ docId, pdfBytes: new Uint8Array([1]), pageIndices: [0, 1], userScale: null });

/** Import the worker fresh, with `self.postMessage` spied. */
async function loadWorker() {
  vi.resetModules();
  sent.length = 0;
  stitch.shouldAborts.length = 0;
  stitch.ocrs.length = 0;
  stitch.release = null;
  (self as any).postMessage = (msg: any) => { sent.push(msg); };
  await import("./stitchProbe.worker");
}

/** Let the worker's request queue reach its `autoStitch` call. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("stitchProbe.worker cooperative abort", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { delete (self as any).onmessage; });

  it("a LATER abort does not un-abort the probe an earlier one stopped", async () => {
    // The regression: the budget for probe 5 fires and aborts it, the user hits
    // Re-check immediately, and the hook's stop() aborts 6. With a single scalar
    // that second message overwrote the first, probe 5's shouldAbort went FALSE
    // again, and it ran to completion with the Re-check queued behind it.
    await loadWorker();
    post(request(5));
    await settle();
    const shouldAbort = stitch.shouldAborts.at(-1)!;
    expect(shouldAbort()).toBe(false);

    post({ kind: "abort", docId: 5 });
    expect(shouldAbort()).toBe(true);

    post({ kind: "abort", docId: 6 });
    expect(shouldAbort()).toBe(true);   // still stopped — this is the fix
  });

  it("an abort for an OLDER probe does not stop the current one", async () => {
    // The watermark must not over-reach in the other direction either.
    await loadWorker();
    post({ kind: "abort", docId: 2 });
    post(request(7));
    await settle();
    expect(stitch.shouldAborts.at(-1)!()).toBe(false);
  });

  it("does not abort the very first probe, which posts docId 0", async () => {
    // AddPdfModal only increments its docId on supersede, so its FIRST probe is
    // docId 0 — which matched the old `abortDocId = 0` initial value and made
    // shouldAbort() true at that probe's first checkpoint.
    await loadWorker();
    post(request(0));
    await settle();
    expect(stitch.shouldAborts.at(-1)!()).toBe(false);
    post({ kind: "abort", docId: 0 });
    expect(stitch.shouldAborts.at(-1)!()).toBe(true);
  });
});

describe("stitchProbe.worker OCR RPC — non-answers", () => {
  const IMG = () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) });

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.useRealTimers(); delete (self as any).onmessage; });

  /** Start a probe and hand back the `ocr` shim autoStitch was given. */
  const withOcr = async () => {
    await loadWorker();
    post(request(1));
    await settle();
    return stitch.ocrs.at(-1)!;
  };

  it("relays the main thread's noResult flag to the caller's onNoResult", async () => {
    // The whole point of the flag: `[]` alone cannot say whether the crop held no
    // text or the read was lost, and only the second earns a band a second pass.
    const ocr = await withOcr();
    let flagged = false;
    const p = ocr(IMG(), { onNoResult: () => { flagged = true; } });
    const req = sent.find((m) => m.kind === "ocr-req");
    expect(req).toBeTruthy();
    post({ kind: "ocr-res", ocrId: req.ocrId, words: [], noResult: true });
    await expect(p).resolves.toEqual([]);
    expect(flagged).toBe(true);
  });

  it("a reply with words, or without the flag, is an ANSWER", async () => {
    const ocr = await withOcr();
    let flagged = false;
    const p = ocr(IMG(), { onNoResult: () => { flagged = true; } });
    const req = sent.find((m) => m.kind === "ocr-req");
    post({ kind: "ocr-res", ocrId: req.ocrId, words: [], noResult: false });
    await expect(p).resolves.toEqual([]);
    expect(flagged).toBe(false);
  });

  it("the RPC backstop covers CONVERSION + queue + job, not just the job", async () => {
    // The backstop is measured from the moment the request is POSTED, and what follows
    // it is a whole pipeline: the raster→Blob conversion RPC on its OWN 30 s budget,
    // then an unbounded wait in the pool's QUEUE (a page issues 7-13 reads at once onto
    // 2-3 workers), and only then the job's 20 s, measured from DISPATCH. At `20 + 5`
    // this fired on reads that were merely still converting or still queued — 13-14
    // spurious non-answers a browser run, each one buying a re-read that put more load
    // on the very pool that was running late. 30 + 20 + 5 = 55 s.
    const ocr = await withOcr();
    // Faked only now: `withOcr` waits on a real timer to reach autoStitch, and the
    // backstop's timer is armed by the `ocr` call below.
    vi.useFakeTimers();
    let flagged = false;
    const p = ocr(IMG(), { onNoResult: () => { flagged = true; } });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(flagged).toBe(false);          // where the old backstop fired
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(p).resolves.toEqual([]);
    // Still a NON-ANSWER when it does fire: a lost reply and a job whose budget expired
    // without an answer are indistinguishable from here, and neither is "no text".
    expect(flagged).toBe(true);
  });

  it("the RPC backstop SCALES with the budget a re-read asks for", async () => {
    // A re-read is dispatched on a doubled job budget (40 s). A backstop fixed at the
    // ordinary read's figure would fire first and turn a job entitled to 40 s into a
    // non-answer — and the caller has no second re-read to spend, so the band would go
    // `unknown` for a reason that is purely an artefact of this timer. 30 + 40 + 5.
    const ocr = await withOcr();
    vi.useFakeTimers();
    let flagged = false;
    const p = ocr(IMG(), { onNoResult: () => { flagged = true; }, timeoutMs: 40_000 });
    // The budget rides on the request, so the main thread's pool honours the same one.
    const req = sent.filter((m) => m.kind === "ocr-req").at(-1);
    expect(req.timeoutMs).toBe(40_000);
    await vi.advanceTimersByTimeAsync(55_000);   // where an ordinary read backstops
    expect(flagged).toBe(false);
    await vi.advanceTimersByTimeAsync(20_001);   // + the doubled budget's extra 20 s
    await expect(p).resolves.toEqual([]);
    expect(flagged).toBe(true);
  });

  it("an ordinary read still carries no budget, and still backstops at 55 s", async () => {
    const ocr = await withOcr();
    vi.useFakeTimers();
    const p = ocr(IMG());
    const req = sent.filter((m) => m.kind === "ocr-req").at(-1);
    expect(req.timeoutMs).toBeUndefined();
    await vi.advanceTimersByTimeAsync(55_000);
    await expect(p).resolves.toEqual([]);
  });

  it("the backstop CANCELS the read on the main thread before giving up on it", async () => {
    // Giving up here does not stop the work: the request may still be sitting in the
    // main thread's pool queue, and a queued job has no deadline of its own — so
    // without this the run pays for a crop nobody will read, exactly when the pool is
    // already the bottleneck. Safe to send for a read that is simultaneously being
    // reported as a non-answer: `attachOcrRpc` drops the reply for an aborted id, and
    // `recognize` suppresses the duplicate `onNoResult`, so the read settles once.
    const ocr = await withOcr();
    vi.useFakeTimers();
    let flagged = false;
    const p = ocr(IMG(), { onNoResult: () => { flagged = true; } });
    const req = sent.filter((m) => m.kind === "ocr-req").at(-1);
    expect(sent.some((m) => m.kind === "ocr-abort")).toBe(false);
    await vi.advanceTimersByTimeAsync(55_000);
    await expect(p).resolves.toEqual([]);
    expect(flagged).toBe(true);
    // The SAME id the request went out on, so the main thread cancels THIS read.
    expect(sent.filter((m) => m.kind === "ocr-abort").map((m) => m.ocrId)).toEqual([req.ocrId]);
  });

  it("an ABORT is not a non-answer — the caller stopped it on purpose", async () => {
    const ocr = await withOcr();
    const ac = new AbortController();
    let flagged = false;
    const p = ocr(IMG(), { signal: ac.signal, onNoResult: () => { flagged = true; } });
    ac.abort();
    await expect(p).resolves.toEqual([]);
    expect(flagged).toBe(false);
    expect(sent.some((m) => m.kind === "ocr-abort")).toBe(true);
  });
});

describe("stitchProbe.worker result shaping", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { delete (self as any).onmessage; });

  it("a finished probe posts the ALIGNER's OCR tally, not just a round-trip count", async () => {
    // The worker's own `ocrCallCount` cannot see non-answers, retries, unknown reads or
    // withheld votes — and `unknown` is the one the hook refuses to show a verdict on.
    // Dropping the tally here would leave the hook blind with no test failing.
    await loadWorker();
    post(request(1));
    await settle();
    stitch.release!();
    await settle();
    const res = sent.find((m) => m && !m.kind && m.docId === 1);
    expect(res).toBeTruthy();
    expect(res.ocrStats).toEqual({ calls: 9, nonAnswers: 1, retries: 1, unknown: 0, withheldVotes: 0 });
    expect(res.ocrCalls).toBe(9);
  });
});
