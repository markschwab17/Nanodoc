/**
 * usePDF Hook
 * 
 * Provides convenient access to PDF operations and current document state.
 */

import { useCallback } from "react";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useTabStore } from "@/shared/stores/tabStore";
import { useRecentFilesStore } from "@/shared/stores/recentFilesStore";
import { useUIStore } from "@/shared/stores/uiStore";
import { PDFDocument } from "@/core/pdf/PDFDocument";
import { PDFEditor } from "@/core/pdf/PDFEditor";

export function usePDF() {
  const pdfStore = usePDFStore();
  const tabStore = useTabStore();
  const recentFilesStore = useRecentFilesStore();
  const { setActiveTool } = useUIStore();

  // Access loading state reactively
  const loading = usePDFStore((state) => state.loading);
  const currentDocument = pdfStore.getCurrentDocument();
  const activeTab = tabStore.getActiveTab();

  const loadPDF = useCallback(
    async (data: Uint8Array, name: string, mupdf: any, filePath?: string | null) => {
      try {
        // Set loading state and ensure it's visible
        pdfStore.setLoading(true);
        pdfStore.clearError();
        
        // Force a microtask delay to ensure React has time to render the loading state
        await new Promise(resolve => setTimeout(resolve, 100));

        const documentId = `pdf_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const document = new PDFDocument(documentId, name, data.length);
        
        await document.loadFromData(data, mupdf);
        
        // Set original file path if provided
        if (filePath) {
          document.setOriginalFilePath(filePath);
        }
        
        pdfStore.addDocument(document, filePath || null);
        pdfStore.setCurrentDocument(documentId);

        // Add to recent files if we have a file path
        if (filePath) {
          recentFilesStore.addRecentFile({
            path: filePath,
            name: name,
            lastOpened: Date.now(),
          });
        }

        // Load existing annotations from PDF
        const editor = new PDFEditor(mupdf);
        const pageCount = document.getPageCount();
        const allAnnotations: any[] = [];
        
        for (let i = 0; i < pageCount; i++) {
          const pageAnnotations = await editor.loadAnnotationsFromPage(document, i);
          allAnnotations.push(...pageAnnotations);
        }
        
        // Add loaded annotations to store
        for (const annot of allAnnotations) {
          pdfStore.addAnnotation(documentId, annot);
        }

        // Create tab for this document
        const tabId = `tab_${documentId}`;
        tabStore.addTab({
          id: tabId,
          documentId,
          name,
          isModified: false,
          lastSaved: filePath ? Date.now() : null, // If loaded from file, consider it "saved"
          order: tabStore.tabs.length,
        });

        // Set select tool as default when PDF is loaded
        setActiveTool("select");
        
        // Blur any focused elements to prevent Enter/Space from triggering buttons
        if (typeof window !== 'undefined' && window.document.activeElement instanceof HTMLElement) {
          window.document.activeElement.blur();
        }

        return document;
      } catch (error) {
        pdfStore.setError(
          error instanceof Error ? error.message : "Failed to load PDF"
        );
        throw error;
      } finally {
        pdfStore.setLoading(false);
      }
    },
    [pdfStore, tabStore, recentFilesStore, setActiveTool]
  );

  const closeCurrentDocument = useCallback(() => {
    if (!currentDocument) return;
    
    const documentId = currentDocument.getId();
    const tab = tabStore.getTabByDocumentId(documentId);
    if (tab) {
      tabStore.removeTab(tab.id);
    }
    
    // Clean up print settings for this document
    import("@/shared/stores/printStore").then(({ usePrintStore }) => {
      usePrintStore.getState().removeDocumentSettings(documentId);
    });
    
    pdfStore.removeDocument(documentId);
  }, [currentDocument, pdfStore, tabStore]);

  return {
    currentDocument,
    activeTab,
    loadPDF,
    closeCurrentDocument,
    setCurrentPage: pdfStore.setCurrentPage,
    currentPage: pdfStore.currentPage,
    loading,
    error: pdfStore.error,
    annotations: currentDocument
      ? pdfStore.getAnnotations(currentDocument.getId())
      : [],
    addAnnotation: (annotation: any) => {
      if (currentDocument) {
        pdfStore.addAnnotation(currentDocument.getId(), annotation);
      }
    },
    removeAnnotation: (annotationId: string) => {
      if (currentDocument) {
        pdfStore.removeAnnotation(currentDocument.getId(), annotationId);
      }
    },
    updateAnnotation: (
      annotationId: string,
      updates: Partial<any>
    ) => {
      if (currentDocument) {
        pdfStore.updateAnnotation(
          currentDocument.getId(),
          annotationId,
          updates
        );
      }
    },
  };
}

