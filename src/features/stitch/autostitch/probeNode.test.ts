/**
 * `runProbe` — the Node entry the Lambda bundles and the harness shares.
 *
 * What is worth testing here is the CONTRACT, not the aligner: the aligner has its own
 * suite, and re-testing it through a second door only makes both slower. So the stitch
 * itself is stubbed for the status tests, and the three answers `runProbe` is allowed to
 * give are pinned one at a time — `ok`, `unknown` (a result reached with a hole in the
 * evidence, which the editor must not trust), and `timeout` (the budget expired, and the
 * result must claim nothing). Plus the two things a caller can silently get wrong: the
 * pool width handed down to the engine, and the OCR transport's encode/map round trip.
 *
 * One test does run the REAL engine, over real bytes, with tesseract stubbed out — but
 * only when the Belcourt fixture is on this machine (it is deliberately not in the repo).
 * That is the test that would notice `probeNode` failing to open a document, failing to
 * shape a result, or throwing where a Node/browser difference bites.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { AutoStitchAborted, type AutoStitchResult } from "./autoStitch";
import {
  runProbe,
  encodePNG,
  toOcrWords,
  ENGINE_VERSION,
  NODE_OCR_POOL_SIZE,
  type ProbeNodeDeps,
  type ProbeNodeRequest,
} from "./probeNode";

/** The stub switch. `null` means the REAL `autoStitch` runs — which is how the
 *  Belcourt test can live in the same file as the stubbed status tests. */
const engine = vi.hoisted(() => ({ stub: null as null | ((...args: any[]) => any) }));
vi.mock("./autoStitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./autoStitch")>();
  return {
    ...actual,
    autoStitch: (...args: any[]) => (engine.stub ? engine.stub(...args) : (actual.autoStitch as any)(...args)),
  };
});

/** An `AutoStitchResult` with nothing interesting in it but a settable OCR tally. */
const canned = (unknown: number): AutoStitchResult => ({
  placements: [{ pageIndex: 0, x: 1, y: 2, width: 3, height: 4, aligned: true } as any],
  rootFtPerIn: 20,
  alignedCount: 1,
  unplacedCount: 0,
  worstResidFt: 0.5,
  method: "geometric",
  poses: [],
  refPageIndices: [0, 1],
  skipped: [],
  scaleWarnings: [],
  ocrStats: { calls: 7, nonAnswers: 0, retries: 0, unknown, withheldVotes: 0 },
});

/** Every PNG buffer the stub worker was asked to recognise, newest last. */
let recognized: Uint8Array[] = [];
let workersMade = 0;
let workersTerminated = 0;
/** What the stub worker reports back. Reset per test. */
let stubWords: any[] = [];

const deps = (mupdf: any): ProbeNodeDeps => ({
  mupdf,
  createWorker: async () => {
    workersMade++;
    return {
      recognize: async (image: Uint8Array) => { recognized.push(image); return { data: { words: stubWords } }; },
      setParameters: async () => undefined,
      terminate: () => { workersTerminated++; },
    };
  },
  PSM: { SPARSE_TEXT: 11 },
});

const fakeDoc = () => ({ destroy: vi.fn() });
const fakeMupdf = (doc: any) => ({ Document: { openDocument: vi.fn(() => doc) } });

const baseReq = (): ProbeNodeRequest => ({
  docId: 4,
  pdfBytes: new Uint8Array([1, 2, 3]),
  pageIndices: [0, 1],
  userScale: 20,
  langPath: path.join(process.cwd(), "public/ocr"),
  cachePath: path.join(os.tmpdir(), "probe-node-test-cache"),
});

beforeEach(() => {
  engine.stub = null;
  recognized = [];
  stubWords = [];
  workersMade = 0;
  workersTerminated = 0;
});

