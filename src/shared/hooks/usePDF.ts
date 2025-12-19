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

        // CRITICAL: Clear renderer cache to prevent artifacts from previous PDF
        // This ensures the new PDF renders cleanly without artifacts from the previous document
        try {
          // PDFRenderer import reserved for future use - currently not needed
          // const { PDFRenderer } = await import("@/core/pdf/PDFRenderer");
          // Get renderer instance if available (it's created in PageCanvas)
          // We'll clear cache in PageCanvas when document changes, but also try here
        } catch (e) {
          // Renderer might not be available yet, that's okay
        }
        
        // Load existing annotations from PDF
        const editor = new PDFEditor(mupdf);
        const pageCount = document.getPageCount();
        const allAnnotations: any[] = [];
        
        for (let i = 0; i < pageCount; i++) {
          const pageAnnotations = await editor.loadAnnotationsFromPage(document, i);
          allAnnotations.push(...pageAnnotations);
        }
        
        // Add loaded annotations to store, but check for duplicates first
        const existingAnnotations = pdfStore.getAnnotations(documentId);
        const annotationsToAdd: typeof allAnnotations = []; // Track annotations we're adding in this batch
        
        for (const annot of allAnnotations) {
          
          // Check if this annotation already exists in the store
          // For arrows, match by pdfAnnotation reference or by position/type
          let isDuplicate = false;
          
          // First, check against annotations we're adding in this batch (prevent duplicates within the same load)
          for (const batchAnnot of annotationsToAdd) {
            // Check if they have the same pdfAnnotation reference
            if (annot.pdfAnnotation && batchAnnot.pdfAnnotation === annot.pdfAnnotation) {
              isDuplicate = true;
              break;
            }
            
            // For arrows, match by position and type within the batch
            if (annot.type === "shape" && annot.shapeType === "arrow" && 
                batchAnnot.type === "shape" && batchAnnot.shapeType === "arrow" &&
                annot.pageNumber === batchAnnot.pageNumber) {
              if (annot.points && batchAnnot.points && annot.points.length === 2 && batchAnnot.points.length === 2) {
                const tolerance = 1; // Very small tolerance for duplicates in same PDF
                const p1Match = Math.abs(annot.points[0].x - batchAnnot.points[0].x) < tolerance &&
                                Math.abs(annot.points[0].y - batchAnnot.points[0].y) < tolerance;
                const p2Match = Math.abs(annot.points[1].x - batchAnnot.points[1].x) < tolerance &&
                                Math.abs(annot.points[1].y - batchAnnot.points[1].y) < tolerance;
                const p1ReverseMatch = Math.abs(annot.points[0].x - batchAnnot.points[1].x) < tolerance &&
                                       Math.abs(annot.points[0].y - batchAnnot.points[1].y) < tolerance;
                const p2ReverseMatch = Math.abs(annot.points[1].x - batchAnnot.points[0].x) < tolerance &&
                                       Math.abs(annot.points[1].y - batchAnnot.points[0].y) < tolerance;
                
                if ((p1Match && p2Match) || (p1ReverseMatch && p2ReverseMatch)) {
                  isDuplicate = true;
                  break;
                }
              }
            }
          }
          
          // Check if any existing annotation matches this one
          for (const existing of existingAnnotations) {
            // First, check if they have the same pdfAnnotation reference
            if (annot.pdfAnnotation && existing.pdfAnnotation === annot.pdfAnnotation) {
              isDuplicate = true;
              break;
            }
            
            // For arrows, match by position and type (even if pdfAnnotation references differ)
            if (annot.type === "shape" && annot.shapeType === "arrow" && 
                existing.type === "shape" && existing.shapeType === "arrow" &&
                annot.pageNumber === existing.pageNumber) {
              if (annot.points && existing.points && annot.points.length === 2 && existing.points.length === 2) {
                const tolerance = 10; // 10 points tolerance for matching (increased from 5)
                const p1Match = Math.abs(annot.points[0].x - existing.points[0].x) < tolerance &&
                                Math.abs(annot.points[0].y - existing.points[0].y) < tolerance;
                const p2Match = Math.abs(annot.points[1].x - existing.points[1].x) < tolerance &&
                                Math.abs(annot.points[1].y - existing.points[1].y) < tolerance;
                // Also check reverse order (start/end might be swapped)
                const p1ReverseMatch = Math.abs(annot.points[0].x - existing.points[1].x) < tolerance &&
                                       Math.abs(annot.points[0].y - existing.points[1].y) < tolerance;
                const p2ReverseMatch = Math.abs(annot.points[1].x - existing.points[0].x) < tolerance &&
                                       Math.abs(annot.points[1].y - existing.points[0].y) < tolerance;
                
                
                if ((p1Match && p2Match) || (p1ReverseMatch && p2ReverseMatch)) {
                  isDuplicate = true;
                  // Update existing annotation with pdfAnnotation reference and correct points
                  pdfStore.updateAnnotation(documentId, existing.id, {
                    pdfAnnotation: annot.pdfAnnotation || existing.pdfAnnotation,
                    // Use the points from PDF (they're the source of truth)
                    points: annot.points,
                    // Also update other properties from PDF
                    x: annot.x,
                    y: annot.y,
                    width: annot.width,
                    height: annot.height,
                    strokeColor: annot.strokeColor || existing.strokeColor,
                    strokeWidth: annot.strokeWidth || existing.strokeWidth,
                    arrowHeadSize: annot.arrowHeadSize || existing.arrowHeadSize,
                  });
                  break;
                } else {
                }
              }
            }
          }
          
          if (!isDuplicate) {
            pdfStore.addAnnotation(documentId, annot);
            annotationsToAdd.push(annot); // Track that we're adding this annotation
          } else {
          }
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

