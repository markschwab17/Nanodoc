/**
 * Browser-only persistence for PDF AI metadata (extracted specs, conversation).
 * Keyed by SHA-256 hash of PDF bytes so re-opening the same file restores "View results".
 * Used when there is no file path (e.g. download then open in same browser).
 */

import type { PDFAIMetadataPayload } from "@/core/pdf/PDFAIMetadata";

const DB_NAME = "pdf-editor-ai-metadata";
const STORE_NAME = "metadata";
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: "hash" });
    };
  });
}

/**
 * Hash PDF bytes with SHA-256 (hex). Uses crypto.subtle; returns empty string if unavailable.
 */
export async function hashPdfBytes(bytes: Uint8Array): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) return "";
  try {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const buffer = await crypto.subtle.digest("SHA-256", ab);
    const arr = new Uint8Array(buffer);
    return Array.from(arr)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return "";
  }
}

/**
 * Store AI metadata for a PDF (keyed by hash of its bytes). No-op if hash is empty.
 */
export async function setPdfAiMetadata(
  hash: string,
  payload: PDFAIMetadataPayload
): Promise<void> {
  if (!hash) return;
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      store.put({ hash, payload, updatedAt: Date.now() });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch (e) {
    console.warn("[browserPdfAiStorage] setPdfAiMetadata failed:", e);
  }
}

/**
 * Retrieve AI metadata for a PDF by hash. Returns null if not found or on error.
 */
export async function getPdfAiMetadata(
  hash: string
): Promise<PDFAIMetadataPayload | null> {
  if (!hash) return null;
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(hash);
      req.onsuccess = () => {
        db.close();
        const row = req.result as { payload?: PDFAIMetadataPayload } | undefined;
        resolve(row?.payload ?? null);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch (e) {
    console.warn("[browserPdfAiStorage] getPdfAiMetadata failed:", e);
    return null;
  }
}

/**
 * True when we can use this storage (browser with IndexedDB and crypto.subtle).
 */
export function isBrowserAiStorageAvailable(): boolean {
  return (
    typeof indexedDB !== "undefined" &&
    typeof crypto !== "undefined" &&
    typeof crypto.subtle !== "undefined"
  );
}
