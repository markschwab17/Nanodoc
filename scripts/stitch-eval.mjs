/**
 * stitch-eval — regression gate for the auto-stitch solver over real PDFs.
 *
 * `stitch-diag` answers "what did the solver do on THIS file, in detail". This
 * answers the other question: "is the engine still as good as it was". It runs the
 * REAL `autoStitch` over the sets named in `scripts/fixtures/stitch-eval-sets.json`,
 * checks each against measured expectations (recall floor, false-pair ceiling,
 * honesty-verdict floor, worst cross-seam residual, suspect-seam count), prints one
 * table, and exits non-zero if any set regressed.
 *
 * Run:  npx vite-node scripts/stitch-eval.mjs [--manifest <path>] [--set <name>] [--json]
 *
 * NOT part of `npm test`: it needs local PDFs (the manifest points at ~/Downloads)
 * and takes ~1 minute warm, several minutes cold. Run it before merging anything
 * that touches `src/features/stitch/autostitch/`.
 *
 * OCR is cached by image-content hash in scratch-diag/ocr-cache.json — the same
 * cache stitch-diag uses, so the two share every result. Set
 * STITCH_EVAL_NO_OCR_CACHE=1 to bypass that cache (read AND write) for a cold,
 * cache-free timing run — every image is re-OCR'd and the cache file is untouched.
 *
 * FAULT INJECTION. This machine's tesseract has never once blown the 20 s job budget
 * (see the note by `ocr` below), so the corpus cannot reach the aligner's non-answer
 * paths on its own — and those paths are exactly the ones that make the BROWSER probe
 * answer differently on two runs of the same sheets. Two env switches make them
 * reachable here, where the answer can be diffed against a baseline:
 *
 *   STITCH_EVAL_FAULT_CALLS=3,7   those OCR reads return the pool's non-answer
 *                                 (`OCR_NO_RESULT`: `onNoResult` fires, `[]` comes
 *                                 back) WITHOUT running tesseract, exactly as a
 *                                 timed-out job does.
 *   STITCH_EVAL_LOG_OCR_CALLS=1   print every read's index and pixel size, which is
 *                                 how you pick the indices above.
 *
 * Indices are 0-based, count EVERY read the aligner makes (cache hits included — a
 * warm cache must not move them), and RESET PER SET, so `--set X FAULT_CALLS=3` means
 * the 4th read of set X whichever other sets ran. A retry re-reads the same clip as a
 * NEW index, so faulting index N exercises the retry without faulting the retry too.
 *
 * The bar: every faulted run must produce the SAME placements and the SAME verdict as
 * the un-faulted one. A difference is a real non-determinism, not a harness artefact.
 *
 * PLACEMENTS SNAPSHOT. That bar used to be enforced by eye — the expectations below
 * bind recall, verdict, residual and suspect count, and none of them moved when a lost
 * OCR read slid a Belcourt sheet 39 ft along its matchline (fault case F5). The
 * placements are the only thing that catches it, so they are now a tracked fixture:
 *
 *   STITCH_EVAL_ASSERT_PLACEMENTS=<path.json>  every set's placements must match the
 *                                              file to 0.01 pt; a difference, a
 *                                              missing set and an unexpected unit are
 *                                              all REGRESSIONS (non-zero exit).
 *   STITCH_EVAL_WRITE_PLACEMENTS=<path.json>   write them instead — how the fixture is
 *                                              made, and how it is deliberately moved
 *                                              when an engine change is meant to move
 *                                              an answer. Merges: sets not in this run
 *                                              keep whatever the file already said.
 *
 * `npm run stitch-eval:check` is this harness with the assert pointed at the tracked
 * `scripts/fixtures/stitch-eval-placements.json`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";

const REPO = process.cwd();
const argv = process.argv.slice(2);
const argOf = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };
const MANIFEST = argOf("--manifest", path.join(REPO, "scripts/fixtures/stitch-eval-sets.json"));
const ONLY = argOf("--set", null);
const AS_JSON = argv.includes("--json");
const round2 = (n) => Math.round(n * 100) / 100;

const expandHome = (p) => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);
function parseRanges(s) {
  const out = [];
  for (const part of String(s).split(",")) {
    const m = part.split("-").map(Number);
    if (m.length === 2) { for (let i = m[0]; i <= m[1]; i++) out.push(i); }
    else out.push(m[0]);
  }
  return out;
}

// ── PNG encode (RGBA 8-bit) — tesseract wants a well-formed buffer ───────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(width, height, rgba) {
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

// ── OCR (tesseract.js) with the shared disk cache ────────────────────────────
// Recognition runs through the SAME pool the app uses (ocrPool.ts) — FIFO queue,
// per-job timeout measured from dispatch, one worker retired on a hang — so the
// harness exercises the production queueing code rather than a private copy of
// it. Three workers here (the app sizes its pool off hardwareConcurrency, which
// a headless run has no business inheriting).
// STITCH_EVAL_NO_OCR_CACHE=1 bypasses the cache entirely (read AND write) — every
// image is re-OCR'd fresh and scratch-diag/ocr-cache.json is left untouched. Used
// to take a cache-free timing baseline without clobbering the shared cache file
// that stitch-diag also reads.
const NO_OCR_CACHE = process.env.STITCH_EVAL_NO_OCR_CACHE === "1";
// See the header. `readIndex` counts every read of the CURRENT set (cache hits and
// faults included) so an index means the same read on a warm cache as on a cold one.
// The empty-string filter is load-bearing: `"".split(",")` is `[""]` and `Number("")`
// is 0, so without it an UNSET switch faulted read #0 of every set.
const FAULT_CALLS = new Set(
  String(process.env.STITCH_EVAL_FAULT_CALLS ?? "")
    .split(",").map((s) => s.trim()).filter((s) => s !== "")
    .map(Number).filter((n) => Number.isInteger(n) && n >= 0),
);
const LOG_OCR_CALLS = process.env.STITCH_EVAL_LOG_OCR_CALLS === "1";
const ASSERT_PLACEMENTS = process.env.STITCH_EVAL_ASSERT_PLACEMENTS || "";
const WRITE_PLACEMENTS = process.env.STITCH_EVAL_WRITE_PLACEMENTS || "";
let readIndex = 0, faultsFired = 0;
const CACHE_DIR = path.join(REPO, "scratch-diag");
const CACHE_FILE = path.join(CACHE_DIR, "ocr-cache.json");
fs.mkdirSync(CACHE_DIR, { recursive: true });
const cache = NO_OCR_CACHE ? {} : (fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) : {});
let cacheDirty = false, ocrCalls = 0, ocrHits = 0;
function hashImage(image) {
  const h = crypto.createHash("sha1");
  h.update(Buffer.from([image.width & 255, (image.width >> 8) & 255, image.height & 255, (image.height >> 8) & 255]));
  h.update(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength));
  return h.digest("hex");
}
const OCR_POOL_SIZE = 3;
const OCR_JOB_TIMEOUT_MS = 20_000;
let poolPromise = null, NO_RESULT = null;
/**
 * The pool, memoised as a PROMISE rather than as the resolved object.
 *
 * `if (pool) return pool` would be a check-then-await race: autoStitch issues a
 * whole page's band reads at once, so every one of them enters here before the
 * first `await import(...)` has resolved, every one builds its OWN pool with its
 * own three tesseract workers, and only the last assignment is ever terminated.
 * The orphaned worker threads then keep the event loop alive and the harness never
 * exits — the run itself finishes and prints, and the process just hangs.
 */
