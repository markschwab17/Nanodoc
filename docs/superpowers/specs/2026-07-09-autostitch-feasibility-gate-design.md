# Feasibility-gated auto-align

- **Date:** 2026-07-09
- **Status:** Approved (design) — ready for implementation plan
- **Branch context:** `feat/page-labels` (builds directly on `ed114c9` key-map grid detection)

## Goal

Stop offering **"Add & auto-align"** for PDF page sets that won't actually stitch. Today the button in `AddPdfModal` is shown whenever ≥2 pages are selected, with zero knowledge of whether the pages form a tiled sheet set. The user clicks, waits through the full capture + stitch pipeline, and only then learns — via the *"Aligned 6 of 11"* toast — that it produced a pile.

Instead: run the real aligner **once, in the background, when the PDF opens**, cache the result, and let the cached outcome drive both (a) whether the button is offered and (b) an instant commit when it is clicked. The probe is not extra work — it is the same stitch that clicking would run, moved earlier and cached.

## Resolved decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | How to judge feasibility | **Background probe — run the real `autoStitch` aligner** and gate on its actual outcome (most accurate; it *is* the outcome). Rejected: cheap heuristic pre-check, try-then-decide-on-click. |
| 2 | Probe scope & timing | **Whole document, once on load.** Cache per-page alignment + placements. Button state derives live from the cache as the selection changes — no re-probe on selection change. |
| 3 | Execution context | **A dedicated stitch worker** with its own mupdf doc, not the main thread. Avoids janking the modal during a large-doc probe and avoids `mupdfDoc` contention with the thumbnail-render loop. |
| 4 | Anti-pile quality gate | Count alone is insufficient (the historical pile reported "6 of 11"). Gate on **method + quality**: `keymap` coverage, or `geometric` with an aligned-ratio floor **and** a seam-residual ceiling. |
| 5 | Not-stitchable presentation | **Disable the button with an explanatory tooltip**, not hide it. A greyed button teaches *why*; a vanished button confuses. |
| 6 | Probe failure behaviour | **Fail open** — on any probe error the button stays enabled and clicking runs the live pipeline exactly as today. A probe bug can never remove working functionality. |

## Background & constraints (from codebase exploration)

- **The button today** lives in `AddPdfModal.tsx` (`src/features/stitch/AddPdfModal.tsx:739-746`), `disabled` only when `selectedPages.size < 2`. Its handler `handleAddAndAutoAlign` (`:460`) renders rasters for the selected pages, then calls `autoStitch(mupdf, mupdfDoc, selected, …)`, then builds tiles from `result.placements`.
- **`autoStitch`** (`src/features/stitch/autostitch/autoStitch.ts:25`) already returns `{ placements, rootFtPerIn, alignedCount, unplacedCount, worstResidFt }`. `placements[i].aligned` marks whether a page landed in the largest connected placement. It does **not** currently report *which method* placed the sheets (key-map grid vs geometric LSQ).
- **`alignedCount` is not a quality signal.** The pre-key-map "pile" reported a high `alignedCount` with a visually wrong layout. The distinguishing signal is `worstResidFt` (large for a pile) and/or `method === 'keymap'` (deterministic topology, residual 0 by construction).
- **Key-map detection** (`src/features/stitch/autostitch/keymap.ts`, `detectKeymapGrid`) is the strongest feasibility signal for text-less tiled sets — the exact case that piles under pure geometry. It is already wired into `autoStitch`.
- **mupdf docs are not safe for concurrent use.** The modal's thumbnail loop drives `mupdfDoc` (`AddPdfModal.tsx:178-194`). A probe must not touch that same doc concurrently → the worker opens its **own** doc from `pdfBytes`.
- **Worker infra already exists.** `src/core/pdf/tiles/tileRender.worker.ts` and `src/core/pdf/pdfRender.worker.ts` both `import("mupdf")` inside the worker; `vite.config.ts:54` sets `worker.format = "es"` for exactly this. `autoStitch`'s inputs (`pdfBytes`, `pageIndices`, `userScale`) and its result (plain data: numbers + `{pageIndex,x,y,width,height,aligned}` objects) are fully structured-clone-serializable — no transferables needed.
- **Placements are scale-invariant for a uniform-scale set** (`autoStitch.ts:44-48` comment: same-scale sets place identically regardless of the value). So the probe may run at the default scale; the *reference* scale applied on commit uses the scale field's value at click time. Changing the scale field after the probe requires **no** re-stitch.

