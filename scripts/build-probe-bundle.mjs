/**
 * build-probe-bundle — the stitch engine as one Node ESM file, for the AWS Lambda that
 * pre-computes an auto-align verdict server-side.
 *
 * Why a bundle at all: every other Node caller of the engine (`stitch-eval.mjs`,
 * `stitch-diag.mjs`) runs under `vite-node`, which transforms the TypeScript on the fly.
 * A Lambda image cannot carry Vite, and it must not carry a hand-maintained copy of the
 * engine either — a copy would answer the same question with different code. So esbuild
 * flattens `probeNode.ts` and everything it imports into `dist-probe/probe-engine.mjs`,
 * and the image copies that one file in.
 *
 * The bundle imports NOTHING at runtime. mupdf and tesseract.js are injected into
 * `runProbe(req, deps)` by the handler, so they are marked external here purely as a
 * belt-and-braces guard: if a future edit ever adds a real import of either, this build
 * keeps it out of the bundle instead of silently inlining a wasm package.
 *
 * ENGINE_VERSION is the whole point of the ceremony. `__ENGINE_VERSION__` is defined to
 * the current commit's short hash and written beside the bundle, so a stored verdict can
 * be matched against the editor's own build — a verdict from a different commit is not
 * interchangeable and the editor re-runs the browser probe.
 *
 * A DIRTY tree stamps `<short>-dirty`, in the define AND in the file, deliberately as one
 * value rather than as a warning next to a clean-looking hash. The editor's own constant
 * is stamped from a build of a committed tree, so `-dirty` can never match it: a bundle
 * built over uncommitted edits produces verdicts the editor will always discard, which is
 * the only safe reading of "this engine is not the one you are running". Untracked files
 * are excluded (`--untracked-files=no`) — a scratch file or an SDD note beside the repo is
 * not a change to the engine.
 *
 * Run: npm run build:probe-bundle
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(REPO, "dist-probe");
const OUT_FILE = path.join(OUT_DIR, "probe-engine.mjs");
const VERSION_FILE = path.join(OUT_DIR, "ENGINE_VERSION");
const ENTRY = path.join(REPO, "src/features/stitch/autostitch/probeNode.ts");

// Not fatal — building one to test locally before committing is the normal loop — but it
// changes the STAMP, not just the log line: see the header.
// `--short=12`, not a bare `--short`: git picks the default abbreviation length per
// checkout from the object count, so this bundle and the editor build could stamp the
// same commit at different lengths and never match. Pinned in BOTH (`vite.config.ts`).
const head = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: REPO, encoding: "utf8" }).trim() !== "";
const version = dirty ? `${head}-dirty` : head;

fs.mkdirSync(OUT_DIR, { recursive: true });

await esbuild.build({
  entryPoints: [ENTRY],
  outfile: OUT_FILE,
  platform: "node",
  format: "esm",
  target: "node20",
  bundle: true,
  external: ["mupdf", "tesseract.js"],
  define: { __ENGINE_VERSION__: JSON.stringify(version) },
  logLevel: "info",
});

fs.writeFileSync(VERSION_FILE, version + "\n");

const kb = (fs.statSync(OUT_FILE).size / 1024).toFixed(1);
console.log(`probe engine ${version}${dirty ? "  ← WORKING TREE DIRTY: this bundle is not that commit, and no editor build will accept its verdicts" : ""}`);
console.log(`  ${path.relative(REPO, OUT_FILE)}  ${kb} kB`);
console.log(`  ${path.relative(REPO, VERSION_FILE)}`);