function ensurePool() {
  if (poolPromise) return poolPromise;
  // A FAILED build must not be memoised: caching a rejected promise would make
  // every later call rethrow the first boot error forever. Clear the memo so the
  // next caller retries (the pool itself has the same retry rule), while the
  // callers already holding this promise still see the real error.
  const built = (async () => {
    const { createOcrPool, OCR_NO_RESULT } = await import("../src/features/stitch/autostitch/ocrPool.ts");
    const { createWorker, PSM } = await import("tesseract.js");
    NO_RESULT = OCR_NO_RESULT;
    return createOcrPool({
      size: OCR_POOL_SIZE,
      createWorker: async () => {
        const w = await createWorker("eng", 1, { langPath: path.join(REPO, "public/ocr"), gzip: true, cachePath: path.join(CACHE_DIR, "tesscache") });
        try { await w.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT }); }
        catch (err) { try { await w.terminate(); } catch { /* ignore */ } throw err; }
        return w;
      },
      timeoutMs: () => OCR_JOB_TIMEOUT_MS,
      onTimeout: () => console.warn("[stitch-eval] OCR job timed out — retiring that worker"),
    });
  })();
  poolPromise = built;
  built.catch(() => { if (poolPromise === built) poolPromise = null; });
  return built;
}
async function ocr(image, opts) {
  const idx = readIndex++;
  if (LOG_OCR_CALLS) console.log(`[ocr] #${idx} ${image.width}x${image.height}`);
  // Injected non-answer. Ahead of the cache on purpose: a fault has to fire whether or
  // not this raster has been read before, or a warm cache would quietly disarm it. This
  // is byte-for-byte what the pool's OCR_NO_RESULT path does below — `onNoResult` fires
  // and the read comes back empty — which is what a 20 s job-budget expiry looks like
  // to the aligner.
  if (FAULT_CALLS.has(idx)) { faultsFired++; opts?.onNoResult?.(); return []; }
  const key = hashImage(image);
  if (!NO_OCR_CACHE && cache[key]) { ocrHits++; return cache[key]; }
  ocrCalls++;
  const p = await ensurePool();
  const res = await p.run(encodePNG(image.width, image.height, image.data));
  // A timed-out job is a non-answer, not an empty sheet — never cache it, and tell
  // the caller so it can re-read that band as sub-clips (`onNoResult`). This machine
  // has never actually produced one: the harness's tesseract finishes a 7200 px band
  // well inside the 20 s budget where the browser build does not, which is why the
  // corpus cannot exercise the retry and must come out bit-identical.
  if (res === NO_RESULT) { opts?.onNoResult?.(); return []; }
  const words = [];
  for (const wd of res.data.words ?? []) { if (wd.text?.trim()) words.push({ text: wd.text.trim(), confidence: wd.confidence, bbox: { ...wd.bbox } }); }
  if (!NO_OCR_CACHE) { cache[key] = words; cacheDirty = true; if (ocrCalls % 20 === 0) flushCache(); }
  return words;
}
const flushCache = () => { if (cacheDirty) { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); cacheDirty = false; } };

