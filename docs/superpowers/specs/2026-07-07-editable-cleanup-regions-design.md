# Editable Clean-up Regions — Design

**Goal:** Let the user directly manipulate detected/manual hide-regions in the Clean-Composite review — **move**, **resize**, and **delete** each one — before Apply, instead of only toggling keep/hide or drawing new boxes.

**Context:** Clean-up review (`CleanupReview.tsx`) renders each proposed hide-region as a dashed rect inside its tile's transform, positioned at `fraction × tileSize`. Clicking toggles `enabled` (red = hide / amber = keep). A lower z-layer captures empty-canvas drags to draw new manual boxes. Regions are stored as **fractions of tile size**; on Apply they flow to `hiddenRegions`. Only **unrotated** tiles are ever in review (rotated tiles are filtered out upstream), so drag math needs no rotation handling.

## Interactions

Each region rect gains three direct-manipulation affordances:

1. **Move** — pointer-drag on the region body repositions it. A drag below a small threshold (`REGION_DRAG_THRESHOLD_PX = 4`, in canvas px) is treated as a **click → toggle keep/hide** (preserves current behavior); a drag at/above the threshold moves the region and suppresses the toggle.
2. **Resize** — 8 handles (4 corners + 4 edges) drag the corresponding edge(s). Handles are shown only while the pointer is over that region (hover) or while dragging it, keeping the overlay uncluttered. Edge handles are the primary tool (extend a footer's top edge up, pull a column's inner edge in/out).
3. **Delete** — an ✕ button in the region's top-right corner removes it from the proposal entirely (distinct from toggle-off, which greys it but keeps it listed).

## Coordinate model

Review tiles are unrotated and each region wrapper is **translate-only** (`translate(tile.x, tile.y)`, no scale), so:

- A pointer position converts to canvas-area space via the existing `clientToCanvas` (accounts for pan/zoom).
- Canvas-area delta maps **1:1** to tile-local pixels; dividing by `tile.width` / `tile.height` yields the **fraction** delta.
- Move: `rect.{x,y} += delta_frac`, clamped so the rect stays fully inside `[0,1]` (`x ∈ [0, 1−w]`, `y ∈ [0, 1−h]`).
- Resize: the dragged handle moves one or two edges; opposite edges stay fixed. Enforce a minimum size `minFrac = MIN_ERASE_SIZE / tileSize` per axis, and clamp all edges to `[0,1]`.

The geometry (move/resize/clamp) is a **pure function module** (`regionEdit.ts`) so it is unit-testable without a DOM; the pointer wiring in `CleanupReview.tsx` calls it.

## Data flow

Move/resize/delete mutate the in-review `cleanupProposals` state via two new `StitchView` handlers:

- `updateCleanupRegion(tileId, index, rect)` — replace a region's `rect` (used by move and resize).
- `deleteCleanupRegion(tileId, index)` — remove a region; if a tile's `regions` becomes empty the group renders nothing (already handled).

Apply is unchanged: enabled regions → `setHiddenRegions` → clip in preview + export. No data-model, storage, or export changes. Non-destructive and reversible exactly as today (Apply is undoable; re-running detection reproposes).

## Components / files

- **Create** `src/features/stitch/cleanup/regionEdit.ts` — pure helpers: `moveRegion`, `resizeRegion` (by handle), `clampRegion`; plus a `ResizeHandle` type (`'n'|'s'|'e'|'w'|'ne'|'nw'|'se'|'sw'`).
- **Create** `src/features/stitch/cleanup/regionEdit.test.ts` — unit tests for move clamp, each resize handle, min-size, delete-index helper.
- **Modify** `CleanupReview.tsx` — per-region drag (move vs click threshold), 8 hover-shown resize handles, ✕ delete button; new props `onUpdateRegion`, `onDeleteRegion`.
- **Modify** `StitchView.tsx` — `updateCleanupRegion` / `deleteCleanupRegion` handlers; pass to `CleanupReview`.
- **Modify** `stitchConstants.ts` — add `REGION_DRAG_THRESHOLD_PX`.

## Testing

- **Unit** (`regionEdit.test.ts`): move clamps to tile bounds; each of the 8 handles resizes the correct edge(s); min-size floor holds; opposite edge stays fixed; delete removes the right index.
- **Browser validation**: in the running app, drag a footer's top edge up (grows the hide band), move a region, delete one, confirm Apply hides the edited rects — pointer capture, hover handles, and click-vs-drag can't be exercised in jsdom.

## Non-goals

- Moving the actual title-block **content** (chosen against — hide-box editing only).
- Editing regions on **rotated** tiles (excluded from review upstream; unchanged).
- Any change to detection, Apply, or export.