## Architecture

```
AddPdfModal opens a PDF
      │
      ├─ thumbnails stream on main thread            (unchanged, uses mupdfDoc)
      │
      └─ stitchProbe.worker.ts  ◄── { docId, pdfBytes, pageIndices: ALL, userScale }
             │  opens its OWN mupdf doc from pdfBytes
             │  runs autoStitch(...) over every page
             └─► ProbeResult {
                    placements: TilePlacement[],   // absolute, shared frame
                    method: 'keymap' | 'geometric' | 'none',
                    alignedPageIndices: number[],
                    worstResidFt: number,
                    rootFtPerIn: number,
                 }
      │
      ▼
  probeRef (cached, keyed to docId) + probeState: 'idle'|'running'|'done'|'error'
      │
      ├─ button = deriveFeasibility(probeRef, selectedPages)   ← pure, recomputed on selection change
      └─ click  → commit cached placements ∩ selection          ← no re-stitch
```

### New unit: `stitchProbe.worker.ts`

Mirrors the init/open-doc handshake of `tileRender.worker.ts`. One message in, one message out.

- **In:** `{ docId: string, pdfBytes: Uint8Array, pageIndices: number[], userScale: number | null }`
- **Work:** `await ensureMupdf()`; open a doc from `pdfBytes`; `const res = await autoStitch(mupdf, doc, pageIndices, { userScale })`; destroy the doc.
- **Out:** `ProbeResult` (see above). On throw, post `{ error: string }`.
- Single-shot per document (no LRU/displaylist cache needed — one probe per load).

### `autoStitch` / `stitchSheets` change: surface `method`

Add `method: 'keymap' | 'geometric' | 'none'` to `AutoStitchResult` (and the underlying `stitchSheets` return). Derivation:

- `'keymap'` when the key-map grid branch placed the sheets (grid present and used).
- `'none'` when fewer than 2 pages landed in the connected placement.
- `'geometric'` otherwise.

This is the only change to the engine; it is additive and does not alter placement behaviour.

### New unit: `deriveFeasibility(probe, selectedPageIndices)` — pure function

The single source of truth for button state. Testable in isolation, no mupdf.

```
interface Feasibility {
  status: 'confident' | 'partial' | 'unstitchable';
  alignedInSelection: number;   // |selected ∩ alignedPageIndices|
  selectedCount: number;
}
```

Two independent steps (thresholds are named, tunable constants):

**Step 1 — the quality gate (enable vs disable).** Does the *set as a whole* stitch well enough to offer at all?

| method | passes the gate when… |
|---|---|
| `keymap` | `alignedInSelection ≥ 2` **and** `alignedInSelection / selectedCount ≥ KEYMAP_COVERAGE (0.6)` |
| `geometric` | `alignedInSelection ≥ 2` **and** `ratio ≥ GEOM_RATIO_FLOOR (0.5)` **and** `worstResidFt ≤ GEOM_RESID_CEIL_FT (5)` |
| `none` | never |

**Step 2 — confident vs partial (only if the gate passed).** Did *every* selected page make it in?

- `alignedInSelection === selectedCount` → **`confident`** (full ✓).
- `alignedInSelection < selectedCount` → **`partial`** (the "M of N" caveat).

If the gate did **not** pass → **`unstitchable`**.

`confident` and `partial` both **enable** the button; `unstitchable` **disables** it. Keeping the gate (quality) and the count (coverage) as separate steps removes any overlap between the two distinctions.

### Data flow — commit from cache (the click path)

`handleAddAndAutoAlign` is rewritten from *"run autoStitch → build tiles"* to *"read cache → build tiles"*:

1. `const probe = probeRef.current`. If absent (probe still running or errored) → **fall back** to the current live path (`autoStitch` on the selected pages). This preserves today's behaviour exactly.
2. Filter `probe.placements` to the selected page indices.
3. Render rasters for the selected pages (unchanged — `renderPage` + optional `makeWhiteTransparentInPlace`).
4. Build tiles from the filtered placements; `addTiles`; `setReferenceScaleFeetPerInch(scaleField ?? probe.rootFtPerIn)`.
5. Selected pages **not** in `alignedPageIndices` drop below for manual placement and stay selected (unchanged behaviour, `AddPdfModal.tsx:505-508`).

