# Nanodoc — Tiled renderer kickoff prompt

Paste everything below the `---` line into a fresh Claude Code session at the root of this repo (`/Users/markschwab/Documents/Pdf_editor`).

The prompt is self-contained and references real files. It assumes the existing tools, annotation editing, and object placement must continue working unchanged — this is a rendering-layer upgrade, not a rewrite of the editor.

---

# Project: Nanodoc tiled renderer

You are upgrading the rendering layer of an existing React + Vite + Tauri PDF editor (Nanodoc) to deliver iOS-PDFKit-level smoothness on large construction PDFs (multi-hundred-page sheet sets, 36"×48" pages, 50–500MB files).

The new system is a **tile pyramid**: each page becomes a grid of small image tiles at multiple zoom levels (LODs). Only visible tiles render. Pan and zoom become CSS/GPU transforms over cached tiles. Memory becomes bounded by viewport, not document size.

**Hard constraint:** every existing feature must keep working unchanged. The full annotation system — text editing, image annotations, stamps, callouts, form fields, signature fields, redline, rulers, drawing, shape handles, context menus — currently lives as DOM overlays on top of the page canvas in `src/features/viewer/PageCanvas.tsx`. Those overlays operate in PDF point coordinates and are CSS-scaled to display dimensions. They must continue to work without modification through this upgrade. This rendering swap is *under* the overlays, not around them.

## What exists today

Read these files first to ground yourself:

| File | LOC | Role |
|---|---|---|
| `src/core/pdf/PDFRenderer.ts` | 362 | mupdf wrapper, worker, render cache (`Map<string, RenderedPage>`) |
| `src/core/pdf/pdfRender.worker.ts` | 118 | runs `mupdf.toPixmap` off-thread |
| `src/core/pdf/renderQueue.ts` | 66 | legacy render queue (mostly unused now) |
| `src/features/viewer/PageCanvas.tsx` | 5,666 | renders a page + all DOM overlays for annotations/tools |
| `src/features/viewer/VirtualizedPageList.tsx` | 296 | windowing for many pages |
| `src/features/viewer/PDFViewer.tsx` | 2,269 | main viewer shell |

Today's render path:

```
zoom changes
   ▼
PageCanvas debounces, calls PDFRenderer.renderPage(pageNumber, scale)
   ▼
PDFRenderer.renderCache miss → posts WorkerRequest to pdfRender.worker
   ▼
worker calls mupdf.toPixmap(pageNumber, scale) for the WHOLE PAGE
   ▼
worker posts ImageData back
   ▼
PageCanvas blits the bitmap to its <canvas>, overlays redraw at new scale
```

Bottleneck: the whole page rasterizes on every zoom change. On a 36"×48" sheet at 3x zoom, that's a 32k×24k image. The worker hangs, the cache is huge, browsers OOM.

## What you're building

```
zoom or pan changes
   ▼
TiledPageRenderer asks: which tiles are visible at the current LOD?
   ▼
TileCache: hit?  → return cached ImageBitmap immediately
                  miss? → enqueue render request to worker pool
   ▼
WorkerPool (N = navigator.hardwareConcurrency)
   each worker has its own mupdf instance
   renders tile at (page, LOD, tileX, tileY) — NOT whole page
   ▼
ImageBitmap returned (transferred zero-copy) → cached → painted
   ▼
PageCanvas's <canvas> shows the tiled background.
   Annotations/tools layered above are UNTOUCHED — same DOM, same coords.
```

The annotation overlays stay exactly where they are. Only the bitmap-source for the page changes.

## Architecture

```
src/core/pdf/tiles/                    (NEW)
├── types.ts                           tile coordinates, LOD math, cache keys
├── TileCache.ts                       L1 in-memory LRU + L2 OPFS persistent
├── WorkerPool.ts                      N workers, priority queue
├── tileRender.worker.ts               mupdf instance per worker, renders ONE tile
├── TiledPageRenderer.ts               orchestrates: viewport → tiles → cache/workers
├── lod.ts                             LOD selection: which level for current zoom
└── prefetch.ts                        speculative tile fetch (next page, next LOD)

src/features/viewer/
├── TiledCanvas.tsx                    (NEW) renders tiles into a grid of <canvas> els
├── PageCanvas.tsx                     (MODIFIED) swap bitmap <canvas> for <TiledCanvas>
└── ... (everything else unchanged)
```

## The five technical decisions that matter

### 1. Tiles are 512×512 pixels at LOD 0; LOD pyramid doubles each level