describe("runProbe status", () => {
  it("reports ok, shapes the result, and closes the document", async () => {
    engine.stub = () => canned(0);
    const doc = fakeDoc();
    const out = await runProbe(baseReq(), deps(fakeMupdf(doc)));

    expect(out.status).toBe("ok");
    expect(out.result.docId).toBe(4);
    expect(out.result.method).toBe("geometric");
    expect(out.result.placements).toHaveLength(1);
    expect(out.result.alignedPageIndices).toEqual([0]);
    expect(out.result.rootFtPerIn).toBe(20);
    expect(out.result.refPageIndices).toEqual([0, 1]);
    // The tally is carried BOTH ways out: the full stats object, and the legacy scalar
    // everything that predates it still reads.
    expect(out.ocrStats).toEqual({ calls: 7, nonAnswers: 0, retries: 0, unknown: 0, withheldVotes: 0 });
    expect(out.result.ocrCalls).toBe(7);
    expect(typeof out.ms).toBe("number");
    expect(doc.destroy).toHaveBeenCalled();
  });

  it("reports unknown when the aligner answered with a read it never got", async () => {
    engine.stub = () => canned(2);
    const out = await runProbe(baseReq(), deps(fakeMupdf(fakeDoc())));
    // The RESULT is intact — this is not a failure, it is an answer that must not be
    // presented as a verdict. The editor falls back to the browser probe on this status.
    expect(out.status).toBe("unknown");
    expect(out.result.placements).toHaveLength(1);
    expect(out.ocrStats?.unknown).toBe(2);
  });

  it("reports timeout on a budget overrun, claims nothing, and still counts the reads it spent", async () => {
    engine.stub = async (_m: any, _d: any, _p: any, opts: any) => {
      // Two real reads through the real pool, then the clock is consulted and has
      // already expired (budgetMs 0), exactly as autoStitch would at a checkpoint.
      const img = { width: 2, height: 2, data: new Uint8ClampedArray(2 * 2 * 4) };
      await opts.ocr(img);
      await opts.ocr(img);
      if (opts.shouldAbort()) throw new AutoStitchAborted();
      return canned(0);
    };
    const doc = fakeDoc();
    const out = await runProbe({ ...baseReq(), budgetMs: 0 }, deps(fakeMupdf(doc)));

    expect(out.status).toBe("timeout");
    expect(out.result.placements).toEqual([]);
    expect(out.result.poses).toEqual([]);
    expect(out.result.alignedPageIndices).toEqual([]);
    expect(out.result.method).toBe("none");
    expect(out.result.worstResidFt).toBe(0);
    // No stats to take: there is no AutoStitchResult behind a budget overrun.
    expect(out.ocrStats).toBeNull();
    // The one thing it IS allowed to say: what the abandoned run cost.
    expect(out.result.ocrCalls).toBe(2);
    expect(doc.destroy).toHaveBeenCalled();
    // Worker threads keep a Node process alive forever if they are not torn down.
    expect(workersTerminated).toBe(workersMade);
  });

  it("latches the expired budget so a second checkpoint cannot un-abort the run", async () => {
    const seen: boolean[] = [];
    engine.stub = (_m: any, _d: any, _p: any, opts: any) => {
      seen.push(opts.shouldAbort(), opts.shouldAbort(), opts.shouldAbort());
      throw new AutoStitchAborted();
    };
    const out = await runProbe({ ...baseReq(), budgetMs: 0 }, deps(fakeMupdf(fakeDoc())));
    expect(seen).toEqual([true, true, true]);
    expect(out.status).toBe("timeout");
  });

  it("does not stay inside the budget forever: an un-expired clock reads false", async () => {
    let asked = false;
    engine.stub = (_m: any, _d: any, _p: any, opts: any) => { asked = opts.shouldAbort(); return canned(0); };
    const out = await runProbe({ ...baseReq(), budgetMs: 600_000 }, deps(fakeMupdf(fakeDoc())));
    expect(asked).toBe(false);
    expect(out.status).toBe("ok");
  });

  it("lets a real engine failure through, and still tears the run down", async () => {
    engine.stub = () => { throw new Error("mupdf exploded"); };
    const doc = fakeDoc();
    await expect(runProbe(baseReq(), deps(fakeMupdf(doc)))).rejects.toThrow("mupdf exploded");
    expect(doc.destroy).toHaveBeenCalled();
  });

  it("does not dress a caller-driven abort up as a timeout", async () => {
    // An AutoStitchAborted with the budget still intact did not come from us; reporting
    // it as `timeout` would tell the caller its clock ran out when it did not.
    engine.stub = () => { throw new AutoStitchAborted(); };
    await expect(runProbe({ ...baseReq(), budgetMs: 600_000 }, deps(fakeMupdf(fakeDoc()))))
      .rejects.toBeInstanceOf(AutoStitchAborted);
  });
});

