/**
 * Fixture builders for the export-interop test suite. Built with pdf-lib so
 * they run in plain Node (no DOM, no workers). Each returns raw PDF bytes that
 * the suite feeds through the REAL app save pipeline.
 */

import {
  PDFDocument as PDFLibDocument,
  PDFName,
  PDFString,
  PDFNumber,
  StandardFonts,
  rgb,
} from "pdf-lib";

const LETTER: [number, number] = [612, 792];

/**
 * One or more letter pages with known text content (for annotation + redaction
 * tests, and multi-page page-label tests). Default `pages = 1` preserves the
 * original single-page fixture for existing callers.
 */
export async function buildBasicPdf(pages: number = 1): Promise<Uint8Array> {
  const doc = await PDFLibDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage(LETTER);
    if (p === 0) {
      page.drawText("CONFIDENTIAL BID 12345", { x: 72, y: 700, size: 18, font, color: rgb(0, 0, 0) });
      page.drawText("General notes: construct 6-inch PCC curb per detail 2.", {
        x: 72,
        y: 660,
        size: 11,
        font,
      });
    } else {
      page.drawText(`Page ${p + 1} body text`, { x: 72, y: 700, size: 12, font });
    }
  }
  return doc.save({ useObjectStreams: false });
}

/** A PDF with an Adobe-style AcroForm: filled text field + checked checkbox. */
export async function buildAcroFormPdf(): Promise<Uint8Array> {
  const doc = await PDFLibDocument.create();
  const page = doc.addPage(LETTER);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Submittal form", { x: 72, y: 730, size: 14, font });

  const form = doc.getForm();
  const tf = form.createTextField("ClientName");
  tf.setText("Acme Corp");
  tf.addToPage(page, { x: 72, y: 680, width: 220, height: 24 });

  const cb = form.createCheckBox("Approved");
  cb.check();
  cb.addToPage(page, { x: 72, y: 640, width: 18, height: 18 });

  return doc.save({ useObjectStreams: false });
}

/** A PDF containing an external (foreign-tool) Ink annotation on page 0. */
export async function buildExternalInkPdf(): Promise<Uint8Array> {
  const doc = await PDFLibDocument.create();
  const page = doc.addPage(LETTER);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Sheet with external markup", { x: 72, y: 700, size: 14, font });

  const ctx = doc.context;
  const inkRef = ctx.register(
    ctx.obj({
      Type: "Annot",
      Subtype: "Ink",
      Rect: [100, 100, 250, 200],
      InkList: [[110, 110, 160, 180, 240, 120]],
      C: [1, 0, 0],
      F: 4, // print flag
      Contents: PDFString.of("external freehand markup"),
    }),
  );
  page.node.set(PDFName.of("Annots"), ctx.obj([inkRef]));
  return doc.save({ useObjectStreams: false });
}

/** A PDF with a native /Outlines tree (one bookmark to page 0). */
export async function buildOutlinePdf(): Promise<Uint8Array> {
  const doc = await PDFLibDocument.create();
  const page = doc.addPage(LETTER);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Document with native bookmarks", { x: 72, y: 700, size: 14, font });

  const ctx = doc.context;
  const pageRef = doc.getPage(0).ref;
  const outlinesRef = ctx.nextRef();
  const itemRef = ctx.nextRef();

  ctx.assign(
    itemRef,
    ctx.obj({
      Title: PDFString.of("Sheet 1 - Grading Plan"),
      Parent: outlinesRef,
      Dest: ctx.obj([pageRef, PDFName.of("Fit")]),
    }),
  );
  ctx.assign(
    outlinesRef,
    ctx.obj({
      Type: "Outlines",
      First: itemRef,
      Last: itemRef,
      Count: PDFNumber.of(1),
    }),
  );
  doc.catalog.set(PDFName.of("Outlines"), outlinesRef);
  return doc.save({ useObjectStreams: false });
}