| LOD | Tile coverage of page | Tiles per page (square page) |
|---|---|---|
| 0 | whole page in 1 tile | 1 |
| 1 | half page per tile | 4 |
| 2 | quarter | 16 |
| 3 | eighth | 64 |
| 4 | sixteenth | 256 |
| 5 | one-thirty-second | 1024 |

LOD selection: the chosen level is the smallest LOD where one tile pixel ≥ one screen pixel. Rule of thumb: `chosenLOD = ceil(log2(pageWidth_screenPixels / 512))`.

### 2. Tile coordinates are in **PDF point space**, not screen space

A tile at `(page=7, lod=3, x=2, y=4)` always covers the same PDF rectangle, regardless of zoom. This makes the cache key stable across zoom levels. Mistakes here cause cache invalidation on every zoom — a fatal bug.

```ts
export type TileKey = {
  docId: string;     // hash of file
  page: number;
  lod: number;
  x: number;         // tile-grid column at this LOD
  y: number;         // tile-grid row at this LOD
};
```

### 3. Annotation overlays use PDF point coordinates with CSS transform — don't change this

`PageCanvas.tsx` already does this. The bitmap is the only thing that's display-pixel-sized; overlays are point-coordinate-positioned and CSS-scaled. This is exactly the architecture tile pyramids need. Don't refactor it.

### 4. Pan and small zoom changes use CSS transforms; tile re-request only on LOD threshold cross

Pan = `transform: translate3d(x, y, 0)` on the tile container. Free, GPU-accelerated, 120fps.

Zoom up to 2x within current LOD = `transform: scale(...)` on the tile container. Tiles look slightly soft when scaled up but stay perfectly smooth.

When zoom crosses an LOD threshold, swap to next LOD and reset scale to 1.0. The crossover is imperceptible if the next LOD's tiles are pre-fetched.

This means **most user zoom interactions never hit the worker pool at all.** Only crossing LOD thresholds does. That's the iOS magic.

### 5. Never blank tiles. Always show something.

When a tile at the requested LOD is missing, show the corresponding tile from a coarser LOD stretched to fill. Even at LOD 0 the user sees a blurry-but-instant page rather than white. This is the single biggest perceived-performance trick.

## File-by-file plan

### `src/core/pdf/tiles/types.ts`

```ts
export interface TileKey {
  docId: string;
  page: number;
  lod: number;
  x: number;
  y: number;
}

export interface RenderedTile {
  key: TileKey;
  bitmap: ImageBitmap;
  pdfRect: { x: number; y: number; w: number; h: number }; // in PDF points
}

export const TILE_SIZE = 512;

export function lodForZoom(pageWidthPoints: number, displayPxPerPoint: number): number {
  const screenPx = pageWidthPoints * displayPxPerPoint;
  return Math.max(0, Math.ceil(Math.log2(screenPx / TILE_SIZE)));
}

export function tilesAtLod(pageWidthPoints: number, pageHeightPoints: number, lod: number) {
  // returns { cols, rows, tilePointsX, tilePointsY }
}

export function visibleTiles(viewport: PdfRect, lod: number, page: PageDims): TileKey[] {
  // intersection math
}
```

### `src/core/pdf/tiles/tileRender.worker.ts`

One mupdf instance per worker. Receives `RenderTileRequest`, calls `mupdf.toPixmap` clipped to the tile's PDF rect, returns `ImageBitmap` via transfer.

Critical: clip to tile rect *before* rasterizing. mupdf supports a clip region via `Page.toPixmap(matrix, colorspace, alpha, showExtras, usage, clipRect)`. This is the single most important API to get right — without it you re-render whole pages and lose all the savings.

### `src/core/pdf/tiles/WorkerPool.ts`

```ts
class WorkerPool {
  constructor(size = navigator.hardwareConcurrency) { /* spawn N workers */ }
  
  // Priority queue: visible tiles first, prefetch tiles last.
  // If the same tile is requested twice while one is in flight, dedupe.
  request(key: TileKey, priority: 'visible' | 'prefetch'): Promise<RenderedTile>;
  
  // Cancel pending tiles that left the viewport.
  cancel(filter: (key: TileKey) => boolean): void;
}
```

Use the existing `WORKER_RENDER_TIMEOUT` pattern from `PDFRenderer.ts` — kill and restart hung workers.

### `src/core/pdf/tiles/TileCache.ts`

Two tiers:

- **L1 (memory):** LRU of `ImageBitmap` keyed by `TileKey`. Capacity ~100MB worth of tiles (~400 tiles at 512×512×RGBA).
- **L2 (OPFS):** persistent across reloads. Stored as PNG blobs, keyed by `${docId}/${page}/${lod}/${x}_${y}.png`. Async writes; reads on cache miss before falling through to worker.

