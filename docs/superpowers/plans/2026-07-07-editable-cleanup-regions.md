# Editable Clean-up Regions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add move / resize / delete direct-manipulation to detected hide-regions in the Clean-Composite review.

**Architecture:** Pure fraction-rect geometry helpers (`regionEdit.ts`, unit-tested) + pointer wiring in `CleanupReview.tsx` + two `StitchView` handlers that mutate the in-review `cleanupProposals`. Regions stay stored as fractions of tile size; Apply/export unchanged.

**Tech Stack:** React 18 + TypeScript, Vitest (jsdom), existing StitchCanvas/CleanupReview overlay.

## Global Constraints

- Regions are **fractions of tile size** (0..1) end-to-end — never store tile px.
- Review tiles are **unrotated**; wrapper is translate-only → canvas delta maps 1:1 to tile px, `/tileSize` = fraction delta.
- Min region size = `MIN_ERASE_SIZE / tileSize` per axis; regions clamp fully inside `[0,1]`.
- Non-destructive: edits touch only `cleanupProposals` until Apply.

---

### Task 1: Pure geometry helpers + tests

**Files:**
- Create: `src/features/stitch/cleanup/regionEdit.ts`
- Test: `src/features/stitch/cleanup/regionEdit.test.ts`

**Interfaces:**
- Produces: `FRect {x,y,w,h}`, `type ResizeHandle`, `moveRegion(r,dx,dy)`, `resizeRegion(r,handle,dx,dy,minW,minH)`, `clampRegion(r,minW,minH)`, `deleteAt(regions,index)`.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import { moveRegion, resizeRegion, clampRegion, deleteAt } from "./regionEdit";

const R = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
describe("moveRegion", () => {
  it("translates by fraction delta", () => {
    expect(moveRegion(R, 0.1, -0.1)).toEqual({ x: 0.5, y: 0.3, w: 0.2, h: 0.2 });
  });
  it("clamps inside the tile, preserving size", () => {
    expect(moveRegion(R, 1, 1)).toEqual({ x: 0.8, y: 0.8, w: 0.2, h: 0.2 });
    expect(moveRegion(R, -1, -1)).toEqual({ x: 0, y: 0, w: 0.2, h: 0.2 });
  });
});
describe("resizeRegion", () => {
  it("east handle grows width, fixes left edge", () => {
    expect(resizeRegion(R, "e", 0.1, 0, 0.02, 0.02)).toEqual({ x: 0.4, y: 0.4, w: 0.3, h: 0.2 });
  });
  it("north handle moves top, fixes bottom", () => {
    const r = resizeRegion(R, "n", 0, -0.1, 0.02, 0.02);
    expect(r.y).toBeCloseTo(0.3); expect(r.h).toBeCloseTo(0.3); // bottom (0.6) fixed
  });
  it("nw corner resizes both, opposite corner fixed", () => {
    const r = resizeRegion(R, "nw", -0.1, -0.1, 0.02, 0.02);
    expect(r.x).toBeCloseTo(0.3); expect(r.y).toBeCloseTo(0.3);
    expect(r.w).toBeCloseTo(0.3); expect(r.h).toBeCloseTo(0.3);
  });
  it("enforces min size on the dragged edge", () => {
    const r = resizeRegion(R, "e", -1, 0, 0.05, 0.05); // collapse width
    expect(r.x).toBeCloseTo(0.4); expect(r.w).toBeCloseTo(0.05); // left fixed, min width
  });
  it("clamps a growing edge to the tile bound", () => {
    const r = resizeRegion(R, "e", 1, 0, 0.02, 0.02);
    expect(r.x + r.w).toBeCloseTo(1);
  });
});
describe("clampRegion", () => {
  it("floors size to min and keeps inside [0,1]", () => {
    expect(clampRegion({ x: 0.95, y: 0.5, w: 0.5, h: 0.01 }, 0.05, 0.05))
      .toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.05 });
  });
});
describe("deleteAt", () => {
  it("removes the index", () => {
    expect(deleteAt([1, 2, 3] as any, 1)).toEqual([1, 3]);
  });
});
```

- [ ] **Step 2: Run — expect fail** (`npx vitest run src/features/stitch/cleanup/regionEdit.test.ts`, module not found).

- [ ] **Step 3: Implement `regionEdit.ts`**

```ts
export interface FRect { x: number; y: number; w: number; h: number; }
export type ResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** Clamp a fraction rect fully inside [0,1], flooring each axis to a minimum size. */
export function clampRegion(r: FRect, minW: number, minH: number): FRect {
  const w = Math.min(1, Math.max(minW, r.w));
  const h = Math.min(1, Math.max(minH, r.h));
  const x = Math.min(Math.max(0, r.x), 1 - w);
  const y = Math.min(Math.max(0, r.y), 1 - h);
  return { x, y, w, h };
}

/** Translate by a fraction delta; size preserved, position clamped inside the tile. */
export function moveRegion(r: FRect, dx: number, dy: number): FRect {
  return clampRegion({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }, r.w, r.h);
}

/** Resize by dragging `handle` a fraction delta (dx,dy). Opposite edge(s) fixed,
 *  min size enforced on the dragged edge, all edges clamped to [0,1]. */
