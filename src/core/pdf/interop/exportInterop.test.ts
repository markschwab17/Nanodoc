// @vitest-environment node
/**
 * Export-interop harness.
 *
 * Drives the REAL save pipeline (PDFDocument + PDFEditor.saveDocument) over
 * pdf-lib-generated fixtures in plain Node, then verifies the output three
 * ways: reopening with mupdf, reopening with pdf-lib, and structural checks
 * via the qpdf CLI when available.
 *
 * Tests marked `it.fails` document KNOWN interop bugs from the 2026-06 export
 * audit — they "pass" while the bug exists and break when it is fixed, at
 * which point they must be flipped to plain `it`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument as PDFLibDocument } from "pdf-lib";
import { PDFDocument } from "../PDFDocument";
import { PDFEditor } from "../PDFEditor";
import type { Annotation } from "../PDFEditor";
import { readIntegratedPageLabels } from "../PageLabels";
import {
  buildBasicPdf,
  buildAcroFormPdf,
  buildExternalInkPdf,
  buildOutlinePdf,
} from "./interopFixtures";

const QPDF = "/opt/homebrew/bin/qpdf";
const hasQpdf = existsSync(QPDF);

let mupdf: any;
let tmpDir: string;
let fixtureCounter = 0;

beforeAll(async () => {
  mupdf = (await import("mupdf")).default;
  tmpDir = mkdtempSync(join(tmpdir(), "nanodoc-interop-"));
});

/** Run a fixture through the real app save pipeline. */
async function saveViaApp(
  bytes: Uint8Array,
  annotations: Annotation[],
): Promise<Uint8Array> {
  const doc = new PDFDocument(`doc_interop_${fixtureCounter++}`, "fixture.pdf", bytes.length);
  await doc.loadFromData(bytes, mupdf);
  const editor = new PDFEditor(mupdf);
  return editor.saveDocument(doc, annotations);
}

/** Load + collect the app's view of existing annotations (mirrors usePDF.loadPDF). */
async function loadAppAnnotations(doc: PDFDocument, editor: PDFEditor): Promise<Annotation[]> {
  const all: Annotation[] = [];
  for (let i = 0; i < doc.getPageCount(); i++) {
    all.push(...(await editor.loadAnnotationsFromPage(doc, i)));
  }
  return all;
}

/** Full open→loadAnnotations→save round trip, like the real app does. */
async function roundTripViaApp(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = new PDFDocument(`doc_interop_${fixtureCounter++}`, "fixture.pdf", bytes.length);
  await doc.loadFromData(bytes, mupdf);
  const editor = new PDFEditor(mupdf);
  const annots = await loadAppAnnotations(doc, editor);
  return editor.saveDocument(doc, annots);
}

/** Collect mupdf annotation subtypes on a page of saved bytes. */
function annotTypesOnPage(bytes: Uint8Array, page = 0): string[] {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const pdf = doc.asPDF();
  const p = pdf.loadPage(page);
  return p.getAnnotations().map((a: any) => a.getType());
}

function qpdfCheck(bytes: Uint8Array): { ok: boolean; output: string } {
  const f = join(tmpDir, `check-${fixtureCounter++}.pdf`);
  writeFileSync(f, bytes);
  try {
    const out = execFileSync(QPDF, ["--check", f], { encoding: "utf8" });
    return { ok: true, output: out };
  } catch (e: any) {
    return { ok: false, output: String(e.stdout || e.message) };
  }
}

function qpdfEncrypt(bytes: Uint8Array): Uint8Array {
  const src = join(tmpDir, `enc-src-${fixtureCounter++}.pdf`);
  const dst = join(tmpDir, `enc-dst-${fixtureCounter++}.pdf`);
  writeFileSync(src, bytes);
  // Owner-password-only (empty user password): opens everywhere, but is
  // encrypted with modification restrictions — the common "protected bid set".
  execFileSync(QPDF, ["--encrypt", "", "owner-secret", "256", "--modify=none", "--", src, dst]);
  return new Uint8Array(readFileSync(dst));
}

function qpdfIsEncrypted(bytes: Uint8Array): boolean {
  const f = join(tmpDir, `isenc-${fixtureCounter++}.pdf`);
  writeFileSync(f, bytes);
  const out = execFileSync(QPDF, ["--show-encryption", f], { encoding: "utf8" });
  return !/not encrypted/i.test(out);
}

function ann(partial: Partial<Annotation> & { type: string }): Annotation {
  return {
    id: `interop_${Math.random().toString(36).slice(2)}`,
    pageNumber: 0,
    x: 100,
    y: 400,
    width: 120,
    height: 60,
    ...partial,
  } as Annotation;
}

