/**
 * The auto-align probe, as a plain-Node entry point.
 *
 * ONE Node path. Three callers now drive the aligner outside the browser — the
 * regression harness (`scripts/stitch-eval.mjs`), the diag harness, and the AWS
 * Lambda that pre-computes a verdict server-side — and until this file existed the
 * first of them owned the only Node OCR transport in the tree: a tesseract pool, a
 * PNG encoder and a result-shaping step living inside a `.mjs` script. A Lambda
 * built from a COPY of that would answer the same question with different code, and
 * the whole point of the server probe is that its verdict is interchangeable with the
 * browser's. So the transport moved here, the harness imports it, and the Lambda
 * bundles it (`npm run build:probe-bundle` → `dist-probe/probe-engine.mjs`).
 *
 * What is NOT here: mupdf and tesseract.js. Both are INJECTED (`deps`), for the same
 * reason `autoStitch` takes `mupdf` as an argument — the Lambda image, the harness and
 * a test each resolve them differently (and a test resolves neither). That also keeps
 * the esbuild bundle import-free: every heavy dependency crosses the boundary as an
 * argument, not as a module specifier the Lambda's node_modules has to satisfy.
 *
 * Browser-safe? No — `node:zlib` and `Buffer`. Nothing under `src/` that ships to the
 * browser may import this file; the browser's transport is `ocrService.ts`.
 */
import * as zlib from "node:zlib";

import { autoStitch, AutoStitchAborted, type OcrStats } from "./autoStitch";
import { createOcrPool, OCR_NO_RESULT, type OcrPool } from "./ocrPool";
import { toProbeResult, type ProbeRequest, type ProbeResult } from "./stitchProbe";
import type { OcrWord, RawImage } from "./ocrService";

export { OCR_NO_RESULT };

/**
 * The nanodoc commit this engine was built from, replaced at bundle time by
 * `scripts/build-probe-bundle.mjs` (`define: { __ENGINE_VERSION__: "<git short hash>" }`)
 * and written alongside the bundle as `dist-probe/ENGINE_VERSION`.
 *
 * `"dev"` when the identifier was never substituted — i.e. every non-bundled run
 * (vite-node, vitest, the diag harness). A server verdict stamped `"dev"` can never
 * match the editor's own constant, which is exactly the desired outcome: a verdict
 * from an unversioned build is not interchangeable and must not be trusted.
 */
export const ENGINE_VERSION: string =
  typeof __ENGINE_VERSION__ !== "undefined" && __ENGINE_VERSION__ ? __ENGINE_VERSION__ : "dev";

/** Workers in the Node pool. Three, everywhere — see `ocrPool.ts`'s ceiling note: it is
 *  the width every probe timing was measured at, and the harness's placements fixture was
 *  recorded at. The browser sizes off `navigator.hardwareConcurrency`; a headless run has
 *  no business inheriting a number that describes the machine instead of the pool. */
export const NODE_OCR_POOL_SIZE = 3;

/** Per-job OCR budget, measured from DISPATCH (see `ocrPool.ts`). A job that blows it is a
 *  NON-ANSWER, not an empty sheet: `onNoResult` fires and the aligner re-reads the band as
 *  sub-clips. Same 20 s the harness has always used, and the same the Lambda runs. */
export const OCR_JOB_TIMEOUT_MS = 20_000;

/** Whole-probe budget. The Lambda's own timeout is 300 s, so the engine must give up
 *  first and hand back a `status: "timeout"` row rather than being killed mid-write. */
export const DEFAULT_PROBE_BUDGET_MS = 240_000;

// ── PNG encode (RGBA 8-bit) ──────────────────────────────────────────────────
// tesseract wants a well-formed buffer, and this is the whole encoder: signature,
// IHDR (8-bit, colour-type 6 = RGBA), one filter-type-0 byte per scanline, one
// deflated IDAT, IEND. Zero dependencies beyond core `zlib`/`Buffer`, which is why
// it can sit in a Lambda image with no native image library at all.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
export function encodePNG(width: number, height: number, rgba: Uint8ClampedArray | Uint8Array): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

// ── the tesseract shapes this file needs, and nothing more ───────────────────
/** One word as tesseract reports it. `bbox` is already `{x0,y0,x1,y1}` in image px. */
export interface RawTesseractWord {
  text?: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}
export interface TesseractRecognizeResult {
  data?: { words?: RawTesseractWord[] };
}
/** Structural subset of a tesseract.js worker — `recognize`/`setParameters`/`terminate`. */
export interface TesseractLikeWorker {
  recognize(image: Uint8Array): Promise<TesseractRecognizeResult>;
  setParameters(params: Record<string, unknown>): Promise<unknown>;
  terminate(): unknown;
}

