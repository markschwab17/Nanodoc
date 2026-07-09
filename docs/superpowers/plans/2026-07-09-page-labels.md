# Per-Page Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every page an auto-extracted, editable, persistent label that follows its page on reorder and is searchable.

**Architecture:** Store each page's label inside its PDF page dictionary under a custom `/NanodocLabel` key — exactly how rotation uses `/Rotate` — so labels ride the physical page through mupdf `rearrangePages`/delete/insert with zero remap code and persist in the saved bytes automatically. On open, auto-populate labels from the PDF's integrated `/PageLabels` tree or from bookmarks (sequential number is a display-only fallback that is *not* stored). On save, also emit a standard `/PageLabels` tree for external-viewer portability. Extend the inline Search to match labels.

**Tech Stack:** React 18, Zustand, TypeScript, mupdf.js (WASM) 1.26.4, pdf-lib 1.17.1, Vitest (interop harness runs in the Node vitest environment with real mupdf).

## Global Constraints

- **mupdf returns TRUTHY null-objects for missing dict keys** — always guard reads with `val.isNull?.()` and/or `val !== null && val !== undefined`; never plain `if (val)`.
- **Never route this feature's writes through pdf-lib for the page dict** — write `/NanodocLabel` and `/PageLabels` on the mupdf side. pdf-lib has no page-label API.
- **Save byte-production choke point is `PDFDocumentOperations.saveDocument`**, bytes minted by `pdfDoc.saveToBuffer()` at `src/core/pdf/PDFDocumentOperations.ts:657`. Inject `/PageLabels` writes *before* that line. Conditional pdf-lib post-passes run after (`:683-716`) and must be verified not to strip the labels.
- **Store a label only when meaningful** — persist `/NanodocLabel` only for labels sourced from integrated `/PageLabels`, a bookmark, or a manual edit. A page whose label would only be the sequential number is left unstored and displays its live position.
- **mupdf page-dict access pattern** (mirror rotation): `const page = pdfDoc.loadPage(i); const pageObj = page.getObject(); pageObj.get("Key"); pageObj.put("Key", pdfDoc.newString(text) | pdfDoc.newNumber(n));` and read strings via `.asString()`.
- **mupdf page-label constants** live on the mupdf `PDFDocument` class: `PAGE_LABEL_NONE="\0"`, `PAGE_LABEL_DECIMAL="D"`, `PAGE_LABEL_ROMAN_UC="R"`, `PAGE_LABEL_ROMAN_LC="r"`, `PAGE_LABEL_ALPHA_UC="A"`, `PAGE_LABEL_ALPHA_LC="a"`. Writer API: `pdfDoc.setPageLabels(index, style?, prefix?, start?)`.
- Run the interop harness with `npm run interop:check` (`vitest run src/core/pdf/interop/exportInterop.test.ts`). Typecheck with `npx tsc --noEmit`.

---

## File Structure

- **Create** `src/core/pdf/PageLabels.ts` — pure label logic: value formatters, the integrated `/PageLabels` reader, the `/PageLabels` tree writer, and the auto-extraction orchestrator.
- **Create** `src/core/pdf/PageLabels.test.ts` — unit tests for the pure formatters (jsdom/node vitest, no mupdf).
- **Modify** `src/core/pdf/PDFDocument.ts` — add `label` to `PDFPageMetadata`; read `/NanodocLabel` in `readPageMetadata`.
- **Modify** `src/core/pdf/PDFPageOperations.ts` — add `setPageLabel(document, pageNumber, text)`.
- **Modify** `src/core/pdf/PDFEditor.ts` — delegate `setPageLabel`; expose `autoPopulatePageLabels`.
- **Modify** `src/core/pdf/PDFDocumentOperations.ts` — write `/PageLabels` before `saveToBuffer()`.
- **Modify** `src/shared/hooks/usePDF.ts` — call auto-extraction after load.
- **Modify** `src/shared/stores/pdfStore.ts` — add `kind` discriminator to `SearchMatch`.
- **Modify** `src/features/thumbnails/ThumbnailItem.tsx` — badge shows label; inline double-click editor; `onLabelChange`.
- **Modify** `src/features/thumbnails/ThumbnailCarousel.tsx` — thread `label`/`onLabelChange`; match labels in the search `useEffect`.
- **Modify** `src/core/pdf/interop/exportInterop.test.ts` — round-trip, reorder-follow, and reader tests.

---

### Task 1: Label value formatters

**Files:**
- Create: `src/core/pdf/PageLabels.ts`
- Test: `src/core/pdf/PageLabels.test.ts`

**Interfaces:**
- Produces: `formatLabelValue(style: string, n: number): string` — formats a 1-based ordinal `n` per a mupdf page-label style constant (`"D"`, `"R"`, `"r"`, `"A"`, `"a"`; `"\0"`/unknown → `""`).
- Produces: `PAGE_LABEL_STYLE` const object mirroring the mupdf constants for use without a live mupdf instance.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/pdf/PageLabels.test.ts
import { describe, it, expect } from "vitest";
import { formatLabelValue, PAGE_LABEL_STYLE } from "./PageLabels";