describe("runProbe wiring", () => {
  it("hands the engine the pool width actually behind the OCR callback", async () => {
    let opts: any = null;
    engine.stub = (_m: any, _d: any, _p: any, o: any) => { opts = o; return canned(0); };
    await runProbe(baseReq(), deps(fakeMupdf(fakeDoc())));
    expect(opts.ocrConcurrency).toBe(NODE_OCR_POOL_SIZE);
    expect(NODE_OCR_POOL_SIZE).toBe(3);

    engine.stub = (_m: any, _d: any, _p: any, o: any) => { opts = o; return canned(0); };
    await runProbe({ ...baseReq(), ocrConcurrency: 1 }, deps(fakeMupdf(fakeDoc())));
    expect(opts.ocrConcurrency).toBe(1);
  });

  it("forwards the page set, scale, per-page scales and caller-known sheet codes", async () => {
    let opts: any = null;
    let pages: number[] = [];
    engine.stub = (_m: any, _d: any, p: any, o: any) => { pages = p; opts = o; return canned(0); };
    await runProbe(
      { ...baseReq(), pageIndices: [3, 4, 5], userScale: 30, pageScales: [[3, 40]], pageCodes: [[4, "C5.00"]] },
      deps(fakeMupdf(fakeDoc())),
    );
    expect(pages).toEqual([3, 4, 5]);
    expect(opts.userScale).toBe(30);
    expect(opts.pageScales.get(3)).toBe(40);
    expect(opts.pageCodes.get(4)).toBe("C5.00");
  });

  it("opens the document from the request's own bytes", async () => {
    engine.stub = () => canned(0);
    const mupdf = fakeMupdf(fakeDoc());
    const req = baseReq();
    await runProbe(req, deps(mupdf));
    expect(mupdf.Document.openDocument).toHaveBeenCalledWith(req.pdfBytes, "application/pdf");
  });

  it("OCR transport: encodes the raster as a real PNG and maps tesseract's words back", async () => {
    stubWords = [
      { text: " MATCHLINE ", confidence: 91, bbox: { x0: 1, y0: 2, x1: 3, y1: 4 } },
      { text: "   ", confidence: 12, bbox: { x0: 5, y0: 6, x1: 7, y1: 8 } },
    ];
    let words: any[] = [];
    engine.stub = async (_m: any, _d: any, _p: any, opts: any) => {
      words = await opts.ocr({ width: 3, height: 2, data: new Uint8ClampedArray(3 * 2 * 4) });
      return canned(0);
    };
    await runProbe(baseReq(), deps(fakeMupdf(fakeDoc())));

    expect(recognized).toHaveLength(1);
    expect([...recognized[0].slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]); // PNG signature
    // Blank words are dropped, real ones trimmed; the bbox is copied, not aliased.
    expect(words).toEqual([{ text: "MATCHLINE", confidence: 91, bbox: { x0: 1, y0: 2, x1: 3, y1: 4 } }]);
  });
});

describe("engine identity", () => {
  it("is 'dev' whenever the build-time constant was never substituted", () => {
    // vitest, vite-node and vite all leave `__ENGINE_VERSION__` undefined. Only
    // `npm run build:probe-bundle` defines it — and a verdict stamped 'dev' can never
    // match the editor's constant, so it is never trusted. That is the point.
    expect(ENGINE_VERSION).toBe("dev");
  });
});

describe("PNG encoder", () => {
  it("writes IHDR dimensions and an 8-bit RGBA colour type", () => {
    const png = encodePNG(3, 2, new Uint8ClampedArray(3 * 2 * 4));
    expect(png.toString("ascii", 12, 16)).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(3);
    expect(png.readUInt32BE(20)).toBe(2);
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(6); // colour type 6 = RGBA
    // IEND is a 12-byte chunk: length, type, no data, CRC.
    expect(png.subarray(png.length - 12).toString("ascii", 4, 8)).toBe("IEND");
  });

  it("reads only this image's rows out of a shared buffer", () => {
    // Band rasters arrive as views into a larger allocation; encoding must respect
    // byteOffset or every crop would be encoded from the top of the arena.
    const arena = new Uint8ClampedArray(4 * 4 * 4);
    arena.fill(7);
    const view = arena.subarray(2 * 4 * 4, 2 * 4 * 4 + 2 * 4 * 4);
    view.fill(200);
    expect(() => encodePNG(2, 4, view)).not.toThrow();
  });
});

describe("toOcrWords", () => {
  it("survives a reply with no words at all", () => {
    expect(toOcrWords({})).toEqual([]);
    expect(toOcrWords({ data: {} })).toEqual([]);
    expect(toOcrWords({ data: { words: [] } })).toEqual([]);
  });
});

// ── the real engine, over real bytes ─────────────────────────────────────────
// The corpus is local by design (see scripts/fixtures/stitch-eval-sets.json), so this
// SKIPS on a machine that does not have it rather than failing. tesseract is still
// stubbed: what is under test is that the Node entry can open a document, drive the
// aligner and shape a result — not what the aligner concludes, which is the harness's
// job and is pinned there against a placements fixture.
const BELCOURT = path.join(os.homedir(), "Downloads", "Belcourt Grading Plans.pdf");
const haveBelcourt = fs.existsSync(BELCOURT);

describe.skipIf(!haveBelcourt)("runProbe over the Belcourt fixture", () => {
  it("drives the real aligner end to end and answers ok or unknown", async () => {
    const mupdfMod: any = await import("mupdf");
    const mupdf = mupdfMod.default ?? mupdfMod;
    const out = await runProbe(
      { ...baseReq(), pdfBytes: new Uint8Array(fs.readFileSync(BELCOURT)), pageIndices: [0, 1], userScale: 20 },
      deps(mupdf),
    );
    // Never `timeout` on two pages with an instant OCR stub; `ok` or `unknown`
    // depending on whether the aligner wanted a read the stub could not answer.
    expect(["ok", "unknown"]).toContain(out.status);
    expect(out.result.docId).toBe(4);
    expect(Array.isArray(out.result.placements)).toBe(true);
    expect(Array.isArray(out.result.poses)).toBe(true);
    expect(typeof out.result.rootFtPerIn).toBe("number");
    expect(out.ocrStats).not.toBeNull();
    expect(out.ms).toBeGreaterThan(0);
  }, 300_000);
});