export function resizeRegion(r: FRect, handle: ResizeHandle, dx: number, dy: number, minW: number, minH: number): FRect {
  let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
  const west = handle.includes("w"), east = handle.includes("e");
  const north = handle.includes("n"), south = handle.includes("s");
  if (west) x0 = Math.max(0, r.x + dx);
  if (east) x1 = Math.min(1, r.x + r.w + dx);
  if (north) y0 = Math.max(0, r.y + dy);
  if (south) y1 = Math.min(1, r.y + r.h + dy);
  if (x1 - x0 < minW) { if (west) x0 = x1 - minW; else if (east) x1 = x0 + minW; }
  if (y1 - y0 < minH) { if (north) y0 = y1 - minH; else if (south) y1 = y0 + minH; }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Immutably remove the region at `index`. */
export function deleteAt<T>(regions: T[], index: number): T[] {
  return regions.filter((_, i) => i !== index);
}
```

- [ ] **Step 4: Run — expect pass.**
- [ ] **Step 5: Commit** (`feat(cleanup): fraction-rect move/resize/delete helpers`).

---

### Task 2: Wire editing into review (handlers + UI)

**Files:**
- Modify: `src/features/stitch/stitchConstants.ts` (add `REGION_DRAG_THRESHOLD_PX = 4`)
- Modify: `src/pages/StitchView.tsx` (`updateCleanupRegion`, `deleteCleanupRegion`; pass to `CleanupReview`)
- Modify: `src/features/stitch/cleanup/CleanupReview.tsx` (move/resize/delete UI; new props)

**Interfaces:**
- Consumes: `moveRegion`, `resizeRegion`, `clampRegion`, `deleteAt`, `ResizeHandle` from Task 1; existing `clientToCanvas`, `cleanupProposals`, `setCleanupProposals`.
- Produces: `onUpdateRegion(tileId, index, rect: FRect)`, `onDeleteRegion(tileId, index)` props on `CleanupReview`.

- [ ] **Step 1: Add constant** — `export const REGION_DRAG_THRESHOLD_PX = 4;` in `stitchConstants.ts`.

- [ ] **Step 2: Add StitchView handlers** (near `handleToggleCleanupRegion`):

```ts
const handleUpdateCleanupRegion = useCallback((tileId: string, index: number, rect: { x: number; y: number; w: number; h: number }) => {
  setCleanupProposals((prev) =>
    prev.map((p) => (p.tileId === tileId
      ? { ...p, regions: p.regions.map((r, i) => (i === index ? { ...r, rect } : r)) }
      : p)));
}, []);

const handleDeleteCleanupRegion = useCallback((tileId: string, index: number) => {
  setCleanupProposals((prev) =>
    prev.map((p) => (p.tileId === tileId
      ? { ...p, regions: p.regions.filter((_, i) => i !== index) }
      : p)));
}, []);
```

Pass `onUpdateRegion={handleUpdateCleanupRegion}` and `onDeleteRegion={handleDeleteCleanupRegion}` where `<CleanupReview .../>` is rendered.

- [ ] **Step 3: CleanupReview — extend props + per-region interaction.**
  - Add to `CleanupReviewProps`: `onUpdateRegion: (tileId, index, rect: FRect) => void; onDeleteRegion: (tileId, index) => void;`
  - Per region, replace the plain toggle `<button>` with a container that:
    - **Body pointer-drag:** on `pointerdown` record start canvas point (via `clientToCanvas`) + start rect + `setPointerCapture`. On `pointermove`, `d = canvas.now − start`; if `hypot(d) < REGION_DRAG_THRESHOLD_PX` do nothing yet; once past threshold, mark `moved=true` and call `onUpdateRegion(tileId, i, moveRegion(startRect, d.x/tile.width, d.y/tile.height))`. On `pointerup`: if never `moved`, `onToggleRegion(tileId, i)` (preserve click-toggle); release capture.
    - **8 resize handles** (`n s e w ne nw se sw`), rendered only when this region is hovered or actively dragging. Each handle: `pointerdown` captures + records start; `pointermove` → `onUpdateRegion(tileId, i, resizeRegion(startRect, handle, d.x/tile.width, d.y/tile.height, MIN_ERASE_SIZE/tile.width, MIN_ERASE_SIZE/tile.height))`; `stopPropagation` so it doesn't start a body move. Handles are small (e.g. 10px) absolutely-positioned squares at the edges/corners with appropriate `cursor`.
    - **✕ delete button** top-right corner (shown on hover): `onPointerDown stopPropagation`, `onClick` → `onDeleteRegion(tileId, i)`.
  - Keep the red/amber enabled styling and the kind label.
  - Track hover with local `useState<number | null>` per tile group, or a `{tileId,index}` "active" ref; simplest: a `hovered` state keyed by `${tileId}:${i}`.

- [ ] **Step 4: Type-check** — `npx tsc --noEmit` clean.
- [ ] **Step 5: Unit tests still green** — `npx vitest run src/features/stitch`.
- [ ] **Step 6: Commit** (`feat(cleanup): move/resize/delete hide-regions in review`).

---

### Task 3: Browser validation

- [ ] Load the running app (`localhost:1420`), stitch a few L-shaped sheets, open Clean-up.
- [ ] Drag a footer region's **top edge** up → the hide band grows; **move** a region; **delete** one via ✕; confirm a small click still **toggles** keep/hide.
- [ ] Apply → confirm the edited rects are the ones hidden (preview), and survive a resize of the tile (fractions).
- [ ] Record a short GIF of move/resize/delete for the change record.
