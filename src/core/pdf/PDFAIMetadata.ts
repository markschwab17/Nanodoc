/**
 * PDF AI Metadata
 *
 * Reads and writes AI-extracted data (specs, conversation history) in the PDF
 * Info dictionary and as an embedded file so that when a PDF is saved and
 * re-opened, extracted information and conversation can be restored.
 */

import type { SpecExtractionResult, GeotechnicalSummary, GeotechnicalScope } from "@/core/ai/types";

/** Key used in the PDF Info dictionary for NanoDoc AI data */
export const PDF_AI_METADATA_KEY = "info:NanoDocAI";
/** Fallback key (some runtimes use key without "info:" prefix) */
const PDF_AI_METADATA_KEY_ALT = "NanoDocAI";
/** Standard PDF Info key that mupdf always persists; we store payload with PREFIX so we can detect it on read */
const KEYWORDS_KEY = "info:Keywords";
/** Exported for ImageStampEmbedder to set Keywords when preserving AI metadata */
export const KEYWORDS_PREFIX = "NanoDocAI:";

/** Name of the embedded file used to store AI metadata inside the PDF (travels with the file) */
export const AI_EMBEDDED_FILE_NAME = ".nanodoc-ai.json";

/** Current schema version for forward compatibility */
const METADATA_VERSION = 1;

/**
 * Encode payload for storage in PDF Keywords (same format as writeAIMetadata).
 * Used by ImageStampEmbedder to restore AI metadata after pdf-lib rewrite.
 */
