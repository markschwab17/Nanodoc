# Feasibility-gated auto-align — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only offer "Add & auto-align" for PDF page sets that will actually stitch, by running the real aligner once in a background worker when the PDF opens and gating the button on the cached outcome.

**Architecture:** A dedicated worker runs `autoStitch` over all pages (its own mupdf doc, no contention with the modal's thumbnail loop) and posts back placements + a `method` + aligned-page indices. A pure `deriveFeasibility` function turns that + the current selection into a button state. Clicking commits the cached placements — the heavy stitch runs once, not twice; on any probe error the button falls open to today's live path.

**Tech Stack:** React 18 + TypeScript, Vite ES-module workers, mupdf (WASM) in-worker, vitest.

## Global Constraints

- **Thresholds (verbatim, as named constants in `feasibility.ts`):** `KEYMAP_COVERAGE = 0.6`, `GEOM_RATIO_FLOOR = 0.5`, `GEOM_RESID_CEIL_FT = 5`.
- **Method type:** `export type StitchMethod = "keymap" | "geometric" | "none"` — defined in `stitchCore.ts`, imported everywhere else.
- **mupdf import:** `(await import("mupdf")).default` — the namespace default; call methods off it (`mupdf.Document.openDocument`), never `.default.X`.
- **Worker instantiation:** `new Worker(new URL("./autostitch/stitchProbe.worker.ts", import.meta.url), { type: "module" })`. The `new URL` argument MUST be a static **relative** string literal (Vite's worker plugin resolves it at build time) — do NOT use the `@/` alias inside `new URL`. Type-only `import`s may use `@/`.
- **Fail-open:** any probe error, or a probe that hasn't finished, must never remove functionality — the button stays clickable (Task 5) and clicking runs the live `autoStitch` pipeline exactly as today (Task 6).
- **mupdf docs are not concurrency-safe:** the worker opens its OWN doc from the bytes; never pass or share the modal's `mupdfDoc`.
- **Placements are scale-invariant for a uniform set:** the probe runs with `userScale: null`; the *reference* scale applied on commit is the scale field's value at click time, falling back to the probe's `rootFtPerIn`.
- **Process:** TDD (failing test first), one commit per task, exact file paths.
- **Test command:** `npx vitest run <path>`. Type check: `npx tsc --noEmit` (verify no new errors reference the touched files).

---

### Task 1: Surface `method` through the stitch engine

**Files:**
- Modify: `src/features/stitch/autostitch/stitchCore.ts` (interface `StitchResult` at `:371`; returns at `:557` and `:752`)
- Modify: `src/features/stitch/autostitch/autoStitch.ts` (`AutoStitchResult` at `:14-20`; body at `:64`, `:68-90`, `:97`)
- Test: `src/features/stitch/autostitch/stitchCore.test.ts` (append a describe block)

**Interfaces:**
- Produces: `StitchMethod = "keymap" | "geometric" | "none"`; `StitchResult.method: StitchMethod`; `AutoStitchResult.method: StitchMethod`.

- [ ] **Step 1: Write the failing tests** — append to `stitchCore.test.ts` (the `lbl`, `Label`, `PageExtract`, `SheetInput` imports/helpers already exist at the top of the file):

```ts
describe("stitchSheets method", () => {
  const mk = (id: string, no: number, labels: Label[]): SheetInput => ({
    id, no, scale: 20, view: [0, 0, 2592, 1728],
    extract: { view: [0, 0, 2592, 1728], shxLabels: labels, labels, words: labels, geometry: [] } as PageExtract,
  });

  it("reports 'geometric' when sheets stitch by shared tokens", () => {
    const OFF_PT = (300 * 72) / 20;
    const texts = ["TC347.33", "TC348.10", "FL346.90", "TC349.55", "FL347.10", "TC350.02"];
    const a = texts.map((t, i) => lbl(t, 400 + i * 120, 800 + (i % 2) * 60));
    const b = texts.map((t, i) => lbl(t, 400 + i * 120 - OFF_PT, 800 + (i % 2) * 60));
    const res = stitchSheets([mk("a", 1, a), mk("b", 2, b)]);
    expect(res.placements.size).toBe(2);
    expect(res.method).toBe("geometric");
  });

  it("reports 'none' when nothing connects", () => {
    const m1 = lbl("MATCHLINE (SEE SHEET 99)", 2450, 850);
    const m2 = lbl("MATCHLINE (SEE SHEET 88)", 60, 850);
    const res = stitchSheets([mk("1", 1, [m1]), mk("2", 2, [m2])]);
    expect(res.placements.size).toBe(0);
    expect(res.method).toBe("none");
  });

  it("reports 'keymap' when a site grid is supplied", () => {
    const grid = new Map([[1, { col: 0, row: 0 }], [2, { col: 1, row: 0 }]]);
    const res = stitchSheets([mk("1", 1, []), mk("2", 2, [])], grid);
    expect(res.method).toBe("keymap");
    expect(res.placements.size).toBe(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/stitch/autostitch/stitchCore.test.ts -t "stitchSheets method"`
Expected: FAIL — `res.method` is `undefined` (property does not exist yet).

- [ ] **Step 3: Add the type and thread `method` in `stitchCore.ts`**

Just above `export interface StitchResult` (line 371), add the type:

```ts
export type StitchMethod = "keymap" | "geometric" | "none";
```

Add `method` to the interface:

```ts
export interface StitchResult { root: number; placements: Map<number, { x: number; y: number }>; worstResidFt: number; pairs: PairReport[]; method: StitchMethod; }
```

At the key-map branch return (line 557), add `method: "keymap"`:

```ts
    return { root: rootKey, placements, worstResidFt: 0, pairs: [], method: "keymap" };
```

At the final geometric return (line 752), derive from the connected component (`main` is `[]` when fewer than 2 sheets connect, else length ≥ 2):

```ts
  return { root: rootKey, placements, worstResidFt: +worst.toFixed(3), pairs, method: main.length ? "geometric" : "none" };
```

- [ ] **Step 4: Thread `method` through `autoStitch.ts`**

Extend the import at line 4 to include the type:

```ts
import { stitchSheets, type SheetInput, type StitchMethod } from "./stitchCore";
```

Add `method` to `AutoStitchResult` (after `worstResidFt`):

```ts
export interface AutoStitchResult {
  placements: TilePlacement[];
  rootFtPerIn: number;
  alignedCount: number;
  unplacedCount: number;
  worstResidFt: number;
  method: StitchMethod;
}
```

Update the empty-rows early return (line 64) to include `method: "none"`:

```ts
  if (!rows.length) return { placements: [], rootFtPerIn: 0, alignedCount: 0, unplacedCount: 0, worstResidFt: 0, method: "none" };
```

Declare a `method` alongside `worstResidFt` (line 68-69) and set it inside the `rows.length >= 2` block after the `stitchSheets` call (line 87-89):

```ts
  let placementsByNo = new Map<number, { x: number; y: number }>();
  let worstResidFt = 0;
  let method: StitchMethod = "none";
```

```ts
    const res = stitchSheets(inputs, grid);
    placementsByNo = res.placements;
    worstResidFt = res.worstResidFt;
    method = res.method;
```

Include `method` in the final return (line 97):

```ts
  return { placements, rootFtPerIn, alignedCount, unplacedCount: placements.length - alignedCount, worstResidFt, method };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/features/stitch/autostitch/stitchCore.test.ts`
Expected: PASS (the 3 new tests plus all pre-existing stitchCore tests).

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors referencing `stitchCore.ts` or `autoStitch.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/features/stitch/autostitch/stitchCore.ts src/features/stitch/autostitch/autoStitch.ts src/features/stitch/autostitch/stitchCore.test.ts
git commit -m "feat(autostitch): surface placement method (keymap|geometric|none)"
```

---

### Task 2: `deriveFeasibility` — the pure gate

**Files:**
- Create: `src/features/stitch/autostitch/feasibility.ts`
- Test: `src/features/stitch/autostitch/feasibility.test.ts`

**Interfaces:**
- Consumes: `StitchMethod` (Task 1).
- Produces: `deriveFeasibility(probe: FeasibilityInput, selectedPageIndices: number[]): Feasibility`; `FeasibilityInput { method: StitchMethod; alignedPageIndices: number[]; worstResidFt: number }`; `Feasibility { status: "confident" | "partial" | "unstitchable"; alignedInSelection: number; selectedCount: number }`; constants `KEYMAP_COVERAGE`, `GEOM_RATIO_FLOOR`, `GEOM_RESID_CEIL_FT`.

- [ ] **Step 1: Write the failing tests** — create `src/features/stitch/autostitch/feasibility.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveFeasibility } from "./feasibility";

describe("deriveFeasibility", () => {
  it("keymap, all selected aligned -> confident", () => {
    const f = deriveFeasibility({ method: "keymap", alignedPageIndices: [0, 1, 2], worstResidFt: 0 }, [0, 1, 2]);
    expect(f.status).toBe("confident");
    expect(f.alignedInSelection).toBe(3);
    expect(f.selectedCount).toBe(3);
  });

  it("keymap, coverage met but not all -> partial", () => {
    // 3 of 4 = 0.75 >= 0.6
    const f = deriveFeasibility({ method: "keymap", alignedPageIndices: [0, 1, 2], worstResidFt: 0 }, [0, 1, 2, 3]);
    expect(f.status).toBe("partial");
  });

  it("keymap, coverage below floor -> unstitchable", () => {
    // 2 of 5 = 0.4 < 0.6
    const f = deriveFeasibility({ method: "keymap", alignedPageIndices: [0, 1], worstResidFt: 0 }, [0, 1, 2, 3, 4]);
    expect(f.status).toBe("unstitchable");
  });

  it("geometric, good ratio + low residual -> confident", () => {
    const f = deriveFeasibility({ method: "geometric", alignedPageIndices: [0, 1], worstResidFt: 1.2 }, [0, 1]);
    expect(f.status).toBe("confident");
  });

  it("geometric, high residual (pile) -> unstitchable", () => {
    const f = deriveFeasibility({ method: "geometric", alignedPageIndices: [0, 1, 2], worstResidFt: 40 }, [0, 1, 2]);
    expect(f.status).toBe("unstitchable");
  });

  it("geometric, below ratio floor -> unstitchable", () => {
    // 2 of 6 = 0.33 < 0.5
    const f = deriveFeasibility({ method: "geometric", alignedPageIndices: [0, 1], worstResidFt: 1 }, [0, 1, 2, 3, 4, 5]);
    expect(f.status).toBe("unstitchable");
  });

  it("fewer than 2 aligned -> unstitchable", () => {
    const f = deriveFeasibility({ method: "geometric", alignedPageIndices: [0], worstResidFt: 0 }, [0, 1]);
    expect(f.status).toBe("unstitchable");
  });

  it("method none -> unstitchable", () => {
    const f = deriveFeasibility({ method: "none", alignedPageIndices: [], worstResidFt: 0 }, [0, 1]);
    expect(f.status).toBe("unstitchable");
  });

  it("empty selection -> unstitchable", () => {
    const f = deriveFeasibility({ method: "keymap", alignedPageIndices: [0, 1], worstResidFt: 0 }, []);
    expect(f.status).toBe("unstitchable");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/features/stitch/autostitch/feasibility.test.ts`
Expected: FAIL — `Cannot find module "./feasibility"`.

- [ ] **Step 3: Implement `feasibility.ts`** — create `src/features/stitch/autostitch/feasibility.ts`:

```ts
/**
 * Pure feasibility gate for auto-align. Turns a background stitch probe + the
 * current page selection into a button state. Two independent steps:
 *   1. quality gate (enable vs disable) — keymap coverage, or geometric
 *      ratio + a seam-residual ceiling (the piece a raw aligned-count misses:
 *      a "pile" reports a high count but a large residual).
 *   2. confident vs partial — did EVERY selected page make it in.
 */
import type { StitchMethod } from "./stitchCore";

export const KEYMAP_COVERAGE = 0.6;
export const GEOM_RATIO_FLOOR = 0.5;
export const GEOM_RESID_CEIL_FT = 5;

export type FeasibilityStatus = "confident" | "partial" | "unstitchable";

export interface FeasibilityInput {
  method: StitchMethod;
  alignedPageIndices: number[];
  worstResidFt: number;
}

export interface Feasibility {
  status: FeasibilityStatus;
  alignedInSelection: number;
  selectedCount: number;
}

export function deriveFeasibility(probe: FeasibilityInput, selectedPageIndices: number[]): Feasibility {
  const selectedCount = selectedPageIndices.length;
  const aligned = new Set(probe.alignedPageIndices);
  const alignedInSelection = selectedPageIndices.reduce((n, i) => n + (aligned.has(i) ? 1 : 0), 0);
  const ratio = selectedCount > 0 ? alignedInSelection / selectedCount : 0;

  let passesGate = false;
  if (alignedInSelection >= 2) {
    if (probe.method === "keymap") passesGate = ratio >= KEYMAP_COVERAGE;
    else if (probe.method === "geometric") passesGate = ratio >= GEOM_RATIO_FLOOR && probe.worstResidFt <= GEOM_RESID_CEIL_FT;
  }

  if (!passesGate) return { status: "unstitchable", alignedInSelection, selectedCount };
  return { status: alignedInSelection === selectedCount ? "confident" : "partial", alignedInSelection, selectedCount };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/features/stitch/autostitch/feasibility.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/stitch/autostitch/feasibility.ts src/features/stitch/autostitch/feasibility.test.ts
git commit -m "feat(autostitch): deriveFeasibility gate for auto-align"
```

---

### Task 3: Probe result shaping + the worker shell

**Files:**
- Create: `src/features/stitch/autostitch/stitchProbe.ts` (types + `toProbeResult`)
- Create: `src/features/stitch/autostitch/stitchProbe.test.ts`
- Create: `src/features/stitch/autostitch/stitchProbe.worker.ts` (thin message shell)

**Interfaces:**
- Consumes: `AutoStitchResult` (Task 1), `TilePlacement` (`./layout`), `StitchMethod` (Task 1), `autoStitch` (`./autoStitch`).
- Produces: `ProbeResult`, `ProbeMessage`, `ProbeRequest`, `toProbeResult(res: AutoStitchResult, docId: number): ProbeResult`.

- [ ] **Step 1: Write the failing test** — create `src/features/stitch/autostitch/stitchProbe.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toProbeResult } from "./stitchProbe";
import type { AutoStitchResult } from "./autoStitch";

describe("toProbeResult", () => {
  it("extracts aligned page indices and carries method/residual/scale", () => {
    const res: AutoStitchResult = {
      placements: [
        { pageIndex: 0, x: 0, y: 0, width: 100, height: 100, aligned: true },
        { pageIndex: 1, x: 100, y: 0, width: 100, height: 100, aligned: true },
        { pageIndex: 2, x: 0, y: 500, width: 100, height: 100, aligned: false },
      ],
      rootFtPerIn: 20, alignedCount: 2, unplacedCount: 1, worstResidFt: 0, method: "keymap",
    };
    const probe = toProbeResult(res, 7);
    expect(probe.docId).toBe(7);
    expect(probe.alignedPageIndices).toEqual([0, 1]);
    expect(probe.method).toBe("keymap");
    expect(probe.rootFtPerIn).toBe(20);
    expect(probe.worstResidFt).toBe(0);
    expect(probe.placements).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/stitch/autostitch/stitchProbe.test.ts`
Expected: FAIL — `Cannot find module "./stitchProbe"`.

- [ ] **Step 3: Implement `stitchProbe.ts`** — create `src/features/stitch/autostitch/stitchProbe.ts`:

```ts
/**
 * Shared types + result shaping for the auto-align feasibility probe. Imported
 * by both the worker (runtime) and AddPdfModal (types). Kept out of the worker
 * file so `toProbeResult` is unit-testable without spawning a worker.
 */
import type { TilePlacement } from "./layout";
import type { AutoStitchResult } from "./autoStitch";
import type { StitchMethod } from "./stitchCore";

export interface ProbeRequest {
  docId: number;
  pdfBytes: Uint8Array;
  pageIndices: number[];
  userScale: number | null;
}

export interface ProbeResult {
  docId: number;
  placements: TilePlacement[];
  method: StitchMethod;
  alignedPageIndices: number[];
  worstResidFt: number;
  rootFtPerIn: number;
}

export type ProbeMessage = ProbeResult | { docId: number; error: string };

export function toProbeResult(res: AutoStitchResult, docId: number): ProbeResult {
  return {
    docId,
    placements: res.placements,
    method: res.method,
    alignedPageIndices: res.placements.filter((p) => p.aligned).map((p) => p.pageIndex),
    worstResidFt: res.worstResidFt,
    rootFtPerIn: res.rootFtPerIn,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/features/stitch/autostitch/stitchProbe.test.ts`
Expected: PASS.

- [ ] **Step 5: Implement the worker shell** — create `src/features/stitch/autostitch/stitchProbe.worker.ts`:

```ts
/**
 * Stitch feasibility probe worker.
 *
 * Runs the SAME deterministic aligner that "Add & auto-align" runs, once, in a
 * worker with its OWN mupdf document (mupdf docs are not safe to share with the
 * modal's thumbnail-render loop). The result feeds the button's feasibility gate
 * and is committed verbatim on click, so the heavy stitch runs once, not twice.
 *
 * Mirrors the mupdf-in-worker init pattern of src/core/pdf/tiles/tileRender.worker.ts.
 */
import { autoStitch } from "./autoStitch";
import { toProbeResult, type ProbeRequest, type ProbeMessage } from "./stitchProbe";

let mupdf: any = null;
async function ensureMupdf() {
  if (!mupdf) mupdf = (await import("mupdf")).default;
}

self.onmessage = async (e: MessageEvent<ProbeRequest>) => {
  const { docId, pdfBytes, pageIndices, userScale } = e.data;
  try {
    await ensureMupdf();
    const doc = mupdf.Document.openDocument(pdfBytes, "application/pdf");
    let res;
    try {
      res = await autoStitch(mupdf, doc, pageIndices, { userScale });
    } finally {
      doc.destroy?.();
    }
    const msg: ProbeMessage = toProbeResult(res, docId);
    self.postMessage(msg);
  } catch (err) {
    const msg: ProbeMessage = { docId, error: String(err) };
    self.postMessage(msg);
  }
};
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors referencing `stitchProbe.ts` or `stitchProbe.worker.ts`. (The worker's `self`/`MessageEvent` types come from the DOM lib already in `tsconfig`.)

- [ ] **Step 7: Commit**

```bash
git add src/features/stitch/autostitch/stitchProbe.ts src/features/stitch/autostitch/stitchProbe.test.ts src/features/stitch/autostitch/stitchProbe.worker.ts
git commit -m "feat(autostitch): stitch probe worker + result shaping"
```

---

### Task 4: Modal — spawn the probe on load, cache the result

**Files:**
- Modify: `src/features/stitch/AddPdfModal.tsx`

**Interfaces:**
- Consumes: `ProbeResult`, `ProbeMessage`, `ProbeRequest` (Task 3); the `stitchProbe.worker.ts` module (Task 3).
- Produces: modal state `probe: ProbeResult | null`, `probeState: "idle" | "running" | "done" | "error"`, and ref `probeDocIdRef` (consumed by Tasks 5–6).

- [ ] **Step 1: Add the type imports** — after the existing `autoStitch` import (line 25):

```ts
import type { ProbeResult, ProbeMessage, ProbeRequest } from "@/features/stitch/autostitch/stitchProbe";
```

- [ ] **Step 2: Add probe state + refs** — after `mupdfDocRef` (line 101):

```ts
  /** Background stitch probe: runs the real aligner once per loaded doc so the
   *  auto-align button reflects the ACTUAL outcome (see stitchProbe.worker.ts). */
  const probeWorkerRef = useRef<Worker | null>(null);
  /** Monotonic id; a probe reply whose docId != current is stale and ignored. */
  const probeDocIdRef = useRef(0);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probeState, setProbeState] = useState<"idle" | "running" | "done" | "error">("idle");
```

- [ ] **Step 3: Spawn/terminate the worker (one per modal session)** — add a new effect after the unmount-cleanup effect (after line 121):

```ts
  // One probe worker per modal session; terminated on unmount.
  useEffect(() => {
    const w = new Worker(new URL("./autostitch/stitchProbe.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (ev: MessageEvent<ProbeMessage>) => {
      const msg = ev.data;
      if (msg.docId !== probeDocIdRef.current) return; // stale — superseded by a newer load
      if ("error" in msg) {
        console.warn("[stitchProbe] failed:", msg.error);
        setProbe(null);
        setProbeState("error");
        return;
      }
      console.debug("[stitchProbe] method", msg.method, "aligned", msg.alignedPageIndices.length, "/", msg.placements.length);
      setProbe(msg);
      setProbeState("done");
    };
    probeWorkerRef.current = w;
    return () => { w.terminate(); probeWorkerRef.current = null; };
  }, []);
```

- [ ] **Step 4: Kick off the probe when a document loads** — in `loadPdfFromResult`, immediately after `setSelectedPages(new Set())` (line 171):

```ts
        // Kick off the background feasibility probe over the WHOLE document.
        // userScale is null: placements are scale-invariant for a uniform set,
        // so the probe outcome is unaffected and we avoid a stale-closure dep.
        const probeDocId = ++probeDocIdRef.current;
        setProbe(null);
        if (count >= 2) {
          setProbeState("running");
          const req: ProbeRequest = {
            docId: probeDocId,
            pdfBytes: data,
            pageIndices: Array.from({ length: count }, (_, i) => i),
            userScale: null,
          };
          probeWorkerRef.current?.postMessage(req);
        } else {
          setProbeState("idle");
        }
```

- [ ] **Step 5: Invalidate the cache on close and source-tab switch.**

In the `if (!open)` cleanup effect, alongside the other resets (after `setThumbProgress(0)`, line 220), add:

```ts
      setProbe(null);
      setProbeState("idle");
      probeDocIdRef.current++;
```

In BOTH source-tab `onClick` handlers (the "From device" button ~line 537 and "From Civiltakeoff" button ~line 554), after each handler's `setLoadError(null);`, add:

```ts
                setProbe(null);
                setProbeState("idle");
                probeDocIdRef.current++;
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors referencing `AddPdfModal.tsx`. (`probe`/`feasibility` are set but not yet read — that's Task 5. If the linter flags `probe` as unused, it is consumed in Task 5; proceed.)

- [ ] **Step 7: Manual verification (dev server already running on :1420)**

Open the stitch view → Add PDF → choose a multi-page tiled set (e.g. `Imperial-Avalon-Mixed-Use (dragged) 2.pdf`). In the browser console, expect within a few seconds:
`[stitchProbe] method keymap aligned 11 / 11`
Choose a non-tiled multi-page PDF → expect `method geometric …` with a low aligned count, or `method none`.

- [ ] **Step 8: Commit**

```bash
git add src/features/stitch/AddPdfModal.tsx
git commit -m "feat(autostitch): run+cache the feasibility probe on PDF load"
```

---

### Task 5: Modal — drive the button from feasibility

**Files:**
- Modify: `src/features/stitch/AddPdfModal.tsx`

**Interfaces:**
- Consumes: `probe`, `probeState` (Task 4); `deriveFeasibility` (Task 2).

- [ ] **Step 1: Add the import** — after the Task 4 type import (line 26):

```ts
import { deriveFeasibility } from "@/features/stitch/autostitch/feasibility";
```

- [ ] **Step 2: Compute the current selection + feasibility** — just before the `const thumbsStillLoading = …` line (line 524):

```ts
  const selectedIndices = useMemo(() => Array.from(selectedPages).sort((a, b) => a - b), [selectedPages]);
  const feasibility = useMemo(
    () => (probe ? deriveFeasibility(probe, selectedIndices) : null),
    [probe, selectedIndices]
  );
```

(`useMemo` is already imported at line 9 alongside `useState`/`useEffect`/`useCallback`/`useRef`. If not present in the import, add it.)

- [ ] **Step 3: Add a hint line above the footer** — immediately before `<DialogFooter>` (line 729):

```tsx
        {probeState === "done" && feasibility && feasibility.status !== "unstitchable" && (
          <p className="text-xs text-muted-foreground text-right px-1">
            {feasibility.status === "confident"
              ? "✓ Tiled sheet set detected — will auto-align"
              : `${feasibility.alignedInSelection} of ${feasibility.selectedCount} will align · the rest are added below to place manually`}
          </p>
        )}
```

- [ ] **Step 4: Replace the auto-align button** — swap the existing `<Button variant="secondary" …>Add & auto-align…</Button>` block (lines 739-746) for a feasibility-aware version:

```tsx
          {(() => {
            // Fail-open: a still-running probe only DISABLES with a "checking"
            // label; error/absent probe leaves the button enabled (clicking runs
            // the live pipeline, per handleAddAndAutoAlign's fallback).
            const tooFew = selectedPages.size < 2;
            const checking = probeState === "running";
            const unstitchable = probeState === "done" && feasibility?.status === "unstitchable";
            const disabled = adding || tooFew || checking || unstitchable;
            const label = adding
              ? "Aligning…"
              : checking
              ? "Checking alignment…"
              : unstitchable
              ? "Auto-align unavailable"
              : `Add & auto-align ${selectedPages.size} page${selectedPages.size !== 1 ? "s" : ""}`;
            const title = tooFew
              ? "Select at least 2 pages to auto-align"
              : unstitchable
              ? "These pages don't look like one tiled plan set — add them and align manually"
              : undefined;
            return (
              <Button variant="secondary" onClick={handleAddAndAutoAlign} disabled={disabled} title={title}>
                {checking && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
                {label}
              </Button>
            );
          })()}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors referencing `AddPdfModal.tsx`.

- [ ] **Step 6: Manual verification**

- Multi-page tiled set → after a beat the button reads **"Add & auto-align N pages"** and the hint shows **"✓ Tiled sheet set detected"**.
- Deselect pages so only e.g. 2 non-adjacent sheets remain → hint may switch to "M of N will align" (partial) or the button greys to **"Auto-align unavailable"** with the tooltip.
- Non-tiled PDF (a spec book / mixed sheets) → button greys to **"Auto-align unavailable"**; hovering shows the tooltip. The plain "Add … to canvas" button stays enabled throughout.

- [ ] **Step 7: Commit**

```bash
git add src/features/stitch/AddPdfModal.tsx
git commit -m "feat(autostitch): gate the auto-align button on feasibility"
```

---

### Task 6: Modal — commit from cache (with live fallback)

**Files:**
- Modify: `src/features/stitch/AddPdfModal.tsx` (`handleAddAndAutoAlign`, lines 460-522)

**Interfaces:**
- Consumes: `probe`, `probeState` (Task 4); `TilePlacement` (`./autostitch/layout`).

- [ ] **Step 1: Add the `TilePlacement` type import** — after the Task 5 import:

```ts
import type { TilePlacement } from "@/features/stitch/autostitch/layout";
```

- [ ] **Step 2: Rewrite `handleAddAndAutoAlign`** — replace the entire callback (lines 460-522) with the cache-first version. Rasters are still rendered (needed either way); the expensive stitch is skipped when the probe already produced placements:

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

      // 1. Render rasters for the selected pages (same as the plain add).
      const rasters = new Map<number, string>();
      for (let i = 0; i < selected.length; i++) {
        const pageIndex = selected[i];
        await new Promise<void>((r) => setTimeout(r, 0));
        const rendered = await renderer.renderPage(mupdfDoc, pageIndex, { scale: TILE_RENDER_SCALE });
        const imageData = rendered.imageData as ImageData;
        if (imageData?.data && removeWhiteBackground) makeWhiteTransparentInPlace(imageData);
        if (imageData?.data) rasters.set(pageIndex, imageDataToDataUrl(imageData));
        setAddingProgress({ done: i + 1, total: selected.length });
      }

      // 2. Placements: prefer the cached probe (skip the second stitch); else
      //    fall back to running the aligner live (probe absent/errored/running).
      let placements: TilePlacement[];
      let rootFtPerIn: number;
      let worstResidFt: number;
      if (probe && probeState === "done") {
        const sel = new Set(selected);
        placements = probe.placements.filter((p) => sel.has(p.pageIndex));
        rootFtPerIn = probe.rootFtPerIn;
        worstResidFt = probe.worstResidFt;
      } else {
        const userScaleNum = scaleFeetPerInch.trim() ? parseFloat(scaleFeetPerInch.trim()) : NaN;
        const result = await autoStitch(mupdf, mupdfDoc, selected, {
          userScale: Number.isFinite(userScaleNum) && userScaleNum > 0 ? userScaleNum : null,
          onProgress: (done, total) => setAddingProgress({ done, total }),
        });
        placements = result.placements;
        rootFtPerIn = result.rootFtPerIn;
        worstResidFt = result.worstResidFt;
      }

      // 3. Build aligned tiles and commit as one undo step.
      const byPage = new Map(placements.map((p) => [p.pageIndex, p]));
      const newTiles = selected.map((pageIndex) => {
        const p = byPage.get(pageIndex);
        return {
          sourcePdfBytes: pdfBytes,
          sourcePageIndex: pageIndex,
          sourceFileName: pdfFileName || undefined,
          x: p?.x ?? MARGIN, y: p?.y ?? MARGIN,
          width: p?.width ?? 0, height: p?.height ?? 0,
          imageDataUrl: rasters.get(pageIndex),
        };
      });
      addTiles(newTiles);
      const scaleNum = scaleFeetPerInch.trim() ? parseFloat(scaleFeetPerInch.trim()) : NaN;
      setReferenceScaleFeetPerInch(Number.isFinite(scaleNum) && scaleNum > 0 ? scaleNum : rootFtPerIn);

      // 4. Leave unaligned tiles selected so the user can place them manually.
      const added = useStitchStore.getState().tiles.slice(-selected.length);
      const alignedSet = new Set(placements.filter((p) => p.aligned).map((p) => p.pageIndex));
      const unalignedIds = added.filter((t) => !alignedSet.has(t.sourcePageIndex)).map((t) => t.id);
      if (unalignedIds.length) setSelectedTileIds(unalignedIds);

      // 5. Report.
      const alignedCount = selected.length - unalignedIds.length;
      const msg = unalignedIds.length > 0
        ? `Aligned ${alignedCount} of ${selected.length} pages · worst seam ${worstResidFt.toFixed(2)} ft. ${unalignedIds.length} placed below for manual alignment.`
        : `Aligned ${selected.length} pages · worst seam ${worstResidFt.toFixed(2)} ft.`;
      useNotificationStore.getState().showNotification(msg, unalignedIds.length > 0 ? "info" : "success");
      onClose();
    } catch (e) {
      console.error(e);
      setLoadError("Could not auto-align the selected pages. Try 'Add to canvas' and align manually.");
    } finally {
      setAdding(false);
    }
  }, [mupdfDoc, pdfBytes, pdfFileName, selectedPages, addTiles, onClose, removeWhiteBackground, scaleFeetPerInch, setReferenceScaleFeetPerInch, setSelectedTileIds, probe, probeState]);
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors referencing `AddPdfModal.tsx`.

- [ ] **Step 4: Run the full stitch test suite (guard against regressions in the engine the modal calls)**

Run: `npx vitest run src/features/stitch`
Expected: PASS (all pre-existing stitch tests + the new feasibility/probe/method tests).

- [ ] **Step 5: Manual verification**

- **Cached commit:** open a tiled set, wait for the ✓ hint, click **Add & auto-align** → tiles land in the correct layout and the commit is near-instant (only rasters render; no second "checking"/stitch pause). Console shows no second `[stitchProbe]`/autoStitch run.
- **Partial:** a set where a couple of sheets don't align → those drop below and stay selected; toast reads "Aligned M of N …".
- **Fail-open:** temporarily force the worker to throw (e.g. `throw new Error("test")` at the top of the worker's `onmessage`), reload a tiled set → button stays enabled (no ✓ hint), clicking still aligns via the live path. Revert the throw afterward.

- [ ] **Step 6: Commit**

```bash
git add src/features/stitch/AddPdfModal.tsx
git commit -m "feat(autostitch): commit auto-align from the cached probe (live fallback)"
```

---

## Self-Review

**Spec coverage:**
- Background probe / real aligner → Tasks 3 (worker) + 4 (spawn/run). ✓
- Whole document, once on load → Task 4 Step 4 (`pageIndices` = all). ✓
- Worker with its own mupdf doc → Task 3 worker. ✓
- `method` surfaced (keymap/geometric/none) → Task 1. ✓
- `deriveFeasibility` two-step gate (keymap coverage; geometric ratio + residual ceiling; confident vs partial) → Task 2. ✓
- UX states (checking / confident / partial / unstitchable / fail-open) → Task 5. ✓
- Disable-with-tooltip, not hide → Task 5 Step 4. ✓
- Commit from cache, heavy stitch once → Task 6 Step 2. ✓
- Fail-open on error/absent probe → Task 5 (enabled) + Task 6 (live fallback). ✓
- Scale-invariant probe (`userScale: null`) + reference scale from field at click → Task 4 Step 4 + Task 6 Step 2. ✓
- Cache invalidation (docId bump on load/close/tab-switch, stale-guard, terminate on unmount) → Task 4 Steps 3–5. ✓
- Testing (unit `deriveFeasibility`, `method` surfacing, `toProbeResult`; manual modal) → Tasks 1,2,3,5,6. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N" — every code step shows complete code. ✓

**Type consistency:** `StitchMethod` defined in Task 1, imported by Tasks 2/3. `ProbeResult`/`ProbeMessage`/`ProbeRequest` defined in Task 3, consumed in Tasks 4–6. `toProbeResult` signature matches its call in the worker. `deriveFeasibility(FeasibilityInput, number[])` — `ProbeResult` satisfies `FeasibilityInput` structurally (`method`, `alignedPageIndices`, `worstResidFt`), so Task 5 passes `probe` directly. `TilePlacement` fields (`pageIndex,x,y,width,height,aligned`) match usage in Tasks 3 and 6. ✓
