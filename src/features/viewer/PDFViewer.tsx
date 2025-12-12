/**
 * PDF Viewer Component
 * 
 * Main component for viewing PDF documents with mupdf-js integration.
 */

import { useEffect, useState, useRef, useCallback } from "react";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useUIStore } from "@/shared/stores/uiStore";
import { PageCanvas } from "./PageCanvas";
import { PDFRenderer } from "@/core/pdf/PDFRenderer";
import { ChevronLeft, ChevronRight, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageTools } from "@/features/toolbar/PageTools";
import { SearchBar } from "@/features/search/SearchBar";

export function PDFViewer() {
  const { currentPage, setCurrentPage, getCurrentDocument } = usePDFStore();
  const { readMode, toggleReadMode, zoomLevel, fitMode } = useUIStore();
  const currentDocument = getCurrentDocument();
  const [mupdf, setMupdf] = useState<any>(null);
  const [renderer, setRenderer] = useState<PDFRenderer | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pagesContainerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [readModePanOffset, setReadModePanOffset] = useState({ x: 0, y: 0 });
  const [isReadModeDragging, setIsReadModeDragging] = useState(false);
  const [readModeDragStart, setReadModeDragStart] = useState({ x: 0, y: 0 });
  const [baseFitScale, setBaseFitScale] = useState<number>(1.0);

  // Initialize mupdf
  useEffect(() => {
    const initMupdf = async () => {
      try {
        const mupdfModule = await import("mupdf");
        setMupdf(mupdfModule.default);
        setRenderer(new PDFRenderer(mupdfModule.default));
        setIsInitialized(true);
      } catch (error) {
        console.error("Failed to initialize mupdf:", error);
      }
    };

    initMupdf();
  }, []);

  // Scroll to current page in read mode
  const scrollToPage = useCallback((pageNumber: number, center: boolean = true) => {
    if (!readMode || !scrollContainerRef.current) return;
    
    const pageEl = pageRefs.current.get(pageNumber);
    const container = scrollContainerRef.current;
    
    if (pageEl && container) {
      if (center) {
        const containerHeight = container.clientHeight;
        const pageHeight = pageEl.offsetHeight;
        const pageTopRelativeToContainer = pageEl.offsetTop;
        const targetScroll = pageTopRelativeToContainer - (containerHeight / 2) + (pageHeight / 2);
        container.scrollTo({
          top: Math.max(0, targetScroll),
          behavior: "smooth"
        });
      } else {
        pageEl.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  }, [readMode]);

  // Track scroll position in read mode to update current page
  useEffect(() => {
    if (!readMode || !currentDocument || !scrollContainerRef.current) return;

    const container = scrollContainerRef.current;
    let isScrolling = false;

    const observer = new IntersectionObserver(
      (entries) => {
        if (isScrolling) return;

        let maxRatio = 0;
        let visiblePage = currentPage;
        const containerRect = container.getBoundingClientRect();
        const viewportCenterY = containerRect.top + containerRect.height / 2;

        entries.forEach((entry) => {
          const pageNum = parseInt(entry.target.getAttribute("data-page-number") || "0");
          const pageRect = entry.boundingClientRect;
          const pageCenterY = pageRect.top + pageRect.height / 2;
          
          const distanceFromCenter = Math.abs(pageCenterY - viewportCenterY);
          const maxDistance = containerRect.height / 2;
          const centerScore = Math.max(0, 1 - Math.min(1, distanceFromCenter / maxDistance));
          
          const zoomWeight = fitMode === "custom" ? 0.7 : 0.5;
          const combinedScore = entry.intersectionRatio * zoomWeight + centerScore * (1 - zoomWeight);
          
          if (combinedScore > maxRatio) {
            maxRatio = combinedScore;
            visiblePage = pageNum;
          }
        });

        const threshold = fitMode === "custom" ? 0.2 : 0.3;
        if (visiblePage !== currentPage && maxRatio > threshold) {
          setCurrentPage(visiblePage);
        }
      },
      {
        root: container,
        rootMargin: fitMode === "custom" ? "-10% 0px -10% 0px" : "-5% 0px -5% 0px",
        threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
      }
    );

    let scrollTimeout: NodeJS.Timeout | null = null;
    const handleScroll = () => {
      isScrolling = true;
      if (scrollTimeout) clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        isScrolling = false;
      }, 150);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });

    const timeoutId = setTimeout(() => {
      pageRefs.current.forEach((pageEl) => {
        if (pageEl) observer.observe(pageEl);
      });
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      if (scrollTimeout) clearTimeout(scrollTimeout);
      container.removeEventListener('scroll', handleScroll);
      observer.disconnect();
    };
  }, [readMode, currentDocument, currentPage, setCurrentPage, fitMode]);

  // Handle wheel zoom in read mode at container level
  useEffect(() => {
    if (!readMode || !scrollContainerRef.current) return;

    const container = scrollContainerRef.current;

    const handleWheelNative = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;

      e.preventDefault();
      e.stopPropagation();

      // Use smaller delta for smoother, less aggressive zooming
      const delta = e.deltaY > 0 ? 0.97 : 1.03;
      const newZoom = Math.max(0.25, Math.min(5, zoomLevel * delta));

      if (Math.abs(newZoom - zoomLevel) > 0.001) {
        const containerRect = container.getBoundingClientRect();
        const viewportWidth = containerRect.width;
        const viewportHeight = containerRect.height;
        
        // Center-based zoom: keep the center of the viewport centered on the content
        // Calculate the center point in the current coordinate system
        const scrollTop = container.scrollTop;
        const scrollLeft = container.scrollLeft;
        const viewportCenterX = viewportWidth / 2 + scrollLeft;
        const viewportCenterY = viewportHeight / 2 + scrollTop;
        
        // Convert viewport center to pages container space (accounting for current pan)
        const centerInPagesSpace = {
          x: viewportCenterX - readModePanOffset.x,
          y: viewportCenterY - readModePanOffset.y
        };
        
        // Convert to PDF coordinate space (accounting for current transform scale)
        const currentScale = zoomLevel / baseFitScale;
        const pdfCenterPoint = {
          x: centerInPagesSpace.x / currentScale,
          y: centerInPagesSpace.y / currentScale
        };
        
        // Calculate where this PDF center point will be at the new zoom level
        const newScale = newZoom / baseFitScale;
        const pdfCenterAtNewZoom = {
          x: pdfCenterPoint.x * newScale,
          y: pdfCenterPoint.y * newScale
        };
        
        // Calculate new pan offset to keep the PDF center point at viewport center
        let newPanX = viewportCenterX - pdfCenterAtNewZoom.x;
        let newPanY = viewportCenterY - pdfCenterAtNewZoom.y;
        
        // Constrain pan to PDF content bounds
        if (currentDocument) {
          const pageCount = currentDocument.getPageCount();
          const firstPageMetadata = currentDocument.getPageMetadata(0);
          if (firstPageMetadata) {
            // Content dimensions at the new zoom level (accounting for transform scale)
            const contentWidth = firstPageMetadata.width * baseFitScale * newScale;
            const contentHeight = (pageCount * (firstPageMetadata.height * baseFitScale) + (pageCount - 1) * 150) * newScale;
            
            // Constrain pan: can't pan beyond content bounds
            const maxPanX = Math.max(0, contentWidth - viewportWidth);
            const maxPanY = Math.max(0, contentHeight - viewportHeight);
            
            newPanX = Math.max(-maxPanX, Math.min(0, newPanX));
            newPanY = Math.max(-maxPanY, Math.min(0, newPanY));
          }
        }

        const { setZoomLevel, setFitMode } = useUIStore.getState();
        setFitMode("custom"); // User is manually zooming, set to custom
        setZoomLevel(newZoom);
        setReadModePanOffset({ x: newPanX, y: newPanY });
      }
    };

    container.addEventListener("wheel", handleWheelNative, { passive: false });

    return () => {
      container.removeEventListener("wheel", handleWheelNative);
    };
  }, [readMode, zoomLevel, readModePanOffset]);

  // Scroll to current page when entering read mode or when page changes
  useEffect(() => {
    if (!readMode || !scrollContainerRef.current) return;
    const timeoutId = setTimeout(() => {
      scrollToPage(currentPage, true);
    }, 200);
    return () => clearTimeout(timeoutId);
  }, [readMode, scrollToPage, currentPage]);

  // Listen for page changes from thumbnail clicks
  useEffect(() => {
    if (readMode && scrollContainerRef.current) {
      requestAnimationFrame(() => {
        scrollToPage(currentPage, true);
      });
    }
  }, [currentPage, readMode, scrollToPage]);

  // Calculate base fit-to-width scale when entering read mode or document changes
  useEffect(() => {
    if (readMode && currentDocument && scrollContainerRef.current) {
      // Calculate the fit-to-width scale based on container width
      const container = scrollContainerRef.current;
      const containerWidth = container.clientWidth || 800;
      const firstPageMetadata = currentDocument.getPageMetadata(0);
      if (firstPageMetadata) {
        const scale = containerWidth / firstPageMetadata.width;
        setBaseFitScale(scale);
      }
    }
  }, [readMode, currentDocument]);

  // Set fit mode to width when entering read mode
  useEffect(() => {
    if (readMode && fitMode !== "width" && fitMode !== "custom") {
      const { setFitMode } = useUIStore.getState();
      setFitMode("width");
    }
  }, [readMode, fitMode]);

  // Reset pan when exiting read mode
  useEffect(() => {
    if (!readMode || fitMode !== "custom") {
      setReadModePanOffset({ x: 0, y: 0 });
    }
  }, [readMode, fitMode]);

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


  if (!isInitialized || !mupdf || !renderer) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-muted-foreground">Initializing PDF viewer...</div>
      </div>
    );
  }

  if (!currentDocument) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center text-muted-foreground">
          <p className="text-lg mb-2">No PDF loaded</p>
          <p className="text-sm">Open a PDF file to get started</p>
        </div>
      </div>
    );
  }

  const pageCount = currentDocument.getPageCount();
  const canGoPrevious = currentPage > 0;
  const canGoNext = currentPage < pageCount - 1;

  return (
    <div className="flex flex-col h-full w-full">
      {/* Search Bar */}
      <SearchBar />

      {/* Top Navigation Bar */}
      <div className="flex items-center justify-between p-2 border-b bg-background">
        <div className="flex items-center gap-2">
          <PageTools />
        </div>
      </div>

      {/* Page Canvas - Full Height */}
      {readMode ? (
        // Read mode: All pages in scrollable container
        <div
          ref={scrollContainerRef}
          className="flex-1 bg-muted"
          style={{ 
            scrollBehavior: "smooth",
            // When zoomed, allow both horizontal and vertical scrolling
            // When not zoomed, only vertical scrolling
            overflowX: fitMode === "custom" ? "auto" : "hidden",
            overflowY: "auto",
            // Ensure content can overflow when zoomed
            position: "relative",
          }}
        >
          <div 
            ref={pagesContainerRef}
            className="flex flex-col items-center" 
            style={{ 
              margin: 0, 
              padding: 0, 
              gap: 0, 
              fontSize: 0,
              paddingTop: "50vh",
              paddingBottom: "50vh",
              // Apply zoom via transform scale - this makes it feel like zooming into a static image
              // Pages stay at fit-to-width size, but are scaled via transform
              // The scale factor is zoomLevel / baseFitScale to scale from fit-to-width
              transform: fitMode === "custom"
                ? `translate(${readModePanOffset.x}px, ${readModePanOffset.y}px) scale(${zoomLevel / baseFitScale})`
                : undefined,
              transformOrigin: "0 0",
              cursor: isReadModeDragging ? "grabbing" : (fitMode === "custom" ? "grab" : undefined),
            }}
            onMouseDown={(e) => {
              if (fitMode === "custom" && e.button === 0 && scrollContainerRef.current) {
                setIsReadModeDragging(true);
                const container = scrollContainerRef.current;
                const containerRect = container.getBoundingClientRect();
                const mouseX = e.clientX - containerRect.left;
                const mouseY = e.clientY - containerRect.top;
                const scrollLeft = container.scrollLeft;
                const scrollTop = container.scrollTop;
                
                // Calculate drag start position in pages coordinate system
                setReadModeDragStart({ 
                  x: mouseX + scrollLeft - readModePanOffset.x, 
                  y: mouseY + scrollTop - readModePanOffset.y 
                });
              }
            }}
            onMouseMove={(e) => {
              if (isReadModeDragging && fitMode === "custom" && pagesContainerRef.current && scrollContainerRef.current) {
                const container = scrollContainerRef.current;
                const scrollLeft = container.scrollLeft;
                const scrollTop = container.scrollTop;
                
                // Calculate mouse position relative to scroll container
                const containerRect = container.getBoundingClientRect();
                const mouseX = e.clientX - containerRect.left;
                const mouseY = e.clientY - containerRect.top;
                
                // Calculate new pan offset based on drag start position
                let newPanX = (mouseX + scrollLeft) - readModeDragStart.x;
                let newPanY = (mouseY + scrollTop) - readModeDragStart.y;
                
                // Constrain pan to PDF content bounds
                if (currentDocument) {
                  const pageCount = currentDocument.getPageCount();
                  const firstPageMetadata = currentDocument.getPageMetadata(0);
                  if (firstPageMetadata) {
                    // Content dimensions at current zoom level (accounting for transform scale)
                    const currentScale = zoomLevel / baseFitScale;
                    const contentWidth = firstPageMetadata.width * baseFitScale * currentScale;
                    const contentHeight = (pageCount * (firstPageMetadata.height * baseFitScale) + (pageCount - 1) * 150) * currentScale;
                    
                    const viewportWidth = containerRect.width;
                    const viewportHeight = containerRect.height;
                    
                    // Constrain pan: can't pan beyond content bounds
                    const maxPanX = Math.max(0, contentWidth - viewportWidth);
                    const maxPanY = Math.max(0, contentHeight - viewportHeight);
                    
                    newPanX = Math.max(-maxPanX, Math.min(0, newPanX));
                    newPanY = Math.max(-maxPanY, Math.min(0, newPanY));
                  }
                }
                
                setReadModePanOffset({
                  x: newPanX,
                  y: newPanY,
                });
              }
            }}
            onMouseUp={() => {
              if (readMode) {
                setIsReadModeDragging(false);
              }
            }}
            onMouseLeave={() => {
              if (readMode) {
                setIsReadModeDragging(false);
              }
            }}
          >
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
                style={{ margin: 0, padding: 0, marginBottom: i < pageCount - 1 ? "150px" : 0, lineHeight: 0, fontSize: 0 }}
              >
                <div className="w-full" style={{ margin: 0, padding: 0, lineHeight: 0, fontSize: 0, display: 'flex', justifyContent: 'center' }}>
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
      
      {/* Bottom Navigation Bar with Read Mode Toggle */}
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
            title={readMode ? "Exit read mode (R)" : "Enter read mode (R)"}
          >
            <BookOpen className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

