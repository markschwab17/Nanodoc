# Auto-Stitch on Import — Design Spec

**Date:** 2026-07-06
**Feature:** Deterministic auto-alignment of construction-plan sheets when adding them to the stitch canvas.
**Status:** Approved design, pending implementation plan.

---

## 1. Problem & goal

nanodoc's stitch feature lets a user drop PDF plan pages onto a canvas and **manually** drag/resize/rotate them into one continuous site view. On a real grading/utility set (10–45 D-size sheets) this manual alignment is slow and error-prone.

**Goal:** a single **"Add & auto-align"** action in the Add-PDF flow that places the selected pages onto the canvas *already aligned* in one shared, scale-correct frame — no manual dragging — using purely deterministic PDF-internal data (zero vision models, zero LLM calls).

This is a port of the proven R&D probe `poc-pdf-deconstruct/probe-scale-geo` (in the CTO-Website repo) into nanodoc. That probe demonstrated, on the Santee Parkvue set:

- **Scale inference:** 0.00% error vs the stated `1"=NN'` note on 10/10 sheets; recovered scale even on a sheet with no note.
- **Match-line stitching:** 10/10 sheets placed, **0.04 ft loop-closure**, mixed-scale (1"=30' composed with 1"=20') continuous across seams.

The probe engine (`scale-infer.js`, `stitch-core.js`, `tokens.js`) is pure JS operating on an intermediate JSON `{shxLabels, labels, words, geometry, view}`. That JSON is the real interface; the extraction that produces it is the only platform-specific part.

## 2. Scope

### In scope (v1)
- "Add & auto-align" button in `AddPdfModal`.
- Per-page deterministic **scale inference** (`ft/inch` + confidence).
- Pairwise **placement** (furniture-filtered token vote, matchline prior, windowed segment vote) + **global Huber-robust least-squares** in a world-feet frame.
- **Translation + uniform scale** only. Mixed-scale sheets resized to share one frame.
- Feet-frame → canvas-pixel mapping; tiles placed via one undoable batch.
- **Fallback:** pages that can't be connected to the aligned cluster are grid-placed below it and flagged for manual alignment ("abstain, don't lie").
- Parity unit tests against the probe's own fixtures.

### Explicitly out of scope (v1)
- **Rotation.** North-up is assumed. Rotated detail sheets fall back to grid + existing manual point/scale align. (Rotation-to-north is derivable from bearings — probe §5 — but deferred to a later increment.)
- **Coordinate-grid georeferencing / KMZ / aerial overlay** (probe §3: impossible without an external control point on this class of drawings).
- **North-arrow symbol detection** (probe §5: derive from bearings instead, deferred).
- Web-worker offloading of extraction (noted follow-up if D-size sets feel slow).

## 3. Architecture

New folder `src/features/stitch/autostitch/`. Each unit is single-purpose and independently testable.

| Module | Responsibility | Origin |
|---|---|---|
| `captureDevice.ts` | Run a page through a mupdf `Device`; emit glyphs (visible + invisible SHX) and stroke subpaths in page space. Produce the intermediate JSON. | **New** — replaces the probe's pdf.js `probe-text/opwalk` + `poc-snap-extract`. |
| `reconstruct.ts` | Glyph atoms → `{ words, labels }` by angle-group → line-cluster → baseline-merge. | Port of `probe-text/lib/reconstruct.js` (pure). |
| `tokens.ts` | Classifiers: scale note, distance token, station, bearing, sheet-ref/matchline. | Port of `probe-scale-geo/lib/tokens.js` (pure). |
| `scaleInfer.ts` | 3 channels (dimension↔line, station pairs, scale-bar) → robust `ftPerIn` + confidence. | Port of `probe-scale-geo/scale-infer.js` (pure). |
| `stitchCore.ts` | Furniture filter, token/matchline/segment votes, `solveGlobal` (Huber IRLS LSQ). | Port of `probe-scale-geo/lib/stitch-core.js` (pure). |
| `autoStitch.ts` | Orchestrator: `(mupdfDoc, pageIndices[], perPagePointSize[]) → { placements: {pageIndex, x, y, width, height}[], unplaced: pageIndex[], report }`. | **New**. |

The intermediate JSON keeps the probe's exact field shape:

```ts
interface PageExtract {
  view: [number, number, number, number]; // [x0,y0,x1,y1] in points
  shxLabels: Label[];   // invisible (render-mode-3) reconstructed labels
  labels: Label[];      // visible reconstructed labels
  words: Label[];       // visible words (space-split)
  geometry: Geom[];     // stroke subpaths
}
interface Label { text: string; x: number; y: number; endX: number; endY: number; angle: number; h: number; font: string | null; atoms?: number; }
interface Geom  { id: string; pts: [number, number][]; closed: boolean; }
```

Because the ports consume/produce exactly this shape, they can be validated against the probe's committed `out/*.json` fixtures for numeric parity.

## 4. The one new algorithmic piece — the mupdf capture device

Confirmed available in the installed `mupdf` WASM build (`node_modules/mupdf/dist/mupdf.d.ts`):
`new Device(callbacks: DeviceFunctions)`, `Page.run(device, matrix)`, `Path.walk(walker)`, `Text.walk(walker)`, `Matrix.concat/identity`, and `beginLayer/endLayer`.

Run each page: `page.run(new Device(callbacks), Matrix.identity)`.

**Text** — `fillText`, `strokeText`, and **`ignoreText`** (render mode 3 = the invisible searchable SHX layer CAD plans hide their text in):
- `text.walk({ showGlyph(font, trm, gid, ucs, wmode, bidi) })`.
- Per-glyph device matrix `m = Matrix.concat(ctm, trm)`; from `m = [a,b,c,d,e,f]`:
  - position `(x,y) = (e,f)`; baseline dir `(dirX,dirY) = (a,b)/‖(a,b)‖`; height `h = ‖(c,d)‖`; angle `= atan2(b,a)`; advance `len` from the glyph advance × font scale.
  - unicode from `ucs` (fall back to font cmap when `ucs` is 0/undefined).
- `ignoreText` callbacks route to the **SHX bucket**; `fillText`/`strokeText` to the **visible bucket**. Each bucket → `reconstruct()` → `shxLabels` vs `labels`/`words`.

**Geometry** — `fillPath` and `strokePath`:
- `path.walk({ moveTo, lineTo, curveTo, closePath })`; transform each point by `ctm`; flatten curves by sampling (matching the probe's flattening granularity). Each subpath → `{ pts, closed }`.
- Carry the current `beginLayer` name onto emitted geometry (optional; not required by v1 stitch, but cheap and matches the probe's layer capture).

**Coordinate frame:** with `Matrix.identity`, coordinates arrive in mupdf **page space: points, y-down, top-left origin** — which matches the tile raster and the DOM canvas. The probe ran y-up (pdf.js). The stitch math is invariant under a *globally consistent* y-reflection (all relative deltas resolved into one frame), so running everything y-down is correct and removes the probe's flip. `view = [0, 0, widthPt, heightPt]` from `page.getBounds()`.

> Verification of the frame is the probe's own method: a visual composite that must flow across seams with no jog.

## 5. Feet-frame → canvas mapping

Each tile in nanodoc is sized in **PDF points** (`AddPdfModal.handleAddToCanvas`: `width = widthPt`), so the canvas coordinate space *is* PDF user space — the mapping is a per-tile uniform scale.

- Each page has inferred `ftPerInᵢ`; native points-per-foot `= 72 / ftPerInᵢ`.
- Pick target `P = 72 / ftPerIn_root` (root = the placement root sheet), so the root keeps native size. Each tile scales by `sᵢ = P · ftPerInᵢ / 72` (uniform; only mixed-scale sheets actually change size).
- Pose: `width = widthPtᵢ · sᵢ`, `height = heightPtᵢ · sᵢ`, `x = (posFtᵢ.x − minX)·P + MARGIN`, `y = (posFtᵢ.y − minY)·P + MARGIN`, where `minX/minY` are the min feet-coords over placed tiles.
- Same-scale sets (the common case) get `sᵢ = 1`: repositioned, not resized.
- Set `referenceScaleFeetPerInch = ftPerIn_root` in the store so downstream scale-bar/measure features stay consistent.

## 6. UX & integration in `AddPdfModal`

- Footer gains a second primary button: **"Add & auto-align"** next to the existing **"Add N pages to canvas"** (plain grid add, unchanged).
- Handler mirrors `handleAddToCanvas` up through raster rendering, then:
  1. For each selected page, run `captureDevice` → `PageExtract`. Progress: *"Analyzing page X of N…"* (reuse the existing `addingProgress` bar; extraction interleaved with `yieldToMain()` like the thumbnail loop).
  2. `autoStitch()` → placements + unplaced list + report.
  3. Build tiles: placed ones at their feet-frame pose; **unplaced** ones grid-laid **below** the aligned cluster (reuse existing row-flush layout), each flagged.
  4. One `addTiles(newTiles)` (single undo step) + optional `setReferenceScaleFeetPerInch(ftPerIn_root)`.
  5. Toast summary: *"Aligned N of M pages · worst seam X.XX ft"*; if any unplaced, *"K pages placed below for manual alignment."*
- If the user typed a scale in the existing `Scale 1"=` field, it overrides `ftPerIn_root` for the frame; per-sheet inference still drives relative sizing.
- Failure of the whole pipeline (e.g. no pages yield usable data) degrades gracefully to the plain grid add with a non-blocking notice — never a hard error.

### Flag for unplaced tiles
Add an optional transient marker to the tile (not persisted to export): reuse `selectedTileIds` to leave the unplaced tiles selected, and surface them in the toast. (A dedicated `autoAlignFailed?: boolean` on the tile is a candidate if a persistent badge is wanted; v1 keeps it to selection + toast to avoid touching the export/undo shape.)

## 7. Testing

- **Parity unit tests** (vitest — already configured, existing stitch tests as a pattern):
  - `reconstruct`, `tokens`, `scaleInfer`, `stitchCore` fed the probe's committed `out/*.json` extracts, asserting the FINDINGS numbers: scale error ~0.00% per sheet, worst loop-closure ≈ 0.04 ft, expected per-pair channels/confidence.
  - Fixtures copied (small JSON) into `src/features/stitch/autostitch/__fixtures__/` so tests run without the CTO-Website repo.
- **Capture-device test:** run `captureDevice` on a small committed fixture PDF page and assert the emitted `PageExtract` matches the probe's extract for that page within tolerance (token set equality; geometry segment count/length within ε).
- **Mapping test:** feet-frame → canvas pose math (pure), including a mixed-scale case.
- **Visual proof (manual):** a same-scale set and a mixed-scale set flow across seams with no jog.

## 8. Risks & mitigations

1. **mupdf glyph unicode gaps.** SHX/CAD fonts may report `ucs = 0`. *Mitigation:* fall back to the font's cmap in `showGlyph`; if a page yields too few tokens, the pipeline **abstains** for that page (grid fallback) rather than misplacing it — the probe's designed failure mode.
2. **y-down vs y-up frame bug.** *Mitigation:* one consistent frame end-to-end; visual seam proof; a parity test that flips a probe fixture to y-down and confirms identical placement up to reflection.
3. **Curve flattening mismatch** vs the probe's pdf.js geometry granularity, perturbing the segment vote. *Mitigation:* match the probe's flattening tolerance; the token channel (exact shared strings) is the primary high-confidence channel and is flattening-independent.
4. **Main-thread extraction latency** on large D-size sets. *Mitigation:* `yieldToMain()` interleave + progress bar (matches today's render loop); web-worker offload is the noted follow-up if needed.
5. **Single-cluster assumption.** Disconnected sheets → grid fallback + flag (already designed), never silently misplaced.

## 9. Non-goals restated (guard against scope creep)
No rotation, no georeferencing, no KMZ, no north-arrow detection, no live re-stitch of already-placed tiles (that is the separate "align current canvas tiles" variant, deferred). v1 is import-time, translation + uniform scale, north-up.
