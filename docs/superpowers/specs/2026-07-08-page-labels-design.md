# Editable, persistent per-page labels

- **Date:** 2026-07-08
- **Status:** Approved (design) — ready for implementation plan
- **Branch context:** `fix/single-page-default-edit-mode`

## Goal

Give every page a **label**. Labels are:

1. **Auto-extracted** on open from the PDF's integrated page labels (`/PageLabels`) or from existing bookmarks, falling back to the sequential page number.
2. **Editable** by the user, inline on the thumbnail.
3. **Persistent** — written into the saved PDF so they survive save → re-open (and, best-effort, show in other PDF viewers).
4. **Searchable** — the Search tab matches page labels in addition to page text.
5. **Attached to the page** — reordering a page carries its label with it (also delete/insert).

## Resolved decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Display on thumbnail badge (+ nav) | **Label replaces the number**, defaulting to the sequential number so nothing changes visually until edited. |
| 2 | Edit UX | **Inline on the thumbnail** (double-click the badge). |
| 3 | Portability | **Also write standard `/PageLabels`** (best-effort, verified via interop harness), in addition to nanodoc's own storage. |
| 4 | Auto-source precedence | **Integrated `/PageLabels` → bookmark title → sequential number.** Only the first two are *stored*; the sequential number is a display-only fallback (see "Store a label only when meaningful"). |

## Background & constraints (from codebase exploration)

- **No stable per-page identity exists.** Pages are tracked purely by 0-based integer index. Every index-keyed store map must be manually remapped wherever pages move; metadata lacking that remap silently attaches to the wrong page. `pageHorizontalFlips` (`src/shared/stores/pdfStore.ts:44`) is the proof — it is never remapped on reorder/delete and is already a latent bug.
- **Rotation is the exception that survives reorder for free**, because it lives *inside the PDF page dictionary* (`/Rotate`) and rides the physical page when mupdf `rearrangePages` moves it. `readPageMetadata` reads it from the page dict (`src/core/pdf/PDFDocument.ts:81-113`).
- **mupdf can write `/PageLabels`** via `setPageLabels(index, style, prefix, start)` and has `PAGE_LABEL_*` style constants (`node_modules/mupdf/dist/mupdf.d.ts:454-461`). There is **no reader API** — reading a file's integrated labels means walking the catalog `/PageLabels` `/Nums` array manually. **pdf-lib has no page-label API.**
- **Save byte-production choke point:** `PDFDocumentOperations.saveDocument` (`src/core/pdf/PDFDocumentOperations.ts:158`), bytes minted by `pdfDoc.saveToBuffer()` at `:657-660`. After that, conditional pdf-lib post-passes re-load/re-save the bytes (`ImageStampEmbedder`, `FormFieldEmbedder`, AI-metadata attach) at `:683-716`.
- **Bookmarks are NOT currently written into the PDF** (the write path `PDFBookmarks.addPDFBookmark` is a no-op stub, `src/core/pdf/PDFBookmarks.ts:73`). The outline *reader* works via `getPDFBookmarks()` (`:26`, uses `loadOutline()`). This feature only *reads* bookmarks (for auto-extraction); it does not change bookmark persistence.
- mupdf returns **truthy null-objects** for missing dict keys — always guard with `val.isNull?.()`, never plain `if (val)` (interop memory).

## Architecture

### Storage model — label lives in the page dictionary

Store each page's label as a custom key **`/NanodocLabel`** (a PDF string) in that page's dictionary, mirroring exactly how `/Rotate` works. Consequences:

- **Reorder / delete / insert require no new remap code.** The label is part of the page object; `rearrangePages`, delete, and insert move the physical page (and its dict) — the label goes with it. `refreshPageMetadata()` re-reads labels from the mutated doc, so in-memory metadata stays correct automatically.
- **Round-trips in nanodoc** — the key is in the saved bytes and read back on open.
- This deliberately does **not** introduce a parallel stable-page-ID system (rejected alternative — see below), which would require keeping an ID array in lockstep at every mutation site (the same fragility class as `pageHorizontalFlips`).

### Rejected alternatives