OPFS API: `await navigator.storage.getDirectory()`. Cap total OPFS usage at 1GB, evict oldest by `mtime`.

### `src/core/pdf/tiles/TiledPageRenderer.ts`

Top-level orchestrator. The single object PageCanvas talks to.

```ts
class TiledPageRenderer {
  constructor(doc: PDFDocument, mupdf: any, opts?: { workerCount?: number });
  
  // Called by TiledCanvas on viewport change.
  // Returns the set of tiles currently displayable (some cached, some pending).
  // Each pending tile resolves via onTileReady callback as it arrives.
  setViewport(page: number, viewportPoints: PdfRect, displayPxPerPoint: number): void;
  
  onTileReady(callback: (tile: RenderedTile) => void): () => void;
  
  // Synchronously returns whatever tiles are immediately renderable for the page.
  // Caller uses these to paint NOW; missing ones fall back to coarser-LOD scaled.
  getVisibleTiles(page: number, viewportPoints: PdfRect, displayPxPerPoint: number): {
    primary: RenderedTile[];      // at chosen LOD
    fallback: RenderedTile[];     // coarser LOD for missing primary tiles
  };
  
  destroy(): void;
}
```

### `src/features/viewer/TiledCanvas.tsx` (new)

Replaces the bare `<canvas>` inside PageCanvas. Renders tiles either as:

- **MVP path:** absolutely-positioned `<canvas>` elements per tile in a container, painted from `ImageBitmap`s. Pan/zoom = `transform` on the container. Simple, works everywhere.
- **Phase 2:** single `<canvas>` with WebGL2 rendering of tiles as textured quads. Better perf at high tile counts.
- **Phase 3 (optional):** WebGPU. Only if benchmarks show WebGL2 is the bottleneck.

Start with the MVP path. Don't over-engineer.

```tsx
interface TiledCanvasProps {
  document: PDFDocument;
  pageNumber: number;
  renderer: TiledPageRenderer;
  pageWidthPoints: number;
  pageHeightPoints: number;
  zoomScale: number;       // CSS scale applied by parent
  panOffset: { x: number; y: number };
  containerSize: { w: number; h: number };
}
```

The `<TiledCanvas>` is positioned where `PageCanvas` currently puts its `<canvas>`. The annotation overlay layers (`RichTextEditor`, `ImageAnnotation`, etc.) sit *on top* in the existing DOM order. Z-index unchanged.

### `src/features/viewer/PageCanvas.tsx` (modified)

This is a 5,666-line file. **Do not rewrite it.** Make a minimal, surgical change:

1. Find the `<canvas>` element that today receives the bitmap from `PDFRenderer.renderPage(...)`.
2. Behind a feature flag (`useTiledRenderer` from a settings store), conditionally render `<TiledCanvas>` in its place.
3. When the flag is on, skip the existing `PDFRenderer.renderPage` call and the `useEffect` that drives it.
4. Everything else — annotation overlays, tools, drag handles, hit testing, RichTextEditor — stays exactly as is.

This keeps the change reviewable and reversible. If anything breaks, flip the flag.

## Feature flag

Add to `src/shared/stores/uiStore.ts` or a new `experimentsStore`:

```ts
useTiledRenderer: boolean  // default: false in production, true in dev
```

Add a toggle in Settings → Experimental. Document the flag in `FEATURE_BUG_TODO.md`.

## Backwards compatibility — what must NOT break

This is the test list. Every item must work identically when the tiled renderer is on:

- [ ] Click-to-place annotations (text, stamp, image, callout, signature)
- [ ] Drag-to-move annotations
- [ ] Drag-to-resize via shape/form-field handles
- [ ] Rich text editing (typing, formatting, clipboard, find/replace)
- [ ] Drawing tool (pencil, highlighter, free-form)
- [ ] Redline popup positioning
- [ ] Form field rendering and editing
- [ ] Signature field placement and signing
- [ ] Stamp placement with preview
- [ ] Rulers (horizontal + vertical)
- [ ] Annotation context menus
- [ ] Text selection across the page (uses `getStructuredTextForPage`, doesn't depend on bitmap)
- [ ] Read mode scaling (`ReadModeScaleWrapper`)
- [ ] Search highlight rectangles
- [ ] Spec extraction highlights
- [ ] Civiltakeoff view params (auto-zoom-to-rect)
- [ ] Print and export (these use a different code path — `PDFConverter`, `PDFPrinter` — unchanged)

Add a smoke test for each in `tests/` (or a manual `TESTING_CHECKLIST.md` entry if no test framework exists yet).

## Performance targets

| Metric | Today | Target with tiled renderer |
|---|---|---|
| Open 500-page construction set | 5–15s | < 800ms (metadata + first viewport) |
| Zoom from 100% → 400% | 1–3s, full re-render | < 16ms (CSS transform) |
| Pan around a sheet | janky | 120fps |
| Memory on a 200MB PDF | grows unbounded | bounded ~300MB |
| First visible content on page jump | 500ms–2s | < 100ms (cached) or < 200ms (uncached) |
| Tile cache hit rate after 30s of use | n/a | > 90% |

## Build order

| Phase | Time | Deliverable |
|---|---|---|
| 1 | Week 1 | `types.ts`, `lod.ts`, `WorkerPool.ts`, `tileRender.worker.ts`. Unit-tested in isolation. |
| 2 | Week 2 | `TileCache.ts` (L1 only), `TiledPageRenderer.ts`. Renders tiles, no CSS-transform optimization yet. |
| 3 | Week 3 | `TiledCanvas.tsx`. Wire into `PageCanvas.tsx` behind feature flag. Single page works. |
| 4 | Week 4 | Pan + intra-LOD zoom via CSS transform. LOD threshold crossover. Coarse-LOD fallback for missing tiles. |
| 5 | Week 5 | OPFS L2 cache. Prefetch heuristics (next page, next LOD). |
| 6 | Week 6 | Multi-page in `VirtualizedPageList`. Annotation overlay backwards-compat audit (every item from the checklist above). |
| 7 | Week 7 | Performance tuning. Memory profiling. Worker pool tuning. |
| 8 | Week 8 | Hardening, real-world construction PDF testing, flip flag default to `true` in dev. Ship gated to power users. |

## What to do in your first session

Don't touch `PageCanvas.tsx` yet. The goal of session 1 is to build the rendering primitives in isolation so they're testable and reviewable.

1. **Read** `src/core/pdf/PDFRenderer.ts`, `src/core/pdf/pdfRender.worker.ts`, and the top 200 lines of `src/features/viewer/PageCanvas.tsx`. Confirm understanding of the current render path.
2. **Create the directory** `src/core/pdf/tiles/`.
3. **Implement `types.ts` and `lod.ts`** with unit tests (use whatever test runner the project uses; if none, set up Vitest in `vitest.config.ts`).
4. **Implement `tileRender.worker.ts`**: takes `{ docId, page, lod, x, y, pageWidthPoints, pageHeightPoints }`, returns `ImageBitmap` via transfer. The critical mupdf call is `page.toPixmap(matrix, colorspace, alpha, showExtras, usage, clipRect)` — verify the exact signature in `src/types/mupdf.d.ts`.
5. **Implement `WorkerPool.ts`** with priority queue, dedupe, cancel, timeout-and-restart (mirror the pattern from `PDFRenderer.ts`).
6. **Write a smoke test** that loads a real PDF (use one from `public/` or wherever sample PDFs live), renders 4 tiles concurrently across 4 workers, asserts they're all valid `ImageBitmap`s with non-zero dimensions.

That's a one-week first session. Stop there. Do not start integrating into PageCanvas until phase 1 is reviewable as a standalone PR.

## Working principles

- **The annotation system is sacred.** Don't refactor `PageCanvas.tsx` opportunistically. Surgical changes only.
- **Tile coordinates live in PDF point space.** Never in screen pixels. This is the load-bearing decision.
- **CSS transform first, re-render last.** If you can pan or zoom by changing a CSS transform, do that. The worker pool is for LOD crossings, not for every interaction.
- **Never blank.** Always show coarser-LOD content while waiting for finer tiles.
- **Feature flag on day one.** Every change ships behind `useTiledRenderer`. If something breaks, the flag flips and Nanodoc reverts to today's behavior with zero risk.
- **PDFRenderer stays.** Don't delete or rewrite it. The new system runs alongside it. If the experiment goes well, deprecate the old path in a later sprint. Until then, both work.

## References

- iOS PDFKit / `CATiledLayer` architecture (Apple WWDC sessions on tiled rendering — search "CATiledLayer best practices")
- Google Maps Vector tiles overview — same architectural pattern
- OPFS (Origin Private File System) — https://web.dev/articles/origin-private-file-system
- ImageBitmap and zero-copy worker transfer — https://developer.mozilla.org/en-US/docs/Web/API/ImageBitmap
- mupdf-js API for clipped rendering — check installed `mupdf` package + `src/types/mupdf.d.ts`

---

Begin with the first-session checklist. Ask clarifying questions only if something is genuinely ambiguous in the existing codebase — the spec is intentionally opinionated to keep momentum.