// ── ground-truth comparison ──────────────────────────────────────────────────
/**
 * Per-unit placement error against a hand-verified fixture, in feet.
 *
 * The fixture stores CANVAS POINTS (`ptPerFt`, at `rootFtPerIn`) and declares its
 * `originConvention` — always `"page"`: every entry, strips included, is where the
 * WHOLE PAGE's top-left corner belongs. A pose reports the origin of the FRAME it
 * anchors, which is the same point for a whole page and offset by the frame's own
 * origin for a strip, so a strip is converted to a page origin before comparing.
 * Skipping that conversion read PG_SITE's lower strip as 170.7 ft out when it is
 * 16.6 ft out — a 646 pt frame inset is 179 ft at 1"=20'. That ambiguity is what made
 * the strip numbers "indicative"; the fixture now states the convention, and this is
 * the only place that applies it.
 *
 * Strips are keyed PER PAGE — `<pageIndex>s<n>`, numbered from 1 in ascending frame
 * order — so a second split page cannot collide with the first. A layout has no
 * absolute origin, so fixture and solve are aligned by the MEDIAN delta before
 * comparing: robust, and it does not let one badly-placed sheet (which is exactly what
 * we are looking for) drag the whole comparison. Units the fixture does not name are
 * skipped; fixture keys that matched NOTHING are reported, so a renamed key cannot
 * quietly turn the comparison into a no-op.
 */