describe("formatLabelValue", () => {
  it("formats decimal", () => {
    expect(formatLabelValue(PAGE_LABEL_STYLE.DECIMAL, 1)).toBe("1");
    expect(formatLabelValue(PAGE_LABEL_STYLE.DECIMAL, 42)).toBe("42");
  });
  it("formats lowercase roman", () => {
    expect(formatLabelValue(PAGE_LABEL_STYLE.ROMAN_LC, 1)).toBe("i");
    expect(formatLabelValue(PAGE_LABEL_STYLE.ROMAN_LC, 4)).toBe("iv");
    expect(formatLabelValue(PAGE_LABEL_STYLE.ROMAN_LC, 9)).toBe("ix");
  });
  it("formats uppercase roman", () => {
    expect(formatLabelValue(PAGE_LABEL_STYLE.ROMAN_UC, 14)).toBe("XIV");
  });
  it("formats lowercase alpha with wraparound (a..z, aa, bb)", () => {
    expect(formatLabelValue(PAGE_LABEL_STYLE.ALPHA_LC, 1)).toBe("a");
    expect(formatLabelValue(PAGE_LABEL_STYLE.ALPHA_LC, 26)).toBe("z");
    expect(formatLabelValue(PAGE_LABEL_STYLE.ALPHA_LC, 27)).toBe("aa");
    expect(formatLabelValue(PAGE_LABEL_STYLE.ALPHA_UC, 28)).toBe("BB");
  });
  it("returns empty string for NONE/unknown style", () => {
    expect(formatLabelValue(PAGE_LABEL_STYLE.NONE, 3)).toBe("");
    expect(formatLabelValue("?", 3)).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/pdf/PageLabels.test.ts`
Expected: FAIL — cannot find module `./PageLabels` / `formatLabelValue is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/pdf/PageLabels.ts
/**
 * Per-page label logic: value formatting, integrated /PageLabels reading,
 * /PageLabels writing, and auto-extraction. Kept free of React so it can be
 * unit-tested and reused by the save pipeline.
 */

/** Mirrors mupdf's PDFDocument.PAGE_LABEL_* constants (usable without a live mupdf). */
export const PAGE_LABEL_STYLE = {
  NONE: "\0",
  DECIMAL: "D",
  ROMAN_UC: "R",
  ROMAN_LC: "r",
  ALPHA_UC: "A",
  ALPHA_LC: "a",
} as const;

const ROMAN: [number, string][] = [
  [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
  [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
];

function toRoman(n: number): string {
  let out = "";
  let rem = n;
  for (const [v, s] of ROMAN) {
    while (rem >= v) { out += s; rem -= v; }
  }
  return out;
}

// 1->a, 26->z, 27->aa, 28->bb (PDF spec: a..z then aa..zz, repeating the letter).
function toAlpha(n: number): string {
  const idx = (n - 1) % 26;
  const repeat = Math.floor((n - 1) / 26) + 1;
  return String.fromCharCode(97 + idx).repeat(repeat);
}

/** Format 1-based ordinal `n` per a mupdf page-label style constant. */
export function formatLabelValue(style: string, n: number): string {
  switch (style) {
    case PAGE_LABEL_STYLE.DECIMAL: return String(n);
    case PAGE_LABEL_STYLE.ROMAN_UC: return toRoman(n);
    case PAGE_LABEL_STYLE.ROMAN_LC: return toRoman(n).toLowerCase();
    case PAGE_LABEL_STYLE.ALPHA_UC: return toAlpha(n).toUpperCase();
    case PAGE_LABEL_STYLE.ALPHA_LC: return toAlpha(n);
    default: return "";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/pdf/PageLabels.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/pdf/PageLabels.ts src/core/pdf/PageLabels.test.ts
git commit -m "feat(page-labels): label value formatters"
```

---

### Task 2: Integrated `/PageLabels` reader

**Files:**
- Modify: `src/core/pdf/PageLabels.ts`
- Test: `src/core/pdf/interop/exportInterop.test.ts` (needs real mupdf)

**Interfaces:**
- Consumes: `formatLabelValue`, `PAGE_LABEL_STYLE` (Task 1).
- Produces: `readIntegratedPageLabels(pdfDoc: any, pageCount: number): (string | null)[]` — returns one entry per page: the computed label from the catalog `/PageLabels` number tree, or `null` for pages not covered / when the doc has no `/PageLabels`. `pdfDoc` is a mupdf `PDFDocument` (from `mupdfDoc.asPDF()`).

- [ ] **Step 1: Write the failing test** (append inside `exportInterop.test.ts`)

```ts
// at top-level imports of exportInterop.test.ts add:
import { readIntegratedPageLabels } from "../PageLabels";

describe("page labels: integrated reader", () => {
  it("reads roman front-matter + decimal body + prefixed range", async () => {
    // Build a 6-page PDF and stamp a /PageLabels tree via mupdf itself.
    const bytes = await buildBasicPdf(6); // helper returns a 6-page PDF (see note)
    const doc = mupdf.Document.openDocument(bytes, "application/pdf");
    const pdfDoc = doc.asPDF();
    // pages 0-1 => i, ii ; pages 2-4 => 1,2,3 ; page 5 => "A-1"
    pdfDoc.setPageLabels(0, mupdf.PDFDocument.PAGE_LABEL_ROMAN_LC);
    pdfDoc.setPageLabels(2, mupdf.PDFDocument.PAGE_LABEL_DECIMAL, undefined, 1);
    pdfDoc.setPageLabels(5, mupdf.PDFDocument.PAGE_LABEL_DECIMAL, "A-", 1);

    const labels = readIntegratedPageLabels(pdfDoc, 6);
    expect(labels).toEqual(["i", "ii", "1", "2", "3", "A-1"]);
  });

  it("returns all-null when the document has no /PageLabels", async () => {
    const bytes = await buildBasicPdf(3);
    const doc = mupdf.Document.openDocument(bytes, "application/pdf");
    expect(readIntegratedPageLabels(doc.asPDF(), 3)).toEqual([null, null, null]);
  });
});
```

> **Note on `buildBasicPdf(n)`:** the existing fixture `buildBasicPdf` in `src/core/pdf/interop/interopFixtures.ts` builds a fixed small PDF. If it does not accept a page count, add an optional `pages = 1` parameter to it (pdf-lib `addPage` in a loop) as part of this task — a one-line change — and keep its default behavior unchanged for existing callers.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run interop:check`
Expected: FAIL — `readIntegratedPageLabels` is not exported.

- [ ] **Step 3: Write minimal implementation** (append to `PageLabels.ts`)

```ts
/** Guard for mupdf's truthy null-objects. */
function isPresent(v: any): boolean {
  return v !== null && v !== undefined && !(v.isNull?.() ?? false);
}

function objToString(v: any): string | null {
  if (!isPresent(v)) return null;
  try { return typeof v.asString === "function" ? v.asString() : null; }
  catch { return null; }
}

function objToNumber(v: any): number | null {
  if (!isPresent(v)) return null;
  if (typeof v === "number") return v;
  if (typeof v.asNumber === "function") { try { return v.asNumber(); } catch { /* fall through */ } }
  if (typeof v.valueOf === "function") { const n = v.valueOf(); if (typeof n === "number") return n; }
  return null;
}

/**
 * Read the catalog /PageLabels number tree and compute each page's label.
 * /PageLabels/Nums = [start0, dict0, start1, dict1, ...]; each dict may have
 * /S (style), /P (prefix), /St (start, default 1). A range runs from its start
 * index until the next range's start. A range with no /S yields prefix only.
 * Returns null per page when no tree exists or a page is uncovered.
 */
export function readIntegratedPageLabels(pdfDoc: any, pageCount: number): (string | null)[] {
  const out: (string | null)[] = new Array(pageCount).fill(null);
  let nums: any;
  try {
    const root = pdfDoc.getTrailer().get("Root");
    const pageLabels = root.get("PageLabels");
    if (!isPresent(pageLabels)) return out;
    nums = pageLabels.get("Nums");
    if (!isPresent(nums)) return out;
  } catch { return out; }

  // Collect [startIndex, styleDict] pairs.
  const ranges: { start: number; style: string; prefix: string; st: number }[] = [];
  const len = typeof nums.length === "number" ? nums.length : (nums.getLength?.() ?? 0);
  for (let i = 0; i + 1 < len; i += 2) {
    const startObj = nums.get(i);
    const dict = nums.get(i + 1);
    const start = objToNumber(startObj);
    if (start === null) continue;
    const style = objToString(dict.get("S")) ?? (isPresent(dict.get("S")) ? "" : PAGE_LABEL_STYLE.NONE);
    const sName = (() => { const s = dict.get("S"); return isPresent(s) && typeof s.asName === "function" ? s.asName() : null; })();
    const prefix = objToString(dict.get("P")) ?? "";
    const st = objToNumber(dict.get("St")) ?? 1;
    ranges.push({ start, style: sName ?? PAGE_LABEL_STYLE.NONE, prefix, st });
  }
  if (ranges.length === 0) return out;
  ranges.sort((a, b) => a.start - b.start);

  for (let p = 0; p < pageCount; p++) {
    // Find the last range whose start <= p.
    let r = ranges[0];
    for (const cand of ranges) { if (cand.start <= p) r = cand; else break; }
    if (r.start > p) { out[p] = null; continue; }
    const value = formatLabelValue(r.style, r.st + (p - r.start));
    out[p] = `${r.prefix}${value}`;
  }
  return out;
}
```

> **Implementation note:** `/S` is a PDF **name** (not a string). Read it via `asName()`; the helper above tries `asName` and falls back to NONE. Verify against the actual mupdf `PDFObject` API during implementation (`isName()`/`asName()` exist per `mupdf.d.ts`). Adjust `objToString`/`asName` usage if a value comes back as a name vs string.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run interop:check`
Expected: PASS for the two new "integrated reader" tests. If the first test's array differs (e.g. `/S` read as name vs string), fix the name-vs-string handling until it matches `["i","ii","1","2","3","A-1"]`.

- [ ] **Step 5: Commit**

```bash
git add src/core/pdf/PageLabels.ts src/core/pdf/interop/exportInterop.test.ts src/core/pdf/interop/interopFixtures.ts
git commit -m "feat(page-labels): read integrated /PageLabels tree"
```

---

### Task 3: `label` on page metadata + read `/NanodocLabel`

**Files:**
- Modify: `src/core/pdf/PDFDocument.ts:8-13` (interface), `:81-115` (`readPageMetadata`)
- Test: `src/core/pdf/interop/exportInterop.test.ts`

**Interfaces:**
- Produces: `PDFPageMetadata.label?: string` — the stored per-page label (from `/NanodocLabel`), `undefined` when unstored.

- [ ] **Step 1: Write the failing test** (append to `exportInterop.test.ts`)

```ts
describe("page labels: /NanodocLabel metadata", () => {
  it("readPageMetadata surfaces a written /NanodocLabel", async () => {
    const bytes = await buildBasicPdf(2);
    const doc = new PDFDocument("doc_label_meta", "fixture.pdf", bytes.length);
    await doc.loadFromData(bytes, mupdf);
    // Write /NanodocLabel directly on page 1's dict.
    const pdfDoc = doc.getMupdfDocument().asPDF();
    const page = pdfDoc.loadPage(1);
    page.getObject().put("NanodocLabel", pdfDoc.newString("Appendix A"));
    doc.refreshPageMetadata();
    expect(doc.getPageMetadata(1)?.label).toBe("Appendix A");
    expect(doc.getPageMetadata(0)?.label).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run interop:check`
Expected: FAIL — `label` is `undefined` on page 1 (reader not implemented).

- [ ] **Step 3: Write minimal implementation**

In `src/core/pdf/PDFDocument.ts`, extend the interface (lines 8-13):

```ts
export interface PDFPageMetadata {
  pageNumber: number;
  width: number;
  height: number;
  rotation: number;
  /** Stored per-page label from the /NanodocLabel page-dict key. Undefined when unstored. */
  label?: string;
}
```

In `readPageMetadata`, after computing `rotation` and before the `return`, read the label (mirrors the rotation read, guards mupdf null-objects):

```ts
    // Read stored per-page label (custom /NanodocLabel key), if present.
    let label: string | undefined;
    try {
      const pageObj = page.getObject();
      const labelObj = pageObj?.get("NanodocLabel");
      if (labelObj !== null && labelObj !== undefined && !(labelObj.isNull?.() ?? false)) {
        const s = typeof labelObj.asString === "function" ? labelObj.asString() : null;
        if (s) label = s;
      }
    } catch {
      label = undefined;
    }

    return {
      pageNumber: i,
      width: bounds[2] - bounds[0],
      height: bounds[3] - bounds[1],
      rotation,
      label,
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run interop:check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/pdf/PDFDocument.ts src/core/pdf/interop/exportInterop.test.ts
git commit -m "feat(page-labels): read /NanodocLabel into page metadata"
```

---

### Task 4: `setPageLabel` write path

**Files:**
- Modify: `src/core/pdf/PDFPageOperations.ts` (add method near `rotatePage` ~`:214`)
- Modify: `src/core/pdf/PDFEditor.ts` (delegate, near `:231`)
- Test: `src/core/pdf/interop/exportInterop.test.ts`

**Interfaces:**
- Consumes: `PDFPageMetadata.label` (Task 3).
- Produces: `PDFPageOperations.setPageLabel(document: PDFDocument, pageNumber: number, text: string): Promise<void>` — writes/clears `/NanodocLabel` on the page dict and refreshes metadata. Empty/whitespace `text` deletes the key (unstores).
- Produces: `PDFEditor.setPageLabel(document, pageNumber, text): Promise<void>` — delegates to `PDFPageOperations.setPageLabel`.

- [ ] **Step 1: Write the failing test**

```ts
describe("page labels: setPageLabel", () => {
  it("writes a label, reads it back, and it survives save+reload", async () => {
    const bytes = await buildBasicPdf(2);
    const doc = new PDFDocument("doc_setlabel", "fixture.pdf", bytes.length);
    await doc.loadFromData(bytes, mupdf);
    const editor = new PDFEditor(mupdf);

    await editor.setPageLabel(doc, 0, "Cover");
    expect(doc.getPageMetadata(0)?.label).toBe("Cover");

    const saved = await editor.saveDocument(doc, []);
    const reopened = new PDFDocument("doc_setlabel_2", "fixture.pdf", saved.length);
    await reopened.loadFromData(saved, mupdf);
    expect(reopened.getPageMetadata(0)?.label).toBe("Cover");
  });

  it("empty text unstores the label", async () => {
    const bytes = await buildBasicPdf(1);
    const doc = new PDFDocument("doc_unset", "fixture.pdf", bytes.length);
    await doc.loadFromData(bytes, mupdf);
    const editor = new PDFEditor(mupdf);
    await editor.setPageLabel(doc, 0, "Temp");
    await editor.setPageLabel(doc, 0, "   ");
    expect(doc.getPageMetadata(0)?.label).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run interop:check`
Expected: FAIL — `editor.setPageLabel is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `src/core/pdf/PDFPageOperations.ts` add:

```ts
  /**
   * Set (or clear) a page's stored label (/NanodocLabel in the page dict).
   * Empty/whitespace text deletes the key. Mirrors rotatePage's dict access
   * so the label rides the physical page through rearrange/delete/insert.
   */
  async setPageLabel(
    document: PDFDocument,
    pageNumber: number,
    text: string
  ): Promise<void> {
    const pdfDoc = document.getMupdfDocument().asPDF();
    if (!pdfDoc) throw new Error("Document is not a PDF");

    const page = pdfDoc.loadPage(pageNumber);
    const pageObj = page.getObject();
    if (!pageObj) throw new Error("Could not get page object");

    const trimmed = (text ?? "").trim();
    if (trimmed.length === 0) {
      try { pageObj.delete("NanodocLabel"); } catch { /* key may not exist */ }
    } else {
      pageObj.put("NanodocLabel", pdfDoc.newString(trimmed));
    }
    document.refreshPageMetadata();
  }
```

> **Note:** confirm the mupdf `PDFObject` delete API name (`delete`) against `mupdf.d.ts` during implementation; if it differs (e.g. no delete), overwrite with an empty string is an acceptable fallback, but prefer true deletion so unstored pages have no key.

In `src/core/pdf/PDFEditor.ts`, add a delegation next to the other page-op delegations:

```ts
  async setPageLabel(document: PDFDocument, pageNumber: number, text: string): Promise<void> {
    return this.pageOperations.setPageLabel(document, pageNumber, text);
  }
```

> Use the exact field name PDFEditor already uses for its `PDFPageOperations` instance (check how `reorderPages`/`rotatePage` delegate — likely `this.pageOperations` or similar). Match it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run interop:check`
Expected: PASS (both tests). The save+reload assertion also proves `/NanodocLabel` survives `saveToBuffer()`.

- [ ] **Step 5: Commit**

```bash
git add src/core/pdf/PDFPageOperations.ts src/core/pdf/PDFEditor.ts src/core/pdf/interop/exportInterop.test.ts
git commit -m "feat(page-labels): setPageLabel write path + persistence"
```

---

### Task 5: Write `/PageLabels` tree on save

**Files:**
- Modify: `src/core/pdf/PageLabels.ts` (add `writePageLabelsTree`)
- Modify: `src/core/pdf/PDFDocumentOperations.ts` (call it before `saveToBuffer()` at `:657`)
- Test: `src/core/pdf/interop/exportInterop.test.ts`

**Interfaces:**
- Consumes: `PDFPageMetadata.label` (Task 3), `readIntegratedPageLabels` (Task 2 — for verification only).
- Produces: `writePageLabelsTree(pdfDoc: any, mupdf: any, labels: (string | null)[], displayNumberOf: (i: number) => number): void` — if any entry is non-null, emits a `/PageLabels` tree: stored label → `setPageLabels(i, NONE, label)`; unstored → `setPageLabels(i, DECIMAL, undefined, displayNumberOf(i))`. No-op when all entries are null.

- [ ] **Step 1: Write the failing test**

```ts
describe("page labels: /PageLabels export on save", () => {
  it("writes a standard /PageLabels tree that round-trips through the full save pipeline", async () => {
    const bytes = await buildBasicPdf(3);
    const doc = new PDFDocument("doc_export", "fixture.pdf", bytes.length);
    await doc.loadFromData(bytes, mupdf);
    const editor = new PDFEditor(mupdf);
    await editor.setPageLabel(doc, 0, "i");   // stored
    await editor.setPageLabel(doc, 2, "B-1"); // stored; page 1 stays unstored

    const saved = await editor.saveDocument(doc, []);

    // Reopen and read the standard tree back with our reader.
    const reDoc = mupdf.Document.openDocument(saved, "application/pdf");
    const labels = readIntegratedPageLabels(reDoc.asPDF(), 3);
    expect(labels[0]).toBe("i");
    expect(labels[2]).toBe("B-1");
    expect(labels[1]).toBe("2"); // unstored page shows its decimal display number

    // And /NanodocLabel still survives too.
    const reApp = new PDFDocument("doc_export_2", "fixture.pdf", saved.length);
    await reApp.loadFromData(saved, mupdf);
    expect(reApp.getPageMetadata(0)?.label).toBe("i");
    expect(reApp.getPageMetadata(2)?.label).toBe("B-1");
    expect(reApp.getPageMetadata(1)?.label).toBeUndefined();
  });

  it("writes NO /PageLabels tree when the document has no stored labels", async () => {
    const bytes = await buildBasicPdf(2);
    const doc = new PDFDocument("doc_none", "fixture.pdf", bytes.length);
    await doc.loadFromData(bytes, mupdf);
    const saved = await new PDFEditor(mupdf).saveDocument(doc, []);
    const reDoc = mupdf.Document.openDocument(saved, "application/pdf");
    expect(readIntegratedPageLabels(reDoc.asPDF(), 2)).toEqual([null, null]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run interop:check`
Expected: FAIL — the reader returns `[null,null,null]` because nothing writes `/PageLabels` on save.

- [ ] **Step 3: Write minimal implementation**

Add to `PageLabels.ts`:

```ts
/**
 * Emit a standard /PageLabels tree from per-page labels. Stored labels become
 * prefix-only NONE ranges (correct for arbitrary text); unstored pages become
 * decimal ranges anchored at their display number so their number still shows.
 * No-op if every entry is null (keeps plain documents pristine).
 */
export function writePageLabelsTree(
  pdfDoc: any,
  mupdf: any,
  labels: (string | null)[],
  displayNumberOf: (i: number) => number,
): void {
  if (!labels.some((l) => l !== null && l !== undefined)) return;
  const S = mupdf.PDFDocument;
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label !== null && label !== undefined) {
      pdfDoc.setPageLabels(i, S.PAGE_LABEL_NONE, label);
    } else {
      pdfDoc.setPageLabels(i, S.PAGE_LABEL_DECIMAL, undefined, displayNumberOf(i));
    }
  }
}
```

In `src/core/pdf/PDFDocumentOperations.ts`, immediately **before** the `saveToBuffer()` block (before line 657), insert:

```ts
  // Emit a standard /PageLabels tree from the per-page stored labels so other
  // viewers show them. No-op when the document has no stored labels.
  try {
    const { writePageLabelsTree } = await import("./PageLabels");
    const meta = document.getMetadata();
    const labels = meta.pages.map((p) => p.label ?? null);
    writePageLabelsTree(pdfDoc, this.mupdf, labels, (i) => document.getDisplayPageNumber(i));
  } catch (e) {
    console.warn("[PDFDocumentOperations] Failed to write /PageLabels:", e);
  }
```

> `this.mupdf` is the mupdf module already held by `PDFDocumentOperations` (used elsewhere in the file, e.g. `this.mupdf.newNumber`). Confirm the field name and reuse it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run interop:check`
Expected: PASS. **If the first test fails only on the reader after save** (tree stripped by the pdf-lib post-passes at `:683-716`): confirm by asserting the tree exists right after `saveToBuffer` but not in `saved`. If stripped, move the `/PageLabels` write into a final pdf-lib post-pass that runs after `FormFieldEmbedder` — build the `/PageLabels` dict with pdf-lib low-level primitives (mirror `FormFieldEmbedder.ts`). Add a code sub-step then. (Expected outcome: catalog `/PageLabels` survives, since these tests exercise fixtures with no stamps/form-fields, so the post-passes are skipped — but the test guards it for the paths that do run them.)

- [ ] **Step 5: Commit**

```bash
git add src/core/pdf/PageLabels.ts src/core/pdf/PDFDocumentOperations.ts src/core/pdf/interop/exportInterop.test.ts
git commit -m "feat(page-labels): export standard /PageLabels tree on save"
```

---

### Task 6: Auto-populate labels on open

**Files:**
- Modify: `src/core/pdf/PageLabels.ts` (add `autoPopulatePageLabels`)
- Modify: `src/core/pdf/PDFEditor.ts` (delegate `autoPopulatePageLabels`)
- Modify: `src/shared/hooks/usePDF.ts` (call after load, ~after `pdfStore.addDocument` at `:81`)
- Test: `src/core/pdf/interop/exportInterop.test.ts`

**Interfaces:**
- Consumes: `readIntegratedPageLabels` (Task 2), `PDFBookmarks.getPDFBookmarks` (`src/core/pdf/PDFBookmarks.ts:26`), `PDFPageOperations.setPageLabel` semantics (Task 4 — but write directly here for batch efficiency).
- Produces: `autoPopulatePageLabels(document: PDFDocument, mupdf: any): Promise<void>` — for each page with no existing `/NanodocLabel`, derive a label (integrated → bookmark) and store it; sequential fallback is NOT stored. Refreshes metadata once at the end. Never throws (best-effort).
- Produces: `PDFEditor.autoPopulatePageLabels(document): Promise<void>` — delegates.

- [ ] **Step 1: Write the failing test**

```ts
import { buildOutlinePdf } from "./interopFixtures"; // already imported at top

describe("page labels: auto-populate on open", () => {
  it("stores integrated labels", async () => {
    const bytes = await buildBasicPdf(3);
    const seed = mupdf.Document.openDocument(bytes, "application/pdf").asPDF();
    seed.setPageLabels(0, mupdf.PDFDocument.PAGE_LABEL_ROMAN_LC);
    const withLabels = seed.saveToBuffer().asUint8Array();

    const doc = new PDFDocument("doc_auto_int", "fixture.pdf", withLabels.length);
    await doc.loadFromData(withLabels, mupdf);
    await new PDFEditor(mupdf).autoPopulatePageLabels(doc, mupdf);
    expect(doc.getPageMetadata(0)?.label).toBe("i");
    expect(doc.getPageMetadata(2)?.label).toBe("iii");
  });

  it("stores bookmark titles when there is no integrated label", async () => {
    // buildOutlinePdf builds a PDF whose outline points at page(s) with titles.
    const bytes = await buildOutlinePdf();
    const doc = new PDFDocument("doc_auto_bm", "fixture.pdf", bytes.length);
    await doc.loadFromData(bytes, mupdf);
    await new PDFEditor(mupdf).autoPopulatePageLabels(doc, mupdf);
    // The outline's first bookmark title should be stored on its target page.
    const bookmarked = doc.getMetadata().pages.find((p) => p.label !== undefined);
    expect(bookmarked?.label).toBeTruthy();
  });

  it("stores nothing for a plain document (no /PageLabels, no bookmarks)", async () => {
    const bytes = await buildBasicPdf(3);
    const doc = new PDFDocument("doc_auto_plain", "fixture.pdf", bytes.length);
    await doc.loadFromData(bytes, mupdf);
    await new PDFEditor(mupdf).autoPopulatePageLabels(doc, mupdf);
    expect(doc.getMetadata().pages.every((p) => p.label === undefined)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run interop:check`
Expected: FAIL — `autoPopulatePageLabels is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `PageLabels.ts`:

```ts
import { PDFBookmarks } from "./PDFBookmarks";

/**
 * On open: give each page a stored label where one is meaningful.
 * Precedence: existing /NanodocLabel (skip) → integrated /PageLabels → bookmark
 * title. The sequential number is a display-only fallback and is NOT stored.
 * Best-effort: never throws.
 */
export async function autoPopulatePageLabels(document: any, mupdf: any): Promise<void> {
  try {
    const pdfDoc = document.getMupdfDocument().asPDF();
    if (!pdfDoc) return;
    const pageCount = document.getPageCount();

    const integrated = readIntegratedPageLabels(pdfDoc, pageCount);

    // pageNumber -> first bookmark title
    const bmTitle = new Map<number, string>();
    try {
      const bookmarks = await new PDFBookmarks(mupdf).getPDFBookmarks(document);
      for (const b of bookmarks) {
        if (!bmTitle.has(b.pageNumber) && b.title) bmTitle.set(b.pageNumber, b.title);
      }
    } catch { /* outline read is best-effort */ }

    let wroteAny = false;
    for (let i = 0; i < pageCount; i++) {
      const page = pdfDoc.loadPage(i);
      const pageObj = page.getObject();
      const existing = pageObj?.get("NanodocLabel");
      const hasExisting = existing !== null && existing !== undefined && !(existing.isNull?.() ?? false);
      if (hasExisting) continue;

      const derived = integrated[i] ?? bmTitle.get(i) ?? null;
      if (derived === null || derived.trim().length === 0) continue; // sequential fallback: don't store

      pageObj.put("NanodocLabel", pdfDoc.newString(derived));
      wroteAny = true;
    }
    if (wroteAny) document.refreshPageMetadata();
  } catch (e) {
    console.warn("[PageLabels] autoPopulatePageLabels failed:", e);
  }
}
```

In `src/core/pdf/PDFEditor.ts`:

```ts
  async autoPopulatePageLabels(document: PDFDocument): Promise<void> {
    const { autoPopulatePageLabels } = await import("./PageLabels");
    return autoPopulatePageLabels(document, this.mupdf);
  }
```

> Use PDFEditor's existing mupdf field name (check the constructor / how it stores the mupdf module).

In `src/shared/hooks/usePDF.ts`, after `pdfStore.addDocument(document, normalizedFilePath || null);` (`:81`) and `setCurrentDocument`, add (wrapped so it never blocks open):

```ts
        // Give each page a label (integrated /PageLabels or bookmark titles).
        try {
          const { PDFEditor } = await import("@/core/pdf/PDFEditor");
          await new PDFEditor(mupdf).autoPopulatePageLabels(document);
        } catch (e) {
          console.warn("Auto page-label population failed:", e);
        }
```

> Match how `usePDF.ts` already imports/instantiates `PDFEditor` elsewhere in the file (it may already have an editor instance in scope — reuse it if so).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run interop:check`
Expected: PASS (3 tests). If `buildOutlinePdf`'s outline maps to unexpected page numbers, assert against the actual mapping it produces (read its fixture definition in `interopFixtures.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/core/pdf/PageLabels.ts src/core/pdf/PDFEditor.ts src/shared/hooks/usePDF.ts src/core/pdf/interop/exportInterop.test.ts
git commit -m "feat(page-labels): auto-populate labels from integrated tree + bookmarks on open"
```

---

### Task 7: Reorder-follow verification

**Files:**
- Test only: `src/core/pdf/interop/exportInterop.test.ts`

**Interfaces:**
- Consumes: `PDFEditor.setPageLabel`, `PDFEditor.reorderPages`, `PDFPageMetadata.label`.

- [ ] **Step 1: Write the failing/guard test**

```ts
describe("page labels: follow page on reorder", () => {
  it("a stored label rides its page through reorder", async () => {
    const bytes = await buildBasicPdf(3);
    const doc = new PDFDocument("doc_reorder", "fixture.pdf", bytes.length);
    await doc.loadFromData(bytes, mupdf);
    const editor = new PDFEditor(mupdf);
    await editor.setPageLabel(doc, 0, "FIRST");
    await editor.setPageLabel(doc, 2, "THIRD");

    // Move page 0 to the end: [0,1,2] -> [1,2,0].
    await editor.reorderPages(doc, [{ fromIndex: 0, toIndex: 2 }]);
    doc.refreshPageMetadata();

    const labels = doc.getMetadata().pages.map((p) => p.label);
    expect(labels).toEqual(["THIRD", undefined, "FIRST"]);
    //            new order: old page2(THIRD), old page1(none), old page0(FIRST)
  });
});
```

> Verify the exact `PageReorderOperation` shape (`{ fromIndex, toIndex }`) against `src/core/pdf/types.ts` and adjust the operation if the reorder semantics differ. The assertion's expected order must match what `rearrangePages` produces for that op.

- [ ] **Step 2: Run the test**

Run: `npm run interop:check`
Expected: PASS if `/NanodocLabel` rides the page (design's core claim). If it FAILS, the label is not surviving `rearrangePages` — do NOT paper over it: investigate whether mupdf drops custom page-dict keys on rearrange, and if so add explicit label carry-over in `PDFPageOperations.reorderPages` (read labels before, re-write after using the `pageOrder` mapping). Then re-run.

- [ ] **Step 3: Commit**

```bash
git add src/core/pdf/interop/exportInterop.test.ts
git commit -m "test(page-labels): verify labels follow pages on reorder"
```

---

### Task 8: Thumbnail badge — display + inline edit

**Files:**
- Modify: `src/features/thumbnails/ThumbnailItem.tsx:19-31` (props), `:263-265` (badge)
- Modify: `src/features/thumbnails/ThumbnailCarousel.tsx` (thumbnail render ~`:1751`, wire `onLabelChange`)

**Interfaces:**
- Consumes: `PDFPageMetadata.label` (Task 3), `PDFEditor.setPageLabel` (Task 4).
- Produces: `ThumbnailItemProps.label?: string`, `ThumbnailItemProps.onLabelChange?: (pageNumber: number, text: string) => void`.

This task is UI glue over canvas thumbnails; it is verified by driving the app (below), not a unit test.

- [ ] **Step 1: Add props + inline-editable badge to `ThumbnailItem.tsx`**

Add to `ThumbnailItemProps` (after `onDragStart?`):

```ts
  /** Stored label for this page; falls back to the 1-based number when absent. */
  label?: string;
  /** Commit an edited label (empty string clears it). */
  onLabelChange?: (pageNumber: number, text: string) => void;
```

Destructure `label` and `onLabelChange` in the component signature. Add edit state near the other `useState`s:

```ts
  const [editingLabel, setEditingLabel] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
```

Replace the badge (`:263-265`) with a display/edit swap:

```tsx
      <div className="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-sm font-medium text-center py-1.5 rounded-b">
        {editingLabel ? (
          <input
            autoFocus
            value={draftLabel}
            onChange={(e) => setDraftLabel(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onBlur={() => { onLabelChange?.(pageNumber, draftLabel); setEditingLabel(false); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { onLabelChange?.(pageNumber, draftLabel); setEditingLabel(false); }
              else if (e.key === "Escape") { setEditingLabel(false); }
            }}
            className="w-11/12 bg-white/90 text-black text-center text-sm rounded px-1 outline-none"
          />
        ) : (
          <span
            title="Double-click to rename this page label"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setDraftLabel(label ?? String(pageNumber + 1));
              setEditingLabel(true);
            }}
          >
            {label ?? pageNumber + 1}
          </span>
        )}
      </div>
```

- [ ] **Step 2: Wire the label + callback in `ThumbnailCarousel.tsx`**

At the `<ThumbnailItem .../>` render (~`:1751`), pass the label from metadata and an `onLabelChange` handler. Add a handler near the other page-op handlers:

```tsx
  const handleLabelChange = useCallback(async (pageNumber: number, text: string) => {
    if (!currentDocument) return;
    const mupdfModule = await import("mupdf");
    const editor = new PDFEditor(mupdfModule.default);
    await editor.setPageLabel(currentDocument, pageNumber, text);
    setReorderVersion((v) => v + 1); // force thumbnails to re-read metadata
  }, [currentDocument]);
```

And in the render:

```tsx
                <ThumbnailItem
                  document={currentDocument}
                  pageNumber={i}
                  /* ...existing props... */
                  label={currentDocument.getPageMetadata(i)?.label}
                  onLabelChange={handleLabelChange}
                />
```

> Match the existing prop list exactly (renderer, isActive, version, onClick, onDelete, onRotate). `PDFEditor` and `useCallback` are already imported in this file — verify and reuse.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Verify by driving the app**

Start the dev server (`npm run dev`, port 1420), create a PDF project (or open one), then in the Pages tab: double-click a thumbnail's number badge → type a label → Enter. Confirm the badge shows the label, switch to another tab and back (or reorder that page) and confirm the label persists and follows the page. Capture a screenshot.

- [ ] **Step 5: Commit**

```bash
git add src/features/thumbnails/ThumbnailItem.tsx src/features/thumbnails/ThumbnailCarousel.tsx
git commit -m "feat(page-labels): inline-editable label on thumbnail badge"
```

---

### Task 9: Search by label

**Files:**
- Modify: `src/shared/stores/pdfStore.ts:21-27` (`SearchMatch`)
- Modify: `src/features/thumbnails/ThumbnailCarousel.tsx:459-526` (search `useEffect`), results renderer `:1818-1908`

**Interfaces:**
- Consumes: `PDFPageMetadata.label`, `SearchResultData`/`SearchMatch`.
- Produces: `SearchMatch.kind: "text" | "label"` (optional, defaults to `"text"` when omitted for back-compat).

- [ ] **Step 1: Add the discriminator to `SearchMatch`**

```ts
export interface SearchMatch {
  pageNumber: number;
  quad: number[][];
  text: string;
  matchIndex: number;
  /** "text" = full-text hit (has quads); "label" = page-label hit (no quads). */
  kind?: "text" | "label";
}
```

- [ ] **Step 2: Match labels in the search `useEffect`**

Inside the per-page loop (`ThumbnailCarousel.tsx` ~`:481-501`), after collecting text matches for page `i`, also test the label:

```ts
      const meta = currentDocument.getPageMetadata(i);
      const label = meta?.label;
      if (label && label.toLowerCase().includes(searchQuery.toLowerCase())) {
        allMatches.push({
          pageNumber: i,
          quad: [],
          text: label,
          matchIndex: matchIndex++,
          kind: "label",
        });
      }
```

- [ ] **Step 3: Distinguish label rows in the results renderer**

In the results list (`:1859-1877`), where each match currently renders `Page {…}` / `Match {idx+1}`, branch on `match.kind`:

```tsx
                        <div className="text-xs text-muted-foreground">
                          {match.kind === "label" ? `Label: "${match.text}"` : `Match ${idx + 1}`}
                        </div>
```

`navigateToSearchResult` already keys off `match.pageNumber`, so clicking a label row jumps to the page (no highlight quad, which is correct for a label match).

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Verify by driving the app**

With a labeled page (from Task 8), open the Search tab and type part of a label → confirm a "Label: …" result appears and clicking it navigates to the page.

- [ ] **Step 6: Commit**

```bash
git add src/shared/stores/pdfStore.ts src/features/thumbnails/ThumbnailCarousel.tsx
git commit -m "feat(page-labels): match page labels in search"
```

---

## Self-Review

**Spec coverage:**
- Auto-extract from integrated `/PageLabels` → Tasks 2, 6. ✅
- Auto-extract from bookmarks → Task 6. ✅
- Give each page a label (display fallback) → Task 8 (badge shows `label ?? number`). ✅
- Editable → Task 8. ✅
- Persist across save/reopen → Tasks 4 (`/NanodocLabel`) + 5 (`/PageLabels`). ✅
- Search by label → Task 9. ✅
- Follows page on reorder → Task 7 (verified; carry-over fix path documented if needed). ✅
- Store-only-meaningful rule → Task 6 (integrated/bookmark stored, sequential not). ✅
- Portability decision (also write `/PageLabels`) → Task 5. ✅
- Interop verification of survival through pdf-lib post-passes → Task 5 Step 4 note. ✅

**Placeholder scan:** No TBD/TODO; every code step contains real code. The two "if the test reveals X, do Y" notes (Task 5 pdf-lib fallback, Task 7 reorder carry-over) are contingency instructions with concrete actions, not deferred work.

**Type consistency:** `PDFPageMetadata.label?: string` (Task 3) used consistently in Tasks 4/5/6/8/9. `readIntegratedPageLabels(pdfDoc, pageCount): (string|null)[]` used in Tasks 2/5/6. `setPageLabel(document, pageNumber, text)` signature consistent Tasks 4/8. `writePageLabelsTree(pdfDoc, mupdf, labels, displayNumberOf)` consistent Task 5. `SearchMatch.kind?: "text"|"label"` consistent Task 9.

**Open verification points (not blockers, resolved during implementation):**
- mupdf `PDFObject` name-vs-string handling for `/S` (Task 2 note).
- mupdf `PDFObject.delete` API name (Task 4 note).
- Whether `/PageLabels` survives pdf-lib post-passes on stamp/form-field paths (Task 5 note; fallback documented).
- Exact `PageReorderOperation` shape and PDFEditor's mupdf/pageOps field names (Tasks 4/6/7 notes).
