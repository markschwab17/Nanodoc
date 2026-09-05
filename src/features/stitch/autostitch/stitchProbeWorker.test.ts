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
  /** Resolves the pending autoStitch call, so a probe can be held open. */
  release: null as null | (() => void),
}));

vi.mock("./autoStitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./autoStitch")>();
  return {
    ...actual,
    autoStitch: vi.fn((_m: any, _d: any, _p: any, opts: any) => {
      stitch.shouldAborts.push(opts.shouldAbort);
      return new Promise((resolve) => {
        stitch.release = () => resolve({
          placements: [], rootFtPerIn: 20, alignedCount: 0, unplacedCount: 0,
          worstResidFt: 0, method: "none", poses: [], refPageIndices: [],
          skipped: [], scaleWarnings: [],
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
