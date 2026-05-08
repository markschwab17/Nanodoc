# Feature & Bug TODO

## Bugs & Fixes

### High Priority

- [ ] **Fix rotating rectangles correct direction**
  - Rectangles are rotating in the wrong direction
  - Need to correct rotation logic

- [x] **Fix text box sizing (flexible resize, font independent)** *(done)*
  - Text boxes can be resized from any corner down to a small minimum (8 PDF units).
  - Font size and text box size are independent (like Figma/Canva/PDF-XChange); resizing does not change font size.
  - Creation by drag and resize no longer enforce the previous 50×30 minimum.

- [ ] **All tools need to work in read mode**
  - Currently not all tools function properly in read mode
  - Need to audit and fix each tool to ensure read mode compatibility

### Medium Priority

- [ ] **Check and verify resize PDF document functionality**
  - Audit all resize PDF document features
  - Ensure resize operations work correctly
  - Test edge cases and document integrity after resize

- [ ] **Check and verify print options**
  - Audit all print functionality
  - Ensure print options work correctly
  - Test various print settings and configurations

- [ ] **Support rotating pages while maintaining size**
  - Allow page rotation without changing page dimensions
  - Maintain original page size when rotating
  - Ensure content scales appropriately during rotation

- [ ] **Fillable forms - large rework**
  - Fillable fields that were created outside of the program need to work
  - Ensure compatibility with external PDF form fields
  - Test and fix field recognition and interaction

- [ ] **Typewriter mode**
  - Create a quick text creation mode
  - Text should be created without a bounding box
  - Click and type directly on the PDF

### Lower Priority

- [ ] **Conditional drop downs in fillable forms**
  - Allow form fields to have conditional logic
  - Dropdown values should change based on other field selections

- [ ] **Proper signature field**
  - Implement a dedicated signature field type
  - Support signature capture and validation

## Future Enhancements

### Content Management

- [ ] **PDF content selection and multi-page combination**
  - Allow for content selection from PDF pages
  - Resize selected PDF content
  - Add multiple PDFs to a single page
  - Combine PDFs (e.g., stitch construction plan sets together)
  - Enable layout and positioning of multiple PDF sources on one page

### Signature Workflow

- [ ] **PDF signature links with authentication**
  - Create temporary expiring storage for PDFs sent for signature
  - Send signature request links
  - Email authentication with code verification
  - Allow recipients to sign after authentication
  - Implement secure, time-limited access

---

## Notes

- This file tracks all known bugs and planned features
- Items are prioritized based on impact and user needs
- Check off items as they are completed

---

## Tile-Pyramid Renderer (Phases 1–7)

### Phase 1 — primitives

- [x] mupdf clipping API verified: spec's `toPixmap(..., clipRect)` does NOT exist in mupdf 1.26.4; tile rendering uses `Pixmap(colorspace, tileBbox, alpha) + DrawDevice(scaleMatrix, pixmap) + DisplayList.run`
- [x] `src/core/pdf/tiles/types.ts` — TileKey, RenderedTile, TILE_SIZE, stable cache-key serializer
- [x] `src/core/pdf/tiles/lod.ts` — LOD selection, tile↔PDF-rect math
- [x] `src/core/pdf/tiles/tileRender.worker.ts` — single-tile worker with per-page DisplayList cache, returns ImageBitmap (transferable)
- [x] `src/core/pdf/tiles/WorkerPool.ts` — N workers, priority queue, in-flight dedupe, cancel, timeout-and-restart
- [x] `/dev/tile-smoke` harness validates pool end-to-end (synthetic 4-page PDF, 64 tiles in ~370 ms)

### Phase 2 — orchestration

- [x] `src/core/pdf/tiles/TileCache.ts` — L1 LRU bitmap cache, `findCoarserAncestor` for fallback, page/doc invalidation
- [x] `src/core/pdf/tiles/TiledPageRenderer.ts` — owns pool+cache, `setViewport` cancels stale and enqueues missing, `getVisibleTiles` returns `{ primary, fallback, missing, lod }`, `onTileReady` listener
- [x] Vitest unit tests: types/lod/TileCache (35 tests passing)
- [x] `/dev/tiled-page-smoke` harness with zoom slider; visually verified LOD crossover and "never blank" fallback behavior

### Phase 3 — PageCanvas integration

