# Relocate Title-Block Content — Design

**Goal:** In the Clean-Composite review, let the user drag a detected region's **content** to a free corner of the same sheet — the title block/footer stays visible but out of the drawing overlap — instead of only hiding it.

**Context:** Regions are stored as fractions of tile size. Tiles render as a single `<img src={tile.imageDataUrl}>` clipped by `cssClipPathWithHoles`. Export draws each tile (vector `drawPage` or raster `drawImage`) inside an even-odd clip that excludes `hiddenRegions`. Only unrotated tiles are in review/scope.

## Model

A **relocated region** = a source rect cut from its spot and redrawn at an offset. New per-tile field:

```ts
interface RelocatedRegion { rect: CropRect; dx: number; dy: number; } // rect + offset, all fractions of tile size
StitchTile.relocatedRegions?: RelocatedRegion[];
```

`dx`/`dy` are fractions of tile width/height (canvas y-down). The offset is clamped so `rect + offset` stays fully inside the tile (v1: relocation is within the sheet).

In review, `CleanupRegionUI` gains `move?: { dx: number; dy: number }`. A region's fate on Apply:
- `move` set → **relocated** (source hidden + content drawn at dest) → `relocatedRegions`.
- no `move`, `enabled` → **hidden** in place → `hiddenRegions`.
- no `move`, disabled → **kept** (nothing).

Apply writes both `hiddenRegions` and `relocatedRegions` for each tile under **one** undo snapshot.

## Rendering

**Preview (`StitchTile`):** the main `<img>` clip excludes `hiddenRegions` **and** every `relocatedRegions[].rect` (source hidden). For each relocated region, render an extra `<img src={tile.imageDataUrl}>` translated by `(dx·w, dy·h)` and clipped to show ONLY the source rect (`cssClipToRect`) — the piece appears at the destination. Rotated tiles skip relocation (as they skip clipping).

**Review overlay (`CleanupReview`):** dragging a region body sets `move` (relocate). During the drag the overlay renders the live cut-out (same `<img>`, clipped to the region, translated to the current offset) so the content follows the cursor. The dashed box + a "moved" badge mark a relocated region. (v1: the source still shows via `StitchTile` until Apply — a before/after both-visible review; Apply makes it faithful.)

**Export (`stitchExport`):** `tileHoleRectsInPdf` includes `relocatedRegions[].rect` so sources are clipped out. After the main draw, for each relocated region draw the SAME page/image a second time — translated by the offset (in PDF space) and clipped to the destination rect — so only that piece composites at its new spot. Applies to both the vector-embed and raster paths.

## Interaction (per region, in review)

- **Drag body** → relocate: live cut-out follows cursor; drop to place; drag again to reposition; dragging back to ~origin clears `move`. Offset clamped inside the tile.
- **Resize handles** → adjust the source rect (`onUpdateRegion`, unchanged).
- **✕** → delete the region from the proposal (`onDeleteRegion`, unchanged).
- **Click (< threshold)** → toggle hide-in-place ↔ keep (only when not relocated).

## Files

- **Modify** `stitchTypes.ts` — `RelocatedRegion`, `StitchTile.relocatedRegions`.
- **Modify** `stitchStore.ts` — `relocatedRegions` in updateTile/updateTileNoUndo whitelists; `setCleanupRegions(id, hidden, relocated)` (one-undo combined write).
- **Modify** `regionEdit.ts` — `clampOffset(rect, dx, dy)` (offset keeping rect inside [0,1]).
- **Create** test `regionEdit.test.ts` cases for `clampOffset`.
- **Modify** `clipRegions.ts` — `cssClipToRect(tileW, tileH, rect)` (show ONLY the rect) + test.
- **Modify** `stitchExport.ts` — holes include relocated sources; `tileRelocationsInPdf` (dest rect + PDF offset); second clipped+translated draw in both paths.
- **Modify** `StitchTile.tsx` — hide relocated sources; render relocated pieces.
- **Modify** `CleanupReview.tsx` — drag body = relocate w/ live cut-out; `onRelocateRegion` prop; "moved" badge.
- **Modify** `StitchView.tsx` — `handleRelocateCleanupRegion`; Apply routes hidden vs relocated; thread props through `StitchCanvas`.

## Testing

- **Unit:** `clampOffset` (clamps to tile, clears near-origin); `cssClipToRect` (correct polygon); `tileRelocationsInPdf` dest/offset math (PDF y-up mapping, offset = dest−source).
- **Browser:** relocate a title block in review → live cut-out; Apply → source hidden + piece at dest in the composite; export a PDF and confirm the piece composites at its new spot (vector and raster tiles).

## Non-goals (v1)

- Relocating onto a **different** sheet or empty canvas (offset clamped to the tile).
- Relocation on **rotated** tiles (excluded, as clipping is).
- Rotating/scaling the relocated piece (translation only).
