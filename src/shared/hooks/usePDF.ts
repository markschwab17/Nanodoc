/**
 * usePDF Hook
 * 
 * Provides convenient access to PDF operations and current document state.
 */

import { useCallback } from "react";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useTabStore } from "@/shared/stores/tabStore";
import { useCiviltakeoffContextStore } from "@/shared/stores/civiltakeoffContextStore";
import { useRecentFilesStore } from "@/shared/stores/recentFilesStore";
import { useUIStore } from "@/shared/stores/uiStore";
import { useSpecExtractionStore } from "@/shared/stores/specExtractionStore";
import { useConversationStore } from "@/shared/stores/conversationStore";
import { useFileSystem } from "@/shared/hooks/useFileSystem";
import { PDFDocument, PasswordRequiredError } from "@/core/pdf/PDFDocument";
import { PDFEditor } from "@/core/pdf/PDFEditor";
import { usePasswordPromptStore } from "@/shared/stores/passwordPromptStore";
import { readAIMetadata, readAIMetadataFromEmbeddedFile, type PDFAIMetadataPayload } from "@/core/pdf/PDFAIMetadata";
import {
  isBrowserAiStorageAvailable,
  hashPdfBytes,
  getPdfAiMetadata,
} from "@/shared/browserPdfAiStorage";

const SIDECAR_SUFFIX = ".ai.json";