- [x] `useTiledRenderer` flag in `uiStore.ts` (off by default)
- [x] **Hotkey: Cmd/Ctrl+Alt+T** (Option+Cmd+T on Mac) toggles the flag at runtime; toast confirms ON/OFF
- [x] `src/core/pdf/tiles/tiledRendererRegistry.ts` — singleton `TiledPageRenderer` per docId
- [x] `src/features/viewer/TiledCanvas.tsx` — drop-in replacement for the page bitmap canvas; renders primary + fallback tiles at PDF-point dimensions
- [x] Surgical edit at `PageCanvas.tsx:3008` — conditional swap behind the flag; legacy render effect early-returns when flag is on
- [x] `pageContentRef` in PageCanvas points at whichever page element is mounted; `getPDFCoordinates` and the image-drop / paste fallback paths use it so tools work with either renderer
- [x] Cache policy: do NOT close `ImageBitmap` on routine eviction (avoids React-StrictMode-double-invoke detachment race); bitmaps GC naturally. `destroy()` still closes everything.
- [x] Tile useEffect only sets `canvas.width/height` when they differ — keeps painted pixels stable across StrictMode's double-invoke
- [x] Pinch-to-zoom on the trackpad works in tile mode (handleWheelNative uses `pageContentRef`)
- [x] Unhandled `Tile request cancelled` rejection fixed (`.then(cleanup, cleanup)` instead of `.finally(...)` chain)
- [x] Cache capacity bumped to 1500 (browser) / 3000 (Tauri); coarser-LOD ancestors prefetched so the fallback path is always populated when jumping to high zoom
- [x] Debug HUD hidden by default; enable via `?tile-debug=1` URL param

### Phase 4 — visual smoothness

- [x] 120ms CSS opacity fade-in on every freshly-mounted tile canvas (via `@keyframes tile-fade-in` in `index.css`). Softens the snap when a new LOD's primaries arrive over a coarser-LOD fallback.
- [x] Intra-LOD zoom is handled entirely by the parent's CSS transform — no worker re-renders for sub-LOD zoom changes. Cached tiles get CSS-scaled smoothly.

### Phase 7 — viewport-restricted tile requests

- [x] `PageCanvas` measures the actually-visible portion of the page on screen via `getBoundingClientRect` (intersection of `containerRef` with `pageContentRef`, mapped from CSS px back to PDF points). Updated via `useLayoutEffect` after every render with a 1pt change-threshold to avoid render loops.
- [x] `TiledCanvas` accepts `viewportPdfRect` prop and uses it for `setViewport` / `getVisibleTiles`. The worker pool only renders tiles the user can actually see.
- [x] LOD cap raised from 5 to 8. With viewport-restricted requests, tile counts scale with viewport size, not with `4^LOD`.
- [x] Side-effect: cache eviction churn (which previously caused "blank tiles loading in" at high zoom) is gone — far fewer tiles are in flight at any moment.

### Multi-page read-mode polish

- [x] `setViewport` cancel filter is now scoped to the page being updated. Previously, page N's `setViewport` would cancel queued tiles for all other pages of the same doc — pages fought each other for the worker queue.
- [x] `onTileReady` listener in `TiledCanvas` filters by `pageNumber`. Tile arrivals for one page no longer trigger re-renders across all mounted PageCanvas instances.
- [x] Always prefetch each visible page's LOD-0 (one tile per page, very cheap) so newly-scrolled-to pages have an instant low-res preview while higher LODs stream in.

### Known limitations (deferred)

- **Direct DOM transform during pinch-zoom is invisible to React** — the wheel handler updates `transformDivRef.style.transform` synchronously and only flushes to React state via debounced `flushSync` after ~100ms. During fast pinches the visible-rect measurement (and thus tile requests) lags by that window; cached tiles render via the parent's CSS scale until the gesture settles. Acceptable today; phase-8 may add a transitionend / RAF listener.
- **Redaction & SelectionBoxTool** call `canvas.getContext` / set `canvas.width` directly through `canvasRef`. When the tile flag is on, those operations no-op silently (canvasRef is null). Toggle the flag off after a redaction to see the result, or stay on the legacy renderer.
- Per-worker `DisplayList` cache has no eviction (small docs only — fine for the current scope)
- PDF bytes are structured-cloned to each worker on first request (~N× memory). SharedArrayBuffer + COOP/COEP is a phase-8 optimization.
- No OPFS L2 cache (phase 5)
- Cancellation drops queue items but doesn't abort in-flight worker renders — only worker timeout will kill an already-running tile
- Bitmaps are leaked on eviction (rely on GC). Phase-8 will reintroduce explicit close behind a render-frame barrier.
- Renderer instances in the registry leak past document close. Phase-8 will hook into doc close.
