# Clean Composite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect and non-destructively hide non-drawing regions (title-block/header/footer strips + match-line overlap margins, plus manual boxes) on a stitch canvas so the composite reads as one continuous drawing, carrying into export.

**Architecture:** A pure `cleanupDetect` module finds proposed rectangles from a page's capture extract (reusing the furniture filter + `parseSheetRefs` + geometry the stitch engine already computes); a mupdf `cleanupRun` orchestrates capture+detect per tile and maps page-local rects → tile-local; tiles gain a persisted `hiddenRegions: Rect[]`; preview and both export paths *clip* those regions out (never paint white — the multiply blend turns white transparent); a toolbar "Clean up" button opens a review overlay to toggle proposals and draw manual hide-boxes.

**Tech Stack:** React 18 + TypeScript 5 + Vite, mupdf WASM, pdf-lib, Zustand, vitest (jsdom).

## Global Constraints

- **No new dependencies.**
- **Non-destructive:** hiding never alters `imageDataUrl` or sets `imageModified`. It is stored region data (`hiddenRegions`) applied at render/export and is fully reversible.
- **Hide = clip/exclude, never paint white.** The export composite uses a Multiply blend (`GS_Multiply`), so white → transparent; a hidden region must be excluded from the tile's draw so what's beneath shows through.
- **mupdf WASM cannot run in vitest/jsdom.** Pure modules (`cleanupDetect`, clip geometry, store) are unit-tested in vitest with synthetic fixtures; the mupdf `cleanupRun` and the UI are validated via a DEV `/dev/cleanup` harness + manual check.
- **Reuse existing signals:** `buildFurnitureFilter`, `parseSheetRefs`, `extractPageLabel`, `capturePage` from `src/features/stitch/autostitch/*`. Reuse UI patterns: `IconButtonWithTooltip` (toolbar), the content-delete erase-box mode + `cropRect` overlay (`StitchCanvas.tsx`), `clientToCanvas`.
- Strict TS (`noUnusedLocals`/`noUnusedParameters` true). Path alias `@/` → `src/`. Tests colocated `*.test.ts`. Conventional Commits. Branch: continue on `feature/auto-stitch-import` (or a fresh `feature/clean-composite` if preferred — controller decides at execution).
- Coordinate frame: mupdf page space (points, y-DOWN, top-left origin) throughout detection; tile-local = page points scaled by the tile's `width/heightPt` ratio.
- Run a single test: `npx vitest run <path>`. Typecheck: `npx tsc --noEmit`.

---

### Task 1: Region data model + store

**Files:**
- Modify: `src/features/stitch/stitchTypes.ts`
- Modify: `src/shared/stores/stitchStore.ts`
- Test: `src/shared/stores/cleanupRegions.test.ts`

**Interfaces:**
- Produces: `StitchTile.hiddenRegions?: Rect[]` where `Rect = { x: number; y: number; w: number; h: number }` (tile-local, same shape as `CropRect`). Store action `setHiddenRegions(id: string, regions: Rect[]): void` (undoable via the existing snapshot mechanism).

- [ ] **Step 1: Write the failing test** `src/shared/stores/cleanupRegions.test.ts`

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useStitchStore } from "./stitchStore";

const tile = () => ({
  sourcePdfBytes: new Uint8Array(0), sourcePageIndex: 0,
  x: 0, y: 0, width: 100, height: 80,
});

