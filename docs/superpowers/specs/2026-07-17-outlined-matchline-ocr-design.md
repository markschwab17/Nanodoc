# Auto-stitch: outlined matchline text (OCR) + multi-strip sheets

**Date:** 2026-07-17
**Status:** Approved (Approach A)

## Problem

Some plan sets — reference case `PG_SITE 1A.pdf` (22-page City of Fontana precise-grading set) — defeat every existing auto-stitch channel:

1. All annotation text, including every "SEE SHEET n" matchline label and the title-block sheet number, is **outlined to vector curves**. Structured text per page is ~500 chars of short utility tags ("WTR", "FS"). The token vote, matchline label prior, and matchline stroke prior all see zero signal, and "SHEET n OF m" numbering falls back to page order.
2. The sheets carry **no key map**, so `detectKeymapGrid` correctly returns null.
3. The only remaining channel, `bandSeamPrior`, false-matches the set's repeated identical building footprints: it emits seams claiming ~50% overlap between adjacent sheets (values sitting right at its `par >= 0.5*dim` acceptance floor), and the global solve collapses sheets into overlapping stacks.
4. At least one page (p1) holds **two plan strips** on one sheet ("SEE ABOVE RIGHT" / "SEE BELOW LEFT" continuation), which the one-translation-per-page model cannot represent at all.

## Goal

`PG_SITE 1A.pdf` (and sets like it) auto-stitches correctly: plan frames — including both strips of a two-strip page — align with sub-foot seams; cover/notes/details sheets stay unplaced. Everything runs offline in the browser (no API keys), matching nanodoc's free/in-browser positioning.

## Non-goals

- AI-service (Gemini) text reading — rejected in favor of offline OCR.
- Raster cross-correlation stitching — same aliasing failure mode as the current band-seam channel.
- A first-class `sourceCrop` tile field — `hiddenRegions` already expresses "show only this region" and is honored by canvas render and export.

## Design

The two additions feed the **existing** pipeline rather than replacing it: OCR restores the text input the label channels were starved of, and frames become the placement unit so the rest of the solver is unchanged in spirit.

### 1. Frame detection — `src/features/stitch/autostitch/frameDetect.ts` (new)

Detect each sheet's plan frame(s) from the already-captured geometry:

- Accumulate long axis-aligned line runs (dashed or solid) binned by cross-coordinate, in the style of `findEdgeStroke`'s dash-span summing.
- Assemble candidate rectangles from strong horizontal/vertical line pairs; accept rectangles covering ≥ ~35% of the page area.
- Yield: 1 frame on a normal plan sheet, 2 stacked frames on a strip sheet, 0 on cover/notes/details sheets.

