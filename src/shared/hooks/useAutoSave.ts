/**
 * Auto-save hook for Tauri desktop.
 *
 * When the document has a known file path (opened from disk or previously saved)
 * and has been modified, auto-saves after a debounce period.
 * Only saves the raw PDF bytes (annotations are synced during manual save).
 */

import { useEffect, useRef } from "react";
import { isTauri } from "@/shared/utils/environment";
import { useTabStore } from "@/shared/stores/tabStore";
import { usePDFStore } from "@/shared/stores/pdfStore";

const AUTO_SAVE_DELAY = 30_000; // 30 seconds after last edit

export function useAutoSave() {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTab = useTabStore((s) => s.activeTabId);
  const tabs = useTabStore((s) => s.tabs);

  useEffect(() => {
    if (!isTauri || !activeTab) return;

    const tab = tabs.find((t) => t.id === activeTab);
    if (!tab?.isModified) return;

    const filePath = usePDFStore.getState().getDocumentPath(tab.documentId);
    if (!filePath) return;

    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(async () => {
      try {
        const doc = usePDFStore.getState().getCurrentDocument();
        if (!doc) return;

        const currentPath = usePDFStore.getState().getDocumentPath(tab.documentId);
        if (!currentPath) return;

        // Sync annotations and save properly
        const annotations = usePDFStore.getState().getAnnotations(doc.getId());
        const mupdfModule = await import("mupdf");
        const { PDFEditor } = await import("@/core/pdf/PDFEditor");
        const editor = new PDFEditor(mupdfModule.default);
        const pdfData = await editor.saveDocument(doc, annotations);

        const { writeFile } = await import("@tauri-apps/plugin-fs");
        await writeFile(currentPath, pdfData);

        useTabStore.getState().setTabModified(activeTab, false);
        useTabStore.getState().setTabLastSaved(activeTab, Date.now());
      } catch (e) {
        console.warn("[AutoSave] Failed:", e);
      }
    }, AUTO_SAVE_DELAY);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [activeTab, tabs]);
}
