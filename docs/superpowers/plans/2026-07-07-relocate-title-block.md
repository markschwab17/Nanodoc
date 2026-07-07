# Relocate Title-Block Content — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans.

**Goal:** Drag a detected region's content to a free corner of the same sheet (relocate), instead of only hiding it.

**Architecture:** New `relocatedRegions` on the tile (fractions). Preview redraws the source region as a translated, clipped copy of the sheet `<img>`; export redraws the page/image clipped-to-dest and translated. Review drag sets the offset with a live cut-out.

## Global Constraints

- All region/offset values are **fractions of tile size** (0..1); never store px.
- Only **unrotated** tiles relocate (as only they clip).
- Offset clamped so `rect + offset` stays inside `[0,1]` (v1: within the sheet).
- Non-destructive: edits touch `cleanupProposals` until Apply; Apply is one undo snapshot.

---

### Task 1: Data model + store

**Files:** Modify `src/features/stitch/stitchTypes.ts`, `src/shared/stores/stitchStore.ts`

- [ ] Add to `stitchTypes.ts`:
```ts
export interface RelocatedRegion { rect: CropRect; dx: number; dy: number; }
```
and `relocatedRegions?: RelocatedRegion[];` on `StitchTile`.
- [ ] In `stitchStore.ts`, add `"relocatedRegions"` to the `updateTile` and `updateTileNoUndo` patch whitelists. Add a combined action:
```ts
setCleanupRegions: (id: string, hidden: CropRect[], relocated: RelocatedRegion[]) => void;
// impl: pushUndoAndSet(set, get, { tiles: get().tiles.map(t => t.id===id ? {...t, hiddenRegions: hidden, relocatedRegions: relocated} : t) })
```
(snapshotState already deep-copies tiles, so undo/redo captures both.)
- [ ] `npx tsc --noEmit` clean. Commit.

---

### Task 2: Geometry + clip helpers (TDD)

**Files:** Modify `src/features/stitch/cleanup/regionEdit.ts` (+`regionEdit.test.ts`), `src/features/stitch/cleanup/clipRegions.ts` (+`clipRegions.test.ts`)

- [ ] Add `clampOffset` to `regionEdit.ts`:
```ts
/** Clamp a move offset (fractions) so the rect stays fully inside the tile. */
export function clampOffset(r: FRect, dx: number, dy: number): { dx: number; dy: number } {
  return {
    dx: Math.min(Math.max(dx, -r.x), 1 - r.w - r.x),
    dy: Math.min(Math.max(dy, -r.y), 1 - r.h - r.y),
  };
}
```
Tests: within-bounds unchanged; over-left clamps to `-r.x`; over-right clamps to `1-r.w-r.x`.

- [ ] Add `cssClipToRect` to `clipRegions.ts` (show ONLY the rect):
```ts
export function cssClipToRect(tileW: number, tileH: number, rect: { x: number; y: number; w: number; h: number }): string | null {
  if (tileW <= 0 || tileH <= 0) return null;
  const px = (v: number) => `${+((v / tileW) * 100).toFixed(3)}%`;
  const py = (v: number) => `${+((v / tileH) * 100).toFixed(3)}%`;
  const x2 = rect.x + rect.w, y2 = rect.y + rect.h;
  return `polygon(${px(rect.x)} ${py(rect.y)}, ${px(x2)} ${py(rect.y)}, ${px(x2)} ${py(y2)}, ${px(rect.x)} ${py(y2)})`;
}
```
Test: a 25%/50% rect → the four expected `%` corners.
- [ ] Run tests (pass). Commit.

---

### Task 3: Export compositing (TDD the PDF math)

**Files:** Modify `src/features/stitch/stitchExport.ts` (+ a test for the new mapping)