- **B — Stable `pageId[]` + store map keyed by id.** Add an id array to the document model, splice it in lockstep with every mupdf page op, key labels by id in the store. Rejected: must touch every mutation site (reorder/delete/insert/paste); high risk of the `pageHorizontalFlips`-class bug; and the id→label map isn't in the page itself, so a re-opened raw file relies solely on the lossy range-based `/PageLabels`.
- **C — `/PageLabels`-only, remap an index-keyed store map on reorder.** Simplest storage but requires remap code at every mutation site *and* `/PageLabels` is range-based/lossy for free-text. Worst of both; rejected.

## Data model changes

- Add `label?: string` to `PDFPageMetadata` (`src/core/pdf/PDFDocument.ts:8-13`).
- `readPageMetadata` (`:81-113`) reads `/NanodocLabel` from the page dict (guarded with `isNull?.()`) into `metadata.label`. Undefined when absent (auto-extraction fills the default).
- No new store map. Labels are document/page state (in the PDF + `PDFPageMetadata`), not a `pdfStore` index-keyed map — this is what makes them reorder-safe.

## Auto-extraction on open

After a document loads, for each page **without** an existing `/NanodocLabel`, derive a label by precedence:

1. **Integrated `/PageLabels`** — read via a new manual reader (see algorithm below).
2. **Bookmark title** — first outline entry pointing at that page (from `getPDFBookmarks()`).
3. **Sequential number** — `getDisplayPageNumber(i)` (cover-page aware).

### Store a label only when meaningful

Write `/NanodocLabel` into the page dict **only when the label came from source 1 or 2** (integrated `/PageLabels` or a bookmark). A page whose label would only be the **sequential fallback (source 3) is left unstored** and simply displays its live position.

Rationale:
- **Plain documents** (no integrated labels, no bookmarks) are **not mutated on open** — no dirty/autosave trip, no bloated `/PageLabels` on save.
- **Reorder is intuitive per source:** a stored label (imported or edited) follows its page; an unstored page re-derives its sequential position — which is what a user expects for a page they never labeled.
- Still satisfies "give each page a label": every page *shows* a label; only meaningful ones are persisted. A manual edit always stores (it is meaningful by definition).

Files that *do* carry importable labels get a one-time dict write on open; this marks them changed, which is baked into the load step so it does not spuriously trip the dirty/autosave indicator. (Fallback if load-time mutation is problematic: defer the write to first-edit/first-reorder/save — but reorder must flush stored labels to the dict *before* `rearrangePages`.)

### `/PageLabels` reader algorithm (new)

`/PageLabels` is a number tree on the catalog: `Root/PageLabels/Nums = [i0, dict0, i1, dict1, …]` where each `dict` may carry `/S` (style: `D`/`R`/`r`/`A`/`a`), `/P` (prefix string), `/St` (start integer, default 1). Each entry `iN` begins a range that runs until the next entry. To compute page `p`'s label: find the range covering `p`, then `label = prefix + format(style, St + (p − rangeStart))`, where `format` renders decimal / upper-or-lower roman / upper-or-lower alpha. A range with no `/S` yields just the prefix (no number). Guard every `.get()` with `isNull?.()`.

## Editing UX

- Double-click the thumbnail badge (`src/features/thumbnails/ThumbnailItem.tsx:263-265`) → inline text `<input>` seeded with the current label → Enter/blur commits, Esc cancels.
- Commit calls a new `PDFPageOperations.setPageLabel(document, pageIndex, text)` that writes `/NanodocLabel` to the page dict and calls `refreshPageMetadata()` (same write+refresh path as rotation).
- `ThumbnailItem` gains a `label` value (from metadata) and an `onLabelChange(pageIndex, text)` callback threaded from `ThumbnailCarousel`.

## Display

- Thumbnail badge shows `metadata.label ?? String(pageNumber + 1)`.
- Search results and any "Page X" text may show the label alongside the absolute index.
- The page-jump input in the bottom nav stays **absolute-index** based (arbitrary label text is not a valid jump target); the current page's label is shown next to "Page X of Y".

## Persistence on save

In `PDFDocumentOperations.saveDocument`, **before** `saveToBuffer()` (`:657`):

1. Stored labels are already in the page dicts, so they persist automatically in the mupdf save.
2. **Additionally**, *if the document has at least one stored label*, emit a standard `/PageLabels` tree via mupdf `setPageLabels`. MVP representation: **one range per page** — a stored label → `setPageLabels(i, PAGE_LABEL_NONE, label_i)` (prefix = the full label, no numbering; correct for arbitrary free-text); an unstored page → `setPageLabels(i, PAGE_LABEL_DECIMAL, undefined, getDisplayPageNumber(i))` so its absolute number still renders. A document with **zero** stored labels writes **no** `/PageLabels` tree (stays pristine). (Collapsing consecutive same-style pages into fewer ranges is a later optimization — YAGNI.)

