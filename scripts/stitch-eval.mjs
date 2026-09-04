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
 * cache stitch-diag uses, so the two share every result.
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
const CACHE_DIR = path.join(REPO, "scratch-diag");
const CACHE_FILE = path.join(CACHE_DIR, "ocr-cache.json");
fs.mkdirSync(CACHE_DIR, { recursive: true });
const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) : {};
let cacheDirty = false, ocrCalls = 0, ocrHits = 0;
function hashImage(image) {
  const h = crypto.createHash("sha1");
  h.update(Buffer.from([image.width & 255, (image.width >> 8) & 255, image.height & 255, (image.height >> 8) & 255]));
  h.update(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength));
  return h.digest("hex");
}
let worker = null;
async function ensureWorker() {
  if (worker) return worker;
  const { createWorker, PSM } = await import("tesseract.js");
  worker = await createWorker("eng", 1, { langPath: path.join(REPO, "public/ocr"), gzip: true, cachePath: path.join(CACHE_DIR, "tesscache") });
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
  return worker;
}
async function ocr(image) {
  const key = hashImage(image);
  if (cache[key]) { ocrHits++; return cache[key]; }
  ocrCalls++;
  const w = await ensureWorker();
  const { data } = await w.recognize(encodePNG(image.width, image.height, image.data));
  const words = [];
  for (const wd of data.words ?? []) { if (wd.text?.trim()) words.push({ text: wd.text.trim(), confidence: wd.confidence, bbox: { ...wd.bbox } }); }
  cache[key] = words; cacheDirty = true;
  if (ocrCalls % 20 === 0) flushCache();
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
  const res = await autoStitch(mupdf, doc, parseRanges(set.pages ?? "0-9"), { userScale: set.scale ?? 20, ocr });
  flushCache();
  row.seconds = (Date.now() - t0) / 1000;
  row.ocrCalls = ocrCalls - before;
  row.aligned = res.alignedCount;
  row.method = res.method;
  row.verdict = res.alignmentVerdict ?? "unverified";
  row.worstResidFt = res.worstResidFt;
  row.suspect = (res.seamReport ?? []).filter((s) => s.status === "suspect").length;
  row.seams = (res.seamReport ?? []).length;
  row.skippedSheets = (res.skipped ?? []).length;
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
  if (set.minAligned != null && row.aligned < set.minAligned) fail(`aligned ${row.aligned} < ${set.minAligned}`);
  if (set.maxAligned != null && row.aligned > set.maxAligned) fail(`aligned ${row.aligned} > ${set.maxAligned} (false pairs)`);
  if (set.verdictFloor != null && VERDICT_RANK[row.verdict] < VERDICT_RANK[set.verdictFloor]) fail(`verdict ${row.verdict} < ${set.verdictFloor}`);
  if (set.maxWorstResidFt != null && row.worstResidFt > set.maxWorstResidFt) fail(`worstResid ${row.worstResidFt} ft > ${set.maxWorstResidFt} ft`);
  if (set.maxSuspectSeams != null && row.suspect > set.maxSuspectSeams) fail(`${row.suspect} suspect seams > ${set.maxSuspectSeams}`);
  if (set.maxSeconds != null && row.seconds > set.maxSeconds) fail(`${row.seconds.toFixed(1)}s > ${set.maxSeconds}s`);
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
if (worker) await worker.terminate();

if (AS_JSON) {
  console.log(JSON.stringify({ manifest: MANIFEST, rows }, null, 2));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\nstitch-eval · ${MANIFEST}\n`);
  console.log(`${pad("set", 26)}${pad("aligned", 9)}${pad("method", 11)}${pad("verdict", 12)}${pad("worstResid", 12)}${pad("suspect", 9)}${pad("skipped", 9)}${pad("ocr", 6)}time`);
  console.log("-".repeat(110));
  for (const r of rows) {
    if (r.skipped) { console.log(`${pad(r.name, 26)}SKIPPED — ${r.skipped}`); continue; }
    console.log(
      `${pad(r.name, 26)}${pad(r.aligned, 9)}${pad(r.method, 11)}${pad(r.verdict, 12)}` +
      `${pad(`${r.worstResidFt.toFixed(2)} ft`, 12)}${pad(`${r.suspect}/${r.seams}`, 9)}${pad(r.skippedSheets, 9)}${pad(r.ocrCalls, 6)}${r.seconds.toFixed(1)}s`,
    );
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
