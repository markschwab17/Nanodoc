import { describe, it, expect } from "vitest";
import { PDFDocument as PdfLibDocument } from "pdf-lib";
import {
  AI_EMBEDDED_FILE_NAME,
  readAIMetadataFromMupdfDocument,
  type PDFAIMetadataPayload,
} from "./PDFAIMetadata";

async function blankPdf(): Promise<Uint8Array> {
  const doc = await PdfLibDocument.create();
  doc.addPage([200, 200]);
  return doc.save({ useObjectStreams: false });
}

// Same attachment the save path writes (attachAIMetadataToPdfBuffer / ImageStampEmbedder:
// pdf-lib attach, application/json). Passed as base64 because pdf-lib's Uint8Array
// instanceof check rejects TextEncoder output across vitest's realms.
async function withAttachments(files: Array<[name: string, text: string]>): Promise<Uint8Array> {
  const doc = await PdfLibDocument.load(await blankPdf());
  for (const [name, text] of files) {
    await doc.attach(Buffer.from(text, "utf8").toString("base64"), name, { mimeType: "application/json" });
  }
  return doc.save({ useObjectStreams: false });
}

async function openWithMupdf(bytes: Uint8Array) {
  const mupdf = (await import("mupdf")).default;
  return mupdf.Document.openDocument(bytes, "application/pdf");
}

const payload: PDFAIMetadataPayload = {
  version: 1,
  bookmarks: [
    { id: "b1", pageNumber: 0, title: "Grading", text: "", position: { x: 0, y: 0 }, created: 0 } as never,
  ],
};

describe("readAIMetadataFromMupdfDocument", () => {
  it("reads the .nanodoc-ai.json attachment written by the save path", async () => {
    const doc = await openWithMupdf(await withAttachments([[AI_EMBEDDED_FILE_NAME, JSON.stringify(payload)]]));
    const read = readAIMetadataFromMupdfDocument(doc);
    expect(read?.version).toBe(1);
    expect(read?.bookmarks?.[0]?.title).toBe("Grading");
  });

  it("returns null for a PDF with no attachments", async () => {
    const doc = await openWithMupdf(await blankPdf());
    expect(readAIMetadataFromMupdfDocument(doc)).toBeNull();
  });

  it("ignores other attachments and malformed payloads", async () => {
    const doc = await openWithMupdf(
      await withAttachments([
        [AI_EMBEDDED_FILE_NAME, "not json"],
        ["other.json", '{"version":1}'],
      ])
    );
    expect(readAIMetadataFromMupdfDocument(doc)).toBeNull();
  });

  it("returns null (never throws) for a non-PDF document handle", () => {
    expect(readAIMetadataFromMupdfDocument({} as never)).toBeNull();
    expect(readAIMetadataFromMupdfDocument(null as never)).toBeNull();
  });
});