export function encodeAIMetadataForKeywords(payload: PDFAIMetadataPayload): string {
  const normalized: PDFAIMetadataPayload = {
    ...payload,
    version: payload.version ?? METADATA_VERSION,
  };
  const json = JSON.stringify(normalized);
  const encoded = btoa(unescape(encodeURIComponent(json)));
  return KEYWORDS_PREFIX + encoded;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface PDFAIMetadataPayload {
  version: number;
  extractedSpecs?: SpecExtractionResult[];
  /** Geotechnical (soils) extraction: fixed 5-row summary and scope used for insights */
  geotechnicalSummary?: GeotechnicalSummary;
  geotechnicalScope?: GeotechnicalScope;
  /** Conversation history for Q&A; can be extended later for "continue conversation" */
  conversationHistory?: {
    messages: ConversationMessage[];
  };
}

const AI_METADATA_KEYS = [PDF_AI_METADATA_KEY, PDF_AI_METADATA_KEY_ALT, "info:nanodocai"] as const;
/** Try "Keywords" first; some runtimes (e.g. encrypted PDF) expose only the standard key. */
const KEYWORDS_KEYS = ["Keywords", KEYWORDS_KEY] as const;

function parsePayload(raw: unknown): PDFAIMetadataPayload | null {
  if (raw == null || typeof raw !== "string" || !raw.length) return null;
  try {
    const decoded = decodeURIComponent(escape(atob(raw)));
    const payload = JSON.parse(decoded) as PDFAIMetadataPayload;
    if (payload == null || typeof payload.version !== "number") return null;
    return payload;
  } catch {
    return null;
  }
}

function payloadFromKeywords(value: unknown): PDFAIMetadataPayload | null {
  if (typeof value !== "string" || !value.startsWith(KEYWORDS_PREFIX)) return null;
  const raw = value.slice(KEYWORDS_PREFIX.length);
  return parsePayload(raw);
}

function readFromDoc(doc: any, getMeta: (key: string) => unknown): PDFAIMetadataPayload | null {
  if (!doc) return null;
  for (const key of AI_METADATA_KEYS) {
    const raw = getMeta(key);
    const payload = parsePayload(raw);
    if (payload) return payload;
  }
  for (const key of KEYWORDS_KEYS) {
    const payload = payloadFromKeywords(getMeta(key));
    if (payload) return payload;
  }
  return null;
}

/**
 * Read AI metadata from a mupdf Document (PDF). Returns null if missing or invalid.
 * Tries asPDF() first (encrypted PDFs often expose decrypted metadata on the PDF object),
 * then the document, with getMetaData/getMetadata and multiple key variants.
 */
export function readAIMetadata(mupdfDoc: any): PDFAIMetadataPayload | null {
  if (!mupdfDoc) return null;

  const getters: Array<(doc: any) => (key: string) => unknown> = [
    (doc) => (key) => (typeof doc.getMetaData === "function" ? doc.getMetaData(key) : null),
    (doc) => (key) => (typeof (doc as any).getMetadata === "function" ? (doc as any).getMetadata(key) : null),
  ];

  // Try PDF object first (asPDF); encrypted PDFs often expose decrypted metadata only there
  const pdf = typeof mupdfDoc.asPDF === "function" ? mupdfDoc.asPDF() : null;
  if (pdf) {
    for (const getter of getters) {
      const getMeta = getter(pdf);
      const payload = readFromDoc(pdf, getMeta);
      if (payload) return payload;
    }
  }

  for (const getter of getters) {
    const getMeta = getter(mupdfDoc);
    const payload = readFromDoc(mupdfDoc, getMeta);
    if (payload) return payload;
  }

  return null;
}

/**
 * Write AI metadata to a mupdf Document (PDF). Call before saveToBuffer() so it is included in the saved file.
 * Writes to both a custom key and to info:Keywords (with a prefix) so that at least one persists when the PDF is saved.
 */
export function writeAIMetadata(mupdfDoc: any, payload: PDFAIMetadataPayload): void {
  if (!mupdfDoc || typeof mupdfDoc.setMetaData !== "function") {
    return;
  }
  try {
    const normalized: PDFAIMetadataPayload = {
      ...payload,
      version: payload.version ?? METADATA_VERSION,
    };
    const json = JSON.stringify(normalized);
    const encoded = btoa(unescape(encodeURIComponent(json)));
    mupdfDoc.setMetaData(PDF_AI_METADATA_KEY, encoded);
    mupdfDoc.setMetaData(KEYWORDS_KEY, KEYWORDS_PREFIX + encoded);
  } catch (e) {
    console.warn("[PDFAIMetadata] Failed to write AI metadata:", e);
  }
}

/**
 * Read AI metadata from an embedded file inside the PDF (/.nanodoc-ai.json).
 * Uses pdf-lib to parse /Names/EmbeddedFiles and decode the stream.
 * Returns null if the attachment is missing or invalid.
 */
export async function readAIMetadataFromEmbeddedFile(
  pdfBytes: Uint8Array
): Promise<PDFAIMetadataPayload | null> {
  try {
    const {
      PDFDocument,
      PDFName,
      PDFDict,
      PDFArray,
      PDFHexString,
      decodePDFRawStream,
    } = await import("pdf-lib");

    const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const catalog = doc.catalog as any;
    const context = doc.context as any;

    if (!catalog.has(PDFName.of("Names"))) return null;
    const Names = catalog.lookup(PDFName.of("Names"), PDFDict);
    if (!Names.has(PDFName.of("EmbeddedFiles"))) return null;
    const EmbeddedFiles = Names.lookup(PDFName.of("EmbeddedFiles"), PDFDict);
    if (!EmbeddedFiles.has(PDFName.of("Names"))) return null;
    const EFNames = EmbeddedFiles.lookup(PDFName.of("Names"), PDFArray);
    const size = EFNames.size();
    for (let i = 0; i < size; i += 2) {
      const nameObj = EFNames.lookup(i);
      let nameStr: string;
      if (nameObj instanceof PDFHexString) {
        nameStr = (nameObj as any).decodeText();
      } else if (nameObj && typeof (nameObj as any).decodeText === "function") {
        nameStr = (nameObj as any).decodeText();
      } else {
        continue;
      }
      if (nameStr !== AI_EMBEDDED_FILE_NAME) continue;
      const fileSpecRef = EFNames.get(i + 1);
      if (!fileSpecRef) continue;
      const fileSpec = context.lookup(fileSpecRef, PDFDict);
      if (!fileSpec || !fileSpec.has(PDFName.of("EF"))) continue;
      const EF = fileSpec.lookup(PDFName.of("EF"), PDFDict);
      const streamRef = EF.get(PDFName.of("F")) || EF.get(PDFName.of("UF"));
      if (!streamRef) continue;
      const streamObj = context.lookup(streamRef);
      const contents =
        typeof (streamObj as any)?.getContents === "function"
          ? (streamObj as any).getContents()
          : (streamObj as any)?.contents;
      if (!streamObj?.dict || !(contents instanceof Uint8Array)) continue;
      const decoded = decodePDFRawStream({ dict: (streamObj as any).dict, contents } as any).decode();
      const json = new TextDecoder().decode(decoded);
      const payload = JSON.parse(json) as PDFAIMetadataPayload;
      if (payload != null && typeof payload.version === "number") return payload;
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Attach AI metadata as an embedded file to a PDF buffer (mupdf-only save path).
 * Loads the buffer with pdf-lib, attaches .nanodoc-ai.json, and returns the new bytes.
 */
export async function attachAIMetadataToPdfBuffer(
  pdfBytes: Uint8Array,
  payload: PDFAIMetadataPayload
): Promise<Uint8Array> {
  try {
    const { PDFDocument } = await import("pdf-lib");
    const normalized: PDFAIMetadataPayload = {
      ...payload,
      version: payload.version ?? METADATA_VERSION,
    };
    const json = JSON.stringify(normalized);
    const jsonBytes = new TextEncoder().encode(json);
    const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    await doc.attach(jsonBytes, AI_EMBEDDED_FILE_NAME, { mimeType: "application/json" });
    // useObjectStreams: false so mupdf-wasm can reopen the file without "corrupt object stream" errors
    return await doc.save({ useObjectStreams: false });
  } catch (e) {
    console.warn("[PDFAIMetadata] Failed to attach AI metadata to buffer:", e);
    return pdfBytes;
  }
}