function groundTruthErrors(res, gt) {
  const PT_PER_FT = gt.ptPerFt ?? 3.6;
  const pos = gt.positions ?? {};
  if (gt.originConvention && gt.originConvention !== "page") {
    throw new Error(`ground truth: unsupported originConvention "${gt.originConvention}" (only "page" is implemented)`);
  }
  // Strip ordinals, per page, top strip first.
  const stripOrdinal = new Map();
  const byPage = new Map();
  for (const p of res.poses) {
    if (!p.frame || !p.posFt) continue;
    if (!byPage.has(p.pageIndex)) byPage.set(p.pageIndex, []);
    byPage.get(p.pageIndex).push(p);
  }
  for (const list of byPage.values()) {
    list.sort((a, b) => a.frame[1] - b.frame[1] || a.frame[0] - b.frame[0]);
    list.forEach((p, i) => stripOrdinal.set(p, i + 1));
  }
  const rows = [];
  const unmatched = new Set(Object.keys(pos));
  for (const p of res.poses) {
    if (!p.posFt) continue;
    const key = p.frame ? `${p.pageIndex}s${stripOrdinal.get(p)}` : String(p.pageIndex);
    const g = pos[key];
    if (!Array.isArray(g)) continue;
    unmatched.delete(key);
    // Frame origin → page origin, using the same canvas-pt-per-page-pt factor
    // `layoutPlacements` applies when it subtracts a frame offset.
    const si = res.rootFtPerIn ? p.scale / res.rootFtPerIn : 1;
    const fx = p.frame ? p.frame[0] * si : 0;
    const fy = p.frame ? p.frame[1] * si : 0;
    rows.push({
      key, pageIndex: p.pageIndex,
      dx: p.posFt.x * PT_PER_FT - fx - g[0],
      dy: p.posFt.y * PT_PER_FT - fy - g[1],
    });
  }
  const rootMismatch =
    gt.rootFtPerIn != null && res.rootFtPerIn != null && gt.rootFtPerIn !== res.rootFtPerIn
      ? `fixture is at rootFtPerIn ${gt.rootFtPerIn}, solve ran at ${res.rootFtPerIn}`
      : null;
  const extra = { unmatched: [...unmatched], rootMismatch };
  if (rows.length < 2) return { rows: [], medianFt: 0, p95Ft: 0, ...extra };
  const med = (xs) => { const a = [...xs].sort((u, v) => u - v); return a[Math.floor(a.length / 2)]; };
  const ox = med(rows.map((r) => r.dx)), oy = med(rows.map((r) => r.dy));
  for (const r of rows) r.errFt = Math.hypot(r.dx - ox, r.dy - oy) / PT_PER_FT;
  const errs = rows.map((r) => r.errFt).sort((a, b) => a - b);
  return {
    rows: rows.sort((a, b) => a.pageIndex - b.pageIndex || a.key.localeCompare(b.key)),
    medianFt: errs[Math.floor(errs.length / 2)],
    p95Ft: errs[Math.min(errs.length - 1, Math.ceil(0.95 * errs.length) - 1)],
    ...extra,
  };
}

// ── placements snapshot ──────────────────────────────────────────────────────
/**
 * One key per PLACED UNIT, in placement order. Normally that is just the page index —
 * but a page split at its own matchline commits TWICE (PG_SITE's page 1 is two strips),
 * and keying those on the bare index would silently drop one of the two and check the
 * other twice. The second and later occurrences get `#2`, `#3`, so the common case
 * reads exactly as "page 4 is here" and the split case still has both halves bound.
 */
function placementKeys(placements) {
  const seen = new Map();
  return placements.map((p) => {
    const n = (seen.get(p.pageIndex) ?? 0) + 1;
    seen.set(p.pageIndex, n);
    return n === 1 ? String(p.pageIndex) : `${p.pageIndex}#${n}`;
  });
}
const placementSnapshot = (placements) => {
  const keys = placementKeys(placements);
  const out = {};
  placements.forEach((p, i) => { out[keys[i]] = { x: p.x, y: p.y, width: p.width, height: p.height }; });
  return out;
};
/** Differences against the fixture, in words a failure line can carry. Both sides are
 *  already rounded to 2 dp, so 0.01 pt is a tolerance for the rounding boundary, not a
 *  licence to move: a sheet that shifts is out by feet, not by hundredths of a point. */
function placementDiffs(expected, actual) {
  const out = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = actual[key];
    if (!got) { out.push(`placement ${key} is in the fixture but this run did not place it`); continue; }
    for (const field of ["x", "y", "width", "height"]) {
      const d = Math.abs(got[field] - want[field]);
      if (d > 0.01 + 1e-9) out.push(`placement ${key} moved — ${field} ${got[field]}, fixture says ${want[field]} (${d.toFixed(2)} pt out)`);
    }
  }
  for (const key of Object.keys(actual)) if (!expected[key]) out.push(`placement ${key} was placed but the fixture has no such unit`);
  return out;
}