/**
 * What the caller resolves for us. `mupdf` and `createWorker`/`PSM` are the two
 * heavyweight resolutions that differ per environment, so they are arguments.
 *
 * `createWorker` and `PSM` are typed loosely on purpose: the real
 * `tesseract.js` declarations use numeric enums for `oem`/`PSM`, and pinning them
 * here would make the genuine `createWorker` fail to satisfy this interface for
 * reasons that have nothing to do with whether it works.
 */
export interface ProbeNodeDeps {
  /** The mupdf module (`(await import("mupdf")).default`). Passed straight to `autoStitch`. */
  mupdf: any;
  /** `tesseract.js`'s `createWorker`. */
  createWorker: (...args: any[]) => Promise<TesseractLikeWorker>;
  /** `tesseract.js`'s `PSM` enum — only `SPARSE_TEXT` is read. */
  PSM: { SPARSE_TEXT: unknown };
}

export type ProbeStatus = "ok" | "unknown" | "timeout";

export interface ProbeNodeRequest extends ProbeRequest {
  /** Directory holding `eng.traineddata.gz` (the repo's `public/ocr`). */
  langPath: string;
  /** Writable directory tesseract caches the unpacked traineddata in. */
  cachePath: string;
  /** Pool width, and the width `autoStitch` batches its band reads at. Default 3. */
  ocrConcurrency?: number;
  /** Whole-probe budget. Default `DEFAULT_PROBE_BUDGET_MS`. */
  budgetMs?: number;
  /** Diagnostic sink. Never `console` here: a Lambda's stdout is its log. */
  log?: (s: string) => void;
}

export interface ProbeOutcome {
  result: ProbeResult;
  /** `autoStitch`'s own OCR tally, or `null` on a budget overrun (there is no result to take it from). */
  ocrStats: OcrStats | null;
  ms: number;
  /**
   * `"ok"`      the aligner answered with every read it wanted.
   * `"unknown"` it answered, but `ocrStats.unknown > 0` — it reached that answer with a
   *             hole in the evidence, so the answer is NOT a verdict and the editor runs
   *             the browser probe instead (same rule `useEarnedAutoAlign` applies).
   * `"timeout"` `budgetMs` expired; `result` carries only what is safe to state.
   */
  status: ProbeStatus;
}

export interface NodeOcrPoolOptions {
  createWorker: ProbeNodeDeps["createWorker"];
  PSM: ProbeNodeDeps["PSM"];
  langPath: string;
  cachePath: string;
  /** Default `NODE_OCR_POOL_SIZE`. */
  size?: number;
  /** Fired when a job blows `OCR_JOB_TIMEOUT_MS` and its worker is retired. Must not throw. */
  onTimeout?: () => void;
}

/**
 * The Node OCR pool: the SAME production `createOcrPool` the browser service drives,
 * with tesseract.js wired in behind it. Everything tesseract-specific — `langPath`,
 * `gzip`, `cachePath`, `PSM.SPARSE_TEXT` — lives here and nowhere else.
 *
 * Workers boot lazily inside the pool, so building one costs nothing until the first
 * read: a fully cache-warm harness run never loads tesseract at all.
 */
export function createNodeOcrPool(opts: NodeOcrPoolOptions): OcrPool<Uint8Array, TesseractRecognizeResult> {
  const { createWorker, PSM, langPath, cachePath, size = NODE_OCR_POOL_SIZE, onTimeout } = opts;
  return createOcrPool<Uint8Array, TesseractRecognizeResult>({
    size,
    createWorker: async () => {
      const w = await createWorker("eng", 1, { langPath, gzip: true, cachePath });
      // A worker that cannot take the page-seg mode is not usable: fail the creation
      // rather than hand the pool a worker running the WRONG segmentation, which would
      // read title cells as paragraphs and change answers silently.
      try { await w.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT }); }
      catch (err) { try { await w.terminate(); } catch { /* ignore */ } throw err; }
      return w;
    },
    timeoutMs: () => OCR_JOB_TIMEOUT_MS,
    onTimeout,
  });
}

/** tesseract's words → the aligner's `OcrWord[]`. Blank/whitespace-only words are dropped:
 *  they carry a bbox and no identity, and every consumer downstream trims anyway. */
export function toOcrWords(res: TesseractRecognizeResult): OcrWord[] {
  const words: OcrWord[] = [];
  for (const wd of res.data?.words ?? []) {
    if (wd.text?.trim()) words.push({ text: wd.text.trim(), confidence: wd.confidence, bbox: { ...wd.bbox } });
  }
  return words;
}

/**
 * What a budget overrun is allowed to claim: nothing.
 *
 * A `ProbeResult` is a required-field shape, so a timeout still has to produce one —
 * but every field that could be read as a verdict is stated at its empty value
 * (`method: "none"`, no placements, no poses, no aligned pages). The only real
 * information carried out is `ocrCalls`, because "we spent N reads getting nowhere" is
 * worth recording. Consumers gate on `status`, never on this shape.
 */
