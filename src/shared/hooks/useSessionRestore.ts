/**
 * Session restore (Tauri only).
 *
 * Continuously records the open path-backed tabs (plus the active tab and its
 * page) to localStorage, and on the next launch reopens them so the user
 * picks up where they left off. Browser opens have no file path, so this is
 * a no-op outside Tauri (crash recovery there is handled by drafts).
 */

import { useEffect, useRef } from "react";
import { isTauri } from "@/shared/utils/environment";
import { useTabStore } from "@/shared/stores/tabStore";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { usePDF } from "@/shared/hooks/usePDF";

const SESSION_KEY = "nanodoc-session";
const PERSIST_DEBOUNCE_MS = 1_000;

interface SessionEntry {
  path: string;
  name: string;
}

interface SessionRecord {
  entries: SessionEntry[];
  activePath: string | null;
  activePage: number;
  savedAt: number;
}

function readSession(): SessionRecord | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessionRecord;
    if (!Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function useSessionRestore() {
  const { loadPDF } = usePDF();
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const currentPage = usePDFStore((s) => s.currentPage);
  const restoreStartedRef = useRef(false);
  const restoreSettledRef = useRef(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // loadPDF is recreated each render (its deps include the whole tab store);
  // keep the latest in a ref so the one-shot restore effect can use it.
  const loadPDFRef = useRef(loadPDF);
  loadPDFRef.current = loadPDF;

  // Restore once on startup, before any document is open.
  useEffect(() => {
    if (!isTauri || restoreStartedRef.current) return;
    restoreStartedRef.current = true;

    const session = readSession();
    if (!session || session.entries.length === 0) {
      restoreSettledRef.current = true;
      return;
    }
    // If something is already open (e.g. launched by double-clicking a PDF,
    // which queues a file-open event), still restore the rest of the session
    // but never duplicate a path that is already open.
    (async () => {
      try {
        const mupdfModule = await import("mupdf");
        const { readFile } = await import("@tauri-apps/plugin-fs");
        for (const entry of session.entries) {
          const alreadyOpen = Array.from(usePDFStore.getState().documentPaths.values()).includes(entry.path);
          if (alreadyOpen) continue;
          try {
            const data = await readFile(entry.path);
            await loadPDFRef.current(data, entry.name, mupdfModule.default, entry.path);
          } catch (e) {
            // File moved/deleted since last session — skip it.
            console.warn(`[SessionRestore] Could not reopen ${entry.path}:`, e);
          }
        }
        // Re-activate the previously active tab and page.
        if (session.activePath) {
          const pdfState = usePDFStore.getState();
          for (const [docId, path] of pdfState.documentPaths.entries()) {
            if (path === session.activePath) {
              const tab = useTabStore.getState().getTabByDocumentId(docId);
              if (tab) useTabStore.getState().setActiveTab(tab.id);
              pdfState.setCurrentDocument(docId);
              if (session.activePage > 0) pdfState.setCurrentPage(session.activePage);
              break;
            }
          }
        }
      } catch (e) {
        console.warn("[SessionRestore] Restore failed:", e);
      } finally {
        restoreSettledRef.current = true;
      }
    })();
  }, []);

  // Persist the session whenever tabs / active tab / page change (debounced).
  useEffect(() => {
    if (!isTauri) return;
    // Never clobber the stored session with an empty one while the startup
    // restore is still running (or hasn't begun) — that would lose it forever.
    if (!restoreSettledRef.current && tabs.length === 0) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      try {
        const pdfState = usePDFStore.getState();
        const entries: SessionEntry[] = [];
        for (const tab of tabs) {
          const path = pdfState.getDocumentPath(tab.documentId);
          if (path) entries.push({ path, name: tab.name });
        }
        const activeTab = tabs.find((t) => t.id === activeTabId) || null;
        const activePath = activeTab ? pdfState.getDocumentPath(activeTab.documentId) : null;
        const record: SessionRecord = {
          entries,
          activePath,
          activePage: currentPage,
          savedAt: Date.now(),
        };
        localStorage.setItem(SESSION_KEY, JSON.stringify(record));
      } catch {
        // localStorage full/unavailable — session restore is best-effort
      }
    }, PERSIST_DEBOUNCE_MS);
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [tabs, activeTabId, currentPage]);
}