const expectedPlacements = ASSERT_PLACEMENTS
  ? (() => {
      const abs = path.resolve(REPO, expandHome(ASSERT_PLACEMENTS));
      if (!fs.existsSync(abs)) { console.error(`STITCH_EVAL_ASSERT_PLACEMENTS: no such file: ${abs}`); process.exit(2); }
      return JSON.parse(fs.readFileSync(abs, "utf8"));
    })()
  : null;
const writtenPlacements = WRITE_PLACEMENTS ? {} : null;

// ── run ──────────────────────────────────────────────────────────────────────
const VERDICT_RANK = { unverified: 0, partial: 1, verified: 2 };

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
const sets = (manifest.sets ?? []).filter((s) => !ONLY || s.name === ONLY);
if (!sets.length) { console.error(`no sets in ${MANIFEST}${ONLY ? ` matching "${ONLY}"` : ""}`); process.exit(2); }

const mupdfMod = await import("mupdf");
const mupdf = mupdfMod.default ?? mupdfMod;
const { autoStitch } = await import("../src/features/stitch/autostitch/autoStitch.ts");

const rows = [];
for (const set of sets) {
  const pdf = expandHome(set.pdf);
  const row = { name: set.name, failures: [] };
  if (!fs.existsSync(pdf)) {
    // A missing local PDF is a SKIP, not a regression: the suite is meant to be
    // runnable on a machine that has only some of the corpus.
    row.skipped = `not found: ${pdf}`;
    rows.push(row);
    continue;
  }
  const bytes = fs.readFileSync(pdf);
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), "application/pdf");
  const t0 = Date.now();
  const before = ocrCalls;
  // Per-set, so a fault index names the same read whichever sets are in the run.
  readIndex = 0;
  const faultsBefore = faultsFired;
  // `ocrConcurrency` tells autoStitch how wide the transport behind `ocr` really is,
  // so its reciprocal strip scan batches to THIS pool rather than guessing. The
  // browser default derives from `navigator.hardwareConcurrency`, which Node only
  // exposes from v21 (this harness runs on v20, where it is undefined and the
  // derivation floors at 2) — and even on a newer Node it would describe the
  // machine, not the three workers built below. Passing the real size is the only
  // way the two agree.
  const res = await autoStitch(mupdf, doc, parseRanges(set.pages ?? "0-9"), { userScale: set.scale ?? 20, ocr, ocrConcurrency: OCR_POOL_SIZE });
  flushCache();
  row.seconds = (Date.now() - t0) / 1000;
  row.ocrCalls = ocrCalls - before;
  // What the OCR channel did, straight from the aligner (autoStitch's OcrStats): reads
  // made, reads the transport could not answer, re-read decisions, reads still unknown
  // after their retry, and side bands whose rotation vote was withheld. On a clean run
  // every one but `calls` is 0; anything else means this run reached its answer with a
  // hole in the evidence, and the answer must be read with that in mind.
  row.ocrStats = res.ocrStats ?? null;
  row.reads = readIndex;
  row.faults = faultsFired - faultsBefore;
  row.aligned = res.alignedCount;
  row.method = res.method;
  row.verdict = res.alignmentVerdict ?? "unverified";
  row.worstResidFt = res.worstResidFt;
  row.suspect = (res.seamReport ?? []).filter((s) => s.status === "suspect").length;
  row.seams = (res.seamReport ?? []).length;
  row.skippedSheets = (res.skipped ?? []).length;
  row.refPages = res.refPageIndices.length;
  // Rounded 2dp placements, in placement order — a stable, small snapshot a later
  // run can diff against without re-deriving it from `res.poses`.
  row.placements = res.placements.map((p) => ({
    pageIndex: p.pageIndex,
    x: round2(p.x),
    y: round2(p.y),
    width: round2(p.width),
    height: round2(p.height),
    aligned: p.aligned,
  }));
  // ALONG-anchored pages, and the placed pages that are NOT (they are connected but
  // free to slide along their seams, so the commit demotes them to unaligned).
  const placedPages = [...new Set(res.poses.filter((p) => p.posFt).map((p) => p.pageIndex))].sort((a, b) => a - b);
  const anchoredSet = new Set(res.alongAnchored ?? []);
  row.alongAnchored = res.alongAnchored ? [...anchoredSet].sort((a, b) => a - b) : null;
  row.demoted = res.alongAnchored ? placedPages.filter((p) => !anchoredSet.has(p)) : [];
  row.alongUncertaintyFt = res.worstAlongUncertaintyFt ?? 0;

  if (set.groundTruth) {
    const gtPath = expandHome(set.groundTruth);
    if (fs.existsSync(gtPath)) {
      const gt = groundTruthErrors(res, JSON.parse(fs.readFileSync(gtPath, "utf8")));
      row.gt = gt;
    } else {
      row.gtMissing = gtPath;
    }
  }

  const fail = (m) => row.failures.push(m);

  // The placements snapshot. A set the fixture does not mention is a FAILURE, not a
  // pass: the whole point is that every set in the run is bound, and "no expectation
  // for this one" is exactly how a silent no-op check looks from the outside.
  if (writtenPlacements) writtenPlacements[set.name] = placementSnapshot(row.placements);
  if (expectedPlacements) {
    const want = expectedPlacements[set.name];
    if (!want) fail(`no placements fixture entry for this set (${path.basename(ASSERT_PLACEMENTS)})`);
    else for (const d of placementDiffs(want, placementSnapshot(row.placements))) fail(d);
  }

  if (set.minAligned != null && row.aligned < set.minAligned) fail(`aligned ${row.aligned} < ${set.minAligned}`);
  if (set.maxAligned != null && row.aligned > set.maxAligned) fail(`aligned ${row.aligned} > ${set.maxAligned} (false pairs)`);
  if (set.verdictFloor != null && VERDICT_RANK[row.verdict] < VERDICT_RANK[set.verdictFloor]) fail(`verdict ${row.verdict} < ${set.verdictFloor}`);
  if (set.maxWorstResidFt != null && row.worstResidFt > set.maxWorstResidFt) fail(`worstResid ${row.worstResidFt} ft > ${set.maxWorstResidFt} ft`);
  if (set.maxSuspectSeams != null && row.suspect > set.maxSuspectSeams) fail(`${row.suspect} suspect seams > ${set.maxSuspectSeams}`);
  if (set.maxSeconds != null && row.seconds > set.maxSeconds) fail(`${row.seconds.toFixed(1)}s > ${set.maxSeconds}s`);
  // Ref-bearing pages: the difference between "these sheets don't share a matchline"
  // and "no callouts were found at all", which are very different things to be told.
  if (set.minRefPages != null && row.refPages < set.minRefPages) fail(`${row.refPages} ref-bearing pages < ${set.minRefPages}`);
  // GROUND TRUTH. The bar applies to the units the solver CLAIMS: an along-anchored
  // unit is offered as aligned, so it must actually be where it belongs. A unit that
  // is not along-anchored is demoted to unaligned by the commit, so a large error
  // there is reported, not failed — but it must never be claimed.
  if (row.gt?.rows.length) {
    row.gtWorstClaimed = 0;
    for (const r of row.gt.rows) {
      const claimed = row.alongAnchored == null || anchoredSet.has(r.pageIndex);
      if (!claimed) continue;
      if (r.errFt > row.gtWorstClaimed) row.gtWorstClaimed = r.errFt;
      if (set.maxTileErrorFt != null && r.errFt > set.maxTileErrorFt) {
        fail(`${r.key} is offered as aligned but sits ${r.errFt.toFixed(1)} ft from ground truth (> ${set.maxTileErrorFt} ft)`);
      }
    }
  }
  if (set.gtMedianCeilFt != null && row.gt && row.gt.medianFt > set.gtMedianCeilFt) {
    fail(`ground-truth median ${row.gt.medianFt.toFixed(1)} ft > ${set.gtMedianCeilFt} ft`);
  }
  // A fixture key that matched nothing is a REGRESSION, not a note. Either the solver
  // stopped placing that unit or the two sides disagree about how units are named, and
  // both silently turn the ground-truth check into a no-op that passes.
  if (row.gt?.unmatched?.length) fail(`ground-truth keys matched no placed unit: ${row.gt.unmatched.join(", ")}`);
  if (row.gt?.rootMismatch) fail(`ground-truth scale mismatch — ${row.gt.rootMismatch}`);
  rows.push(row);
}
flushCache();
if (writtenPlacements) {
  // MERGE, never replace: `--set X` with the write flag would otherwise wipe every
  // other set's baseline out of the fixture in one keystroke.
  const abs = path.resolve(REPO, expandHome(WRITE_PLACEMENTS));
  const prior = fs.existsSync(abs) ? JSON.parse(fs.readFileSync(abs, "utf8")) : {};
  const merged = { ...prior, ...writtenPlacements };
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(merged, null, 2) + "\n");
  const kept = Object.keys(prior).filter((k) => !(k in writtenPlacements));
  console.error(`wrote placements for ${Object.keys(writtenPlacements).length} set(s) to ${abs}` +
    (kept.length ? ` (kept ${kept.length} untouched: ${kept.join(", ")})` : ""));
}
// Teardown must not resurrect a boot failure as the script's exit status: the run
// itself already reported whatever that failure did to the results.
const builtPool = poolPromise ? await poolPromise.catch(() => null) : null;
if (builtPool) await builtPool.terminate();