export function usePDF() {
  // Use selectors to avoid re-rendering host components when unrelated state (e.g. annotations) changes.
  const currentPage = usePDFStore((s) => s.currentPage);
  const loading = usePDFStore((s) => s.loading);
  const error = usePDFStore((s) => s.error);
  const getCurrentDocument = usePDFStore((s) => s.getCurrentDocument);
  const currentDocument = getCurrentDocument();
  const tabStore = useTabStore();
  const recentFilesStore = useRecentFilesStore();
  const fileSystem = useFileSystem();
  const { setActiveTool } = useUIStore();

  const activeTab = tabStore.getActiveTab();

  const loadPDF = useCallback(
    async (data: Uint8Array, name: string, mupdf: any, filePath?: string | null) => {
      const pdfStore = usePDFStore.getState();
      try {
        // Set loading state and ensure it's visible
        pdfStore.setLoading(true);
        pdfStore.clearError();
        
        // Force a microtask delay to ensure React has time to render the loading state
        await new Promise(resolve => setTimeout(resolve, 100));

        const documentId = `pdf_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const document = new PDFDocument(documentId, name, data.length);

        // Password-protected PDFs: prompt and retry until correct or cancelled.
        let password: string | undefined;
        for (;;) {
          try {
            await document.loadFromData(data, mupdf, password);
            break;
          } catch (e) {
            if (e instanceof PasswordRequiredError) {
              const entered = await usePasswordPromptStore.getState().ask(name, e.wrongPassword);
              if (entered == null) {
                throw new Error("This PDF is password-protected. Password required to open it.");
              }
              password = entered;
              continue;
            }
            throw e;
          }
        }
        
        const normalizedFilePath = filePath
          ? filePath.trim().replace(/^file:\/\//i, "").replace(/\\/g, "/").replace(/\/+$/, "")
          : null;
        if (normalizedFilePath) {
          document.setOriginalFilePath(normalizedFilePath);
        }
        pdfStore.addDocument(document, normalizedFilePath || null);
        pdfStore.setCurrentDocument(documentId);

        // Give each page a label (integrated /PageLabels or bookmark titles).
        // Best-effort — never blocks opening the document.
        try {
          await new PDFEditor(mupdf).autoPopulatePageLabels(document);
        } catch (e) {
          console.warn("Auto page-label population failed:", e);
        }

        // Restore AI metadata: sidecar (desktop) → IndexedDB (browser) → embedded file → PDF Info/Keywords
        let aiPayload: PDFAIMetadataPayload | null = null;
        if (normalizedFilePath) {
          try {
            const sidecarData = await fileSystem.readFile(normalizedFilePath + SIDECAR_SUFFIX);
            const parsed = JSON.parse(new TextDecoder().decode(sidecarData)) as PDFAIMetadataPayload;
            const hasSpecs = Array.isArray(parsed?.extractedSpecs) && parsed.extractedSpecs.length > 0;
            const hasGeo = Array.isArray(parsed?.geotechnicalSummary) && parsed.geotechnicalSummary.length > 0 && parsed.geotechnicalScope;
            const hasConv = Array.isArray(parsed?.conversationHistory?.messages) && parsed.conversationHistory.messages.length > 0;
            const hasBookmarks = Array.isArray(parsed?.bookmarks) && parsed.bookmarks.length > 0;
            if (parsed?.version != null && (hasSpecs || hasGeo || hasConv || hasBookmarks)) {
              aiPayload = parsed;
            }
          } catch {
            // no sidecar
          }
        }
        if (!aiPayload && isBrowserAiStorageAvailable()) {
          try {
            const hash = await hashPdfBytes(data);
            if (hash) {
              const stored = await getPdfAiMetadata(hash);
              const hasSpecs = Array.isArray(stored?.extractedSpecs) && stored.extractedSpecs.length > 0;
              const hasGeo = Array.isArray(stored?.geotechnicalSummary) && stored.geotechnicalSummary.length > 0 && stored.geotechnicalScope;
              const hasConv = Array.isArray(stored?.conversationHistory?.messages) && stored.conversationHistory.messages.length > 0;
              const hasBookmarks = Array.isArray(stored?.bookmarks) && stored.bookmarks.length > 0;
              if (stored?.version != null && (hasSpecs || hasGeo || hasConv || hasBookmarks)) {
                aiPayload = stored;
              }
            }
          } catch {
            // non-fatal
          }
        }
        if (!aiPayload) {
          try {
            aiPayload = await readAIMetadataFromEmbeddedFile(data);
          } catch {
            // non-fatal
          }
        }
        if (!aiPayload) {
          try {
            aiPayload = readAIMetadata(document.getMupdfDocument());
          } catch {
            // non-fatal (e.g. encrypted PDF)
          }
        }
        if (aiPayload?.extractedSpecs?.length) {
          useSpecExtractionStore.getState().setExtractedSpecs(documentId, aiPayload.extractedSpecs);
        }
        if (aiPayload?.geotechnicalSummary?.length) {
          useSpecExtractionStore.getState().setGeotechnicalSummary(documentId, aiPayload.geotechnicalSummary);
          if (aiPayload.geotechnicalScope) {
            useSpecExtractionStore.getState().setGeotechnicalScope(documentId, aiPayload.geotechnicalScope);
          }
        }
        if (aiPayload?.conversationHistory?.messages?.length) {
          useConversationStore.getState().setMessages(documentId, aiPayload.conversationHistory.messages);
        }
        if (aiPayload?.bookmarks?.length) {
          for (const b of aiPayload.bookmarks) {
            pdfStore.addBookmark(documentId, {
              id: b.id,
              pageNumber: b.pageNumber,
              title: b.title,
              text: b.text,
              position: b.position,
              created: new Date(b.created),
            });
          }
        }

        // Add to recent files if we have a file path (use normalized path for consistency with sidecar)
        if (normalizedFilePath) {
          recentFilesStore.addRecentFile({
            path: normalizedFilePath,
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

        // If we have CTO context (e.g. opened from CTO or postMessage), attach it to this tab so Save uses the correct file
        const ctoContext = useCiviltakeoffContextStore.getState().getContext();
        if (ctoContext) {
          tabStore.updateTab(tabId, { ctoContext });
        }

        // Set select tool as default when PDF is loaded (in CTO split screen keep
        // current tool so "Select text" stays active). A marketing deep link
        // (/editor?tool=redact) instead wins the first load and is then cleared.
        const pendingDeepLinkTool = useUIStore.getState().pendingDeepLinkTool;
        if (pendingDeepLinkTool) {
          setActiveTool(pendingDeepLinkTool);
          useUIStore.getState().setPendingDeepLinkTool(null);
        } else if (!useUIStore.getState().splitScreenMode) {
          setActiveTool("select");
        }
        
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
    [tabStore, recentFilesStore, fileSystem, setActiveTool]
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

    usePDFStore.getState().removeDocument(documentId);
  }, [currentDocument, tabStore]);

  return {
    currentDocument,
    activeTab,
    loadPDF,
    closeCurrentDocument,
    setCurrentPage: usePDFStore.getState().setCurrentPage,
    currentPage,
    loading,
    error,
    annotations: currentDocument
      ? usePDFStore.getState().getAnnotations(currentDocument.getId())
      : [],
    addAnnotation: (annotation: any) => {
      if (currentDocument) {
        usePDFStore.getState().addAnnotation(currentDocument.getId(), annotation);
      }
    },
    removeAnnotation: (annotationId: string) => {
      if (currentDocument) {
        usePDFStore.getState().removeAnnotation(currentDocument.getId(), annotationId);
      }
    },
    updateAnnotation: (
      annotationId: string,
      updates: Partial<any>
    ) => {
      if (currentDocument) {
        usePDFStore.getState().updateAnnotation(
          currentDocument.getId(),
          annotationId,
          updates
        );
      }
    },
  };
}

