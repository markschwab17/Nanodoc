/**
 * Auto-save hook.
 *
 * Two modes, both triggered 30s after a document becomes modified:
 * - Tauri + known file path: saves in place (atomic temp-file + rename).
 * - No file path (browser opens, never-saved docs): writes a crash-recovery
 *   draft to IndexedDB. Drafts are offered for recovery on next startup and
 *   deleted once the document is saved for real.
 */

import { useEffect, useRef } from "react";
import { isTauri } from "@/shared/utils/environment";
import { useTabStore } from "@/shared/stores/tabStore";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { saveDraft, deleteDraft, isDraftStorageAvailable } from "@/shared/browserDraftStorage";
import { hasDecryptConsent } from "@/shared/utils/decryptConsent";

const AUTO_SAVE_DELAY = 30_000; // 30 seconds after last edit

/** Serialize the document with its annotations baked in. */
async function serializeDocument(documentId: string): Promise<Uint8Array | null> {
  const doc = usePDFStore.getState().documents.get(documentId);
  if (!doc) return null;
  const annotations = usePDFStore.getState().getAnnotations(documentId);
  const mupdfModule = await import("mupdf");
  const { PDFEditor } = await import("@/core/pdf/PDFEditor");
  const editor = new PDFEditor(mupdfModule.default);
  return editor.saveDocument(doc, annotations);
}

export function useAutoSave() {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTab = useTabStore((s) => s.activeTabId);
  const tabs = useTabStore((s) => s.tabs);

  useEffect(() => {
    if (!activeTab) return;

    const tab = tabs.find((t) => t.id === activeTab);
    if (!tab) return;

    if (!tab.isModified) {
      // Saved (or never edited): any crash-recovery draft is now stale.
      if (isDraftStorageAvailable()) {
        void deleteDraft(tab.documentId);
      }
      return;
    }

    const filePath = usePDFStore.getState().getDocumentPath(tab.documentId);
    const canSaveInPlace = isTauri && !!filePath;
    if (!canSaveInPlace && !isDraftStorageAvailable()) return;

    // Never silently auto-save an unprotected copy of an encrypted document —
    // wait until the user has confirmed the decrypt-on-save warning once
    // (via a manual save).
    const doc = usePDFStore.getState().documents.get(tab.documentId);
    if (doc?.isEncrypted() && !hasDecryptConsent(tab.documentId)) return;

    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(async () => {
      try {
        const pdfData = await serializeDocument(tab.documentId);
        if (!pdfData) return;

        const currentPath = usePDFStore.getState().getDocumentPath(tab.documentId);
        if (isTauri && currentPath) {
          const { atomicWriteFile } = await import("@/core/fs/TauriFileSystem");
          await atomicWriteFile(currentPath, pdfData);
          useTabStore.getState().setTabModified(activeTab, false);
          useTabStore.getState().setTabLastSaved(activeTab, Date.now());
        } else {
          // No real save target — keep a crash-recovery draft instead.
          // The tab stays modified; the draft is deleted on real save.
          await saveDraft(tab.documentId, tab.name, pdfData);
        }
      } catch (e) {
        console.warn("[AutoSave] Failed:", e);
      }
    }, AUTO_SAVE_DELAY);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [activeTab, tabs]);
}