function abandonedResult(req: ProbeNodeRequest, ocrCalls: number): ProbeResult {
  return {
    docId: req.docId,
    placements: [],
    method: "none",
    alignedPageIndices: [],
    worstResidFt: 0,
    // Not a measurement — the run never got far enough to solve a root scale. It is the
    // scale we were ASKED for, which is the only honest number available here.
    rootFtPerIn: req.userScale ?? 0,
    poses: [],
    refPageIndices: [],
    ocrCalls,
  };
}

/**
 * Run one probe over `req.pdfBytes` and report what it found.
 *
 * Identical engine, identical options, identical pool width as the browser probe —
 * that is the contract the server verdict rests on. The two differences are both
 * environmental: the OCR transport is tesseract.js-in-process rather than an RPC to the
 * main thread, and the abort is a clock rather than a user click.
 *
 * Throws only what the engine throws (a corrupt PDF, a mupdf failure). An abort caused
 * by our OWN budget is not a throw — it comes back as `status: "timeout"`.
 */
export async function runProbe(req: ProbeNodeRequest, deps: ProbeNodeDeps): Promise<ProbeOutcome> {
  const t0 = Date.now();
  const budgetMs = req.budgetMs ?? DEFAULT_PROBE_BUDGET_MS;
  const size = req.ocrConcurrency ?? NODE_OCR_POOL_SIZE;
  const log = req.log ?? (() => { /* silent by default */ });
  /** Set by `shouldAbort`, read by the catch: it is what tells an `AutoStitchAborted`
   *  apart from one a future caller-supplied abort might raise. */
  let timedOut = false;
  /** Reads ISSUED. `autoStitch`'s own `ocrStats.calls` supersedes this on every path
   *  that produces a result; this tally exists for the path that does not. */
  let ocrCalls = 0;

  const pool = createNodeOcrPool({
    createWorker: deps.createWorker,
    PSM: deps.PSM,
    langPath: req.langPath,
    cachePath: req.cachePath,
    size,
    onTimeout: () => log("[probe] OCR job blew its 20 s budget — retiring that worker"),
  });

  const ocr = async (
    image: RawImage,
    opts?: { signal?: AbortSignal; onNoResult?: () => void },
  ): Promise<OcrWord[]> => {
    ocrCalls++;
    const res = await pool.run(encodePNG(image.width, image.height, image.data), { signal: opts?.signal });
    // A non-answer is not an empty sheet. Say so, so the aligner re-reads the band as
    // sub-clips instead of concluding the band holds no text — collapsing the two is
    // the exact non-determinism the `unknown` status exists to surface.
    if (res === OCR_NO_RESULT) { opts?.onNoResult?.(); return []; }
    return toOcrWords(res);
  };

  // Checked at every `autoStitch` checkpoint. Latching `timedOut` matters: the engine
  // consults this many times on its way out, and a clock that reads false again after
  // reading true would let the run resume.
  const shouldAbort = (): boolean => {
    if (timedOut) return true;
    if (Date.now() - t0 >= budgetMs) {
      timedOut = true;
      log(`[probe] budget of ${budgetMs} ms expired — abandoning this probe`);
      return true;
    }
    return false;
  };

  const doc = deps.mupdf.Document.openDocument(req.pdfBytes, "application/pdf");
  try {
    const res = await autoStitch(deps.mupdf, doc, req.pageIndices, {
      userScale: req.userScale,
      pageScales: req.pageScales ? new Map(req.pageScales) : undefined,
      pageCodes: req.pageCodes ? new Map(req.pageCodes) : undefined,
      ocr,
      // The engine must batch its reciprocal strip scan to the pool ACTUALLY behind
      // `ocr`, not to a guess derived from the host's core count.
      ocrConcurrency: size,
      shouldAbort,
      onOcrStart: () => log("[probe] reading outlined text"),
    });
    const ocrStats = res.ocrStats ?? null;
    // `> 0` on a possibly-absent tally: `undefined > 0` and `NaN > 0` are both false, so
    // an unreported tally reads as "nobody told us", never as "unknown reads happened".
    const status: ProbeStatus = (ocrStats?.unknown ?? 0) > 0 ? "unknown" : "ok";
    return { result: toProbeResult(res, req.docId), ocrStats, ms: Date.now() - t0, status };
  } catch (err) {
    if (timedOut && err instanceof AutoStitchAborted) {
      return { result: abandonedResult(req, ocrCalls), ocrStats: null, ms: Date.now() - t0, status: "timeout" };
    }
    throw err;
  } finally {
    // Both unconditionally: a thrown probe still holds a mupdf document and up to three
    // tesseract worker threads, and an un-terminated worker keeps a Node event loop alive
    // forever (the harness learned this the hard way — see its `ensurePool` note).
    doc.destroy?.();
    await pool.terminate();
  }
}
