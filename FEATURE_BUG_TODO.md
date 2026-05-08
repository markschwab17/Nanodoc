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

## Tile-Pyramid Renderer (Phase 1 — primitives only)

- [x] mupdf clipping API verified: spec's `toPixmap(..., clipRect)` does NOT exist in mupdf 1.26.4; tile rendering uses `Pixmap(colorspace, tileBbox, alpha) + DrawDevice(scaleMatrix, pixmap) + DisplayList.run`
- [x] `src/core/pdf/tiles/types.ts` — TileKey, RenderedTile, TILE_SIZE, stable cache-key serializer
- [x] `src/core/pdf/tiles/lod.ts` — LOD selection, tile↔PDF-rect math
- [x] `src/core/pdf/tiles/tileRender.worker.ts` — single-tile worker with per-page DisplayList cache, returns ImageBitmap (transferable)
- [x] `src/core/pdf/tiles/WorkerPool.ts` — N workers, priority queue, in-flight dedupe, cancel, timeout-and-restart
- [x] Vitest configured (jsdom); `types.test.ts` and `lod.test.ts` cover pure logic (19 tests passing)
- [x] `/dev/tile-smoke` harness validates end-to-end against a synthetic 4-page PDF (5.8 ms/tile measured)

### Known limitations (deferred)

- Per-worker `DisplayList` cache has no eviction (small docs only — fine for phase 1 smoke)
- PDF bytes are structured-cloned to each worker on first request (~N× memory). SharedArrayBuffer + COOP/COEP is a phase-7 optimization
- No `TileCache`, `TiledPageRenderer`, `TiledCanvas` yet (phases 2–3)
- Legacy `PDFRenderer` still drives `PageCanvas.tsx`; tile renderer is NOT user-visible
