/**
 * PDF Viewer Component
 * 
 * Main component for viewing PDF documents with mupdf-js integration.
 */

import { useEffect, useState, useRef } from "react";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useUIStore } from "@/shared/stores/uiStore";
import { PageCanvas } from "./PageCanvas";
import { PDFRenderer } from "@/core/pdf/PDFRenderer";
import { ChevronLeft, ChevronRight, Plus, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PDFEditor } from "@/core/pdf/PDFEditor";

export function PDFViewer() {
  const { currentPage, setCurrentPage, getCurrentDocument } = usePDFStore();
  const { readMode, toggleReadMode } = useUIStore();
  const currentDocument = getCurrentDocument();
  const [mupdf, setMupdf] = useState<any>(null);
  const [renderer, setRenderer] = useState<PDFRenderer | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [showInsertDialog, setShowInsertDialog] = useState(false);
  const [editor, setEditor] = useState<PDFEditor | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Initialize mupdf
  useEffect(() => {
    const initMupdf = async () => {
      try {
        const mupdfModule = await import("mupdf");
        setMupdf(mupdfModule.default);
        setRenderer(new PDFRenderer(mupdfModule.default));
        setEditor(new PDFEditor(mupdfModule.default));
        setIsInitialized(true);
      } catch (error) {
        console.error("Failed to initialize mupdf:", error);
      }
    };

    initMupdf();
  }, []);

  // Track scroll position in read mode to update current page
  useEffect(() => {
    if (!readMode || !currentDocument || !scrollContainerRef.current) return;

    const container = scrollContainerRef.current;

    // Use IntersectionObserver to detect which page is most visible
    const observer = new IntersectionObserver(
      (entries) => {
        // Find the page with the highest intersection ratio
        let maxRatio = 0;
        let visiblePage = currentPage;

        entries.forEach((entry) => {
          const pageNum = parseInt(entry.target.getAttribute("data-page-number") || "0");
          if (entry.intersectionRatio > maxRatio) {
            maxRatio = entry.intersectionRatio;
            visiblePage = pageNum;
          }
        });

        // Update current page if a different page is most visible
        if (visiblePage !== currentPage && maxRatio > 0.1) {
          setCurrentPage(visiblePage);
        }
      },
      {
        root: container,
        rootMargin: "-20% 0px -20% 0px", // Consider page visible when 20% is in view
        threshold: [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0],
      }
    );

    // Observe all page containers
    pageRefs.current.forEach((pageEl) => {
      if (pageEl) {
        observer.observe(pageEl);
      }
    });

    return () => {
      observer.disconnect();
    };
  }, [readMode, currentDocument, currentPage, setCurrentPage]);

  // Scroll to current page when entering read mode or when page changes
  useEffect(() => {
    if (!readMode || !scrollContainerRef.current) return;

    // Small delay to ensure pages are rendered
    const timeoutId = setTimeout(() => {
      const pageEl = pageRefs.current.get(currentPage);
      if (pageEl) {
        pageEl.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, 100);

    return () => clearTimeout(timeoutId);
  }, [readMode, currentPage]);

  const handlePreviousPage = () => {
    if (currentDocument && currentPage > 0) {
      setCurrentPage(currentPage - 1);
    }
  };

  const handleNextPage = () => {
    if (currentDocument && currentPage < currentDocument.getPageCount() - 1) {
      setCurrentPage(currentPage + 1);
    }
  };

  const handleInsertBlankPage = async () => {
    if (!currentDocument || !editor) return;

    try {
      await editor.insertBlankPage(currentDocument, currentPage + 1);
      setShowInsertDialog(false);
      setCurrentPage(currentPage + 1);
    } catch (error) {
      console.error("Error inserting page:", error);
    }
  };


  if (!isInitialized || !mupdf || !renderer) {
    return (
      <div className="flex items-center justify-center h-full w-full">
        <div className="text-muted-foreground">Initializing PDF viewer...</div>
      </div>
    );
  }

  if (!currentDocument) {
    // Return empty div - the drag-and-drop area is handled in App.tsx
    return <div className="flex items-center justify-center h-full w-full" />;
  }

  const pageCount = currentDocument.getPageCount();
  const canGoPrevious = currentPage > 0;
  const canGoNext = currentPage < pageCount - 1;

  return (
    <div className="flex flex-col h-full w-full">
      {/* Page Canvas - Full Height */}
      {readMode ? (
        // Read mode: All pages in scrollable container
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto bg-muted"
          style={{ scrollBehavior: "smooth" }}
        >
          <div className="flex flex-col items-center" style={{ margin: 0, padding: 0, gap: 0, fontSize: 0 }}>
            {Array.from({ length: pageCount }, (_, i) => (
              <div
                key={i}
                ref={(el) => {
                  if (el) {
                    pageRefs.current.set(i, el);
                  } else {
                    pageRefs.current.delete(i);
                  }
                }}
                data-page-number={i}
                className="w-full flex justify-center"
                style={{ margin: 0, padding: 0, lineHeight: 0, fontSize: 0 }}
              >
                <div className="w-full max-w-4xl" style={{ margin: 0, padding: 0, lineHeight: 0, fontSize: 0 }}>
                  <PageCanvas
                    document={currentDocument}
                    pageNumber={i}
                    renderer={renderer}
                    readMode={true}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        // Normal mode: Single page
        <div className="flex-1 overflow-hidden">
          <PageCanvas
            document={currentDocument}
            pageNumber={currentPage}
            renderer={renderer}
          />
        </div>
      )}

      {/* Bottom Navigation Bar */}
      <div className="flex items-center justify-between p-2 border-t bg-background">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={handlePreviousPage}
            disabled={!canGoPrevious || readMode}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground min-w-[100px] text-center">
            Page {currentPage + 1} of {pageCount}
          </span>
          <Button
            variant="outline"
            size="icon"
            onClick={handleNextPage}
            disabled={!canGoNext || readMode}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant={readMode ? "default" : "outline"}
            size="icon"
            onClick={toggleReadMode}
            title={readMode ? "Exit read mode" : "Enter read mode"}
          >
            <BookOpen className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowInsertDialog(true)}
          >
            <Plus className="h-4 w-4 mr-2" />
            Insert Page
          </Button>
        </div>
      </div>

      {/* Insert Page Dialog */}
      <Dialog open={showInsertDialog} onOpenChange={setShowInsertDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Insert Page</DialogTitle>
            <DialogDescription>
              Insert a blank page after page {currentPage + 1}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowInsertDialog(false)}
            >
              Cancel
            </Button>
            <Button onClick={handleInsertBlankPage}>
              <Plus className="h-4 w-4 mr-2" />
              Insert Blank Page
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