**Interop verification required** (see Risks): confirm both `/NanodocLabel` and `/PageLabels` survive the conditional pdf-lib post-passes (`:683-716`). If `/PageLabels` is stripped by a pdf-lib re-save, move its write to a final pdf-lib post-pass built from low-level primitives (mirroring `FormFieldEmbedder`). `/NanodocLabel` on page objects is expected to survive (pdf-lib copies page objects).

## Reorder / delete / insert

No dedicated remap code for labels — stored labels ride the page dict. After any op, the existing `refreshPageMetadata()` re-reads labels from the mutated doc, so a stored label follows its page and an unstored page re-derives its sequential position. The one requirement: stored labels must be in the page dict *before* the first `rearrangePages` (satisfied by write-on-open / write-on-edit). Existing annotation/spec remap logic in `handleDragEnd` (`ThumbnailCarousel.tsx:654-807`) is unchanged.

## Search by label

In the inline debounced search `useEffect` (`ThumbnailCarousel.tsx:459-526`), for each page also test its `label` against the query (case-insensitive substring). Push a synthetic `SearchMatch` with a new discriminator `kind: "text" | "label"` (`SearchMatch` in `pdfStore.ts:21-33`); label matches have no `quad`. The results renderer (`:1818-1908`) and `navigateToSearchResult` (`:543-547`) already key off `pageNumber`, so a label match integrates naturally; label rows render a "label" affordance instead of a text-highlight quad.

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| `/NanodocLabel` lost by `rearrangePages` | High confidence it survives (rotation does). Covered by interop test. |
| `/NanodocLabel` and/or `/PageLabels` stripped by pdf-lib post-passes | Interop round-trip test through the full save pipeline. `/PageLabels` fallback: write as a final pdf-lib post-pass. |
| `setPageLabels(i, NONE, prefix)` doesn't render prefix-only labels | Verify via harness; adjust representation if needed. |
| "Modified on open" from write-on-open | Only occurs for files that actually carry importable labels/bookmarks; plain docs are untouched. Baked into load step; documented fallback to defer the dict write. |
| Large docs → verbose one-range-per-page `/PageLabels` | Only written when ≥1 meaningful label exists; acceptable for MVP; run-collapsing is a later optimization. |

## Testing

Extend `src/core/pdf/interop/exportInterop.test.ts` (`npm run interop:check`):

1. Create doc → `setPageLabel` on several pages → save → reload → assert labels present in page dicts **and** in `/PageLabels`.
2. Reorder pages → assert each label follows its page.
3. Open a fixture with integrated `/PageLabels` → assert the reader extracts correct labels (roman front-matter + decimal body + a prefixed range).

## Out of scope (YAGNI)

- Bulk-edit / labels-list panel (decision 2 chose inline-only).
- Writing bookmarks into the PDF (separate concern; the stub stays as-is).
- Collapsing `/PageLabels` ranges.
- Label-based page-jump input.

## File-by-file touch list

- `src/core/pdf/PDFDocument.ts` — add `label` to `PDFPageMetadata`; read `/NanodocLabel` in `readPageMetadata`.
- `src/core/pdf/PDFPageOperations.ts` — new `setPageLabel(doc, pageIndex, text)` (write `/NanodocLabel` + refresh).
- `src/core/pdf/PageLabels.ts` *(new)* — `/PageLabels` reader (walk `/Nums`) + label formatters + auto-extraction orchestration (precedence).
- `src/core/pdf/PDFDocumentOperations.ts` — in `saveDocument`, write `/PageLabels` via `setPageLabels` before `saveToBuffer` (+ interop-verified fallback).
- Document load path — run auto-extraction after load, writing labels into page dicts.
- `src/features/thumbnails/ThumbnailItem.tsx` — badge shows label; inline double-click editor; `onLabelChange`.
- `src/features/thumbnails/ThumbnailCarousel.tsx` — thread `label`/`onLabelChange`; extend search `useEffect` to match labels.
- `src/shared/stores/pdfStore.ts` — add `kind` to `SearchMatch`.
- `src/core/pdf/interop/exportInterop.test.ts` — round-trip + reorder + reader tests.
