# Clean Composite (stitch cleanup) — Design Spec

**Date:** 2026-07-06
**Feature:** Detect and hide non-drawing regions (title blocks / headers / footers / overlap margins, plus manual boxes for notes/legends) on a stitched canvas, so the composite reads as one continuous drawing.
**Status:** Approved design, pending implementation plan.

---

## 1. Problem & goal

When plan sheets are stitched into one canvas, each sheet's **title block, header/footer strip, and the overlap margin past its match lines** overlap the neighboring sheet's drawing area — cluttering the composite with boilerplate (company blocks, revision tables, sheet codes) and double-drawn linework. Users want the composite to show only the continuous *drawing*.

**Goal:** a **"Clean up composite"** action that (a) **auto-detects and proposes** the high-confidence non-drawing regions — the title-block strip and the match-line overlap margins — and (b) lets the user **toggle those proposals and draw boxes** to hide anything else (notes, legends, keymaps). Hiding is **non-destructive and reversible** (region data, never baked into pixels) and carries into export.

## 2. Scope

### In scope (v1)
- **Auto-detect + propose** two region types, reusing data the capture pass already produces:
  - **Title-block / header / footer strip** (high confidence).
  - **Match-line overlap margin** (medium confidence).
- **Manual "box to hide"** tool for any other region.
- **Non-destructive** region model on tiles; toggle/undo; carries into **export**.
- Works on **any stitch canvas** (auto-stitched or manually assembled) — detection runs on demand from each tile's source page, decoupled from the auto-stitch flow.

### Out of scope (v1)
- Auto-detecting notes / legends / keymaps (fuzzy — handled by the manual box).
- Erasing/altering source pixels (this is the existing content-delete feature; Clean Composite is separate and reversible).
- Reflowing or re-cropping the canvas; hidden regions just don't draw.

## 3. Architecture & modules

New/changed units, each with one responsibility:

| Unit | Responsibility |
|---|---|
| `src/features/stitch/cleanup/cleanupDetect.ts` | **Pure detection.** Input: a page's capture extract (`PageExtract`) + the set-shared furniture info. Output: proposed hidden `Rect`s (page-local) with a `kind` (`title-block` \| `match-margin`) and confidence. No mupdf, no DOM — unit-testable with synthetic fixtures. |
| `src/features/stitch/cleanup/cleanupRun.ts` | **Orchestration.** For the current tiles, capture each source page (via the existing `capturePage`), build the set-shared furniture filter, call `cleanupDetect` per page, map page-local rects → tile-local `Rect`s. Returns proposals per tile. Drives mupdf; validated via the dev harness, not vitest. |
| `StitchTile.hiddenRegions?: Rect[]` + store actions | Persisted, non-destructive hidden regions (tile-local). Actions: set/add/toggle/clear, undoable via the existing stitch undo. |
| Cleanup review UI (`CleanupOverlay.tsx` + a box tool) | Review mode: render proposals as toggleable dashed overlays, add manual boxes, Apply/Cancel. |
| `stitchExport` region exclusion | Exclude each tile's `hiddenRegions` when drawing (vector + raster paths) so what's beneath shows through. |
| `StitchTile.tsx` render | Exclude `hiddenRegions` from the displayed tile in the preview composite. |

`Rect` reuses the existing shape convention (`{ x, y, w, h }`, tile-local), consistent with `CropRect`.

## 4. Detection algorithms (`cleanupDetect`)

All detection is deterministic over the capture extract (`{ shxLabels, labels, words, geometry, view }`) — the same data the stitch engine uses. Coordinates are page-local points (mupdf page space), later mapped to tile-local.

### 4.1 Title-block / header / footer strip (high confidence)
1. **Furniture labels.** Reuse `buildFurnitureFilter(sheets, minSheets)` — text that repeats at the same page-local position across the set (company name, revision dates, sheet codes, scale notes). Collect the labels each page's filter flags as furniture, plus the `extractPageLabel` sheet-code position (the title-block corner anchor).
2. **Edge & extent.** Cluster the furniture positions; determine the dominant edge (right strip if the cluster sits at `rightFrac > ~0.7`; bottom/top strip if near a horizontal edge). The strip spans the full length of that edge.
3. **Inner boundary snap.** Set the strip's inner edge to the furniture cluster's inner extent, then snap to the nearest **long border stroke** parallel to the edge (the title-block frame line) from `geometry` — a straight segment spanning most of the sheet within a small band of the cluster edge. This gives a clean rectangle that hugs the actual title-block border.
4. **Set-shared.** A coherent plan set shares title-block geometry, so aggregate across the set (median inner boundary) and produce **one page-local rectangle** applied to every sheet — robust to a single noisy page.

Confidence = high when a furniture cluster AND a snapping border line are both found; medium when only the furniture cluster is found; omit when neither.

