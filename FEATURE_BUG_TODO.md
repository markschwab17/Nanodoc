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

## Tile-Pyramid Renderer (Phases 1–2)

### Phase 1 — primitives

- [x] mupdf clipping API verified: spec's `toPixmap(..., clipRect)` does NOT exist in mupdf 1.26.4; tile rendering uses `Pixmap(colorspace, tileBbox, alpha) + DrawDevice(scaleMatrix, pixmap) + DisplayList.run`
- [x] `src/core/pdf/tiles/types.ts` — TileKey, RenderedTile, TILE_SIZE, stable cache-key serializer
- [x] `src/core/pdf/tiles/lod.ts` — LOD selection, tile↔PDF-rect math
- [x] `src/core/pdf/tiles/tileRender.worker.ts` — single-tile worker with per-page DisplayList cache, returns ImageBitmap (transferable)
- [x] `src/core/pdf/tiles/WorkerPool.ts` — N workers, priority queue, in-flight dedupe, cancel, timeout-and-restart
- [x] `/dev/tile-smoke` harness validates pool end-to-end (synthetic 4-page PDF, 64 tiles in ~370 ms)

### Phase 2 — orchestration

- [x] `src/core/pdf/tiles/TileCache.ts` — L1 LRU bitmap cache, `findCoarserAncestor` for fallback, page/doc invalidation, `bitmap.close()` on eviction
- [x] `src/core/pdf/tiles/TiledPageRenderer.ts` — owns pool+cache, `setViewport` cancels stale and enqueues missing, `getVisibleTiles` returns `{ primary, fallback, missing, lod }`, `onTileReady` listener
- [x] Vitest unit tests: types/lod/TileCache (35 tests passing)
- [x] `/dev/tiled-page-smoke` harness with zoom slider; visually verified LOD crossover and "never blank" fallback behavior

### Known limitations (deferred)

- Per-worker `DisplayList` cache has no eviction (small docs only — fine for current smoke harnesses)
- PDF bytes are structured-cloned to each worker on first request (~N× memory). SharedArrayBuffer + COOP/COEP is a phase-7 optimization
- No `TiledCanvas` React component or `PageCanvas.tsx` integration yet (phase 3)
- Legacy `PDFRenderer` still drives `PageCanvas.tsx`; tile renderer is NOT user-visible (only the two `/dev/*-smoke` routes)
- No CSS-transform pan/zoom optimization (phase 4) — every zoom currently re-runs `setViewport` and may request fresh tiles
- No OPFS L2 cache; all tiles are in-memory only (phase 5)
- Cancellation drops queue items but doesn't abort an in-flight worker render — only worker timeout will kill an already-running tile
