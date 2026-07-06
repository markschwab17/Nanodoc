# Auto-Stitch on Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "Add & auto-align" action to nanodoc's Add-PDF flow that places the selected plan pages onto the stitch canvas already aligned in one scale-correct feet-frame, using deterministic PDF-internal data (zero models).

**Architecture:** Port the proven R&D engine (`poc-pdf-deconstruct/probe-scale-geo`) into `src/features/stitch/autostitch/`. A new mupdf capture-`Device` pass produces the engine's exact intermediate JSON (`{shxLabels, labels, words, geometry, view}`); ported pure modules infer per-page scale and solve a global least-squares placement in world-feet; a pure mapping converts feet → canvas tile poses. Pages that can't be connected fall back to a grid below the aligned cluster.

**Tech Stack:** React 18 + TypeScript 5 + Vite, mupdf ^1.26.4 (WASM), pdf-lib, Zustand, vitest (jsdom). **No new dependencies.**

## Global Constraints

- **No new dependencies.** Everything uses the installed `mupdf` WASM API (`Device`, `Path.walk`, `Text.walk`, `Matrix.concat/identity`, `beginLayer`) and existing libs.
- **mupdf WASM cannot run in vitest/jsdom** (`vitest.config.ts` excludes worker/wasm). Pure modules are unit-tested in vitest with **synthetic fixtures**; the mupdf capture device + full pipeline are validated only through a **DEV-only `/dev/autostitch` smoke harness** and by eye.
- **Port source of truth** (read-only reference; the executor has filesystem access to it): `/Users/markschwab/Documents/CTO-Website/poc-pdf-deconstruct/probe-scale-geo/` and `/Users/markschwab/Documents/CTO-Website/poc-pdf-deconstruct/probe-text/lib/reconstruct.js`. Ports MUST preserve the algorithm bodies and every numeric constant byte-for-byte; only convert CommonJS→ESM, add TypeScript types, and make the enumerated structural edits. Do not "improve" the algorithm.
- **`tsconfig` has `strict`, `noUnusedLocals`, and `noUnusedParameters` all `true`.** The verbatim ports carry dead symbols that will fail `tsc` (e.g. the unused `const words` in `scale-infer.js`'s `dimensionChannel`, line 85). Resolving these is the ONE permitted deviation from byte-for-byte: **delete unused locals** and **prefix unused function/callback parameters with `_`** — removal only, never a logic change. After each port, run `npx tsc --noEmit` and clear unused-symbol errors this way. Everything else stays identical.
- **Coordinate frame:** one consistent frame end-to-end = mupdf page space (points, y-down, top-left origin). No y-flip anywhere.
- **Scope:** translation + uniform scale, north-up. No rotation, no georeferencing, no KMZ, no north-arrow detection, no live re-stitch of placed tiles.
- **Path alias:** `@/` → `src/`. Test files are `*.test.ts` colocated with source.
- **Branch:** all work on `feature/auto-stitch-import` (never commit to the default branch).
- **Commits:** Conventional Commits (`feat:`, `test:`, `refactor:`).
- **Run a single test file:** `npx vitest run <path>`. **Typecheck:** `npx tsc --noEmit`.

---

## Plan Revision — 2026-07-06 (resequencing: scale inference deferred)

The POC's scale-inference code is being actively reworked (new `lib/scale-core.js`, `lib/page-labels.js`, a confidence-tier `decideScale`, cross-sheet `reconcileBySet`, and additive `tokens.js` fields `axis`/`sheetCode`/`detectNoScale`). Per decision on 2026-07-06 ("port latest, no snapshot; build stable engine now, port scale-infer last"), the sequence is revised:

- **Same-scale stitching needs no scale inference.** Per-sheet scale cancels in the points→feet→canvas round-trip, so a uniform scale (user-entered or default) yields exact placement for a single-scale set. Scale only affects mixed-scale resizing and seam-error reporting in real feet.
- **Task 2's committed tokens port stays as-is.** `stitch-core.js` is unchanged and consumes the original `parseScaleNotes(...).ftPerIn` / `parseSheetRefs(...).sheet/.edge`; the current tokens.js additions are all scale-only, so re-syncing them is folded into the deferred scale task.
- **Task 3 (`scaleInfer`) is DEFERRED and superseded by Task 10.** Do not port the old single-file `scale-infer.js`. Skip Task 3 entirely in this pass.
- **Task 7 (`autoStitch`) uses a thin scale interface** (user-entered/default scale), not `inferScale` — see the revised Task 7 below.
- **Task 10 (final, deferred): port the current scale-inference stack** — re-sync `tokens.ts` (axis/detectNoScale/sheetCode) + port `scale-core.js` + `page-labels.js` + the reworked `scaleInfer.ts` (`{scale, confidence, source}` + `reconcileBySet`), then replace the thin scale interface in `autoStitch`. Its detailed brief is authored at execution time against the then-frozen POC source (the source is still changing, so a detailed brief now would be stale). Order after Task 9.

Execution order this pass: **1 ✓ → 2 (review) → 4 → 5 → 6 → 7 (revised) → 8 → 9**, then **10** once the user confirms the POC scale logic is frozen.

---

### Task 1: Scaffolding, shared types, and `reconstruct` port

**Files:**
- Create branch `feature/auto-stitch-import`
- Create: `src/features/stitch/autostitch/types.ts`
- Create: `src/features/stitch/autostitch/reconstruct.ts`
- Test: `src/features/stitch/autostitch/reconstruct.test.ts`

**Interfaces:**
- Produces `types.ts`:
  ```ts
  export interface Label { text: string; x: number; y: number; endX: number; endY: number; angle: number; h: number; font: string | null; atoms?: number; }
  export interface Geom { id: string; pts: [number, number][]; closed: boolean; }
  export interface Atom { text: string; x: number; y: number; dirX: number; dirY: number; h: number; len: number; angle: number; font: string | null; }
  export interface PageExtract { view: [number, number, number, number]; shxLabels: Label[]; labels: Label[]; words: Label[]; geometry: Geom[]; }
  export interface Pt { x: number; y: number; }
  ```
- Produces `reconstruct.ts`: `export function reconstruct(atoms: Atom[]): { labels: Label[]; words: Label[] }`

- [ ] **Step 1: Create the branch**

Run:
```bash
cd /Users/markschwab/Documents/Pdf_editor
git checkout -b feature/auto-stitch-import
```

- [ ] **Step 2: Create `types.ts`** with exactly the interfaces listed under "Produces `types.ts`" above.

- [ ] **Step 3: Write the failing test** `src/features/stitch/autostitch/reconstruct.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { reconstruct } from "./reconstruct";
import type { Atom } from "./types";

/** A horizontal glyph run: chars at ascending x, height h, advance = adv. */
function glyphs(chars: string, x0: number, adv: number, h = 10): Atom[] {
  return [...chars].map((c, i) => ({
    text: c, x: x0 + i * adv, y: 0, dirX: 1, dirY: 0, h, len: adv, angle: 0, font: null,
  }));
}

describe("reconstruct", () => {
  it("glues adjacent glyphs into one word", () => {
    // adv == char width, gaps == 0 -> all glued
    const { labels, words } = reconstruct(glyphs("347", 0, 6));
    expect(labels).toHaveLength(1);
    expect(labels[0].text).toBe("347");
    expect(words.map((w) => w.text)).toEqual(["347"]);
  });

  it("splits a wide gap into a space-joined label with two words", () => {
    // "34" then a big gap (2 em) then "7" -> one label "34 7", two words
    const a = glyphs("34", 0, 6, 10);
    const b = glyphs("7", 6 * 2 + 10 * 1.0, 6, 10); // gap ~= 1.0*h (< GAP_SPACE 2.2*h, > GAP_GLUE 0.18*h)
    const { labels, words } = reconstruct([...a, ...b]);
    expect(labels).toHaveLength(1);
    expect(labels[0].text).toBe("34 7");
    expect(words.map((w) => w.text).sort()).toEqual(["34", "7"]);
  });

  it("keeps runs on different baselines as separate labels", () => {
    const top = glyphs("ABC", 0, 6, 10).map((g) => ({ ...g, y: 100 }));
    const bot = glyphs("XYZ", 0, 6, 10).map((g) => ({ ...g, y: 0 }));
    const { labels } = reconstruct([...top, ...bot]);
    expect(labels.map((l) => l.text).sort()).toEqual(["ABC", "XYZ"]);
  });

  it("drops whitespace-only and non-finite atoms", () => {
    const noisy: Atom[] = [
      ...glyphs("5", 0, 6),
      { text: " ", x: 6, y: 0, dirX: 1, dirY: 0, h: 10, len: 6, angle: 0, font: null },
      { text: "6", x: NaN, y: 0, dirX: 1, dirY: 0, h: 10, len: 6, angle: 0, font: null },
    ];
    const { labels } = reconstruct(noisy);
    expect(labels).toHaveLength(1);
    expect(labels[0].text).toBe("5");
  });
});
```

- [ ] **Step 4: Run the test — verify it fails**

Run: `npx vitest run src/features/stitch/autostitch/reconstruct.test.ts`
Expected: FAIL (`Cannot find module './reconstruct'`).

- [ ] **Step 5: Port `reconstruct.js` → `reconstruct.ts`**

Copy the body of `/Users/markschwab/Documents/CTO-Website/poc-pdf-deconstruct/probe-text/lib/reconstruct.js` into `src/features/stitch/autostitch/reconstruct.ts` and apply exactly these edits, changing nothing else (all constants `ANGLE_TOL`, `Y_TOL`, `GAP_GLUE`, `GAP_SPACE` and all algorithm bodies stay byte-identical):
1. Replace the file's export block with ESM: `export function reconstruct(atoms: Atom[]): { labels: Label[]; words: Label[] } { ... }`.
2. Add `import type { Atom, Label } from "./types";` at the top.
3. **Delete** `atomsFromGlyphs` and `atomsFromTextContent` (the capture device builds `Atom[]` directly; they are not needed).
4. Add types to the internal helpers: `angleDiff(a: number, b: number): number`, `dedupeOverprint(atoms: Atom[]): Atom[]`, `mkLabel(angle: number, p: any)`, `clean(l: any): Label`. `any` on the internal `p`/`l` scratch objects is acceptable — do not restructure the algorithm to avoid it.

- [ ] **Step 6: Run the test — verify it passes**

Run: `npx vitest run src/features/stitch/autostitch/reconstruct.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add src/features/stitch/autostitch/types.ts src/features/stitch/autostitch/reconstruct.ts src/features/stitch/autostitch/reconstruct.test.ts
git commit -m "feat(autostitch): scaffold types + port glyph reconstruction"
```

---

### Task 2: `tokens` port

**Files:**
- Create: `src/features/stitch/autostitch/tokens.ts`
- Test: `src/features/stitch/autostitch/tokens.test.ts`

**Interfaces:**
- Consumes: `Label`, `Pt` from `./types`.
- Produces:
  ```ts
  export function center(l: Label): Pt;
  export function parseScaleNotes(labels: Label[]): { ftPerIn: number; text: string; at: Pt; angle: number }[];
  export function parseDistanceTokens(words: Label[]): { ft: number; text: string; at: Pt; angle: number; kind: string }[];
  export function parseStations(words: Label[]): { ft: number; text: string; at: Pt; angle: number }[];
  export function parseBearings(labels: Label[]): { az: number; ft: number | null; text: string; at: Pt; angle: number }[];
  export interface SheetRef { text: string; at: Pt; angle: number; sheet: number | null; matchline: boolean; station: string | null; edge: string; edgeDist: number; }
  export function parseSheetRefs(labels: Label[], view: [number, number, number, number]): SheetRef[];
  ```

- [ ] **Step 1: Write the failing test** `src/features/stitch/autostitch/tokens.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { parseScaleNotes, parseDistanceTokens, parseStations, parseBearings, parseSheetRefs } from "./tokens";
import type { Label } from "./types";

const L = (text: string, x = 0, y = 0, endX = 0, endY = 0): Label =>
  ({ text, x, y, endX: endX || x, endY: endY || y, angle: 0, h: 8, font: null });

describe("tokens", () => {
  it("parses stated scale notes incl. arch fractions", () => {
    expect(parseScaleNotes([L('1" = 20\'')])[0].ftPerIn).toBeCloseTo(20, 6);
    expect(parseScaleNotes([L('1/8" = 1\'-0"')])[0].ftPerIn).toBeCloseTo(8, 6);
  });

  it("parses decimal-feet and feet-inch distance tokens; rejects stations", () => {
    expect(parseDistanceTokens([L("105.49'")])[0].ft).toBeCloseTo(105.49, 6);
    expect(parseDistanceTokens([L("12'-6\"")])[0].ft).toBeCloseTo(12.5, 6);
    expect(parseDistanceTokens([L("10+36.00")])).toHaveLength(0);
  });

  it("parses station tokens to feet", () => {
    expect(parseStations([L("10+36.00")])[0].ft).toBeCloseTo(1036, 6);
  });

  it("parses a bearing+distance label to azimuth and distance", () => {
    const b = parseBearings([L("N89°55'47\"W 734.66'")])[0];
    expect(b.az).toBeCloseTo(270.07, 1);
    expect(b.ft).toBeCloseTo(734.66, 2);
  });

  it("classifies an edge sheet reference", () => {
    // view 2592x1728; label near the left edge
    const r = parseSheetRefs([L("SEE SHEET NO. 8", 50, 800)], [0, 0, 2592, 1728])[0];
    expect(r.sheet).toBe(8);
    expect(r.edge).toBe("left");
  });

  it("flags a matchline label with a station", () => {
    const r = parseSheetRefs([L("MATCHLINE 10+72.00", 1200, 20)], [0, 0, 2592, 1728])[0];
    expect(r.matchline).toBe(true);
    expect(r.station).toBe("10+72.00");
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `npx vitest run src/features/stitch/autostitch/tokens.test.ts`
Expected: FAIL (`Cannot find module './tokens'`).

- [ ] **Step 3: Port `lib/tokens.js` → `tokens.ts`**

Copy `/Users/markschwab/Documents/CTO-Website/poc-pdf-deconstruct/probe-scale-geo/lib/tokens.js` into `src/features/stitch/autostitch/tokens.ts`. Edits only:
1. `import type { Label, Pt } from "./types";` at top.
2. Convert `module.exports = {...}` to individual `export function` on each of `center`, `parseScaleNotes`, `parseDistanceTokens`, `parseStations`, `parseBearings`, `parseSheetRefs`.
3. Add the parameter/return types from the "Produces" block above (add the `SheetRef` interface and use it as `parseSheetRefs`' return element type).
4. Keep `const DEG = String.fromCharCode(0xB0);` and every regex byte-identical.

- [ ] **Step 4: Run the test — verify it passes**

Run: `npx vitest run src/features/stitch/autostitch/tokens.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/stitch/autostitch/tokens.ts src/features/stitch/autostitch/tokens.test.ts
git commit -m "feat(autostitch): port deterministic token classifiers"
```

---

### Task 3: `scaleInfer` port — ⛔ DEFERRED / SUPERSEDED

> **Do not implement this task.** The POC's `scale-infer.js` was reworked after this plan was written (candidate-ladder + `decideScale` + `reconcileBySet`, depending on new `lib/scale-core.js` and `lib/page-labels.js`). The old single-file port below is obsolete. Scale inference is now **Task 10**, authored against the frozen source after Task 9. Skip to Task 4.

**Files (obsolete — retained for reference only):**
- Create: `src/features/stitch/autostitch/scaleInfer.ts`
- Test: `src/features/stitch/autostitch/scaleInfer.test.ts`

**Interfaces:**
- Consumes: `PageExtract`, `Label` from `./types`; all of `./tokens`.
- Produces:
  ```ts
  export interface ScaleResult {
    stated: number | null;
    dim: { ftPerIn: number; errPct: number | null; n: number; inliers: number; inlierFrac: number; spreadPct: number } | null;
    station: { ftPerIn: number; errPct: number | null; pairs: number; inliers: number; spreadPct: number } | null;
    scaleBar: { ftPerIn: number; errPct: number | null; ticks: number[] } | { reason: string } | null;
    combined: { ftPerIn: number; errPct: number | null; agreement: "high" | "medium" | "low"; channels: string[] } | null;
  }
  export function inferScale(page: PageExtract): ScaleResult;
  ```

- [ ] **Step 1: Write the failing test** `src/features/stitch/autostitch/scaleInfer.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { inferScale } from "./scaleInfer";
import type { PageExtract, Label, Geom } from "./types";

const L = (text: string, x: number, y: number, endX: number, endY: number, angle = 0): Label =>
  ({ text, x, y, endX, endY, angle, h: 8, font: null });

describe("inferScale", () => {
  it("recovers 20 ft/in from a dimension token on a parallel line, matching the stated note", () => {
    // 105.49 ft over a 379.76 pt segment -> 105.49 / (379.76/72) = 20.0 ft/in
    const segLen = (105.49 * 72) / 20; // 379.764 pt
    const geometry: Geom[] = [{ id: "g0", pts: [[0, 0], [segLen, 0]], closed: false }];
    const page: PageExtract = {
      view: [0, 0, 2592, 1728],
      shxLabels: [],
      labels: [L('1" = 20\'', 100, 100, 180, 100)],
      words: [L("105.49'", segLen / 2 - 20, 5, segLen / 2 + 20, 5)],
      geometry,
    };
    const res = inferScale(page);
    expect(res.stated).toBeCloseTo(20, 6);
    expect(res.dim?.ftPerIn).toBeCloseTo(20, 1);
    expect(res.combined?.ftPerIn).toBeCloseTo(20, 1);
  });

  it("abstains (combined null) when there is no usable signal", () => {
    const page: PageExtract = { view: [0, 0, 2592, 1728], shxLabels: [], labels: [], words: [], geometry: [] };
    expect(inferScale(page).combined).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `npx vitest run src/features/stitch/autostitch/scaleInfer.test.ts`
Expected: FAIL (`Cannot find module './scaleInfer'`).

- [ ] **Step 3: Port `scale-infer.js` → `scaleInfer.ts`**

Copy `/Users/markschwab/Documents/CTO-Website/poc-pdf-deconstruct/scale-infer.js` into `src/features/stitch/autostitch/scaleInfer.ts`. Edits:
1. `import { parseScaleNotes, parseDistanceTokens, parseStations, parseBearings } from "./tokens";` and `import type { PageExtract } from "./types";`. **Remove** `const fs = require('fs')` and `const path = require('path')`.
2. **Delete** the CLI section at the bottom (everything from `const files = process.argv...` to the final `console.log`/`fs.writeFileSync`).
3. Rename the `run(file)` function to `inferScale(page: PageExtract): ScaleResult` and **delete its first two lines** that read the file (`const page = JSON.parse(fs.readFileSync(file))`). It already receives `page`. Remove `file: path.basename(file)` from the returned object.
4. Keep `robustScale`, `dimensionChannel`, `stationChannel`, `scaleBarChannel`, `segments`, `ptToSeg`, `angDiff180`, `labelsFrom`, `wordsFrom`, `explode` verbatim (add light types: `robustScale(samples: {v:number;w?:number;src?:string}[], relBin?: number, relInlier?: number)`, etc. — `any` is acceptable on internal scratch).
5. Add the `ScaleResult` interface from "Produces" and annotate `inferScale`'s return.
6. Keep `PT_PER_IN = 72` and every threshold byte-identical.

- [ ] **Step 4: Run the test — verify it passes**

Run: `npx vitest run src/features/stitch/autostitch/scaleInfer.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/stitch/autostitch/scaleInfer.ts src/features/stitch/autostitch/scaleInfer.test.ts
git commit -m "feat(autostitch): port 3-channel deterministic scale inference"
```

---

### Task 4: `stitchCore` port + `stitchSheets` driver

**Files:**
- Create: `src/features/stitch/autostitch/stitchCore.ts`
- Test: `src/features/stitch/autostitch/stitchCore.test.ts`

**Interfaces:**
- Consumes: `PageExtract`, `Label`, `Geom` from `./types`; `parseSheetRefs`, `parseScaleNotes` from `./tokens`.
- Produces (ported primitives, keep names exactly):
  ```ts
  export const FT: (pt: number, scale: number) => number;
  export interface TokFeat { text: string; x: number; y: number; }
  export interface SegFeat { mx: number; my: number; len: number; ang: number; }
  export interface Vote { dx: number; dy: number; inliers: number; rmsFt: number; votes?: number; secondVotes?: number; tokens?: string[]; }
  export function buildFurnitureFilter(sheets: any[], minSheets: number): { size: number; isFurniture(l: Label): boolean };
  export function tokenFeats(s: any, furn: { isFurniture(l: Label): boolean } | null): TokFeat[];
  export function segFeats(s: any): SegFeat[];
  export function tokenVote(si: { tok: TokFeat[] }, sj: { tok: TokFeat[] }, opts?: { minInliers?: number; minMag?: number }): Vote | null;
  export function matchlinePrior(si: any, sj: any): { dx: number; dy: number; sameSta: boolean } | null;
  export function segVote(si: any, sj: any, win: { x0: number; x1: number; y0: number; y1: number }): Vote | null;
  export function windowFor(rel: string, span: number): { x0: number; x1: number; y0: number; y1: number };
  export function solveGlobal(keys: number[], rootKey: number, constraints: { i: number; j: number; dx: number; dy: number; weight: number }[], opts?: { huberFt?: number; iters?: number }): { pos: Map<number, { x: number; y: number }>; resid: any[] };
  export function residual(c: { i: number; j: number; dx: number; dy: number }, pos: Map<number, { x: number; y: number }>): number;
  ```
  Produces (new driver):
  ```ts
  export interface SheetInput { id: string; no: number; scale: number; view: [number, number, number, number]; extract: PageExtract; }
  export interface PairReport { i: number; j: number; channel: string | null; conf: string | null; dxFt: number | null; dyFt: number | null; weight: number; residFt: number | null; }
  export interface StitchResult { root: number; placements: Map<number, { x: number; y: number }>; worstResidFt: number; pairs: PairReport[]; }
  export function stitchSheets(inputs: SheetInput[]): StitchResult;
  ```

- [ ] **Step 1: Write the failing test** `src/features/stitch/autostitch/stitchCore.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { tokenVote, stitchSheets, type SheetInput } from "./stitchCore";
import type { Label, PageExtract } from "./types";

const tok = (text: string, x: number, y: number) => ({ text, x, y });
const lbl = (text: string, x: number, y: number): Label =>
  ({ text, x, y, endX: x + 30, endY: y, angle: 0, h: 8, font: null });

describe("tokenVote", () => {
  it("finds the modal translation from shared tokens", () => {
    const A = { tok: Array.from({ length: 6 }, (_, i) => tok(`TC${i}00.0`, i * 100, 0)) };
    const B = { tok: A.tok.map((t) => ({ ...t, x: t.x + 100, y: t.y + 50 })) };
    const v = tokenVote(A, B, { minInliers: 5 });
    expect(v).not.toBeNull();
    expect(v!.dx).toBeCloseTo(-100, 1); // A - B
    expect(v!.dy).toBeCloseTo(-50, 1);
    expect(v!.inliers).toBeGreaterThanOrEqual(5);
  });
});

describe("stitchSheets", () => {
  it("places a second sheet at the token-implied feet offset from the root", () => {
    // scale 20 ft/in => 72 pt = 20 ft => 1080 pt = 300 ft
    const OFF_PT = (300 * 72) / 20; // 1080 pt in page space
    const texts = ["TC347.33", "TC348.10", "FL346.90", "TC349.55", "FL347.10", "TC350.02"];
    const aLabels = texts.map((t, i) => lbl(t, 400 + i * 120, 800 + (i % 2) * 60));
    const bLabels = texts.map((t, i) => lbl(t, 400 + i * 120 - OFF_PT, 800 + (i % 2) * 60));
    const mk = (id: string, no: number, labels: Label[]): SheetInput => ({
      id, no, scale: 20, view: [0, 0, 2592, 1728],
      extract: { view: [0, 0, 2592, 1728], shxLabels: labels, labels, words: labels, geometry: [] } as PageExtract,
    });
    const res = stitchSheets([mk("a", 1, aLabels), mk("b", 2, bLabels)]);
    expect(res.root).toBe(1);
    expect(res.placements.get(1)).toEqual({ x: 0, y: 0 });
    const p2 = res.placements.get(2)!;
    // sheet b tokens are shifted -1080pt in x => +300 ft on sheet b's origin
    expect(p2.x).toBeCloseTo(300, 0);
    expect(p2.y).toBeCloseTo(0, 0);
    expect(res.worstResidFt).toBeLessThan(0.1);
  });

  it("leaves a disconnected sheet out of placements", () => {
    const shared = ["AA111.1", "BB222.2", "CC333.3", "DD444.4", "EE555.5", "FF666.6"];
    const a = shared.map((t, i) => lbl(t, 400 + i * 120, 800));
    const b = shared.map((t, i) => lbl(t, 400 + i * 120 - 1080, 800));
    const loner = ["ZZ999.9", "YY888.8", "XX777.7"].map((t, i) => lbl(t, 100 + i * 50, 100));
    const mk = (id: string, no: number, labels: Label[]): SheetInput => ({
      id, no, scale: 20, view: [0, 0, 2592, 1728],
      extract: { view: [0, 0, 2592, 1728], shxLabels: labels, labels, words: labels, geometry: [] } as PageExtract,
    });
    const res = stitchSheets([mk("a", 1, a), mk("b", 2, b), mk("c", 3, loner)]);
    expect(res.placements.has(1)).toBe(true);
    expect(res.placements.has(2)).toBe(true);
    expect(res.placements.has(3)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `npx vitest run src/features/stitch/autostitch/stitchCore.test.ts`
Expected: FAIL (`Cannot find module './stitchCore'`).

- [ ] **Step 3: Port the primitives**

Copy `/Users/markschwab/Documents/CTO-Website/poc-pdf-deconstruct/lib/stitch-core.js` into `src/features/stitch/autostitch/stitchCore.ts`. Edits:
1. Replace `const { parseSheetRefs, parseScaleNotes } = require('./tokens');` with `import { parseSheetRefs, parseScaleNotes } from "./tokens";` and add `import type { Label, Geom, PageExtract } from "./types";`.
2. Convert `module.exports = {...}` to `export` on each function/const listed in "Produces (ported primitives)". Add the type annotations shown there (`TokFeat`, `SegFeat`, `Vote` interfaces + `gaussSolve(A: Float64Array[] | number[][], b: Float64Array)` internal helper stays; `any` acceptable on the internal `s`/`sheet` scratch params).
3. Keep every constant and the IRLS/Huber math byte-identical (`huberFt = 2.0`, `iters = 8`, bins, etc.).

- [ ] **Step 4: Append the `stitchSheets` driver** to `stitchCore.ts`

This is the distilled *improved* path of `stitch2.js` (no legacy/before comparison, no fs, no PNG). Add verbatim:

```ts
interface DriverSheet {
  id: string; no: number; scale: number; view: [number, number, number, number];
  raw: { shxLabels: Label[]; labels: Label[]; geometry: Geom[]; view: [number, number, number, number] };
  key: number; tok?: TokFeat[]; seg?: SegFeat[];
}

export function stitchSheets(inputs: SheetInput[]): StitchResult {
  const sheets: DriverSheet[] = inputs.map((s) => {
    let shx = s.extract.shxLabels || [];
    if (shx.length < 8 && s.extract.labels?.length) shx = s.extract.labels; // visible fallback
    return {
      id: s.id, no: s.no, scale: s.scale, view: s.view,
      raw: { shxLabels: shx, labels: s.extract.labels || [], geometry: s.extract.geometry || [], view: s.view },
      key: s.no,
    };
  });
  const byNo = new Map(sheets.map((s) => [s.no, s]));
  const keys = sheets.map((s) => s.no);
  const rootKey = sheets[0].no;

  const FURN_MIN = Math.max(2, Math.min(3, sheets.length));
  const furn = buildFurnitureFilter(sheets, FURN_MIN);
  for (const s of sheets) { s.tok = tokenFeats(s, furn); s.seg = segFeats(s); }

  const EDGE2REL: Record<string, string> = { left: "left", right: "right", top: "above", bottom: "below" };
  const OPPREL: Record<string, string> = { left: "right", right: "left", above: "below", below: "above" };
  const relOf = new Map<string, string>();
  for (const s of sheets) {
    const refs = parseSheetRefs(s.raw.shxLabels, s.raw.view)
      .filter((r) => r.edge !== "interior" && r.sheet && byNo.has(r.sheet) && r.sheet !== s.no);
    for (const r of refs) if (!relOf.has(`${s.no}-${r.sheet}`)) relOf.set(`${s.no}-${r.sheet}`, EDGE2REL[r.edge]);
  }
  const relFor = (ni: number, nj: number): string | null =>
    relOf.get(`${ni}-${nj}`) ?? (relOf.has(`${nj}-${ni}`) ? OPPREL[relOf.get(`${nj}-${ni}`)!] : null);

  const tv = (si: DriverSheet, sj: DriverSheet) => tokenVote({ tok: si.tok! }, { tok: sj.tok! }, { minInliers: 5 });

  const pairKeys = new Set<string>();
  for (const k of relOf.keys()) { const [a, b] = k.split("-").map(Number); pairKeys.add(a < b ? `${a}-${b}` : `${b}-${a}`); }
  for (let a = 0; a < sheets.length; a++) for (let b = a + 1; b < sheets.length; b++) {
    const si = sheets[a], sj = sheets[b];
    const span = Math.max(FT(si.view[2] - si.view[0], si.scale), FT(sj.view[2] - sj.view[0], sj.scale)) * 1.4;
    const t = tv(si, sj);
    if (t && Math.hypot(t.dx, t.dy) < span) pairKeys.add(`${si.no}-${sj.no}`);
  }

  const pairs: (PairReport & { _final?: { dx: number; dy: number } })[] = [];
  for (const uk of pairKeys) {
    const [ni, nj] = uk.split("-").map(Number);
    const si = byNo.get(ni)!, sj = byNo.get(nj)!;
    const span = Math.max(FT(si.view[2] - si.view[0], si.scale), FT(sj.view[2] - sj.view[0], sj.scale));
    const rel = relFor(ni, nj);
    const tok = tv(si, sj);
    const prior = matchlinePrior(si, sj);
    let win: { x0: number; x1: number; y0: number; y1: number };
    if (prior) win = { x0: prior.dx - 60, x1: prior.dx + 60, y0: prior.dy - 60, y1: prior.dy + 60 };
    else if (tok) win = { x0: tok.dx - 30, x1: tok.dx + 30, y0: tok.dy - 30, y1: tok.dy + 30 };
    else if (rel) win = windowFor(rel, span);
    else win = { x0: -span, x1: span, y0: -span, y1: span };
    const seg = segVote(si, sj, win);

    let final: { dx: number; dy: number } | null = null, channel: string | null = null, conf: string | null = null, w = 0;
    if (tok && seg && Math.hypot(tok.dx - seg.dx, tok.dy - seg.dy) < 5) {
      final = { dx: (tok.dx + seg.dx) / 2, dy: (tok.dy + seg.dy) / 2 }; channel = "token+segment"; conf = "high";
      w = tok.inliers / (tok.rmsFt ** 2 + 0.01) + seg.inliers / (seg.rmsFt ** 2 + 0.04);
    } else if (tok) { final = tok; channel = "token"; conf = "high"; w = tok.inliers / (tok.rmsFt ** 2 + 0.01); }
    else if (seg && prior) { final = seg; channel = "matchline+segment"; conf = seg.votes! >= 2 * seg.secondVotes! ? "high" : "medium"; w = seg.inliers / (seg.rmsFt ** 2 + 0.09); }
    else if (seg) { final = seg; channel = "segment(windowed)"; conf = seg.votes! >= 2 * seg.secondVotes! ? "medium" : "low"; w = 0.5 * seg.inliers / (seg.rmsFt ** 2 + 0.25); }
    else if (prior) { final = prior; channel = "matchline-label-only"; conf = "low"; w = 2; }

    pairs.push({
      i: ni, j: nj, channel, conf,
      dxFt: final ? +final.dx.toFixed(2) : null, dyFt: final ? +final.dy.toFixed(2) : null,
      weight: +w.toFixed(2), residFt: null, _final: final ?? undefined,
    });
  }

  const constraints = pairs.filter((r) => r._final && r.weight > 0)
    .map((r) => ({ i: r.i, j: r.j, dx: r._final!.dx, dy: r._final!.dy, weight: r.weight }));
  const { pos } = solveGlobal(keys, rootKey, constraints);

  const refCons = pairs.filter((r) => r._final && /token/.test(String(r.channel)))
    .map((r) => ({ i: r.i, j: r.j, dx: r._final!.dx, dy: r._final!.dy }));
  let worst = 0;
  for (const c of refCons) { const rr = residual(c, pos); if (rr > worst) worst = rr; }
  for (const r of pairs) {
    if (r._final) r.residFt = +residual({ i: r.i, j: r.j, dx: r._final.dx, dy: r._final.dy }, pos).toFixed(3);
    delete r._final;
  }

  // Keep only sheets reachable from root through the constraint graph.
  const connected = new Set<number>([rootKey]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of constraints) {
      if (connected.has(c.i) && !connected.has(c.j)) { connected.add(c.j); changed = true; }
      if (connected.has(c.j) && !connected.has(c.i)) { connected.add(c.i); changed = true; }
    }
  }
  const placements = new Map<number, { x: number; y: number }>();
  for (const k of keys) if (connected.has(k)) placements.set(k, pos.get(k)!);

  return { root: rootKey, placements, worstResidFt: +worst.toFixed(3), pairs };
}
```

Also add the `SheetInput`, `PairReport`, `StitchResult` interfaces (from "Produces (new driver)") near the top of the file.

- [ ] **Step 5: Run the test — verify it passes**

Run: `npx vitest run src/features/stitch/autostitch/stitchCore.test.ts`
Expected: PASS (3 tests). If the token-only pair fails to resolve, confirm `tokenVote`'s `minMag` default (15 ft) is below the 300 ft test offset (it is) and that furniture filtering does not drop the shifted tokens (their page-local positions differ between sheets, so they are not furniture).

- [ ] **Step 6: Commit**

```bash
git add src/features/stitch/autostitch/stitchCore.ts src/features/stitch/autostitch/stitchCore.test.ts
git commit -m "feat(autostitch): port placement primitives + global stitch driver"
```

---

### Task 5: `layout` — feet-frame → canvas pose mapping (pure)

**Files:**
- Create: `src/features/stitch/autostitch/layout.ts`
- Test: `src/features/stitch/autostitch/layout.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PlacedSheetPose { pageIndex: number; scale: number; sizePt: { w: number; h: number }; posFt: { x: number; y: number } | null; }
  export interface TilePlacement { pageIndex: number; x: number; y: number; width: number; height: number; aligned: boolean; }
  export function layoutPlacements(sheets: PlacedSheetPose[], rootFtPerIn: number, opts?: { margin?: number; gap?: number; tilesPerRow?: number }): TilePlacement[];
  ```

- [ ] **Step 1: Write the failing test** `src/features/stitch/autostitch/layout.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { layoutPlacements, type PlacedSheetPose } from "./layout";

describe("layoutPlacements", () => {
  it("keeps the root sheet native size and repositions same-scale sheets", () => {
    const sheets: PlacedSheetPose[] = [
      { pageIndex: 0, scale: 20, sizePt: { w: 2592, h: 1728 }, posFt: { x: 0, y: 0 } },
      { pageIndex: 1, scale: 20, sizePt: { w: 2592, h: 1728 }, posFt: { x: 300, y: 0 } },
    ];
    const out = layoutPlacements(sheets, 20, { margin: 20 });
    const a = out.find((p) => p.pageIndex === 0)!;
    const b = out.find((p) => p.pageIndex === 1)!;
    expect(a.width).toBeCloseTo(2592, 6); // root unchanged
    expect(a.x).toBeCloseTo(20, 6);
    // 300 ft * (72/20) pt/ft = 1080 pt to the right
    expect(b.x - a.x).toBeCloseTo(1080, 6);
    expect(b.width).toBeCloseTo(2592, 6);
    expect(a.aligned && b.aligned).toBe(true);
  });

  it("enlarges a coarser-scale sheet to share the root frame", () => {
    const sheets: PlacedSheetPose[] = [
      { pageIndex: 0, scale: 20, sizePt: { w: 2592, h: 1728 }, posFt: { x: 0, y: 0 } },
      { pageIndex: 1, scale: 30, sizePt: { w: 2592, h: 1728 }, posFt: { x: 0, y: 0 } },
    ];
    const out = layoutPlacements(sheets, 20);
    const b = out.find((p) => p.pageIndex === 1)!;
    expect(b.width).toBeCloseTo(2592 * 1.5, 6); // 30/20 = 1.5
  });

  it("grid-drops unplaced sheets below the aligned cluster", () => {
    const sheets: PlacedSheetPose[] = [
      { pageIndex: 0, scale: 20, sizePt: { w: 1000, h: 800 }, posFt: { x: 0, y: 0 } },
      { pageIndex: 1, scale: 20, sizePt: { w: 1000, h: 800 }, posFt: null },
    ];
    const out = layoutPlacements(sheets, 20, { margin: 20 });
    const unplaced = out.find((p) => p.pageIndex === 1)!;
    expect(unplaced.aligned).toBe(false);
    expect(unplaced.y).toBeGreaterThan(20 + 800); // below the aligned tile
    expect(unplaced.width).toBeCloseTo(1000, 6); // native size, not rescaled
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `npx vitest run src/features/stitch/autostitch/layout.test.ts`
Expected: FAIL (`Cannot find module './layout'`).

- [ ] **Step 3: Write `layout.ts`**

```ts
export interface PlacedSheetPose {
  pageIndex: number;
  scale: number; // ftPerIn
  sizePt: { w: number; h: number };
  posFt: { x: number; y: number } | null; // null => could not be placed
}
export interface TilePlacement {
  pageIndex: number;
  x: number; y: number; width: number; height: number;
  aligned: boolean;
}

/**
 * Map world-feet placements into canvas (PDF-point) tile poses. The root sheet
 * keeps its native size; other sheets scale uniformly by scale/rootFtPerIn so
 * every sheet shares the same points-per-foot. Unplaced sheets (posFt null) are
 * grid-laid below the aligned cluster at native size.
 */
export function layoutPlacements(
  sheets: PlacedSheetPose[],
  rootFtPerIn: number,
  opts: { margin?: number; gap?: number; tilesPerRow?: number } = {}
): TilePlacement[] {
  const MARGIN = opts.margin ?? 20;
  const GAP = opts.gap ?? 10;
  const PER_ROW = opts.tilesPerRow ?? 3;
  const P = 72 / rootFtPerIn; // canvas points per foot

  const out: TilePlacement[] = [];
  const placed = sheets.filter((s) => s.posFt);
  let maxYCanvas = MARGIN;

  if (placed.length) {
    const minX = Math.min(...placed.map((s) => s.posFt!.x));
    const minY = Math.min(...placed.map((s) => s.posFt!.y));
    for (const s of placed) {
      const si = (P * s.scale) / 72; // == s.scale / rootFtPerIn
      const width = s.sizePt.w * si;
      const height = s.sizePt.h * si;
      const x = (s.posFt!.x - minX) * P + MARGIN;
      const y = (s.posFt!.y - minY) * P + MARGIN;
      out.push({ pageIndex: s.pageIndex, x, y, width, height, aligned: true });
      maxYCanvas = Math.max(maxYCanvas, y + height);
    }
  }

  const unplaced = sheets.filter((s) => !s.posFt);
  let rowY = maxYCanvas + (placed.length ? GAP * 3 : 0);
  for (let i = 0; i < unplaced.length; i += PER_ROW) {
    const row = unplaced.slice(i, i + PER_ROW);
    let x = MARGIN;
    let maxH = 0;
    for (const s of row) {
      out.push({ pageIndex: s.pageIndex, x, y: rowY, width: s.sizePt.w, height: s.sizePt.h, aligned: false });
      x += s.sizePt.w + GAP;
      maxH = Math.max(maxH, s.sizePt.h);
    }
    rowY += maxH + GAP;
  }
  return out;
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `npx vitest run src/features/stitch/autostitch/layout.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/stitch/autostitch/layout.ts src/features/stitch/autostitch/layout.test.ts
git commit -m "feat(autostitch): feet-frame to canvas pose mapping"
```

---

### Task 6: `captureDevice` — mupdf page → intermediate JSON

**Files:**
- Create: `src/features/stitch/autostitch/captureDevice.ts`

> No vitest test (mupdf WASM cannot run in jsdom). Verified in Task 8's `/dev/autostitch` harness and by `tsc`.

**Interfaces:**
- Consumes: `reconstruct` from `./reconstruct`; `PageExtract`, `Atom`, `Geom`, `Label` from `./types`.
- Produces: `export function capturePage(mupdf: typeof import("mupdf"), page: any): PageExtract;`

- [ ] **Step 1: Write `captureDevice.ts`**

```ts
import type { PageExtract, Atom, Geom, Label } from "./types";
import { reconstruct } from "./reconstruct";

// `mupdf` here is the module NAMESPACE — callers pass (await import("mupdf")).default,
// exactly like PDFRenderer and the render workers. The ambient src/types/mupdf.d.ts shim
// types the module as { default: any }, so the namespace is `any`; access mupdf.Device /
// mupdf.Matrix directly, NEVER mupdf.default.Device (that would need the raw module and
// crash under the app's standard `.then(m => m.default)` wiring).
const CURVE_STEPS = 8; // chords per bezier when flattening

/** fz matrix concat: result = m * n, both [a,b,c,d,e,f]. */
function matMul(m: number[], n: number[]): number[] {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}
const apply = (m: number[], x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

/**
 * Run a page through a capture Device, returning glyphs (visible + invisible
 * render-mode-3 "SHX" channel) reconstructed into words/labels, plus stroke
 * geometry — all in mupdf page space (points, y-down). Identity CTM at page.run
 * keeps everything in one frame that matches the tile raster and DOM canvas.
 */
export function capturePage(mupdf: any, page: any): PageExtract {
  const visAtoms: Atom[] = [];
  const shxAtoms: Atom[] = [];
  const geometry: Geom[] = [];
  let gid = 0;

  const walkText = (text: any, ctm: number[], bucket: Atom[]) => {
    let span: { m: number[]; ucs: number }[] = [];
    const flushSpan = () => {
      for (let i = 0; i < span.length; i++) {
        const { m, ucs } = span[i];
        const ch = ucs > 0 ? String.fromCodePoint(ucs) : "";
        if (!ch) continue;
        const a = m[0], b = m[1], c = m[2], d = m[3];
        const norm = Math.hypot(a, b) || 1;
        // advance = distance to the next glyph origin within the span (real
        // kerning/advance, incl. skipped space glyphs); last glyph falls back to h.
        const len = i + 1 < span.length
          ? Math.hypot(span[i + 1].m[4] - m[4], span[i + 1].m[5] - m[5])
          : Math.hypot(c, d);
        bucket.push({
          text: ch, x: m[4], y: m[5],
          dirX: a / norm, dirY: b / norm,
          h: Math.hypot(c, d) || 1, len,
          angle: (Math.atan2(b, a) * 180) / Math.PI, font: null,
        });
      }
      span = [];
    };
    text.walk({
      beginSpan() { flushSpan(); },
      showGlyph(_font: any, trm: number[], _gid: number, ucs: number) {
        // Glyph device matrix = trm THEN ctm (mupdf fz_concat(trm, ctm) — apply
        // trm first, then the device ctm). Order matters: matMul(a,b) applies a first.
        span.push({ m: matMul(trm as unknown as number[], ctm), ucs });
      },
      endSpan() { flushSpan(); },
    });
    flushSpan();
  };

  const walkPath = (path: any, ctm: number[]) => {
    let cur: [number, number][] = [];
    let closed = false;
    let px = 0, py = 0;
    const flush = () => {
      if (cur.length >= 2) geometry.push({ id: `g${gid++}`, pts: cur, closed });
      cur = []; closed = false;
    };
    path.walk({
      moveTo(x: number, y: number) { flush(); px = x; py = y; cur = [apply(ctm, x, y)]; },
      lineTo(x: number, y: number) { px = x; py = y; cur.push(apply(ctm, x, y)); },
      curveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) {
        const x0 = px, y0 = py;
        for (let k = 1; k <= CURVE_STEPS; k++) {
          const t = k / CURVE_STEPS, u = 1 - t;
          const bx = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
          const by = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
          cur.push(apply(ctm, bx, by));
        }
        px = x3; py = y3;
      },
      closePath() { closed = true; if (cur.length) cur.push(cur[0]); },
    });
    flush();
  };

  // `mupdf: any` (the namespace) means Device callbacks need explicit `any` params
  // under strict/noImplicitAny. Access mupdf.Device / mupdf.Matrix directly (namespace).
  const device = new mupdf.Device({
    fillText: (text: any, ctm: any) => walkText(text, ctm as unknown as number[], visAtoms),
    strokeText: (text: any, _s: any, ctm: any) => walkText(text, ctm as unknown as number[], visAtoms),
    ignoreText: (text: any, ctm: any) => walkText(text, ctm as unknown as number[], shxAtoms),
    fillPath: (path: any, _eo: any, ctm: any) => walkPath(path, ctm as unknown as number[]),
    strokePath: (path: any, _s: any, ctm: any) => walkPath(path, ctm as unknown as number[]),
  });
  page.run(device, mupdf.Matrix.identity);
  (device as any).close?.();

  const bounds = page.getBounds();
  const view: [number, number, number, number] = [bounds[0], bounds[1], bounds[2], bounds[3]];
  const vis = reconstruct(visAtoms);
  const shx = reconstruct(shxAtoms);
  return { view, labels: vis.labels, words: vis.words, shxLabels: shx.labels as Label[], geometry };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors in `src/features/stitch/autostitch/`. (If mupdf's `Device` constructor callback types complain about the `ctm`/`text` params, keep the `as unknown as number[]` casts shown; the runtime shape is `[a,b,c,d,e,f]`.)

- [ ] **Step 3: Commit**

```bash
git add src/features/stitch/autostitch/captureDevice.ts
git commit -m "feat(autostitch): mupdf capture device -> intermediate extract"
```

---

### Task 7: `autoStitch` orchestrator

**Files:**
- Create: `src/features/stitch/autostitch/autoStitch.ts`

> No vitest test (drives mupdf). The pure pieces it composes (`inferScale`, `stitchSheets`, `layoutPlacements`) are already covered. Verified end-to-end in Task 8's harness.

> **Revised (2026-07-06):** scale inference is deferred to Task 10. This task uses a **thin scale interface** — a uniform user-entered/default scale, NOT `inferScale`. Do not import `scaleInfer`.

**Interfaces:**
- Consumes: `capturePage`, `stitchSheets`/`SheetInput`, `layoutPlacements`/`TilePlacement`, `PageExtract`.
- Produces:
  ```ts
  export interface AutoStitchOptions { userScale?: number | null; onProgress?: (done: number, total: number) => void; }
  export interface AutoStitchResult { placements: TilePlacement[]; rootFtPerIn: number; alignedCount: number; unplacedCount: number; worstResidFt: number; }
  export async function autoStitch(mupdf: any, doc: any, pageIndices: number[], opts?: AutoStitchOptions): Promise<AutoStitchResult>;
  // `mupdf` is the namespace — (await import("mupdf")).default — same as PDFRenderer/harness/modal pass.
  ```

- [ ] **Step 1: Write `autoStitch.ts`**

```ts
import type { PageExtract } from "./types";
import { capturePage } from "./captureDevice";
// NOTE: scale inference (inferScale) is deferred to Task 10. Do not import it yet.
import { stitchSheets, type SheetInput } from "./stitchCore";
import { layoutPlacements, type TilePlacement } from "./layout";

const DEFAULT_SCALE = 20;

export interface AutoStitchOptions {
  userScale?: number | null;
  onProgress?: (done: number, total: number) => void;
}
export interface AutoStitchResult {
  placements: TilePlacement[];
  rootFtPerIn: number;
  alignedCount: number;
  unplacedCount: number;
  worstResidFt: number;
}

/** Yield to the event loop so the tab stays responsive between page extractions. */
const yieldToMain = () => new Promise<void>((r) => setTimeout(r, 0));

export async function autoStitch(
  mupdf: any,
  doc: any,
  pageIndices: number[],
  opts: AutoStitchOptions = {}
): Promise<AutoStitchResult> {
  const total = pageIndices.length;
  const rows: { pageIndex: number; extract: PageExtract; scale: number; sizePt: { w: number; h: number }; no: number }[] = [];

  for (let i = 0; i < pageIndices.length; i++) {
    const pageIndex = pageIndices[i];
    await yieldToMain();
    const page = doc.loadPage(pageIndex);
    let extract: PageExtract;
    try {
      extract = capturePage(mupdf, page);
    } finally {
      page.destroy?.();
    }
    // Scale inference is deferred to Task 10. Until then use a uniform scale
    // (user-entered or default). Same-scale sets place exactly regardless of the
    // value (per-sheet scale cancels in points->feet->canvas). Task 10 replaces
    // this line with per-page inferScale(extract).
    const scale = opts.userScale && opts.userScale > 0 ? opts.userScale : DEFAULT_SCALE;
    const w = extract.view[2] - extract.view[0];
    const h = extract.view[3] - extract.view[1];
    let no = pageIndex + 1;
    for (const l of [...extract.shxLabels, ...extract.labels]) {
      const m = l.text.match(/SHEET\s+(?:NO\.?\s*)?(\d+)\s+OF\s+\d+/i);
      if (m) { no = Number(m[1]); break; }
    }
    rows.push({ pageIndex, extract, scale, sizePt: { w, h }, no });
    opts.onProgress?.(i + 1, total);
  }

  // Unique sheet numbers (printed numbers can collide with synthetic ones).
  const used = new Set<number>();
  for (const r of rows) { while (used.has(r.no)) r.no += 10000; used.add(r.no); }

  const rootFtPerIn = rows[0].scale; // == the stitch root sheet's scale (consistent frame)

  let placementsByNo = new Map<number, { x: number; y: number }>();
  let worstResidFt = 0;
  if (rows.length >= 2) {
    const inputs: SheetInput[] = rows.map((r) => ({
      id: String(r.pageIndex), no: r.no, scale: r.scale, view: r.extract.view, extract: r.extract,
    }));
    const res = stitchSheets(inputs);
    placementsByNo = res.placements;
    worstResidFt = res.worstResidFt;
  }

  const placements = layoutPlacements(
    rows.map((r) => ({ pageIndex: r.pageIndex, scale: r.scale, sizePt: r.sizePt, posFt: placementsByNo.get(r.no) ?? null })),
    rootFtPerIn
  );
  const alignedCount = placements.filter((p) => p.aligned).length;
  return { placements, rootFtPerIn, alignedCount, unplacedCount: placements.length - alignedCount, worstResidFt };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: No new errors.

- [ ] **Step 3: Commit**

```bash
git add src/features/stitch/autostitch/autoStitch.ts
git commit -m "feat(autostitch): orchestrator — capture, infer, stitch, layout"
```

---

### Task 8: `/dev/autostitch` smoke harness (mupdf validation)

**Files:**
- Create: `src/features/dev/AutoStitchSmokeHarness.tsx`
- Modify: `src/router.tsx` (add lazy import + DEV route, mirroring `TileSmokeHarness`)

**Interfaces:**
- Consumes: `autoStitch` from `@/features/stitch/autostitch/autoStitch`.

- [ ] **Step 1: Write the harness** `src/features/dev/AutoStitchSmokeHarness.tsx`

```tsx
/**
 * DEV-only smoke harness for auto-stitch. Pick a multi-page plan PDF; it runs
 * the full pipeline (mupdf capture -> scale infer -> stitch -> layout) and prints
 * per-page scale + placement and the worst seam residual. mupdf WASM cannot run
 * in vitest, so this is how the capture device + orchestrator are validated.
 *
 * Reference input: merge two adjacent Santee sheets (e.g. santee-parkvue p07.pdf
 * = sheet 14 and p08.pdf = sheet 15, a high-confidence token+segment seam) into a
 * 2-page PDF, or load any real grading/utility set.
 */
import { useState } from "react";
import { autoStitch } from "@/features/stitch/autostitch/autoStitch";

export default function AutoStitchSmokeHarness() {
  const [log, setLog] = useState<string>("Choose a multi-page plan PDF…");
  const [busy, setBusy] = useState(false);

  const onFile = async (file: File) => {
    setBusy(true);
    setLog("Loading…");
    try {
      const mupdf = await import("mupdf").then((m) => m.default);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const doc = mupdf.Document.openDocument(bytes, "application/pdf") as any;
      const count = doc.countPages();
      const indices = Array.from({ length: count }, (_, i) => i);
      const t0 = performance.now();
      const res = await autoStitch(mupdf, doc, indices, {
        onProgress: (done, total) => setLog(`Analyzing page ${done}/${total}…`),
      });
      const ms = Math.round(performance.now() - t0);
      const lines = res.placements.map(
        (p) => `  page ${p.pageIndex}: ${p.aligned ? "ALIGNED" : "unplaced"}  x=${p.x.toFixed(0)} y=${p.y.toFixed(0)} w=${p.width.toFixed(0)} h=${p.height.toFixed(0)}`
      );
      setLog(
        [
          `${count} pages in ${ms} ms`,
          `rootFtPerIn=${res.rootFtPerIn}  aligned=${res.alignedCount}  unplaced=${res.unplacedCount}  worstSeam=${res.worstResidFt.toFixed(2)} ft`,
          ...lines,
        ].join("\n")
      );
      doc.destroy?.();
    } catch (e) {
      setLog("ERROR: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: 24, fontFamily: "monospace" }}>
      <h1>Auto-Stitch Smoke Harness</h1>
      <input
        type="file"
        accept="application/pdf"
        disabled={busy}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
      />
      <pre style={{ marginTop: 16, whiteSpace: "pre-wrap" }}>{log}</pre>
    </div>
  );
}
```

- [ ] **Step 2: Register the route** in `src/router.tsx`

Add near the other dev-harness lazy imports (after line 19 `const TiledPageSmokeHarness = ...`):
```ts
const AutoStitchSmokeHarness = lazy(() => import("@/features/dev/AutoStitchSmokeHarness"));
```
Add inside the `import.meta.env.DEV ? [ ... ]` route array (alongside `/dev/tiled-page-smoke`):
```ts
{
  path: "/dev/autostitch",
  element: lazyRoute(<AutoStitchSmokeHarness />),
},
```

- [ ] **Step 3: Run the dev server and validate on real data**

Run: `npm run dev`
Then in the browser open `http://localhost:3000/dev/autostitch` and load a 2+ page plan PDF (reference: a 2-page merge of Santee sheets 14+15). Confirm in the printed log:
1. **Text was recovered** — `rootFtPerIn` is a plausible plan scale (e.g. 20 or 30), *not* the `20` default fallback on every page (that would mean extraction returned nothing). If every page shows exactly `20` with no variation and the source isn't 1"=20', open the console: the capture device likely got no glyphs — see Task 6 risk notes.
2. **Placement happened** — at least the two adjacent sheets show `ALIGNED`, and `worstSeam` is small (well under ~2 ft for a clean token+segment seam; the reference set closes to ~0.04 ft).
3. **No crash**, and total time is acceptable (seconds).

If extraction returns empty on a page whose glyph unicodes are 0 (SHX fonts), note it — the pipeline correctly abstains for that page (it grid-drops), which is acceptable; a cmap fallback in `showGlyph` is a follow-up.

- [ ] **Step 4: Commit**

```bash
git add src/features/dev/AutoStitchSmokeHarness.tsx src/router.tsx
git commit -m "feat(autostitch): DEV smoke harness at /dev/autostitch"
```

---

### Task 9: "Add & auto-align" button in `AddPdfModal`

**Files:**
- Modify: `src/features/stitch/AddPdfModal.tsx`

**Interfaces:**
- Consumes: `autoStitch`, `AutoStitchResult` from `@/features/stitch/autostitch/autoStitch`; `useNotificationStore` from `@/shared/stores/notificationStore`; existing `useStitchStore` (`addTiles`, `setReferenceScaleFeetPerInch`, `setSelectedTileIds`), `PDFRenderer`, `makeWhiteTransparentInPlace`.

- [ ] **Step 1: Add imports** at the top of `AddPdfModal.tsx`

```ts
import { autoStitch } from "@/features/stitch/autostitch/autoStitch";
import { useNotificationStore } from "@/shared/stores/notificationStore";
```

- [ ] **Step 2: Add the handler** inside the `AddPdfModal` component, next to `handleAddToCanvas`

```ts
const handleAddAndAutoAlign = useCallback(async () => {
  if (!mupdfDoc || !pdfBytes || selectedPages.size === 0) return;
  setAdding(true);
  setLoadError(null);
  const selected = Array.from(selectedPages).sort((a, b) => a - b);
  setAddingProgress({ done: 0, total: selected.length });
  try {
    const mupdf = await import("mupdf").then((m) => m.default);
    if (!rendererRef.current) rendererRef.current = new PDFRenderer(mupdf);
    const renderer = rendererRef.current;

    // 1. Render rasters (same as the plain add), keyed by page index.
    const rasters = new Map<number, string>();
    for (let i = 0; i < selected.length; i++) {
      const pageIndex = selected[i];
      await new Promise<void>((r) => setTimeout(r, 0));
      const rendered = await renderer.renderPage(mupdfDoc, pageIndex, { scale: TILE_RENDER_SCALE });
      const imageData = rendered.imageData as ImageData;
      if (imageData?.data && removeWhiteBackground) makeWhiteTransparentInPlace(imageData);
      if (imageData?.data) rasters.set(pageIndex, imageDataToDataUrl(imageData));
      setAddingProgress({ done: i + 1, total: selected.length * 2 }); // rasters are first half
    }

    // 2. Run the deterministic pipeline.
    const userScaleNum = scaleFeetPerInch.trim() ? parseFloat(scaleFeetPerInch.trim()) : NaN;
    const result = await autoStitch(mupdf, mupdfDoc, selected, {
      userScale: Number.isFinite(userScaleNum) && userScaleNum > 0 ? userScaleNum : null,
      onProgress: (done, total) => setAddingProgress({ done: selected.length + done, total: selected.length + total }),
    });

    // 3. Build aligned tiles and commit as one undo step.
    const byPage = new Map(result.placements.map((p) => [p.pageIndex, p]));
    const newTiles = selected.map((pageIndex) => {
      const p = byPage.get(pageIndex)!;
      return {
        sourcePdfBytes: pdfBytes,
        sourcePageIndex: pageIndex,
        sourceFileName: pdfFileName || undefined,
        x: p.x, y: p.y, width: p.width, height: p.height,
        imageDataUrl: rasters.get(pageIndex),
      };
    });
    addTiles(newTiles);
    setReferenceScaleFeetPerInch(result.rootFtPerIn);

    // 4. Leave unaligned tiles selected so the user can place them manually.
    const added = useStitchStore.getState().tiles.slice(-selected.length);
    const unalignedIds = added.filter((t) => byPage.get(t.sourcePageIndex)?.aligned === false).map((t) => t.id);
    if (unalignedIds.length) useStitchStore.getState().setSelectedTileIds(unalignedIds);

    // 5. Report.
    const msg = result.unplacedCount > 0
      ? `Aligned ${result.alignedCount} of ${selected.length} pages · worst seam ${result.worstResidFt.toFixed(2)} ft. ${result.unplacedCount} placed below for manual alignment.`
      : `Aligned ${selected.length} pages · worst seam ${result.worstResidFt.toFixed(2)} ft.`;
    useNotificationStore.getState().showNotification(msg, result.unplacedCount > 0 ? "info" : "success");
    onClose();
  } catch (e) {
    console.error(e);
    setLoadError("Could not auto-align the selected pages. Try 'Add to canvas' and align manually.");
  } finally {
    setAdding(false);
  }
}, [mupdfDoc, pdfBytes, pdfFileName, selectedPages, addTiles, onClose, removeWhiteBackground, scaleFeetPerInch, setReferenceScaleFeetPerInch]);
```

Also add the store selector near the existing ones (top of component):
```ts
const setSelectedTileIds = useStitchStore((s) => s.setSelectedTileIds);
```
(`setSelectedTileIds` is referenced via `getState()` above, but add the selector too so a future refactor has it; if the linter flags it as unused, use it in step 3 instead of `getState().setSelectedTileIds`.)

- [ ] **Step 3: Add the button** in the `DialogFooter` (after the existing "Add … to canvas" button)

```tsx
<Button
  variant="secondary"
  onClick={handleAddAndAutoAlign}
  disabled={!pdfBytes || selectedPages.size < 2 || adding}
  title={selectedPages.size < 2 ? "Select at least 2 pages to auto-align" : undefined}
>
  {adding ? "Aligning…" : `Add & auto-align ${selectedPages.size} pages`}
</Button>
```

- [ ] **Step 4: Update the progress label** so it reads sensibly during the two phases. Find the "Rendering page …" text in the `adding` block and replace with:

```tsx
<p>Working… {addingProgress.done} of {addingProgress.total}</p>
```

- [ ] **Step 5: Typecheck + existing tests**

Run: `npx tsc --noEmit`
Expected: no errors.
Run: `npx vitest run src/features/stitch`
Expected: existing stitch tests still pass (this task only adds a handler + button).

- [ ] **Step 6: Manual verification (visual seam proof)**

Run: `npm run dev`, open `/stitch`, click **Add PDF**, load a real multi-page grading set, select the sheets, click **"Add & auto-align"**. Confirm:
1. Tiles land already aligned in one continuous view; streets/contours flow across seams with no jog (pan across a match line).
2. A mixed-scale set (a 1"=30' sheet with 1"=20' sheets) still lines up (the 30' sheet is resized).
3. The toast reports the aligned count + worst seam. Undo (Cmd/Ctrl-Z) removes all added tiles in one step.

- [ ] **Step 7: Commit**

```bash
git add src/features/stitch/AddPdfModal.tsx
git commit -m "feat(stitch): Add & auto-align button on PDF import"
```

---

## Self-Review

**1. Spec coverage:**
- Spec §1 problem/goal → Task 9 button + full pipeline. ✔
- Spec §2 scale inference → Task 3. ✔
- Spec §2 placement (token/matchline/segment + global LSQ) → Task 4. ✔
- Spec §2 translation + uniform scale, mixed-scale resize → Task 5 mapping. ✔
- Spec §2 fallback grid-drop + flag → Task 5 (`aligned:false` grid) + Task 9 (selection + toast). ✔
- Spec §3 module table → Tasks 1–7 create exactly those modules. ✔
- Spec §4 capture device (`ignoreText` SHX, `Matrix.concat`, path flatten) → Task 6. ✔
- Spec §5 feet→canvas mapping → Task 5, consumed in Task 7. ✔
- Spec §6 UX (button, progress, toast, userScale override, graceful degrade) → Task 9. ✔
- Spec §7 testing (parity unit tests; capture via harness) → Tasks 1–5 vitest + Task 8 harness. ✔
- Spec §8 risks (unicode gaps→abstain; y-frame; flatten; latency yield; single-cluster) → handled in Tasks 6/7 (`yieldToMain`, connected-set filter, abstain path) + Task 8 validation notes. ✔
- Spec §9 non-goals → enforced by scope; no rotation/georef tasks. ✔

**2. Placeholder scan:** No TBD/TODO/"handle edge cases". Ports reference exact source paths with enumerated edits (not "implement later"). New modules and all tests carry full code. ✔

**3. Type consistency:** `PageExtract`/`Label`/`Geom`/`Atom` defined once in Task 1 `types.ts` and consumed unchanged. `SheetInput`/`StitchResult`/`stitchSheets` defined in Task 4 and consumed with the same names in Task 7. `TilePlacement`/`layoutPlacements` defined in Task 5, consumed in Task 7. `capturePage(mupdf, page)` signature defined in Task 6, called with the same args in Task 7. `AutoStitchResult`/`autoStitch(mupdf, doc, pageIndices, opts)` defined in Task 7, called identically in Tasks 8 and 9. ✔

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task with two-stage review between tasks (fast iteration, isolated context).
2. **Inline Execution** — execute tasks in this session with checkpoints for review.