if (AS_JSON) {
  console.log(JSON.stringify({ manifest: MANIFEST, rows }, null, 2));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  const NAMEW = 32;
  console.log(`\nstitch-eval · ${MANIFEST}\n`);
  // `ocr` is tesseract MISSES (a warm cache reads 0); `calls/na/rt/unk/wh` is what the
  // aligner's own OCR channel did — see OcrStats. The two answer different questions:
  // the first is "what did this run cost", the second "what did this run not know".
  const statsCell = (s) => (s ? `${s.calls}/${s.nonAnswers}/${s.retries}/${s.unknown}/${s.withheldVotes}` : "—");
  console.log(`${pad("set", NAMEW)}${pad("aligned", 9)}${pad("method", 11)}${pad("verdict", 12)}${pad("worstResid", 12)}${pad("suspect", 9)}${pad("skipped", 9)}${pad("refPg", 7)}${pad("ocr", 6)}${pad("calls/na/rt/unk/wh", 20)}time`);
  console.log("-".repeat(130));
  for (const r of rows) {
    if (r.skipped) { console.log(`${pad(r.name, NAMEW)}SKIPPED — ${r.skipped}`); continue; }
    console.log(
      `${pad(r.name, NAMEW)}${pad(r.aligned, 9)}${pad(r.method, 11)}${pad(r.verdict, 12)}` +
      `${pad(`${r.worstResidFt.toFixed(2)} ft`, 12)}${pad(`${r.suspect}/${r.seams}`, 9)}${pad(r.skippedSheets, 9)}${pad(r.refPages, 7)}${pad(r.ocrCalls, 6)}` +
      `${pad(statsCell(r.ocrStats), 20)}${r.seconds.toFixed(1)}s`,
    );
  }
  if (FAULT_CALLS.size) {
    const asked = [...FAULT_CALLS].sort((a, b) => a - b).join(",");
    console.log(`\nFAULTS INJECTED at read ${asked} of each set: ` +
      rows.filter((r) => !r.skipped).map((r) => `${r.name} ${r.faults}/${r.reads} reads`).join("; "));
  }
  console.log("");
  for (const r of rows) {
    if (r.skipped) continue;
    if (r.alongAnchored) {
      console.log(`${r.name}: along-anchored pages [${r.alongAnchored.map((p) => p + 1).join(",") || "—"}]` +
        (r.demoted.length ? `; demoted (placed, free to slide ±${Math.round(r.alongUncertaintyFt)} ft) [${r.demoted.map((p) => p + 1).join(",")}]` : ""));
    }
    if (r.gtMissing) console.log(`${r.name}: ground truth not found (${r.gtMissing})`);
    if (r.gt?.rows.length) {
      console.log(`${r.name}: ground-truth error median ${r.gt.medianFt.toFixed(1)} ft, 95p ${r.gt.p95Ft.toFixed(1)} ft` +
        (r.gtWorstClaimed != null ? `, worst CLAIMED ${r.gtWorstClaimed.toFixed(1)} ft` : ""));
      console.log(`    ${r.gt.rows.map((x) => `${x.key}:${x.errFt.toFixed(1)}`).join("  ")}`);
    }
  }
  console.log("");
  for (const r of rows) for (const f of r.failures) console.log(`REGRESSION · ${r.name}: ${f}`);
}

const regressed = rows.some((r) => r.failures.length);
if (!AS_JSON) console.log(regressed ? "\nFAIL — see the regressions above." : "\nOK — every set met its expectations.");
process.exitCode = regressed ? 1 : 0;