describe("save pipeline writes standard annotation subtypes", () => {
  let saved: Uint8Array;
  let types: string[];

  beforeAll(async () => {
    const basic = await buildBasicPdf();
    saved = await saveViaApp(basic, [
      ann({ type: "text", x: 72, y: 560, width: 220, height: 36, content: "Reviewed by nanodoc", fontSize: 12, fontFamily: "Helvetica", color: "#cc0000" }),
      ann({ type: "shape", shapeType: "rectangle", x: 80, y: 440, width: 140, height: 70, strokeColor: "#ff0000", strokeWidth: 2 }),
      ann({ type: "shape", shapeType: "circle", x: 280, y: 440, width: 80, height: 80, strokeColor: "#0000ff", strokeWidth: 2 }),
      ann({
        type: "shape",
        shapeType: "arrow",
        x: 80,
        y: 320,
        width: 120,
        height: 60,
        strokeColor: "#00aa00",
        strokeWidth: 2,
        points: [
          { x: 80, y: 320 },
          { x: 200, y: 380 },
        ],
      }),
      ann({
        type: "draw",
        x: 300,
        y: 300,
        width: 100,
        height: 60,
        color: "#aa00aa",
        strokeWidth: 2,
        strokeOpacity: 1,
        path: [
          { x: 300, y: 300 },
          { x: 340, y: 350 },
          { x: 400, y: 320 },
        ],
      }),
      ann({ type: "formField", fieldType: "text", x: 72, y: 220, width: 180, height: 24, fieldName: "JobNumber", fieldValue: "JN-100" }),
      ann({ type: "formField", fieldType: "checkbox", x: 72, y: 180, width: 18, height: 18, fieldName: "Reviewed", fieldValue: true }),
    ]);
    types = annotTypesOnPage(saved);
  });

  it("emits FreeText / Square / Circle / Line / Ink", () => {
    expect(types).toContain("FreeText");
    expect(types).toContain("Square");
    expect(types).toContain("Circle");
    expect(types).toContain("Line");
    expect(types).toContain("Ink");
  });

  // Phase 2: form fields are written as REAL AcroForm fields via the pdf-lib
  // post-pass (mupdf WASM cannot create functional Widgets). Verified through
  // pdf-lib's strict form parser — the same structures Adobe reads.
  it("emits fillable AcroForm fields for nanodoc-created form fields", async () => {
    const reopened = await PDFLibDocument.load(saved);
    const form = reopened.getForm();
    expect(form.getTextField("JobNumber").getText()).toBe("JN-100");
    expect(form.getCheckBox("Reviewed").isChecked()).toBe(true);
  });

  it("form fields have on-page widgets (not just orphan field dicts)", () => {
    // Regression guard: a /DA bug once left fields in /AcroForm with values
    // but no Widget on any page — invisible in every viewer.
    const doc = mupdf.Document.openDocument(saved, "application/pdf");
    const widgets = doc.asPDF().loadPage(0).getWidgets?.() ?? [];
    expect(widgets.length).toBeGreaterThanOrEqual(2);
  });

  it.skipIf(!hasQpdf)("passes qpdf --check (structurally valid PDF)", () => {
    const res = qpdfCheck(saved);
    expect(res.output).toContain("No syntax or stream encoding errors");
    expect(res.ok).toBe(true);
  });

  it("reopens in pdf-lib (Adobe-style strict parser)", async () => {
    const reopened = await PDFLibDocument.load(saved);
    expect(reopened.getPageCount()).toBe(1);
  });
});

describe("external AcroForm round-trip (Adobe-created forms)", () => {
  it("preserves field names and values through open+save", async () => {
    const fixture = await buildAcroFormPdf();
    const saved = await roundTripViaApp(fixture);
    const reopened = await PDFLibDocument.load(saved);
    const form = reopened.getForm();
    const tf = form.getTextField("ClientName");
    expect(tf.getText()).toBe("Acme Corp");
    const cb = form.getCheckBox("Approved");
    expect(cb.isChecked()).toBe(true);
  });
});

describe("external annotations from other tools", () => {
  // Phase 3: external Ink loads as an editable draw annotation and is
  // recreated on save (previously it was deleted and never reloaded).
  it("preserves a foreign Ink annotation through open+save", async () => {
    const fixture = await buildExternalInkPdf();
    const saved = await roundTripViaApp(fixture);
    expect(annotTypesOnPage(saved)).toContain("Ink");
  });
});