- [ ] Read `tileHoleRectsInPdf` (lines ~193–221). Make it also include `relocatedRegions.map(r => r.rect)` so relocated sources are clipped out. (Keep behavior identical when there are none.)
- [ ] Add `tileRelocationsInPdf(tile, cropX, cropY, cropH)`: for each relocated region, map its source rect and its `(rect shifted by dx,dy)` rect to PDF space with the SAME transform `tileHoleRectsInPdf` uses, returning `{ dest: {x,y,w,h}, offX, offY }` where `offX = dest.x - source.x`, `offY = dest.y - source.y`. Unit-test the offset/dest for a known tile pose (assert `offX ≈ dx·tile.width`, `offY ≈ -dy·tile.height`, dest = source shifted).
- [ ] In the draw loop, after the main `drawPage`/`drawImage` (both branches, before `popGraphicsState`/`continue`), for each relocation:
```ts
for (const rel of relocations) {
  page.pushOperators(pushGraphicsState(), setGraphicsState(multiplyGsName));
  page.pushOperators(
    moveTo(rel.dest.x, rel.dest.y), lineTo(rel.dest.x + rel.dest.w, rel.dest.y),
    lineTo(rel.dest.x + rel.dest.w, rel.dest.y + rel.dest.h), lineTo(rel.dest.x, rel.dest.y + rel.dest.h),
    closePath(), clipEvenOdd(), endPath(),
  );
  // vector: page.drawPage(embeddedPage, { x: drawX + rel.offX, y: drawY + rel.offY, width: tile.width, height: tile.height });
  // raster: page.drawImage(pdfImage, { x: drawX + rel.offX, y: drawY + rel.offY, width: tile.width, height: tile.height });
  page.pushOperators(popGraphicsState());
}
```
(rotated tiles are excluded from relocation, so no `rotate`.)
- [ ] `npx tsc --noEmit` clean; export-math test passes. Commit.

---

### Task 4: Preview render (StitchTile)

**Files:** Modify `src/features/stitch/StitchTile.tsx`

- [ ] Extend `holesPx` to include `relocatedRegions.map(r => r.rect)` scaled to px (source hidden). Guard: only for unrotated tiles (existing pattern).
- [ ] After the main `<img>`, for each relocated region (unrotated only), render:
```tsx
<img src={tile.imageDataUrl} alt="" draggable={false}
  className="absolute inset-0 w-full h-full pointer-events-none select-none object-fill"
  style={{
    transform: `translate(${rel.dx * tile.width}px, ${rel.dy * tile.height}px)`,
    clipPath: cssClipToRect(tile.width, tile.height, { x: rel.rect.x*tile.width, y: rel.rect.y*tile.height, w: rel.rect.w*tile.width, h: rel.rect.h*tile.height }) ?? undefined,
    WebkitClipPath: (same),
  }} />
```
- [ ] `npx tsc --noEmit` clean. Manually confirm no crash. Commit.

---

### Task 5: Review interaction + Apply routing

**Files:** Modify `src/features/stitch/cleanup/CleanupReview.tsx`, `src/features/stitch/StitchCanvas.tsx`, `src/pages/StitchView.tsx`

- [ ] `CleanupRegionUI` gains `move?: { dx: number; dy: number }`.
- [ ] `CleanupReview`: new prop `onRelocateRegion(tileId, index, move | null)`. In `RegionBox`, the **body drag** now calls `onRelocateRegion(tileId, index, clampOffset(startRect, startMove.dx + d.x/tileW, startMove.dy + d.y/tileH))` (base from the region's current `move`), clearing to `null` when both components snap under a small epsilon. During the drag render the live cut-out: `<img src={tile.imageDataUrl}>` clipped to the region (`cssClipToRect`) translated by the current offset. Show a "moved" badge when `move` is set. Pass `tileImageDataUrl` into `RegionBox`. Resize/delete/click unchanged.
- [ ] Thread `onRelocateCleanupRegion` through `StitchCanvas` → `CleanupReview` (mirror `onUpdateCleanupRegion`).
- [ ] `StitchView`:
  - `handleRelocateCleanupRegion(tileId, index, move)` sets `regions[i].move` (or clears it).
  - `handleCleanupApply`: for each proposal, `hidden = regions.filter(r => r.enabled && !r.move).map(r=>r.rect)`; `relocated = regions.filter(r => r.move).map(r => ({ rect: r.rect, dx: r.move.dx, dy: r.move.dy }))`. Call `pushUndoSnapshot()` once, then `updateTileNoUndo(tileId, { hiddenRegions: hidden, relocatedRegions: relocated })` per changed tile. Update the counter/hint text ("drag a box to move it").
- [ ] `npx tsc --noEmit` clean; `npx vitest run src/features/stitch` green. Commit.

---

### Task 6: Browser + export validation

- [ ] In the app, relocate a title block in review → live cut-out follows the cursor; badge shows.
- [ ] Apply → source hidden, piece at its new spot in the composite (StitchTile).
- [ ] Save/flatten to PDF → confirm the piece composites at the destination for a vector tile and a raster (erased) tile; source is clean.
- [ ] Confirm a resized tile keeps the relocation correct (fractions). GIF the flow.