Fallbacks: detection ambiguous or 0 frames on a geometry-dense page → the whole page is a single unit (today's behavior). API: `detectFrames(extract): { bbox: [x0,y0,x1,y1] }[]` — pure function over `PageExtract`, unit-testable without mupdf.

### 2. OCR band reader — `src/features/stitch/autostitch/ocrBands.ts` (new), lazy `tesseract.js`

Runs **only** for units whose extracted text yields no edge refs (`parseSheetRefs` empty at frame edges):

- Render the four edge bands of the frame (~60 pt strips centered on each frame edge) at ~200 DPI via mupdf pixmap with clip; rotate the vertical bands upright before OCR (try both orientations, keep the higher-confidence read).
- OCR with `tesseract.js` (English, sparse-text mode), lazy-loaded inside the stitch probe worker; results cached per (document, page) so re-probes never re-OCR.
- Words at or above a confidence floor (~60) map back to page-point coordinates and are appended to `extract.labels` as synthetic `Label`s — downstream, `parseSheetRefs`, `matchlinePrior`, `matchlineStrokePrior`, and the windowed segment vote work unchanged.
- The same pass OCRs the title-block sheet-number cell so printed sheet numbers resolve even when they differ from pageIndex + 1; fall back to page order when unreadable.
- `parseSheetRefs` (in `tokens.ts`) learns the intra-page strip refs: "SEE ABOVE RIGHT", "SEE BELOW LEFT" (and LEFT/RIGHT mirror forms) → a sibling-frame reference.

Pixmaps are rendered and destroyed one band at a time to keep worker memory flat.

### 3. Units through the pipeline — `autoStitch.ts`, `stitchCore.ts`

- The stitch unit becomes **(page, frame)**: `view` = frame bbox; labels/geometry sliced to the frame. Single-frame pages degrade to today's whole-page unit.
- `stitchSheets` keys generalize from sheet-no to unit id. A sheet-number ref resolves to the target page's single unit; when the target page has two frames, the pair is formed with the frame whose facing edge opposes the ref's edge (the same opposite-edge rule `matchlinePrior` already applies), and if both qualify, both become candidate pairs — the windowed segment vote and the global solve's outlier rejection keep the wrong one from bonding.
- A strip ref ("SEE BELOW LEFT") adds a candidate pair between the two units of the same page, solved by the same prior + segment-vote machinery as any inter-sheet seam.
- Scale stays uniform per document (per-sheet inference remains deferred, as today).

### 4. Canvas commit — `layout.ts`, `stitchProbe.ts`, `AddPdfModal.tsx`

- `PlacedSheetPose` / `TilePlacement` gain the frame: `{ pageIndex, frameRect, posFt }`; the probe result carries per-unit poses (feasibility counts stay per page).
- `layoutPlacements` positions the **page** so the frame lands at its solved spot; tile width/height remain the full page footprint.
- A two-frame page commits as two `StitchTile`s referencing the same source page, each masking everything outside its own frame via `hiddenRegions` (complement of a rect = ≤ 4 fractional rects). Canvas render and export already honor these masks — no changes there.
- Unplaced pages grid below the aligned cluster, as today.

### 5. Hardening — `bandSeamPrior` in `stitchCore.ts`

Raise the abutment floor from `0.5*dim` to `0.75*dim` (perpendicular tolerance unchanged), rejecting the degenerate 50%-overlap matches observed on this set. With OCR refs available, the seam channel returns to being a last resort for orphan sheets.

## Error handling

| Failure | Behavior |
| --- | --- |
| tesseract.js fails to load or OCR throws | Warn to console, continue without synthetic labels (exactly today's behavior). |
| Frame detection ambiguous / zero frames on a plan-like page | Whole-page unit (today's behavior). |
| OCR misreads text | Strict ref regexes + per-word confidence floor keep garbage out; a lone bogus ref that survives is down-weighted by the existing Huber/outlier rejection in the global solve. |
| Ref targets a sheet number outside the selection | Ignored (existing behavior). |
| OCR slow on huge sheets | Bands only (not full pages), only for ref-less units, cached; progress reported through the existing probe progress channel. |

## Testing

1. **Feasibility spike first** (gates the rest of the build): extend `/dev/autostitch` to render PG_SITE 1A p1's edge bands and print tesseract output — proves the outlined SHX italic text is readable at ~200 DPI before any pipeline work.
2. **Vitest** (no mupdf required):
   - `frameDetect`: synthetic geometry for 1-frame, 2-strip, and frameless pages.
   - `ocrBands` mapping math: OCR word box → page points, including rotated bands (mock OCR output).
   - `tokens`: strip-ref parsing ("SEE ABOVE RIGHT" etc.).
   - `layout`: frame-anchored positioning + hiddenRegions complement math.
   - `stitchCore`: seam-floor regression (0.75 floor rejects the observed 240–310 ft false verticals on 480 ft sheets); synthetic two-strip set reproducing PG_SITE's topology solves to the correct layout.
3. **Acceptance** (manual, `/dev/autostitch` — mupdf WASM cannot run in vitest): PG_SITE 1A stitches with plan frames aligned at sub-foot worst seam; cover/notes/details sheets unplaced; existing suites (`stitchCore`, `layout`, `cleanup`, interop) stay green; a known-good token set (e.g. Santee pair) still stitches identically.

## Reference diagnostics

Full failure analysis in memory note `pg-site-1a-autostitch-failure` (2026-07-17). Repro without UI: drive `stitchCore` in the page via `import('/src/features/stitch/autostitch/stitchCore.ts')` + `import('/@id/mupdf')` against the Vite dev server.