describe("hiddenRegions store", () => {
  beforeEach(() => useStitchStore.getState().reset());

  it("sets hidden regions on a tile and is undoable", () => {
    const s = useStitchStore.getState();
    s.addTiles([tile()]);
    const id = useStitchStore.getState().tiles[0].id;
    useStitchStore.getState().setHiddenRegions(id, [{ x: 10, y: 20, w: 30, h: 40 }]);
    expect(useStitchStore.getState().tiles[0].hiddenRegions).toEqual([{ x: 10, y: 20, w: 30, h: 40 }]);
    useStitchStore.getState().undo();
    expect(useStitchStore.getState().tiles[0].hiddenRegions).toBeUndefined();
  });

  it("clears hidden regions with an empty array", () => {
    useStitchStore.getState().addTiles([tile()]);
    const id = useStitchStore.getState().tiles[0].id;
    useStitchStore.getState().setHiddenRegions(id, [{ x: 1, y: 1, w: 2, h: 2 }]);
    useStitchStore.getState().setHiddenRegions(id, []);
    expect(useStitchStore.getState().tiles[0].hiddenRegions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `npx vitest run src/shared/stores/cleanupRegions.test.ts`
Expected: FAIL (`setHiddenRegions is not a function`).

- [ ] **Step 3: Add `hiddenRegions` to the tile type** in `src/features/stitch/stitchTypes.ts`, at the end of the `StitchTile` interface (before the closing `}`):

```ts
  /** Non-destructive Clean-Composite regions to hide (tile-local coords). Never bakes into the raster. */
  hiddenRegions?: CropRect[];
```
(`CropRect` is already `{ x, y, w, h }` and declared in this file — reuse it as the Rect shape.)

- [ ] **Step 4: Add the store action + snapshot field** in `src/shared/stores/stitchStore.ts`:
  1. Add `hiddenRegions` to BOTH `updateTile`/`updateTileNoUndo` patch `Pick<...>` unions (find the two `Partial<Pick<StitchTile, ...>>` type lists and append `| "hiddenRegions"` ... i.e. add `"hiddenRegions"` to the picked keys).
  2. Add to the `StitchState` interface: `setHiddenRegions: (id: string, regions: CropRect[]) => void;`
  3. Implement it in the store object (mirror `updateTile`, undoable):
```ts
  setHiddenRegions: (id, regions) =>
    pushUndoAndSet(set, get, {
      tiles: get().tiles.map((t) => (t.id === id ? { ...t, hiddenRegions: regions } : t)),
    }),
```
(Import `CropRect` is already available via `stitchTypes`.)

- [ ] **Step 5: Run — verify it passes**

Run: `npx vitest run src/shared/stores/cleanupRegions.test.ts` → PASS (2 tests). Then `npx tsc --noEmit` → clean.

- [ ] **Step 6: Commit**
```bash
git add src/features/stitch/stitchTypes.ts src/shared/stores/stitchStore.ts src/shared/stores/cleanupRegions.test.ts
git commit -m "feat(cleanup): non-destructive hiddenRegions on stitch tiles"
```

---

### Task 2: `cleanupDetect` — title-block strip

**Files:**
- Create: `src/features/stitch/cleanup/cleanupDetect.ts`
- Test: `src/features/stitch/cleanup/cleanupDetect.test.ts`

**Interfaces:**
- Consumes: `PageExtract`, `Label` from `@/features/stitch/autostitch/types`.
- Produces:
  ```ts
  export interface Rect { x: number; y: number; w: number; h: number; } // page-local points
  export type CleanupKind = "title-block" | "match-margin" | "manual";
  export interface CleanupRegion { rect: Rect; kind: CleanupKind; confidence: "high" | "medium"; }
  export function detectTitleBlock(page: PageExtract, isFurniture: (l: Label) => boolean): CleanupRegion | null;
  ```

- [ ] **Step 1: Write the failing test** `src/features/stitch/cleanup/cleanupDetect.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { detectTitleBlock } from "./cleanupDetect";
import type { PageExtract, Label, Geom } from "@/features/stitch/autostitch/types";

const L = (text: string, x: number, y: number): Label =>
  ({ text, x, y, endX: x + 120, endY: y, angle: 0, h: 10, font: null });
const VIEW = [0, 0, 2592, 1728] as [number, number, number, number];
const base = (labels: Label[], geometry: Geom[] = []): PageExtract =>
  ({ view: VIEW, shxLabels: [], labels, words: labels, geometry });

describe("detectTitleBlock", () => {
  it("finds a right-edge title-block strip and snaps to the border line", () => {
    // furniture clustered on the right margin (x ~ 2100-2400)
    const furn = [L("RICK ENGINEERING", 2120, 200), L("REV 3  06/01/26", 2120, 400), L("SHEET C5.01", 2120, 1600)];
    // a long vertical border stroke at x=2080 (the title-block frame line)
    const border: Geom = { id: "b", pts: [[2080, 40], [2080, 1690]], closed: false };
    const r = detectTitleBlock(base(furn, [border]), () => true);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("title-block");
    // right strip from the snapped border to the page edge
    expect(r!.rect.x).toBeCloseTo(2080, 0);
    expect(r!.rect.w).toBeCloseTo(2592 - 2080, 0);
    expect(r!.rect.h).toBeCloseTo(1728, 0);
    expect(r!.confidence).toBe("high");
  });

  it("abstains when there is no furniture cluster", () => {
    expect(detectTitleBlock(base([L("BUILDING D", 800, 600)]), () => false)).toBeNull();
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `npx vitest run src/features/stitch/cleanup/cleanupDetect.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `cleanupDetect.ts` (title-block part)**

```ts
import type { PageExtract, Label, Geom } from "@/features/stitch/autostitch/types";

export interface Rect { x: number; y: number; w: number; h: number; }
export type CleanupKind = "title-block" | "match-margin" | "manual";
export interface CleanupRegion { rect: Rect; kind: CleanupKind; confidence: "high" | "medium"; }

const cx = (l: Label) => (l.x + l.endX) / 2;
const cy = (l: Label) => (l.y + l.endY) / 2;
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/** Iterate a page's straight segments (endpoints), calling back with each. */
function eachSegment(geometry: Geom[], cb: (ax: number, ay: number, bx: number, by: number) => void) {
  for (const g of geometry) {
    const pts = g.pts; if (!pts || pts.length < 2) continue;
    const n = pts.length - 1 + (g.closed ? 1 : 0);
    for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; cb(a[0], a[1], b[0], b[1]); }
  }
}

/** Longest near-vertical stroke whose x is within `band` of nearX and which spans most of [y0,y1]. Returns its x or null. */
function snapVerticalBorder(geometry: Geom[], nearX: number, y0: number, y1: number, band = 120): number | null {
  const H = y1 - y0; let best: { x: number; span: number } | null = null;
  eachSegment(geometry, (ax, ay, bx, by) => {
    if (Math.abs(bx - ax) > 3) return;                 // vertical
    const x = (ax + bx) / 2;
    if (Math.abs(x - nearX) > band) return;
    const span = Math.abs(by - ay);
    if (span < 0.5 * H) return;                          // spans most of the sheet
    if (!best || span > best.span) best = { x, span };
  });
  return best ? best.x : null;
}

/** Longest near-horizontal stroke near nearY spanning most of [x0,x1]. Returns its y or null. */
function snapHorizontalBorder(geometry: Geom[], nearY: number, x0: number, x1: number, band = 120): number | null {
  const W = x1 - x0; let best: { y: number; span: number } | null = null;
  eachSegment(geometry, (ax, ay, bx, by) => {
    if (Math.abs(by - ay) > 3) return;                 // horizontal
    const y = (ay + by) / 2;
    if (Math.abs(y - nearY) > band) return;
    const span = Math.abs(bx - ax);
    if (span < 0.5 * W) return;
    if (!best || span > best.span) best = { y, span };
  });
  return best ? best.y : null;
}

export function detectTitleBlock(page: PageExtract, isFurniture: (l: Label) => boolean): CleanupRegion | null {
  const [x0, y0, x1, y1] = page.view;
  const W = x1 - x0, H = y1 - y0;
  const furn = [...page.shxLabels, ...page.labels].filter(isFurniture);
  if (furn.length < 3) return null;
  const xs = furn.map(cx), ys = furn.map(cy);
  const rightFrac = (median(xs) - x0) / W, botFrac = (median(ys) - y0) / H;

  if (rightFrac > 0.72) {
    const innerX = Math.min(...xs);
    const snapped = snapVerticalBorder(page.geometry, innerX, y0, y1);
    const bx = snapped ?? innerX;
    return { rect: { x: bx, y: y0, w: x1 - bx, h: H }, kind: "title-block", confidence: snapped != null ? "high" : "medium" };
  }
  if (botFrac > 0.72 || botFrac < 0.14) {
    const bottom = botFrac >= 0.5;
    const innerY = bottom ? Math.min(...ys) : Math.max(...ys);
    const snapped = snapHorizontalBorder(page.geometry, innerY, x0, x1);
    const by = snapped ?? innerY;
    const conf = snapped != null ? "high" : "medium";
    return bottom
      ? { rect: { x: x0, y: by, w: W, h: y1 - by }, kind: "title-block", confidence: conf }
      : { rect: { x: x0, y: y0, w: W, h: by - y0 }, kind: "title-block", confidence: conf };
  }
  return null;
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `npx vitest run src/features/stitch/cleanup/cleanupDetect.test.ts` → PASS (2 tests). `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**
```bash
git add src/features/stitch/cleanup/cleanupDetect.ts src/features/stitch/cleanup/cleanupDetect.test.ts
git commit -m "feat(cleanup): detect title-block strip from furniture cluster + border snap"
```

---

### Task 3: `cleanupDetect` — match-line margins

**Files:**
- Modify: `src/features/stitch/cleanup/cleanupDetect.ts`
- Test: `src/features/stitch/cleanup/cleanupDetect.test.ts` (add cases)

**Interfaces:**
- Consumes: `parseSheetRefs` from `@/features/stitch/autostitch/tokens`.
- Produces: `export function detectMatchMargins(page: PageExtract): CleanupRegion[];`

- [ ] **Step 1: Add the failing test** (append inside the existing describe or a new one) in `cleanupDetect.test.ts`:

```ts
import { detectMatchMargins } from "./cleanupDetect";
// ... (L, VIEW, base already defined above)

describe("detectMatchMargins", () => {
  it("proposes the overlap strip between a match line and its paper edge", () => {
    // A MATCHLINE label near the top edge (y-down: small y), plus the actual
    // long horizontal match-line stroke at y=260.
    const label = { text: "MATCHLINE (SEE SHEET C5.01)", x: 900, y: 250, endX: 1400, endY: 250, angle: 0, h: 10, font: null };
    const line = { id: "m", pts: [[60, 260], [2500, 260]] as [number, number][], closed: false };
    const regions = detectMatchMargins({ view: VIEW, shxLabels: [], labels: [label], words: [label], geometry: [line] });
    expect(regions.length).toBe(1);
    expect(regions[0].kind).toBe("match-margin");
    // top edge (near y0): strip from y0=0 to the line at 260
    expect(regions[0].rect.y).toBeCloseTo(0, 0);
    expect(regions[0].rect.h).toBeCloseTo(260, 0);
    expect(regions[0].rect.w).toBeCloseTo(2592, 0);
  });

  it("abstains when the match-line stroke isn't found", () => {
    const label = { text: "MATCHLINE (SEE SHEET C5.01)", x: 900, y: 250, endX: 1400, endY: 250, angle: 0, h: 10, font: null };
    expect(detectMatchMargins({ view: VIEW, shxLabels: [], labels: [label], words: [label], geometry: [] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `npx vitest run src/features/stitch/cleanup/cleanupDetect.test.ts` → FAIL (`detectMatchMargins` missing).

- [ ] **Step 3: Implement `detectMatchMargins`** — append to `cleanupDetect.ts`:

```ts
import { parseSheetRefs } from "@/features/stitch/autostitch/tokens";

/** Find the match-line stroke coordinate near a matchline label. `axis` = "h"
 *  (label near top/bottom → horizontal line, return its y) or "v" (left/right →
 *  vertical line, return its x). Searches within `band` of the label's cross-coord. */
function findMatchLineStroke(
  geometry: Geom[], axis: "h" | "v", labelCross: number, x0: number, y0: number, x1: number, y1: number, band = 80
): number | null {
  const W = x1 - x0, H = y1 - y0;
  let best: { pos: number; span: number } | null = null;
  eachSegment(geometry, (ax, ay, bx, by) => {
    if (axis === "h") {
      if (Math.abs(by - ay) > 3) return;               // horizontal stroke
      const y = (ay + by) / 2;
      if (Math.abs(y - labelCross) > band) return;
      const span = Math.abs(bx - ax);
      if (span < 0.4 * W) return;                        // dashed lines: this catches the longest dash; good enough for the edge
      if (!best || span > best.span) best = { pos: y, span };
    } else {
      if (Math.abs(bx - ax) > 3) return;
      const x = (ax + bx) / 2;
      if (Math.abs(x - labelCross) > band) return;
      const span = Math.abs(by - ay);
      if (span < 0.4 * H) return;
      if (!best || span > best.span) best = { pos: x, span };
    }
  });
  return best ? best.pos : null;
}

export function detectMatchMargins(page: PageExtract): CleanupRegion[] {
  const [x0, y0, x1, y1] = page.view;
  const refs = parseSheetRefs([...page.shxLabels, ...page.labels], page.view)
    .filter((r) => r.matchline && r.edge !== "interior");
  const out: CleanupRegion[] = [];
  const seenEdges = new Set<string>();
  for (const r of refs) {
    if (seenEdges.has(r.edge)) continue;               // one margin per edge
    const horizontal = r.edge === "top" || r.edge === "bottom";
    const cross = horizontal ? r.at.y : r.at.x;
    const pos = findMatchLineStroke(page.geometry, horizontal ? "h" : "v", cross, x0, y0, x1, y1);
    if (pos == null) continue;
    seenEdges.add(r.edge);
    // parseSheetRefs edge (y-down frame): "top" => label near y1, "bottom" => near y0.
    let rect: Rect;
    if (r.edge === "top") rect = { x: x0, y: pos, w: x1 - x0, h: y1 - pos };
    else if (r.edge === "bottom") rect = { x: x0, y: y0, w: x1 - x0, h: pos - y0 };
    else if (r.edge === "right") rect = { x: pos, y: y0, w: x1 - pos, h: y1 - y0 };
    else rect = { x: x0, y: y0, w: pos - x0, h: y1 - y0 }; // left
    if (rect.w > 2 && rect.h > 2) out.push({ rect, kind: "match-margin", confidence: "medium" });
  }
  return out;
}
```

> NOTE for the implementer: the test's label at `y=250` is near `y0` (top of the y-down page). `parseSheetRefs` classifies edges by proximity to `y1` for `"top"` / `y0` for `"bottom"`, so a label at `y=250` (near `y0`) is `edge="bottom"` → the branch `{ x:x0, y:y0, w, h: pos-y0 }` = `{0,0,2592,260}`. Adjust the test's expected `edge`/branch if `parseSheetRefs` returns `"bottom"` here — the RECT (y=0,h=260) is what matters and is asserted; keep the rect assertions, and if needed loosen the kind/edge coupling. Verify empirically in Step 4 and align the test to the actual `parseSheetRefs` edge label for a near-`y0` position.

- [ ] **Step 4: Run — verify it passes** (adjust the test's edge expectation to match `parseSheetRefs`' actual output for a near-`y0` label, keeping the rect assertions)

Run: `npx vitest run src/features/stitch/cleanup/cleanupDetect.test.ts` → PASS. `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**
```bash
git add src/features/stitch/cleanup/cleanupDetect.ts src/features/stitch/cleanup/cleanupDetect.test.ts
git commit -m "feat(cleanup): detect match-line overlap margins"
```

---

### Task 4: Clip geometry helper (pure) for preview + export

**Files:**
- Create: `src/features/stitch/cleanup/clipRegions.ts`
- Test: `src/features/stitch/cleanup/clipRegions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // CSS clip-path polygon (percent) for a tile of size w×h with rectangular holes.
  export function cssClipPathWithHoles(tileW: number, tileH: number, holes: {x:number;y:number;w:number;h:number}[]): string | null;
  ```
  Returns `null` when there are no holes (caller applies no clip). Uses an even-odd `polygon()` that traces the outer rect then each hole via zero-width bridges (a standard CSS technique), so holes are cut out.

- [ ] **Step 1: Write the failing test** `clipRegions.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { cssClipPathWithHoles } from "./clipRegions";

describe("cssClipPathWithHoles", () => {
  it("returns null with no holes", () => {
    expect(cssClipPathWithHoles(100, 100, [])).toBeNull();
  });
  it("produces a polygon that includes the outer rect and the hole corners", () => {
    const p = cssClipPathWithHoles(200, 100, [{ x: 50, y: 25, w: 50, h: 50 }]);
    expect(p).not.toBeNull();
    expect(p!.startsWith("polygon(")).toBe(true);
    // outer corners present
    expect(p).toContain("0% 0%");
    expect(p).toContain("100% 100%");
    // hole corners as percentages: x 50/200=25%, 100/200=50%; y 25/100=25%, 75/100=75%
    expect(p).toContain("25% 25%");
    expect(p).toContain("50% 75%");
  });
});
```

- [ ] **Step 2: Run — verify it fails.** `npx vitest run src/features/stitch/cleanup/clipRegions.test.ts` → FAIL.

- [ ] **Step 3: Implement `clipRegions.ts`**

```ts
interface Hole { x: number; y: number; w: number; h: number; }

/**
 * Build a CSS `clip-path: polygon(...)` (evenodd) that shows the whole tile
 * EXCEPT the given rectangular holes. Technique: trace the outer rectangle, then
 * for each hole cut in via a zero-width bridge from the outer edge, walk the hole,
 * and return. Coordinates are emitted as percentages of the tile size so the clip
 * survives the tile's CSS scaling. Returns null when there are no holes.
 */
export function cssClipPathWithHoles(tileW: number, tileH: number, holes: Hole[]): string | null {
  if (!holes.length || tileW <= 0 || tileH <= 0) return null;
  const px = (v: number) => `${((v / tileW) * 100).toFixed(3)}%`;
  const py = (v: number) => `${((v / tileH) * 100).toFixed(3)}%`;
  const pt = (x: number, y: number) => `${px(x)} ${py(y)}`;
  const parts: string[] = [
    pt(0, 0), pt(tileW, 0), pt(tileW, tileH), pt(0, tileH), pt(0, 0),
  ];
  for (const h of holes) {
    const x2 = h.x + h.w, y2 = h.y + h.h;
    // bridge from left edge at the hole's top-y, around the hole, and back
    parts.push(pt(0, h.y), pt(h.x, h.y), pt(h.x, y2), pt(x2, y2), pt(x2, h.y), pt(h.x, h.y), pt(0, h.y), pt(0, 0));
  }
  return `polygon(evenodd, ${parts.join(", ")})`;
}
```

- [ ] **Step 4: Run — verify it passes.** `npx vitest run src/features/stitch/cleanup/clipRegions.test.ts` → PASS. `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**
```bash
git add src/features/stitch/cleanup/clipRegions.ts src/features/stitch/cleanup/clipRegions.test.ts
git commit -m "feat(cleanup): CSS clip-path-with-holes helper"
```

---

### Task 5: `cleanupRun` — mupdf capture + detect + map to tile-local

**Files:**
- Create: `src/features/stitch/cleanup/cleanupRun.ts`

> No vitest (drives mupdf). Verified via `npx tsc --noEmit` + the `/dev/cleanup` harness (Task 8).

**Interfaces:**
- Consumes: `capturePage` (`@/features/stitch/autostitch/captureDevice`), `buildFurnitureFilter` (`@/features/stitch/autostitch/stitchCore`), `detectTitleBlock`/`detectMatchMargins`/`CleanupRegion`/`Rect` (`./cleanupDetect`).
- Produces:
  ```ts
  export interface TileProposal { tileId: string; regions: (CleanupRegion & { rect: Rect /* tile-local px */ })[]; }
  export async function detectCleanupForTiles(
    mupdf: any,
    tiles: { id: string; sourcePdfBytes: Uint8Array; sourcePageIndex: number; width: number; height: number }[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<TileProposal[]>;
  ```

- [ ] **Step 1: Implement `cleanupRun.ts`**

```ts
import { capturePage } from "@/features/stitch/autostitch/captureDevice";
import { buildFurnitureFilter } from "@/features/stitch/autostitch/stitchCore";
import { detectTitleBlock, detectMatchMargins, type CleanupRegion, type Rect } from "./cleanupDetect";
import type { PageExtract } from "@/features/stitch/autostitch/types";

export interface TileProposal { tileId: string; regions: CleanupRegion[]; }

const yieldToMain = () => new Promise<void>((r) => setTimeout(r, 0));

/** `mupdf` is the namespace ((await import("mupdf")).default), like PDFRenderer. */
export async function detectCleanupForTiles(
  mupdf: any,
  tiles: { id: string; sourcePdfBytes: Uint8Array; sourcePageIndex: number; width: number; height: number }[],
  onProgress?: (done: number, total: number) => void,
): Promise<TileProposal[]> {
  // 1. capture every tile's source page.
  const docCache = new Map<Uint8Array, any>();
  const extracts: { tile: (typeof tiles)[number]; ex: PageExtract }[] = [];
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i];
    await yieldToMain();
    let doc = docCache.get(t.sourcePdfBytes);
    if (!doc) { doc = mupdf.Document.openDocument(t.sourcePdfBytes, "application/pdf"); docCache.set(t.sourcePdfBytes, doc); }
    const page = doc.loadPage(t.sourcePageIndex);
    let ex: PageExtract;
    try { ex = capturePage(mupdf, page); } finally { page.destroy?.(); }
    extracts.push({ tile: t, ex });
    onProgress?.(i + 1, tiles.length);
  }
  for (const doc of docCache.values()) doc.destroy?.();

  // 2. set-shared furniture filter (needs the whole set to spot repeated boilerplate).
  const furnSheets = extracts.map(({ ex }, i) => ({ key: i, raw: { shxLabels: [...ex.shxLabels, ...ex.labels] } }));
  const furn = buildFurnitureFilter(furnSheets, Math.max(2, Math.min(3, extracts.length)));

  // 3. detect per page, map page-local points -> tile-local px (tile size / page size).
  const out: TileProposal[] = [];
  for (const { tile, ex } of extracts) {
    const [x0, y0, x1, y1] = ex.view;
    const sx = tile.width / (x1 - x0 || 1), sy = tile.height / (y1 - y0 || 1);
    const toLocal = (r: Rect): Rect => ({ x: (r.x - x0) * sx, y: (r.y - y0) * sy, w: r.w * sx, h: r.h * sy });
    const regions: CleanupRegion[] = [];
    const tb = detectTitleBlock(ex, (l) => furn.isFurniture(l));
    if (tb) regions.push({ ...tb, rect: toLocal(tb.rect) });
    for (const m of detectMatchMargins(ex)) regions.push({ ...m, rect: toLocal(m.rect) });
    out.push({ tileId: tile.id, regions });
  }
  return out;
}
```

- [ ] **Step 2: Typecheck.** `npx tsc --noEmit` → clean. (`buildFurnitureFilter` accepts sheets with `.raw.shxLabels` + `.key`; the shape above matches its usage in `stitchCore`. If its exported param type is stricter, cast the array with `as any` — matches the existing `any`-typed furniture sheets.)

- [ ] **Step 3: Commit**
```bash
git add src/features/stitch/cleanup/cleanupRun.ts
git commit -m "feat(cleanup): mupdf capture + detect + map to tile-local proposals"
```

---

### Task 6: Preview — clip hidden regions on the tile

**Files:**
- Modify: `src/features/stitch/StitchTile.tsx`

> Verified via `tsc` + manual (Task 8). The clip helper is already unit-tested (Task 4).

**Interfaces:**
- Consumes: `cssClipPathWithHoles` (`./cleanup/clipRegions`); `tile.hiddenRegions`.

- [ ] **Step 1: Apply the clip to the tile image** in `StitchTile.tsx`. Import at top:
```ts
import { cssClipPathWithHoles } from "./cleanup/clipRegions";
```
Compute the clip near the other derived values (before the `<img>`), using the tile's intrinsic size (`tile.width`/`tile.height`, the same units `hiddenRegions` are in):
```ts
const hiddenClip = cssClipPathWithHoles(tile.width, tile.height, tile.hiddenRegions ?? []);
```
On the `<img>` element (the one with `src={tile.imageDataUrl}`), add to its `style`:
```ts
clipPath: hiddenClip ?? undefined,
WebkitClipPath: hiddenClip ?? undefined,
```
(Find the `<img ... style={{ ... }}>` around line 358 and add these two style properties.)

- [ ] **Step 2: Typecheck + existing stitch tests.** `npx tsc --noEmit` → clean. `npx vitest run src/features/stitch` → still passing.

- [ ] **Step 3: Commit**
```bash
git add src/features/stitch/StitchTile.tsx
git commit -m "feat(cleanup): clip hidden regions out of the preview tile"
```

---

### Task 7: Export — exclude hidden regions from drawn tiles

**Files:**
- Modify: `src/features/stitch/stitchExport.ts`
- Test: `src/features/stitch/stitchExport.test.ts` (add a clip-rect helper test)

**Interfaces:**
- Produces (pure, exported for tests): `export function tileHoleRectsInPdf(tile, cropX, cropY, cropH): {x:number;y:number;w:number;h:number}[];` — each `hiddenRegion` mapped into the export page's PDF coordinate space (y-up), given the tile's draw pose. Returns [] when none.

- [ ] **Step 1: Write the failing test** in `stitchExport.test.ts` (append a new `describe`):

```ts
import { tileHoleRectsInPdf } from "./stitchExport";

describe("tileHoleRectsInPdf", () => {
  test("maps an unrotated tile's hidden region into PDF (y-up) space", () => {
    // tile 100x50 at (30,40); crop full page height 200; hidden region local (10,5,20,10)
    const tile = { x: 30, y: 40, width: 100, height: 50, rotation: 0, hiddenRegions: [{ x: 10, y: 5, w: 20, h: 10 }] } as any;
    const holes = tileHoleRectsInPdf(tile, 0, 0, 200);
    expect(holes).toHaveLength(1);
    // pdf x = tile.x + local.x = 40 ; pdf y = cropH - (tile.y + local.y + local.h) = 200 - (40+5+10) = 145
    expect(holes[0]).toEqual({ x: 40, y: 145, w: 20, h: 10 });
  });
  test("no hidden regions -> empty", () => {
    expect(tileHoleRectsInPdf({ x: 0, y: 0, width: 10, height: 10 } as any, 0, 0, 100)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — verify it fails.** `npx vitest run src/features/stitch/stitchExport.test.ts` → FAIL.

- [ ] **Step 3: Implement `tileHoleRectsInPdf` + wire the clip into the draw loop** in `stitchExport.ts`:

Add the helper (near `pdfPoseForTile`; v1 supports unrotated tiles — auto-align produces `rotation: 0`, and a rotated tile simply skips hole-clipping):
```ts
export function tileHoleRectsInPdf(
  tile: { x: number; y: number; width: number; height: number; rotation?: number; hiddenRegions?: { x: number; y: number; w: number; h: number }[] },
  cropX: number, cropY: number, cropH: number,
): { x: number; y: number; w: number; h: number }[] {
  const regions = tile.hiddenRegions ?? [];
  if (!regions.length || (tile.rotation ?? 0) !== 0) return [];
  return regions.map((r) => ({
    x: tile.x - cropX + r.x,
    y: cropH - (tile.y - cropY + r.y + r.h),   // flip to PDF y-up
    w: r.w, h: r.h,
  }));
}
```

In `exportStitchToPdf`, inside the `for (const tile of tilesToDraw)` loop, right after computing `drawX/drawY/rotation`, compute holes and (when present) push an even-odd clip that excludes them, before the vector/raster draw; pop it after. Concretely, wrap BOTH draw paths: replace each `page.pushOperators(pushGraphicsState(), setGraphicsState(multiplyGsName));` ... `page.pushOperators(popGraphicsState());` block so the clip is added inside the graphics-state save:

```ts
const holes = tileHoleRectsInPdf(tile, cropX, cropY, cropH);
// helper to open a clipped graphics state that excludes the holes (even-odd)
const openClipped = () => {
  page.pushOperators(pushGraphicsState(), setGraphicsState(multiplyGsName));
  if (holes.length) {
    const { moveTo, lineTo, closePath, clipEvenOdd, endPath } = pdfLib;
    const ops = [
      // outer rect = full page (crop) so the tile draws everywhere except holes
      moveTo(0, 0), lineTo(cropW, 0), lineTo(cropW, cropH), lineTo(0, cropH), closePath(),
    ];
    for (const h of holes) {
      ops.push(moveTo(h.x, h.y), lineTo(h.x + h.w, h.y), lineTo(h.x + h.w, h.y + h.h), lineTo(h.x, h.y + h.h), closePath());
    }
    ops.push(clipEvenOdd(), endPath());
    page.pushOperators(...ops);
  }
};
```
Use `openClipped()` in place of the two existing `page.pushOperators(pushGraphicsState(), setGraphicsState(multiplyGsName));` calls (vector path and raster path), leaving the matching `page.pushOperators(popClip? no — popGraphicsState())` as-is. Import the extra pdf-lib ops in the destructure at the top of `exportStitchToPdf`:
```ts
const { PDFDocument, degrees, pushGraphicsState, popGraphicsState, setGraphicsState, PDFName, moveTo, lineTo, closePath, clipEvenOdd, endPath } = pdfLib;
```
(These operator helpers exist in pdf-lib's `PDFOperator` factories. If a name differs in the installed version, the implementer confirms the exact export via `node -e "console.log(Object.keys(require('pdf-lib')).filter(k=>/clip|moveTo|lineTo|closePath|endPath/i.test(k)))"` and uses the matching names — the clip is `W*` (even-odd) + `n` (end path no-op).)

- [ ] **Step 4: Run — verify the helper test passes.** `npx vitest run src/features/stitch/stitchExport.test.ts` → PASS. `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**
```bash
git add src/features/stitch/stitchExport.ts src/features/stitch/stitchExport.test.ts
git commit -m "feat(cleanup): exclude hidden regions from exported tiles (even-odd clip)"
```

---

### Task 8: UI — Clean-up button, review overlay, manual box + dev harness

**Files:**
- Create: `src/features/stitch/cleanup/CleanupReview.tsx`
- Create: `src/features/dev/CleanupSmokeHarness.tsx`
- Modify: `src/features/stitch/StitchToolbar.tsx` (button), `src/pages/StitchView.tsx` (wire review mode), `src/router.tsx` (dev route)

> Verified manually (browser) + `tsc`. No vitest (DOM/mupdf).

**Interfaces:**
- Consumes: `detectCleanupForTiles` (`./cleanup/cleanupRun`), `cssClipPathWithHoles`, the stitch store (`tiles`, `setHiddenRegions`, `clientToCanvas` via `StitchCanvas`), `useNotificationStore`.

- [ ] **Step 1: Dev harness first** (proves `cleanupRun` end-to-end before UI). Create `src/features/dev/CleanupSmokeHarness.tsx`: a file input that loads a multi-page PDF, builds tile stubs (`{id, sourcePdfBytes, sourcePageIndex, width: widthPt, height: heightPt}` per page via mupdf `getBounds`), calls `detectCleanupForTiles(mupdf, tiles, onProgress)`, and prints each tile's proposed regions (kind, confidence, rect). Mirror `AutoStitchSmokeHarness.tsx` structure (mupdf namespace via `.then(m=>m.default)`). Register `/dev/cleanup` in `src/router.tsx` inside the `import.meta.env.DEV` array (mirror `/dev/autostitch`).

Run: `npm run dev`, open `/dev/cleanup`, load a plan set (e.g. the Rose Hill file). Confirm the title-block strip is proposed on the correct edge (high confidence) and at least one match-margin appears. This validates detection on real data before building the interactive UI.

- [ ] **Step 2: Review overlay component** `CleanupReview.tsx`: given `proposals: TileProposal[]` and the tiles' canvas poses, render each region as an absolutely-positioned dashed rect (map tile-local → canvas via the tile's `x,y` + scale, same math `StitchTile` uses), color by state (amber = off, red = will-hide) and kind; click toggles a region's `enabled`; expose `onApply` that calls `setHiddenRegions(tileId, enabledRects)` per tile (one undo step is acceptable per tile, or batch). Follow the `cropRect` overlay render pattern in `StitchCanvas.tsx` (absolute div under the same pan/zoom transform).

- [ ] **Step 3: Manual hide-box** reuses the existing content-delete erase-box mode: in review mode, route the canvas's box-draw callback (`onEraseBox`, canvas-space rect) to "add a manual region": convert the canvas rect → the hit tile's local coords (`canvasToTileLocal` from `stitchGeometry`) and append a `{ kind: "manual", enabled: true }` proposal for that tile.

- [ ] **Step 4: Toolbar button** in `StitchToolbar.tsx`: add an `IconButtonWithTooltip` (mirror the "Add PDF" button around line 404) labeled "Clean up", `onClick={onCleanup}`, wired through a new `onCleanup` prop; add the prop to the toolbar's props type and pass it from `StitchView.tsx`.

- [ ] **Step 5: Wire review mode in `StitchView.tsx`**: on "Clean up", `const mupdf = await import("mupdf").then(m=>m.default)`, call `detectCleanupForTiles(mupdf, useStitchStore.getState().tiles.filter(t=>!t.isScaleStamp))`, store proposals in local state, enter review mode (render `CleanupReview` over the canvas, put the canvas in erase-box draw mode for manual boxes). Show a notification "Found N regions to clean up." Apply commits via `setHiddenRegions`; Cancel discards. Errors degrade to a non-blocking notice.

- [ ] **Step 6: Manual verification.** `npm run dev`, `/stitch`: add a plan set, auto-align, click **Clean up** → confirm the title-block strips + match-margins are proposed; toggle a couple, draw a manual box over a notes block, **Apply** → the composite shows continuous drawing with the title blocks/margins gone; **export** and confirm the exported PDF matches (hidden regions excluded, neighbor shows through). Undo restores. `npx tsc --noEmit` clean; `npx vitest run src/features/stitch` green.

- [ ] **Step 7: Commit**
```bash
git add src/features/stitch/cleanup/CleanupReview.tsx src/features/dev/CleanupSmokeHarness.tsx src/features/stitch/StitchToolbar.tsx src/pages/StitchView.tsx src/router.tsx
git commit -m "feat(cleanup): Clean-up button, review overlay, manual box + /dev/cleanup harness"
```

---

## Self-Review

**1. Spec coverage:**
- §2 auto-detect title-block → Task 2; match-margin → Task 3. ✔
- §2 manual box → Task 8 Step 3 (reuses erase-box). ✔
- §2 non-destructive region model, undo, carries to export → Task 1 (`hiddenRegions` + store) + Task 7 (export). ✔
- §2 works on any stitch canvas / on-demand / decoupled → Task 5 (`detectCleanupForTiles` over current tiles, not the auto-stitch flow). ✔
- §3 modules (`cleanupDetect`, `cleanupRun`, store, review UI, export, tile render) → Tasks 1–8 one-to-one. ✔
- §4 detection algorithms (furniture cluster + border snap; match-line stroke + frame margin) → Tasks 2/3. ✔
- §5 data model (`Rect`/`hiddenRegions`, review state) → Task 1 + Task 8. ✔
- §6 clip-not-white, preview + both export paths → Task 4 (helper) + Task 6 (preview) + Task 7 (export). ✔
- §7 UI/flow (button → detect → review → toggle/box → apply) → Task 8. ✔
- §8 testing (cleanupDetect unit, region-model unit, export clip-geometry unit, dev harness) → Tasks 1/2/3/4/7 vitest + Task 5/8 harness. ✔
- §9 risks (edge choice from cluster, dashed match line, white-trap, pdf-lib clip, on-demand cost) → handled in Tasks 2/3/7 + progress in Task 5/8. ✔

**2. Placeholder scan:** No TBD/TODO. The two "confirm the exact pdf-lib op name / parseSheetRefs edge label empirically" notes are concrete verification steps with the exact command/assertion to run, not deferred work. Full code given for every pure module + test.

**3. Type consistency:** `Rect = {x,y,w,h}` (Task 2) reused as `CropRect` in the tile (Task 1) and as export holes (Task 7). `CleanupRegion`/`CleanupKind` (Task 2) consumed unchanged in Tasks 3/5/8. `detectTitleBlock(page, isFurniture)` / `detectMatchMargins(page)` (Tasks 2/3) called identically in Task 5. `detectCleanupForTiles(mupdf, tiles, onProgress)` (Task 5) called identically in Task 8. `setHiddenRegions(id, regions)` (Task 1) called in Tasks 8. `cssClipPathWithHoles` (Task 4) used in Tasks 6. ✔

## Execution Handoff

Two execution options:
1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks.
2. **Inline Execution** — execute in this session with checkpoints.
