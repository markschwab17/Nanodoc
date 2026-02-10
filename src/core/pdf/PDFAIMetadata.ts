/**
 * PDF AI Metadata
 *
 * Reads and writes AI-extracted data (specs, conversation history) in the PDF
 * Info dictionary so that when a PDF is saved and re-opened, extracted information
 * and conversation can be restored.
 */

import type { SpecExtractionResult } from "@/core/ai/types";

/** Key used in the PDF Info dictionary for NanoDoc AI data */
export const PDF_AI_METADATA_KEY = "info:NanoDocAI";
/** Fallback key (some runtimes use key without "info:" prefix) */
const PDF_AI_METADATA_KEY_ALT = "NanoDocAI";

/** Current schema version for forward compatibility */
const METADATA_VERSION = 1;

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface PDFAIMetadataPayload {
  version: number;
  extractedSpecs?: SpecExtractionResult[];
  /** Conversation history for Q&A; can be extended later for "continue conversation" */
  conversationHistory?: {
    messages: ConversationMessage[];
  };
}

/**
 * Read AI metadata from a mupdf Document (PDF). Returns null if missing or invalid.
 */
export function readAIMetadata(mupdfDoc: any): PDFAIMetadataPayload | null {
  if (!mupdfDoc || typeof mupdfDoc.getMetaData !== "function") {
    return null;
  }
  const tryKey = (key: string): PDFAIMetadataPayload | null => {
    try {
      const raw = mupdfDoc.getMetaData(key);
      if (raw == null || typeof raw !== "string" || !raw.length) {
        return null;
      }
      const decoded = decodeURIComponent(escape(atob(raw)));
      const payload = JSON.parse(decoded) as PDFAIMetadataPayload;
      if (payload == null || typeof payload.version !== "number") {
        return null;
      }
      return payload;
    } catch {
      return null;
    }
  };
  return tryKey(PDF_AI_METADATA_KEY) ?? tryKey(PDF_AI_METADATA_KEY_ALT);
}

/**
 * Write AI metadata to a mupdf Document (PDF). Call before saveToBuffer() so it is included in the saved file.
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
  } catch (e) {
    console.warn("[PDFAIMetadata] Failed to write AI metadata:", e);
  }
}