### 4.2 Match-line overlap margin (medium confidence)
1. **Match-line labels.** From `parseSheetRefs` (`matchline === true`, `edge !== 'interior'`): each gives an edge + position.
2. **Actual match-line stroke.** For each label, find the real match line — a long straight (often dashed → collinear short segments) stroke spanning most of the sheet, perpendicular to the edge direction (horizontal for top/bottom, vertical for left/right), within a small band of the label's cross-coordinate.
3. **Frame & margin.** The **drawing frame** is the rectangle bounded by the found match lines (and the title-block inner boundary on the title side). Propose the strip(s) **outside** the frame on match-lined edges as `match-margin` regions.
4. **Fallback.** If a match line's stroke isn't cleanly found, fall back to the label position, or omit that edge — never propose a wrong clip.

## 5. Data model

```ts
interface Rect { x: number; y: number; w: number; h: number; } // tile-local (matches CropRect)
// StitchTile gains:
hiddenRegions?: Rect[];   // applied (persisted, non-destructive)
```

Review state (before Apply) lives in a transient cleanup store / component state, holding per-tile **proposed** regions each with `{ rect, kind, enabled }`. Applying writes the enabled regions into each tile's `hiddenRegions` (one undoable step). Toggling flips `enabled`; the manual box tool appends a `{ kind: 'manual', enabled: true }` proposal.

## 6. Rendering & export

**Requirement:** a hidden region is *not drawn* from its tile, so whatever is beneath (the neighbor's drawing, or the white page) shows through — consistent with the existing multiply-blend composite (white → transparent, so painting white would NOT hide; the region must be *excluded*, i.e. clipped).

- **Preview** (`StitchTile.tsx`): clip the displayed tile image to (tile − hiddenRegions) — e.g. a CSS `clip-path` of the tile rect with the hidden rects as holes. In review mode, draw the proposed/hidden rects as dashed outlines instead of clipping, so the user can see and toggle them.
- **Export** (`stitchExport.ts`): before drawing each tile, push a clip path of (tile rect minus hiddenRegions) using the even-odd rule, in BOTH the vector (`drawPage`) and raster (`drawImage`) paths, then pop. Rectangular holes make the clip path straightforward.

Both paths already run inside `pushGraphicsState/popGraphicsState`, so the clip is scoped per tile.

## 7. UI / flow

- A **"Clean up composite"** button in the stitch toolbar (near auto-align).
- Click → **capture + detect** (progress: "Scanning sheets…") → enter **review mode**: proposals render as dashed overlays color-coded by state (amber = proposed/off, red = will-hide) and kind; click a region to toggle; drag on empty canvas to add a manual hide-box; **Apply** commits to `hiddenRegions`, **Cancel** discards.
- After Apply, the composite renders clean; re-opening Clean up shows current hidden regions as toggleable (reversible).
- Export respects `hiddenRegions` automatically.

## 8. Testing

- **`cleanupDetect` unit tests** (vitest, synthetic `PageExtract` fixtures): a right-edge furniture cluster + a vertical border stroke → one title-block rect on the correct edge with the snapped inner boundary; a horizontal `MATCHLINE` + its stroke → a match-margin rect outside the frame; no furniture / no match line → no proposals (abstain, don't guess).
- **Region model** unit tests: set/toggle/clear/undo of `hiddenRegions`; Apply writes only enabled regions.
- **Export exclusion** unit test: the pure clip-geometry helper (tile rect minus rects → clip path spec) for both a right strip and an interior box.
- **Manual / dev harness**: `cleanupRun` (mupdf) validated on a real set via a dev route — confirm the title-block strip and a match-margin are proposed on the correct edges; visual check that Apply + export produce a clean continuous drawing.

## 9. Risks & mitigations

1. **Title block not on the expected edge** (some sets use a bottom strip or a boxed corner). *Mitigation:* edge chosen from the furniture cluster's actual location, not assumed; abstain if no clear cluster (manual box covers it).
2. **Match-line stroke not found / dashed as many tiny segments.** *Mitigation:* collinear-dash aggregation; fall back to label position or omit — never a wrong clip.
3. **Multiply-blend "white ≠ hidden" trap.** *Mitigation:* regions are *clipped out* (excluded), not painted white — verified against the export's `GS_Multiply`.
4. **Vector-path clipping in pdf-lib.** *Mitigation:* rectangular holes → an even-odd clip path; unit-test the clip-geometry helper; the raster path shares the same helper.
5. **Detection cost on large sets.** *Mitigation:* runs on demand (only when the user opens Clean up), reuses the capture pass; progress bar; abstaining is cheap.

## 10. Non-goals (restated)
No pixel erasure, no auto-detection of notes/legends/keymaps (manual box only), no canvas reflow, no dependency on the auto-stitch flow (works on any stitch canvas). Reversible always.