Net compute: the heavy stitch runs **once** (the probe). Clicking renders only rasters — the same rasters the plain "Add to canvas" already renders.

### Cache lifecycle & invalidation

- Probe fires from `loadPdfFromResult` after the doc is set, passing the current `pdfBytes` + all page indices to the worker. Keyed by a `docId` (monotonic counter, like `thumbGenRef`).
- New file / "Change file" / source-tab switch → bump `docId`, ignore any late worker message whose `docId` is stale, re-probe.
- Modal close / unmount → terminate the worker (mirror the existing cleanup in the unmount effect, `AddPdfModal.tsx:112-121`).
- Selection change → **no** re-probe; only `deriveFeasibility` re-runs.

## UX states on the button

| State | Button label | Enabled | Hint |
|---|---|---|---|
| Probe running | `Checking alignment…` | no | small spinner |
| `confident` (full) | `Add & auto-align N pages` | yes | ✓ *Tiled sheet set detected* |
| `partial` | `Add & auto-align` | yes | *M of N will align · rest added below to place manually* |
| `unstitchable` | `Auto-align unavailable` | no | tooltip: *These pages don't look like one tiled plan set — add them and align manually* |
| Probe errored | `Add & auto-align N pages` | yes (fail-open) | — (click runs the live pipeline) |

The plain **"Add … to canvas"** button is unaffected in every state.

## Error handling

- **Worker throws** (corrupt page, OOM, mupdf error) → `probeState = 'error'`, button fails open, click runs the live pipeline. Logged to console, not surfaced to the user.
- **Probe slow on a large doc** → button sits in `Checking alignment…` until the message arrives; the plain add button remains usable throughout.
- **Selection changes mid-probe** → allowed; `deriveFeasibility` runs against whatever the cache holds (empty until the probe returns → button shows the running state).
- **Password-protected / unopenable PDF** → never reaches the probe (the existing `needsPassword` / open-error guards in `loadPdfFromResult` short-circuit first).

## Testing

- **Unit (`deriveFeasibility`)** — table-driven over the state matrix: keymap-full, keymap-partial, geometric-good, geometric-high-residual (pile), too-few-aligned, method-none, empty selection. Pure function, no mupdf.
- **Unit (`method` surfacing)** — extend `stitchCore.test.ts`: a set that hits the key-map branch reports `method:'keymap'`; a geometric set reports `'geometric'`; a 1-sheet/degenerate set reports `'none'`.
- **Node diagnostic (worker logic, run against the aligner directly)** — probe both `Imperial-Avalon-Mixed-Use (dragged).pdf` and `(dragged) 2.pdf` → `keymap`, `confident`; a non-tiled multi-page PDF (spec book / mixed sheets) → `unstitchable`.
- **Manual, in-app (Mark)** — open a tiled set → button enables with ✓ after a beat; open a non-tiled set → button greys with tooltip; click a confident set → commits instantly (no second pipeline run); confirm the fail-open path by forcing a probe error.

## Rejected alternatives

- **Cheap heuristic pre-check** (page-size uniformity + vector-ness + key-map presence, no full stitch). Faster, but mis-gates geometric-only sets and can't measure seam quality — it would green-light some piles and hide some stitchable sets. Rejected in favour of the real outcome.
- **Try-then-decide on click** (always show the button; discard a poor result and fall back to a plain grid). Never hides a workable set, but still makes the user wait through a compute they may not benefit from and doesn't satisfy the "don't offer it if it won't work" intent.
- **Re-probe per selection (debounced)** — tightest per-selection accuracy, but re-runs the heavy pipeline on every check/uncheck. The whole-doc probe's per-page `aligned` flags already answer any sub-selection.
- **Main-thread probe after thumbnails** — simpler (reuses the open `mupdfDoc`, no worker), but delays the feasibility hint until all thumbnails finish and janks the modal on large docs. Kept as the fallback if the worker proves problematic.