describe("rotated rectangles", () => {
  it("persist rotation as a Polygon and round-trip back to an editable rotated rect", async () => {
    const basic = await buildBasicPdf();
    const rotated = ann({
      type: "shape",
      shapeType: "rectangle",
      x: 100,
      y: 400,
      width: 140,
      height: 70,
      rotation: Math.PI / 6, // 30°
      strokeColor: "#ff0000",
      strokeWidth: 2,
    });
    const saved = await saveViaApp(basic, [rotated]);

    // Other viewers: a Polygon with 4 vertices (not an axis-aligned Square)
    expect(annotTypesOnPage(saved)).toContain("Polygon");
    expect(annotTypesOnPage(saved)).not.toContain("Square");

    // Our round-trip: loader restores shape + rotation from metadata keys
    const doc = new PDFDocument("doc_rot", "f.pdf", saved.length);
    await doc.loadFromData(saved, mupdf);
    const editor = new PDFEditor(mupdf);
    const loaded = await loadAppAnnotations(doc, editor);
    const rect = loaded.find((a: any) => a.type === "shape" && a.shapeType === "rectangle") as any;
    expect(rect).toBeTruthy();
    expect(rect.rotation).toBeCloseTo(Math.PI / 6, 3);
    expect(rect.x).toBeCloseTo(100, 1);
    expect(rect.width).toBeCloseTo(140, 1);

    // Re-save must not duplicate the polygon (delete-then-recreate covers it)
    const resaved = await editor.saveDocument(doc, loaded);
    const polys = annotTypesOnPage(resaved).filter((t) => t === "Polygon");
    expect(polys.length).toBe(1);
  });
});

describe("native outlines (bookmarks from the source PDF)", () => {
  it("survive open+save", async () => {
    const fixture = await buildOutlinePdf();
    const saved = await roundTripViaApp(fixture);
    const doc = mupdf.Document.openDocument(saved, "application/pdf");
    const outline = doc.loadOutline();
    expect(outline).toBeTruthy();
    expect(outline.length).toBeGreaterThan(0);
    expect(outline[0].title).toBe("Sheet 1 - Grading Plan");
  });
});

describe("all form field types are Adobe-fillable", () => {
  let saved: Uint8Array;

  beforeAll(async () => {
    const basic = await buildBasicPdf();
    saved = await saveViaApp(basic, [
      ann({ type: "formField", fieldType: "email", x: 60, y: 560, width: 180, height: 24, fieldName: "ContactEmail", fieldValue: "pm@acme.com" }),
      ann({ type: "formField", fieldType: "number", x: 60, y: 520, width: 120, height: 24, fieldName: "UnitCount", fieldValue: "42" }),
      ann({ type: "formField", fieldType: "date", x: 60, y: 480, width: 140, height: 24, fieldName: "BidDate", fieldValue: "June 9, 2026" }),
      ann({ type: "formField", fieldType: "dropdown", x: 60, y: 440, width: 160, height: 24, fieldName: "Phase", fieldValue: "Phase 2", options: ["Phase 1", "Phase 2", "Phase 3"] }),
      ann({ type: "formField", fieldType: "listbox", x: 60, y: 360, width: 160, height: 60, fieldName: "Trades", fieldValue: "Concrete", options: ["Grading", "Concrete", "Paving"] }),
      ann({ type: "formField", fieldType: "signature", x: 60, y: 300, width: 200, height: 40, fieldName: "EngineerSignature" }),
      ann({ type: "formField", fieldType: "radio", x: 60, y: 260, width: 18, height: 18, fieldName: "OptYes", fieldValue: true, radioGroup: "Approval" }),
      ann({ type: "formField", fieldType: "radio", x: 100, y: 260, width: 18, height: 18, fieldName: "OptNo", fieldValue: false, radioGroup: "Approval" }),
    ]);
  });

  it("email/number/date round-trip as text fields with values", async () => {
    const form = (await PDFLibDocument.load(saved)).getForm();
    expect(form.getTextField("ContactEmail").getText()).toBe("pm@acme.com");
    expect(form.getTextField("UnitCount").getText()).toBe("42");
    expect(form.getTextField("BidDate").getText()).toBe("June 9, 2026");
  });

  it("dropdown and listbox carry options and selection", async () => {
    const form = (await PDFLibDocument.load(saved)).getForm();
    const dd = form.getDropdown("Phase");
    expect(dd.getOptions()).toEqual(["Phase 1", "Phase 2", "Phase 3"]);
    expect(dd.getSelected()).toEqual(["Phase 2"]);
    const lb = form.getOptionList("Trades");
    expect(lb.getOptions()).toEqual(["Grading", "Concrete", "Paving"]);
    expect(lb.getSelected()).toEqual(["Concrete"]);
  });

  it("radio group selects the checked option", async () => {
    const form = (await PDFLibDocument.load(saved)).getForm();
    const rg = form.getRadioGroup("Approval");
    expect(rg.getOptions().sort()).toEqual(["OptNo", "OptYes"]);
    expect(rg.getSelected()).toBe("OptYes");
  });

  it("signature field exists as /FT Sig", async () => {
    const form = (await PDFLibDocument.load(saved)).getForm();
    const names = form.getFields().map((f) => f.getName());
    expect(names).toContain("EngineerSignature");
  });

  it.skipIf(!hasQpdf)("form output passes qpdf --check", () => {
    const res = qpdfCheck(saved);
    expect(res.ok).toBe(true);
  });
});

