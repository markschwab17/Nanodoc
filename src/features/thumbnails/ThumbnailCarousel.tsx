/**
 * Thumbnail Carousel Component
 * 
 * Horizontal scrollable carousel of PDF page thumbnails with search tab.
 */

import { usePDFStore } from "@/shared/stores/pdfStore";
import { useUIStore } from "@/shared/stores/uiStore";
import { useTabStore } from "@/shared/stores/tabStore";
import { ThumbnailItem } from "./ThumbnailItem";
import { PDFRenderer } from "@/core/pdf/PDFRenderer";
import { PDFEditor } from "@/core/pdf/PDFEditor";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useEffect, useState, useRef } from "react";
import { Search, X, ChevronUp, ChevronDown, FileText, RotateCw, FlipVertical, FlipHorizontal } from "lucide-react";
import { useClipboard } from "@/shared/hooks/useClipboard";
import { wrapPageOperation } from "@/shared/stores/undoHelpers";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { useTextAnnotationClipboardStore } from "@/shared/stores/textAnnotationClipboardStore";

type TabType = "pages" | "search";

interface SearchResult {
  pageNumber: number;
  quads: number[][];
  text: string;
}

export function ThumbnailCarousel() {
  const { currentPage, setCurrentPage, getCurrentDocument, setSearchResults, getSearchResults, currentSearchResult, setCurrentSearchResult, getAnnotations, documents } = usePDFStore();
  const currentDocument = getCurrentDocument();
  const { showThumbnails } = useUIStore();
  const [renderer, setRenderer] = useState<PDFRenderer | null>(null);
  const [editor, setEditor] = useState<PDFEditor | null>(null);
  const [draggedPage, setDraggedPage] = useState<number | null>(null);
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [isDragOverPDF, setIsDragOverPDF] = useState(false);
  const [pdfDragOverIndex, setPdfDragOverIndex] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>("pages");
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [pagesToDelete, setPagesToDelete] = useState<number[]>([]);
  const [showRotateDialog, setShowRotateDialog] = useState(false);
  const [pagesToRotate, setPagesToRotate] = useState<number[]>([]);
  const [rotationType, setRotationType] = useState<"clockwise" | "counterclockwise" | "vertical" | "horizontal">("clockwise");
  const [applyToRange, setApplyToRange] = useState(false);
  const [rangeStart, setRangeStart] = useState<number>(0);
  const [rangeEnd, setRangeEnd] = useState<number>(0);
  const { copyPages, pastePages, hasPages, getSourceInfo } = useClipboard();
  const { showNotification } = useNotificationStore();
  const { hasTextAnnotation } = useTextAnnotationClipboardStore();
  
  const results = currentDocument ? getSearchResults(currentDocument.getId()) : [];
  const currentResultIndex = currentSearchResult;
  
  // Track if the last page change was from a click (to preserve selection)
  const lastClickPageRef = useRef<number | null>(null);
  
  // Clear selected pages when current page changes from scrolling (not clicking)
  // This prevents the ring border from staying on previously selected pages
  useEffect(() => {
    // If current page changed and it wasn't from a click, clear selection
    if (selectedPages.size > 0 && lastClickPageRef.current !== currentPage) {
      // Small delay to ensure click events have processed
      const timeoutId = setTimeout(() => {
        // Only clear if current page is still not the clicked page
        if (lastClickPageRef.current !== currentPage) {
          setSelectedPages(new Set());
          lastClickPageRef.current = null; // Reset after clearing
        }
      }, 100);
      return () => clearTimeout(timeoutId);
    }
  }, [currentPage, selectedPages]);

  useEffect(() => {
    const initRenderer = async () => {
      const mupdfModule = await import("mupdf");
      setRenderer(new PDFRenderer(mupdfModule.default));
      setEditor(new PDFEditor(mupdfModule.default));
    };
    initRenderer();
  }, []);

  const handleDeletePages = async (pageNumbers: number[]) => {
    if (!currentDocument || !editor || pageNumbers.length === 0) {
      return;
    }
    
    // Don't allow deleting all pages
    const pageCount = currentDocument.getPageCount();
    if (pageNumbers.length >= pageCount) {
      return;
    }

    try {
      const documentId = currentDocument.getId();
      
      // Wrap with undo/redo
      await wrapPageOperation(
        async () => {
          await editor.deletePages(currentDocument, pageNumbers);
          
          // Refresh document metadata after deletion
          if (typeof (currentDocument as any).refreshPageMetadata === 'function') {
            (currentDocument as any).refreshPageMetadata();
          }
          
          // Get updated page count
          const newPageCount = currentDocument.getPageCount();
          
          // Adjust current page if needed
          const sortedPages = [...pageNumbers].sort((a, b) => b - a);
          const maxDeleted = Math.max(...sortedPages);
          
          if (currentPage >= maxDeleted && newPageCount > 0) {
            // If current page was deleted or after deleted pages, adjust
            const deletedBeforeCurrent = sortedPages.filter(p => p < currentPage).length;
            setCurrentPage(Math.max(0, currentPage - deletedBeforeCurrent));
          } else if (newPageCount > 0 && currentPage >= newPageCount) {
            setCurrentPage(newPageCount - 1);
          }
          
          // Remove annotations for deleted pages
          const docAnnotations = getAnnotations(documentId);
          const annotationsToKeep = docAnnotations.filter(
            (ann) => !pageNumbers.includes(ann.pageNumber)
          );
          // Update annotations - remap page numbers for pages after deleted ones
          const updatedAnnotations = annotationsToKeep.map((ann) => {
            const deletedBefore = pageNumbers.filter((p) => p < ann.pageNumber).length;
            return {
              ...ann,
              pageNumber: ann.pageNumber - deletedBefore,
            };
          });
          
          // Clear and re-add annotations
          const pdfStore = usePDFStore.getState();
          const currentAnnotations = new Map(pdfStore.annotations);
          currentAnnotations.set(documentId, updatedAnnotations);
          usePDFStore.setState({ annotations: currentAnnotations });
        },
        "deletePages",
        documentId,
        pageNumbers
      );
      
      setSelectedPages(new Set());
    } catch (error) {
      console.error("Error deleting pages:", error);
    }
  };

  // Handle copy/paste and delete key for selected pages
  useEffect(() => {
    const handleCopyPages = () => {
      if (!currentDocument) return;
      
      // Get pages to copy - selected pages or current page
      const pagesToCopy = selectedPages.size > 0
        ? Array.from(selectedPages).sort((a, b) => a - b)
        : [currentPage];
      
      // Get annotations for those pages
      const documentId = currentDocument.getId();
      const allAnnotations = getAnnotations(documentId);
      const pageAnnotations = allAnnotations.filter((ann) =>
        pagesToCopy.includes(ann.pageNumber)
      );
      
      // Copy to clipboard
      copyPages(
        documentId,
        currentDocument.getName(),
        pagesToCopy,
        pageAnnotations
      );
      
      // Show feedback
      showNotification(
        `Copied ${pagesToCopy.length} page${pagesToCopy.length > 1 ? "s" : ""}`,
        "success"
      );
    };

    const handlePastePages = async () => {
      // Don't paste pages if we have a text box in clipboard (let PageCanvas handle it)
      if (hasTextAnnotation()) {
        return;
      }
      
      if (!currentDocument || !editor || !hasPages) return;
      
      const clipboardData = pastePages();
      if (!clipboardData) return;
      
      try {
        const documentId = currentDocument.getId();
        const targetIndex = currentPage + 1; // Insert after current page
        
        // Get source document
        let sourceDocument: typeof currentDocument = currentDocument;
        if (clipboardData.sourceDocumentId !== documentId) {
          // Cross-document paste
          const foundDoc = documents.get(clipboardData.sourceDocumentId);
          if (!foundDoc) {
            console.error("Source document not found");
            return;
          }
          sourceDocument = foundDoc;
        }
        
        if (!sourceDocument) {
          console.error("Source document is null");
          return;
        }
        
        // Extract page indices from clipboard
        const sourcePageIndices = clipboardData.pages.map((p) => p.pageIndex);
        
        // Wrap with undo/redo
        await wrapPageOperation(
          async () => {
            // Insert pages
            await editor.insertPagesFromDocument(
              currentDocument,
              sourceDocument,
              targetIndex,
              sourcePageIndices
            );
            
            // Refresh document metadata
            if (typeof (currentDocument as any).refreshPageMetadata === 'function') {
              (currentDocument as any).refreshPageMetadata();
            }
            
            // Copy annotations and remap page numbers
            const insertedPageCount = sourcePageIndices.length;
            
            // Get existing annotations
            const existingAnnotations = getAnnotations(documentId);
            
            // Remap existing annotations that are after insertion point
            const remappedAnnotations = existingAnnotations.map((ann) => {
              if (ann.pageNumber >= targetIndex) {
                return {
                  ...ann,
                  pageNumber: ann.pageNumber + insertedPageCount,
                };
              }
              return ann;
            });
            
            // Add copied annotations with remapped page numbers
            const copiedAnnotations = clipboardData.pages.flatMap((page, idx) => {
              return page.annotations.map((ann) => ({
                ...ann,
                id: `${ann.id}_copy_${Date.now()}_${idx}`,
                pageNumber: targetIndex + idx,
              }));
            });
            
          // Update annotations
          const pdfStore = usePDFStore.getState();
          const currentAnnotations = new Map(pdfStore.annotations);
          currentAnnotations.set(documentId, [...remappedAnnotations, ...copiedAnnotations]);
          usePDFStore.setState({ annotations: currentAnnotations });
            
            // Move to first inserted page
            setCurrentPage(targetIndex);
          },
          "pastePages",
          documentId,
          sourcePageIndices,
          targetIndex,
          clipboardData.sourceDocumentId
        );
        
        const sourceInfo = getSourceInfo();
        const sourceName = sourceInfo && sourceInfo.documentId !== documentId
          ? ` from "${sourceInfo.documentName}"`
          : "";
        showNotification(
          `Pasted ${sourcePageIndices.length} page${sourcePageIndices.length > 1 ? "s" : ""}${sourceName}`,
          "success"
        );
      } catch (error) {
        console.error("Error pasting pages:", error);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if typing in inputs
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) {
        return;
      }

      // Delete key (only if pages selected)
      if ((e.key === "Delete" || e.key === "Backspace") && selectedPages.size > 0) {
        e.preventDefault();
        const pages = Array.from(selectedPages).sort((a, b) => a - b);
        setPagesToDelete(pages);
        setShowDeleteDialog(true);
      }
    };

    // Listen for custom copy/paste events
    window.addEventListener("copyPages", handleCopyPages);
    window.addEventListener("pastePages", handlePastePages);
    window.addEventListener("keydown", handleKeyDown);
    
    return () => {
      window.removeEventListener("copyPages", handleCopyPages);
      window.removeEventListener("pastePages", handlePastePages);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [selectedPages, currentDocument, currentPage, editor, hasPages, copyPages, pastePages, getAnnotations, documents, setCurrentPage]);

  // Debounced search
  useEffect(() => {
    if (!searchQuery.trim() || !currentDocument) {
      if (currentDocument) {
        setSearchResults(currentDocument.getId(), []);
      }
      setCurrentSearchResult(-1);
      return;
    }

    let cancelled = false;

    const timeoutId = setTimeout(async () => {
      if (cancelled || !currentDocument) return;
      
      setIsSearching(true);
      try {
        const mupdfDoc = currentDocument.getMupdfDocument();
        const pageCount = currentDocument.getPageCount();
        const allResults: SearchResult[] = [];

        for (let i = 0; i < pageCount; i++) {
          if (cancelled) break;
          try {
            const page = mupdfDoc.loadPage(i);
            const matches = page.search(searchQuery, 100);

            if (matches && matches.length > 0) {
              allResults.push({
                pageNumber: i,
                quads: matches,
                text: searchQuery,
              });
            }
          } catch (error) {
            console.error(`Error searching page ${i}:`, error);
          }
        }

        if (!cancelled && currentDocument) {
          setSearchResults(currentDocument.getId(), allResults);
        }
      } catch (error) {
        console.error("Error performing search:", error);
        if (!cancelled && currentDocument) {
          setSearchResults(currentDocument.getId(), []);
        }
      } finally {
        if (!cancelled) {
          setIsSearching(false);
        }
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [searchQuery, currentDocument, setSearchResults, setCurrentSearchResult]);


  const handleSearchNext = () => {
    if (results.length === 0) return;
    const nextIndex = (currentResultIndex + 1) % results.length;
    setCurrentSearchResult(nextIndex);
    navigateToSearchResult(nextIndex);
  };

  const handleSearchPrevious = () => {
    if (results.length === 0) return;
    const prevIndex = currentResultIndex <= 0 ? results.length - 1 : currentResultIndex - 1;
    setCurrentSearchResult(prevIndex);
    navigateToSearchResult(prevIndex);
  };

  const navigateToSearchResult = (index: number) => {
    if (index < 0 || index >= results.length) return;
    const result = results[index];
    setCurrentPage(result.pageNumber);
  };

  const handleSearchClear = () => {
    setSearchQuery("");
    if (currentDocument) {
      setSearchResults(currentDocument.getId(), []);
    }
    setCurrentSearchResult(-1);
  };

  const handleThumbnailClick = (e: React.MouseEvent, pageNumber: number) => {
    if (e.shiftKey) {
      // Multi-select with shift
      setSelectedPages((prev) => {
        const newSet = new Set(prev);
        if (newSet.has(pageNumber)) {
          newSet.delete(pageNumber);
        } else {
          newSet.add(pageNumber);
        }
        return newSet;
      });
      lastClickPageRef.current = pageNumber;
    } else {
      // Single select
      setSelectedPages(new Set([pageNumber]));
      lastClickPageRef.current = pageNumber;
      setCurrentPage(pageNumber);
    }
  };

  const handleDragStart = (e: React.DragEvent, pageNumber: number) => {
    const pagesToDrag = selectedPages.size > 0 && selectedPages.has(pageNumber)
      ? Array.from(selectedPages).sort((a, b) => a - b)
      : [pageNumber];
    
    setDraggedPage(pageNumber);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", pagesToDrag.join(","));
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    
    if (draggedPage !== null) {
      const pagesToDrag = selectedPages.size > 0 && selectedPages.has(draggedPage)
        ? Array.from(selectedPages).sort((a, b) => a - b)
        : [draggedPage];
      
      // Calculate insertion point
      const targetIndex = index;
      const draggedIndices = pagesToDrag;
      
      // Don't show drop indicator if dragging over selected pages
      if (!draggedIndices.includes(index)) {
        setDragOverIndex(targetIndex);
      } else {
        setDragOverIndex(null);
      }
    }
  };

  const handleDragLeave = () => {
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    if (draggedPage !== null && dragOverIndex !== null && currentDocument && editor) {
      const pagesToDrag = selectedPages.size > 0 && selectedPages.has(draggedPage)
        ? Array.from(selectedPages).sort((a, b) => a - b)
        : [draggedPage];
      
      // Calculate target index accounting for pages being removed
      let targetIndex = dragOverIndex;
      const draggedIndices = pagesToDrag;
      const maxDragged = Math.max(...draggedIndices);
      const minDragged = Math.min(...draggedIndices);
      
      // Adjust target if dragging from before to after
      if (targetIndex > maxDragged) {
        targetIndex -= draggedIndices.length;
      } else if (targetIndex < minDragged) {
        // Target is before dragged pages, no adjustment needed
      }
      
      // Reorder pages
      const operations = pagesToDrag.map((fromIdx, i) => ({
        fromIndex: fromIdx,
        toIndex: targetIndex + i,
      }));
      
      editor.reorderPages(currentDocument, operations);
      setSelectedPages(new Set());
    }
    setDraggedPage(null);
    setDragOverIndex(null);
  };

  // Handle PDF file drag and drop to insert pages
  const handlePDFDragOver = (e: React.DragEvent, index: number) => {
    // Only handle if dragging a PDF file (not reordering pages)
    const hasPdf = Array.from(e.dataTransfer.items).some(
      (item) => item.type === "application/pdf" || (item.type === "" && item.kind === "file")
    );
    
      if (hasPdf && !draggedPage) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setIsDragOverPDF(true);
        // Show indicator at the position where pages will be inserted (after this thumbnail)
        setPdfDragOverIndex(index + 1);
      }
  };

  const handlePDFDragLeave = () => {
    setIsDragOverPDF(false);
    setPdfDragOverIndex(null);
  };

  const handlePDFDrop = async (e: React.DragEvent, thumbnailIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOverPDF(false);
    setPdfDragOverIndex(null);

    if (!currentDocument || !editor) {
      console.warn("Cannot insert pages: missing document or editor");
      return;
    }

    const files = Array.from(e.dataTransfer.files);
    const pdfFile = files.find(
      (file) => file.type === "application/pdf" || file.name.endsWith(".pdf")
    );

    if (!pdfFile) return;

    try {
      // Load the dropped PDF as a temporary document
      const arrayBuffer = await pdfFile.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);
      const mupdfModule = await import("mupdf");
      
      // Import PDFDocument class
      const { PDFDocument: PDFDocumentClass } = await import("@/core/pdf/PDFDocument");
      
      // Create temporary document
      const tempDocId = `temp_${Date.now()}`;
      const tempDocument = new PDFDocumentClass(tempDocId, pdfFile.name, data.length);
      await tempDocument.loadFromData(data, mupdfModule.default);

      // Insert all pages from the dropped PDF at the specified location
      // Insert after the thumbnail index (so dropping on thumbnail 0 inserts at position 1)
      const insertIndex = thumbnailIndex + 1;
      const sourcePageCount = tempDocument.getPageCount();
      const sourcePageIndices = Array.from({ length: sourcePageCount }, (_, i) => i);

      await editor.insertPagesFromDocument(
        currentDocument,
        tempDocument,
        insertIndex,
        sourcePageIndices
      );

      // Refresh document metadata
      if (typeof (currentDocument as any).refreshPageMetadata === 'function') {
        (currentDocument as any).refreshPageMetadata();
      }

      // Remap annotations that are after the insertion point
      const documentId = currentDocument.getId();
      const existingAnnotations = getAnnotations(documentId);
      const remappedAnnotations = existingAnnotations.map((ann) => {
        if (ann.pageNumber >= insertIndex) {
          return {
            ...ann,
            pageNumber: ann.pageNumber + sourcePageCount,
          };
        }
        return ann;
      });

      // Update annotations in store
      const pdfStore = usePDFStore.getState();
      const currentAnnotations = new Map(pdfStore.annotations);
      currentAnnotations.set(documentId, remappedAnnotations);
      usePDFStore.setState({ annotations: currentAnnotations });

      // Move to first inserted page
      setCurrentPage(insertIndex);
      
      showNotification(`Inserted ${sourcePageCount} page(s) at position ${insertIndex + 1}`, "success");
    } catch (error) {
      console.error("Error inserting PDF pages:", error);
      showNotification("Failed to insert PDF pages", "error");
    }
  };

  const handleThumbnailDelete = (e: React.MouseEvent, pageNumber: number) => {
    e.stopPropagation();
    e.preventDefault();
    
    // If multiple pages are selected, delete all selected
    // Otherwise, delete just this page
    const pages = selectedPages.size > 0 && selectedPages.has(pageNumber)
      ? Array.from(selectedPages).sort((a, b) => a - b)
      : [pageNumber];
    
    setPagesToDelete(pages);
    setShowDeleteDialog(true);
  };

  const handleThumbnailRotate = (e: React.MouseEvent, pageNumber: number) => {
    e.stopPropagation();
    e.preventDefault();
    
    // If multiple pages are selected, rotate all selected
    // Otherwise, rotate just this page
    const pages = selectedPages.size > 0 && selectedPages.has(pageNumber)
      ? Array.from(selectedPages).sort((a, b) => a - b)
      : [pageNumber];
    
    setPagesToRotate(pages);
    setRangeStart(pageNumber);
    setRangeEnd(pageNumber);
    setApplyToRange(false);
    setRotationType("clockwise");
    setShowRotateDialog(true);
  };

  const handleConfirmDelete = () => {
    handleDeletePages(pagesToDelete);
    setShowDeleteDialog(false);
    setPagesToDelete([]);
  };

  const handleRotatePages = async (pageNumbers: number[], rotationDegrees: number) => {
    if (!currentDocument || !editor || pageNumbers.length === 0) {
      return;
    }

    try {
      const documentId = currentDocument.getId();
      
      // Wrap with undo/redo
      await wrapPageOperation(
        async () => {
          // Rotate each page
          for (const pageNum of pageNumbers) {
            await editor.rotatePage(currentDocument, pageNum, rotationDegrees);
          }
          
          // Refresh document metadata after rotation
          // Rotation affects page dimensions (width/height swap at 90/270 degrees)
          currentDocument.refreshPageMetadata();
          
          // Small delay to ensure PDF is updated
          await new Promise(resolve => setTimeout(resolve, 50));
          
          // Refresh again to get updated bounds
          currentDocument.refreshPageMetadata();
        },
        "rotatePages",
        documentId,
        pageNumbers
      );
      
      // Clear render cache so pages re-render with new rotation
      if (renderer) {
        renderer.clearCache();
      }
      
      // Also need to clear cache in PDFViewer's renderer
      // We'll trigger a document metadata refresh which should cause re-render
      // The PageCanvas useEffect should pick up the metadata change via rotation dependency
      
      // Mark tab as modified
      const tab = useTabStore.getState().getTabByDocumentId(documentId);
      if (tab) {
        useTabStore.getState().setTabModified(tab.id, true);
      }
      
      showNotification(`Rotated ${pageNumbers.length} page${pageNumbers.length > 1 ? 's' : ''}`);
    } catch (error) {
      console.error("Error rotating pages:", error);
      showNotification("Failed to rotate pages", "error");
    }
  };

  const handleConfirmRotate = () => {
    let pagesToRotateFinal: number[] = [];
    
    if (applyToRange) {
      // Create range from start to end
      const start = Math.min(rangeStart, rangeEnd);
      const end = Math.max(rangeStart, rangeEnd);
      pagesToRotateFinal = Array.from({ length: end - start + 1 }, (_, i) => start + i);
    } else {
      // Use the pages that were clicked/selected
      pagesToRotateFinal = pagesToRotate;
    }
    
    // Map rotation type to relative degrees to add/subtract
    // PDF Rotate field: 0=0°, 90=90° counter-clockwise, 180=180°, 270=270° counter-clockwise
    // IMPORTANT: PDF Rotate is counter-clockwise, but visually:
    // - Rotate 90° = page appears rotated 90° counter-clockwise (top→left)
    // - Rotate 270° = page appears rotated 90° clockwise (top→right)
    // So for user-facing "clockwise" rotation, we need Rotate = 90° (add 90°)
    // For "counter-clockwise", we need Rotate = 270° (add 270°)
    // Wait, that's backwards. Let me think:
    // If current is 0° and we want clockwise 90°, we want the page to rotate so top→right
    // That's Rotate = 90° in PDF (90° counter-clockwise = 90° clockwise visually)
    // Actually no, Rotate 90° means rotate 90° counter-clockwise, which visually appears as counter-clockwise
    // Rotate 270° means rotate 270° counter-clockwise, which is 90° clockwise visually
    // So clockwise should be 270°, counter-clockwise should be 90°
    // But the user says clockwise is rotating counter-clockwise, so we need to swap them
    const rotationMap: Record<typeof rotationType, number> = {
      clockwise: 90,       // Add 90° (Rotate = 90° = 90° counter-clockwise = 90° clockwise visually)
      counterclockwise: 270, // Add 270° (Rotate = 270° = 270° counter-clockwise = 90° counter-clockwise visually)
      vertical: 180,       // Add 180° (flip)
      horizontal: 180,     // Add 180° (flip)
    };
    
    const degrees = rotationMap[rotationType];
    handleRotatePages(pagesToRotateFinal, degrees);
    setShowRotateDialog(false);
    setPagesToRotate([]);
  };

  if (!showThumbnails || !currentDocument || !renderer) {
    return null;
  }

  const pageCount = currentDocument.getPageCount();

  return (
    <div className="flex flex-col h-full w-full">
      {/* Tab Navigation */}
      <div className="flex border-b bg-background">
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "rounded-none border-b-2 border-transparent",
            activeTab === "pages" && "border-primary"
          )}
          onClick={() => setActiveTab("pages")}
        >
          <FileText className="h-4 w-4 mr-2" />
          Pages
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "rounded-none border-b-2 border-transparent",
            activeTab === "search" && "border-primary"
          )}
          onClick={() => setActiveTab("search")}
        >
          <Search className="h-4 w-4 mr-2" />
          Search
        </Button>
      </div>

      {/* Tab Content */}
      <ScrollArea className="flex-1">
        {activeTab === "pages" ? (
          <div className="flex flex-col gap-3 p-3">
            {/* Drop indicator bar at the very top if inserting at position 0 */}
            {pdfDragOverIndex === 0 && isDragOverPDF && (
              <div className="h-1 bg-primary rounded-full shadow-lg -mb-2 z-20" />
            )}
            {Array.from({ length: pageCount }, (_, i) => (
              <div key={i} className="relative">
                {/* Clean drop indicator bar for PDF insertion - shows between thumbnails */}
                {pdfDragOverIndex === i + 1 && isDragOverPDF && (
                  <div className="absolute -top-2 left-0 right-0 h-1 bg-primary z-20 rounded-full shadow-lg" />
                )}
                {/* Drop indicator line for page reordering */}
                {dragOverIndex === i && draggedPage !== null && (
                  <div className="absolute -top-1.5 left-0 right-0 h-1 bg-primary z-10 rounded" />
                )}
                
                <div
                  draggable
                  onDragStart={(e) => handleDragStart(e, i)}
                  onDragOver={(e) => {
                    // Try PDF drop first, then page reorder
                    handlePDFDragOver(e, i);
                    if (!isDragOverPDF) {
                      handleDragOver(e, i);
                    }
                  }}
                  onDragLeave={() => {
                    handlePDFDragLeave();
                    handleDragLeave();
                  }}
                  onDrop={(e) => {
                    if (isDragOverPDF) {
                      handlePDFDrop(e, i);
                    }
                    // Page reorder drop is handled elsewhere
                  }}
                  onDragEnd={handleDragEnd}
                  className={cn(
                    "transition-all relative",
                    draggedPage === i || (selectedPages.has(i) && draggedPage !== null) ? "opacity-50" : "",
                    selectedPages.has(i) ? "ring-2 ring-primary rounded" : ""
                  )}
                >
                  <ThumbnailItem
                    document={currentDocument}
                    pageNumber={i}
                    renderer={renderer}
                    isActive={i === currentPage || selectedPages.has(i)}
                    onClick={(e) => handleThumbnailClick(e, i)}
                    onDelete={(e) => handleThumbnailDelete(e, i)}
                    onRotate={(e) => handleThumbnailRotate(e, i)}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col p-3 gap-3">
            {/* Search Input */}
            <div className="relative">
              <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="text"
                placeholder="Search PDF..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 pr-8"
              />
              {searchQuery && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 transform -translate-y-1/2 h-6 w-6"
                  onClick={handleSearchClear}
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>

            {/* Search Results */}
            {isSearching && (
              <div className="text-sm text-muted-foreground text-center py-4">
                Searching...
              </div>
            )}

            {!isSearching && results.length > 0 && (
              <>
                <div className="flex items-center justify-between">
                  <div className="text-sm text-muted-foreground">
                    {currentResultIndex + 1} of {results.length} results
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={handleSearchPrevious}
                      disabled={results.length === 0}
                    >
                      <ChevronUp className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={handleSearchNext}
                      disabled={results.length === 0}
                    >
                      <ChevronDown className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  {results.map((result, idx) => (
                    <Button
                      key={idx}
                      variant={idx === currentResultIndex ? "default" : "outline"}
                      className="justify-start text-left h-auto py-2"
                      onClick={() => {
                        setCurrentSearchResult(idx);
                        navigateToSearchResult(idx);
                      }}
                    >
                      <div className="flex flex-col gap-1">
                        <div className="font-medium">Page {result.pageNumber + 1}</div>
                        <div className="text-xs text-muted-foreground">
                          {result.quads.length} match{result.quads.length !== 1 ? "es" : ""}
                        </div>
                      </div>
                    </Button>
                  ))}
                </div>
              </>
            )}

            {!isSearching && searchQuery && results.length === 0 && (
              <div className="text-sm text-muted-foreground text-center py-4">
                No results found
              </div>
            )}

            {!isSearching && !searchQuery && (
              <div className="text-sm text-muted-foreground text-center py-4">
                Enter a search query to find text in the PDF
              </div>
            )}
          </div>
        )}
      </ScrollArea>

      {/* Delete Confirmation Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Page{pagesToDelete.length > 1 ? "s" : ""}</DialogTitle>
            <DialogDescription>
              {pagesToDelete.length === 1 ? (
                <>Are you sure you want to delete page {pagesToDelete[0] + 1}? This action cannot be undone.</>
              ) : (
                <>Are you sure you want to delete pages {pagesToDelete.map(p => p + 1).join(", ")}? This action cannot be undone.</>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowDeleteDialog(false);
                setPagesToDelete([]);
              }}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rotate Dialog */}
      <Dialog open={showRotateDialog} onOpenChange={setShowRotateDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Rotate Page{pagesToRotate.length > 1 ? "s" : ""}</DialogTitle>
            <DialogDescription>
              {pagesToRotate.length === 1
                ? `Rotate page ${pagesToRotate[0] + 1}`
                : `Rotate ${pagesToRotate.length} selected pages`}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-6 py-4">
            {/* Rotation Type Selection - Visual Card Style */}
            <div className="space-y-3">
              <Label className="text-sm font-medium">Select Rotation</Label>
              <div className="grid grid-cols-2 gap-3">
                {/* Clockwise */}
                <div
                  onClick={() => setRotationType("clockwise")}
                  className={cn(
                    "relative p-4 border-2 rounded-lg cursor-pointer transition-all hover:border-primary/50",
                    rotationType === "clockwise"
                      ? "border-primary bg-primary/5"
                      : "border-border"
                  )}
                >
                  <div className="flex flex-col items-center space-y-2">
                    <div className={cn(
                      "p-2 rounded-full transition-colors",
                      rotationType === "clockwise" ? "bg-primary/10" : "bg-muted"
                    )}>
                      <RotateCw className={cn(
                        "h-6 w-6 transition-colors",
                        rotationType === "clockwise" ? "text-primary" : "text-muted-foreground"
                      )} />
                    </div>
                    <div className="text-center">
                      <div className="text-sm font-medium">Clockwise</div>
                      <div className="text-xs text-muted-foreground">90°</div>
                    </div>
                  </div>
                  {rotationType === "clockwise" && (
                    <div className="absolute top-2 right-2 h-2 w-2 rounded-full bg-primary" />
                  )}
                </div>

                {/* Counter-clockwise */}
                <div
                  onClick={() => setRotationType("counterclockwise")}
                  className={cn(
                    "relative p-4 border-2 rounded-lg cursor-pointer transition-all hover:border-primary/50",
                    rotationType === "counterclockwise"
                      ? "border-primary bg-primary/5"
                      : "border-border"
                  )}
                >
                  <div className="flex flex-col items-center space-y-2">
                    <div className={cn(
                      "p-2 rounded-full transition-colors",
                      rotationType === "counterclockwise" ? "bg-primary/10" : "bg-muted"
                    )}>
                      <RotateCw className={cn(
                        "h-6 w-6 rotate-180 transition-colors",
                        rotationType === "counterclockwise" ? "text-primary" : "text-muted-foreground"
                      )} />
                    </div>
                    <div className="text-center">
                      <div className="text-sm font-medium">Counter-clockwise</div>
                      <div className="text-xs text-muted-foreground">90°</div>
                    </div>
                  </div>
                  {rotationType === "counterclockwise" && (
                    <div className="absolute top-2 right-2 h-2 w-2 rounded-full bg-primary" />
                  )}
                </div>

                {/* Vertical Flip */}
                <div
                  onClick={() => setRotationType("vertical")}
                  className={cn(
                    "relative p-4 border-2 rounded-lg cursor-pointer transition-all hover:border-primary/50",
                    rotationType === "vertical"
                      ? "border-primary bg-primary/5"
                      : "border-border"
                  )}
                >
                  <div className="flex flex-col items-center space-y-2">
                    <div className={cn(
                      "p-2 rounded-full transition-colors",
                      rotationType === "vertical" ? "bg-primary/10" : "bg-muted"
                    )}>
                      <FlipVertical className={cn(
                        "h-6 w-6 transition-colors",
                        rotationType === "vertical" ? "text-primary" : "text-muted-foreground"
                      )} />
                    </div>
                    <div className="text-center">
                      <div className="text-sm font-medium">Vertical Flip</div>
                      <div className="text-xs text-muted-foreground">180°</div>
                    </div>
                  </div>
                  {rotationType === "vertical" && (
                    <div className="absolute top-2 right-2 h-2 w-2 rounded-full bg-primary" />
                  )}
                </div>

                {/* Horizontal Flip */}
                <div
                  onClick={() => setRotationType("horizontal")}
                  className={cn(
                    "relative p-4 border-2 rounded-lg cursor-pointer transition-all hover:border-primary/50",
                    rotationType === "horizontal"
                      ? "border-primary bg-primary/5"
                      : "border-border"
                  )}
                >
                  <div className="flex flex-col items-center space-y-2">
                    <div className={cn(
                      "p-2 rounded-full transition-colors",
                      rotationType === "horizontal" ? "bg-primary/10" : "bg-muted"
                    )}>
                      <FlipHorizontal className={cn(
                        "h-6 w-6 transition-colors",
                        rotationType === "horizontal" ? "text-primary" : "text-muted-foreground"
                      )} />
                    </div>
                    <div className="text-center">
                      <div className="text-sm font-medium">Horizontal Flip</div>
                      <div className="text-xs text-muted-foreground">180°</div>
                    </div>
                  </div>
                  {rotationType === "horizontal" && (
                    <div className="absolute top-2 right-2 h-2 w-2 rounded-full bg-primary" />
                  )}
                </div>
              </div>
            </div>

            {/* Apply To Selection */}
            <div className="space-y-3 border-t pt-4">
              <div className="flex items-center space-x-3">
                <input
                  type="checkbox"
                  id="applyToRange"
                  checked={applyToRange}
                  onChange={(e) => setApplyToRange(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                />
                <Label htmlFor="applyToRange" className="text-sm font-medium cursor-pointer">
                  Apply to range of pages
                </Label>
              </div>
              
              {applyToRange && currentDocument && (
                <div className="grid grid-cols-2 gap-3 ml-7">
                  <div className="space-y-1.5">
                    <Label htmlFor="rangeStart" className="text-xs font-medium text-muted-foreground">From Page</Label>
                    <Input
                      id="rangeStart"
                      type="number"
                      min="1"
                      max={currentDocument.getPageCount()}
                      value={rangeStart + 1}
                      onChange={(e) => {
                        const val = Math.max(1, Math.min(currentDocument.getPageCount(), parseInt(e.target.value) || 1));
                        setRangeStart(val - 1);
                      }}
                      className="h-9"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="rangeEnd" className="text-xs font-medium text-muted-foreground">To Page</Label>
                    <Input
                      id="rangeEnd"
                      type="number"
                      min="1"
                      max={currentDocument.getPageCount()}
                      value={rangeEnd + 1}
                      onChange={(e) => {
                        const val = Math.max(1, Math.min(currentDocument.getPageCount(), parseInt(e.target.value) || 1));
                        setRangeEnd(val - 1);
                      }}
                      className="h-9"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setShowRotateDialog(false);
                setPagesToRotate([]);
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleConfirmRotate} className="min-w-[100px]">
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