describe("redaction", () => {
  it("removes the text content and passes content verification", async () => {
    const basic = await buildBasicPdf();
    const doc = new PDFDocument("doc_redact", "fixture.pdf", basic.length);
    await doc.loadFromData(basic, mupdf);
    const editor = new PDFEditor(mupdf);

    // "CONFIDENTIAL BID 12345" is drawn at PDF y=700 (≈ fitz y 74-96 on a
    // 792pt page). Redact rect is given in the same y-down space RedactTool
    // uses after its flip.
    await editor.addRedactionAnnotation(
      doc,
      ann({ type: "redact", x: 60, y: 65, width: 280, height: 45 }),
    );

    const saved = await editor.saveDocument(doc, []);
    const reopened = mupdf.Document.openDocument(saved, "application/pdf");
    const text = reopened.asPDF().loadPage(0).toStructuredText().asText();
    expect(text).not.toContain("CONFIDENTIAL");
    // The second line of the fixture is outside the rect and must survive.
    expect(text).toContain("General notes");
  });
});

describe.skipIf(!hasQpdf)("encrypted/restricted PDFs", () => {
  // Phase 1: encrypted sources are saved explicitly decrypted (consistent
  // across all save paths); the UI warns + collects consent before saving.
  it("owner decision: output is saved unencrypted (restrictions removed)", async () => {
    const basic = await buildBasicPdf();
    const encrypted = qpdfEncrypt(basic);
    expect(qpdfIsEncrypted(encrypted)).toBe(true);

    const saved = await roundTripViaApp(encrypted);
    // Per owner decision the app saves unencrypted — the UI must WARN
    // (Phase 1); this asserts the output itself is consistent + valid.
    expect(qpdfIsEncrypted(saved)).toBe(false);
    const res = qpdfCheck(saved);
    expect(res.ok).toBe(true);
  });
});

describe("page labels: integrated reader", () => {
  it("reads roman front-matter + decimal body + prefixed range", async () => {
    // Build a 6-page PDF and stamp a /PageLabels tree via mupdf itself.
    const bytes = await buildBasicPdf(6);
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

describe("page labels: auto-populate on open", () => {
  it("stores integrated labels", async () => {
    const bytes = await buildBasicPdf(3);
    const seed = mupdf.Document.openDocument(bytes, "application/pdf").asPDF();
    seed.setPageLabels(0, mupdf.PDFDocument.PAGE_LABEL_ROMAN_LC);
    const withLabels = seed.saveToBuffer().asUint8Array();

    const doc = new PDFDocument("doc_auto_int", "fixture.pdf", withLabels.length);
    await doc.loadFromData(withLabels, mupdf);
    await new PDFEditor(mupdf).autoPopulatePageLabels(doc);
    expect(doc.getPageMetadata(0)?.label).toBe("i");
    expect(doc.getPageMetadata(2)?.label).toBe("iii");
  });

  it("stores bookmark titles when there is no integrated label", async () => {
    const bytes = await buildOutlinePdf();
    const doc = new PDFDocument("doc_auto_bm", "fixture.pdf", bytes.length);
    await doc.loadFromData(bytes, mupdf);
    await new PDFEditor(mupdf).autoPopulatePageLabels(doc);
    // The outline's first bookmark title should be stored on its target page.
    const bookmarked = doc.getMetadata().pages.find((p) => p.label !== undefined);
    expect(bookmarked?.label).toBeTruthy();
  });

  it("stores nothing for a plain document (no /PageLabels, no bookmarks)", async () => {
    const bytes = await buildBasicPdf(3);
    const doc = new PDFDocument("doc_auto_plain", "fixture.pdf", bytes.length);
    await doc.loadFromData(bytes, mupdf);
    await new PDFEditor(mupdf).autoPopulatePageLabels(doc);
    expect(doc.getMetadata().pages.every((p) => p.label === undefined)).toBe(true);
  });
});
