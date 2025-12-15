/**
 * PDF Viewer Component
 * 
 * Main component for viewing PDF documents with mupdf-js integration.
 */

import { useEffect, useState, useRef, useCallback } from "react";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useUIStore } from "@/shared/stores/uiStore";
import { useDocumentSettingsStore } from "@/shared/stores/documentSettingsStore";
import { PageCanvas } from "./PageCanvas";
import { PDFRenderer } from "@/core/pdf/PDFRenderer";
import { VirtualizedPageList } from "./VirtualizedPageList";
import { ChevronLeft, ChevronRight, BookOpen, Ruler, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageTools } from "@/features/toolbar/PageTools";
import { DocumentSettingsDialog } from "@/features/settings/DocumentSettingsDialog";
import { PDFEditor } from "@/core/pdf/PDFEditor";
import { useTabStore } from "@/shared/stores/tabStore";

export function PDFViewer() {
  const { currentPage, setCurrentPage, getCurrentDocument } = usePDFStore();
  const { readMode, toggleReadMode, zoomLevel, fitMode, setZoomLevel, setFitMode } = useUIStore();
  const { showRulers, toggleRulers } = useDocumentSettingsStore();
  const currentDocument = getCurrentDocument();
  const [mupdf, setMupdf] = useState<any>(null);
  const [renderer, setRenderer] = useState<PDFRenderer | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [showDocumentSettings, setShowDocumentSettings] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pagesContainerRef = useRef<HTMLDivElement>(null);
  const [baseFitScale, setBaseFitScale] = useState<number>(1.0);
  const isScrollingFromUserRef = useRef(false); // Track if page change is from user scroll vs external action
  const previousPageRef = useRef(currentPage); // Track previous page to detect actual changes
  const pendingScrollTopRef = useRef<number | null>(null); // Store pending scroll position to apply after zoom
  const isZoomingRef = useRef(false); // Flag to prevent scroll interference during zoom
  const zoomAnchorPointRef = useRef<{ x: number; y: number } | null>(null); // Store anchor point for transform origin
  const previousReadModeRef = useRef(readMode); // Track previous read mode state
  
  // Use refs for smooth zoom to avoid stale closures
  const zoomLevelRef = useRef(zoomLevel);
  const baseFitScaleRef = useRef(baseFitScale);
  
  // Keep refs in sync with state
  useEffect(() => {
    zoomLevelRef.current = zoomLevel;
  }, [zoomLevel]);
  
  useEffect(() => {
    baseFitScaleRef.current = baseFitScale;
  }, [baseFitScale]);

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

  // Zoom function for read mode - zooms to anchor point (mouse cursor or viewport center)
  const zoomToPoint = useCallback((
    newZoom: number,
    anchorX?: number,  // Mouse X in screen coordinates, or undefined for center
    anchorY?: number   // Mouse Y in screen coordinates, or undefined for center
  ) => {
    if (!readMode || !scrollContainerRef.current || !pagesContainerRef.current || !currentDocument) return;

    const scrollContainer = scrollContainerRef.current;
    const pagesContainer = pagesContainerRef.current;
    const currentZoom = zoomLevelRef.current;
    const currentBaseFitScale = baseFitScaleRef.current;
    
    // Get container dimensions and position
    const scrollRect = scrollContainer.getBoundingClientRect();
    const pagesRect = pagesContainer.getBoundingClientRect();
    const viewportWidth = scrollContainer.clientWidth;
    const viewportHeight = scrollContainer.clientHeight;
    
    // Determine anchor point in viewport coordinates (relative to scroll container)
    const anchorPointX = anchorX !== undefined 
      ? anchorX - scrollRect.left
      : viewportWidth / 2;
    const anchorPointY = anchorY !== undefined
      ? anchorY - scrollRect.top
      : viewportHeight / 2;
    
    // Get current scroll position
    const scrollTop = scrollContainer.scrollTop;
    
    // Current and new scale factors
    const currentScale = currentZoom / currentBaseFitScale;
    const newScale = newZoom / currentBaseFitScale;
    
    // Calculate the document position that is currently at the anchor point
    // The key insight: scrollTop is the scroll position in base-scale coordinates
    // The anchor point in the viewport (anchorPointY) is the offset from the top of the viewport
    // The document position at the anchor = scrollTop + anchorPointY (in base-scale coordinates)
    // const documentY = scrollTop + anchorPointY; // Reserved for future use
    
    // Calculate new scroll position to maintain the document position at the anchor point
    // Formula: newScrollTop = ((scrollTop + anchorPointY) * currentScale / newScale) - anchorPointY
    // This maintains the visual position of the anchor point during zoom
    const newScrollTop = ((scrollTop + anchorPointY) * currentScale / newScale) - anchorPointY;
    
    // Store the target scroll position and anchor point for transform origin
    // The transform origin needs to be relative to the pages container, not the scroll container
    // The pages container is centered horizontally with flex justify-center
    // We need to calculate the base width (at baseFitScale) to find the left edge
    // Base width = firstPageMetadata.width * baseFitScale
    // Pages container left edge = (viewportWidth - baseWidth) / 2
    // But pagesRect.width is the transformed width, which changes with zoom
    // So we need to use the base width divided by currentScale to get the untransformed width
    const firstPageMetadata = currentDocument.getPageMetadata(0);
    const baseWidth = firstPageMetadata ? firstPageMetadata.width * currentBaseFitScale : pagesRect.width / currentScale;
    const pagesContainerLeftInScroll = (viewportWidth - baseWidth) / 2;
    // Transform origin is relative to the pages container's coordinate system
    // Y coordinate must include scrollTop since the container's top is at scrollTop=0 in its own coordinates
    const anchorPointRelativeToPages = {
      x: anchorPointX - pagesContainerLeftInScroll,
      y: scrollTop + anchorPointY
    };
    
    pendingScrollTopRef.current = newScrollTop;
    isZoomingRef.current = true;
    zoomAnchorPointRef.current = anchorPointRelativeToPages;
    
    // Update zoom state (this may trigger re-renders)
    zoomLevelRef.current = newZoom;
    setFitMode("custom");
    setZoomLevel(newZoom);
    
    // Apply scroll position after transform has been applied
    setTimeout(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (scrollContainer && pendingScrollTopRef.current !== null) {
            const currentMaxScrollTop = Math.max(0, scrollContainer.scrollHeight - viewportHeight);
            const targetScroll = Math.max(0, Math.min(currentMaxScrollTop, pendingScrollTopRef.current));
            
            scrollContainer.scrollTop = targetScroll;
            
            // Verify and retry if needed
            if (Math.abs(scrollContainer.scrollTop - targetScroll) > 1) {
              scrollContainer.scrollTop = targetScroll;
              if (Math.abs(scrollContainer.scrollTop - targetScroll) > 1) {
                scrollContainer.scrollTo({ top: targetScroll, behavior: 'auto' });
              }
            }
            
            setTimeout(() => {
              pendingScrollTopRef.current = null;
              isZoomingRef.current = false;
              zoomAnchorPointRef.current = null;
            }, 10);
          }
        });
      });
    }, 50);
  }, [readMode, currentDocument, setZoomLevel, setFitMode]);

  // Scroll to current page in read mode
  const scrollToPage = useCallback((pageNumber: number, center: boolean = true) => {
    if (!readMode || !scrollContainerRef.current || !currentDocument) return;
    
    const container = scrollContainerRef.current;
    const firstPageMetadata = currentDocument.getPageMetadata(0);
    if (!firstPageMetadata) return;
    
    const scale = zoomLevel / baseFitScale;
    const pageHeight = (firstPageMetadata.height * baseFitScale) * scale;
    const pageGap = 24;
    
    // Calculate page position
    let pageTop = 0;
    for (let i = 0; i < pageNumber; i++) {
      const pageMetadata = currentDocument.getPageMetadata(i);
      if (pageMetadata) {
        pageTop += (pageMetadata.height * baseFitScale) * scale + pageGap;
      }
    }
    
      if (center) {
        const containerHeight = container.clientHeight;
      const targetScroll = pageTop - (containerHeight / 2) + (pageHeight / 2);
        container.scrollTo({
          top: Math.max(0, targetScroll),
          behavior: "smooth"
        });
      } else {
      container.scrollTo({
        top: Math.max(0, pageTop),
        behavior: "smooth"
      });
    }
  }, [readMode, currentDocument, zoomLevel, baseFitScale]);

  // Handle page visibility changes from VirtualizedPageList
  // This updates the current page as the user scrolls
  const handlePageVisible = useCallback((pageNumber: number) => {
    if (pageNumber !== currentPage) {
      isScrollingFromUserRef.current = true; // Mark as user scroll
      setCurrentPage(pageNumber);
      // Reset flag after a short delay
      setTimeout(() => {
        isScrollingFromUserRef.current = false;
      }, 100);
    }
  }, [currentPage, setCurrentPage]);

  // Handle wheel zoom in read mode at container level
  useEffect(() => {
    if (!readMode || !scrollContainerRef.current) return;

    const container = scrollContainerRef.current;

    const handleWheelNative = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;

      e.preventDefault();
      e.stopPropagation();

      const currentZoom = zoomLevelRef.current;
      const delta = e.deltaY > 0 ? 0.97 : 1.03;
      const newZoom = Math.max(0.25, Math.min(5, currentZoom * delta));

      if (Math.abs(newZoom - currentZoom) > 0.001) {
        // Pass mouse cursor position to zoom to that point
        // e.clientX and e.clientY are relative to the viewport (screen coordinates)
        // These will be converted to scroll container coordinates in zoomToPoint
        zoomToPoint(newZoom, e.clientX, e.clientY);
      }
    };

    container.addEventListener("wheel", handleWheelNative, { passive: false });

    return () => {
      container.removeEventListener("wheel", handleWheelNative);
    };
  }, [readMode, zoomToPoint]);

  // Expose read mode zoom function via UI store callback
  // For button clicks, zoom to viewport center
  useEffect(() => {
    if (readMode) {
      const { setZoomToCenterCallback } = useUIStore.getState();
      // Create a wrapper that zooms to viewport center when called from buttons
      const zoomToCenterWrapper = (newZoom: number) => {
        if (!scrollContainerRef.current) return;
        const container = scrollContainerRef.current;
        const containerRect = container.getBoundingClientRect();
        const viewportCenterX = containerRect.left + containerRect.width / 2;
        const viewportCenterY = containerRect.top + containerRect.height / 2;
        zoomToPoint(newZoom, viewportCenterX, viewportCenterY);
      };
      setZoomToCenterCallback(zoomToCenterWrapper);
      return () => {
        setZoomToCenterCallback(null);
      };
    }
  }, [readMode, zoomToPoint]);

  // Track the page we should scroll to when entering read mode
  const targetPageOnReadModeEntryRef = useRef<number | null>(null);
  
  // Scroll to current page when entering read mode
  useEffect(() => {
    // Check if we just entered read mode (transitioned from false to true)
    const justEnteredReadMode = !previousReadModeRef.current && readMode;
    previousReadModeRef.current = readMode;
    
    if (justEnteredReadMode) {
      // Store the current page to scroll to
      targetPageOnReadModeEntryRef.current = currentPage;
    }
    
    // Only proceed if we're in read mode and have a target page
    if (!readMode || !scrollContainerRef.current || !currentDocument || targetPageOnReadModeEntryRef.current === null) {
      if (!readMode) {
        targetPageOnReadModeEntryRef.current = null; // Clear target when exiting read mode
      }
      return;
    }
    
    // Wait for baseFitScale to be calculated and view to be ready
    const targetPage = targetPageOnReadModeEntryRef.current;
    const scrollToCurrentPage = () => {
      if (scrollContainerRef.current && pagesContainerRef.current && baseFitScale > 0) {
        scrollToPage(targetPage, true);
        targetPageOnReadModeEntryRef.current = null; // Clear after scrolling
      }
    };
    
    let checkInterval: NodeJS.Timeout | null = null;
    let timeoutId: NodeJS.Timeout | null = null;
    let rafId1: number | null = null;
    let rafId2: number | null = null;
    let scrollTimeoutId: NodeJS.Timeout | null = null;
    
    // Wait for baseFitScale calculation and VirtualizedPageList to render
    // Use multiple requestAnimationFrame calls and a timeout to ensure everything is ready
    if (baseFitScale > 0) {
      // baseFitScale is already ready
      rafId1 = requestAnimationFrame(() => {
        rafId2 = requestAnimationFrame(() => {
          scrollTimeoutId = setTimeout(scrollToCurrentPage, 150);
        });
      });
    } else {
      // Wait for baseFitScale to be calculated first
      checkInterval = setInterval(() => {
        if (baseFitScale > 0 && scrollContainerRef.current && pagesContainerRef.current) {
          if (checkInterval) clearInterval(checkInterval);
          rafId1 = requestAnimationFrame(() => {
            rafId2 = requestAnimationFrame(() => {
              scrollTimeoutId = setTimeout(scrollToCurrentPage, 150);
            });
          });
        }
      }, 50);
      
      // Timeout after 2 seconds to prevent infinite waiting
      timeoutId = setTimeout(() => {
        if (checkInterval) clearInterval(checkInterval);
      }, 2000);
    }
    
    // Cleanup function
    return () => {
      if (checkInterval) clearInterval(checkInterval);
      if (timeoutId) clearTimeout(timeoutId);
      if (rafId1 !== null) cancelAnimationFrame(rafId1);
      if (rafId2 !== null) cancelAnimationFrame(rafId2);
      if (scrollTimeoutId) clearTimeout(scrollTimeoutId);
    };
  }, [readMode, currentPage, currentDocument, baseFitScale, scrollToPage]);

  // Listen for page changes from thumbnail clicks (external actions)
  // Only scroll if the change didn't come from user scrolling
  useEffect(() => {
    if (!readMode || !scrollContainerRef.current) return;
    
    // Skip if page didn't actually change
    if (previousPageRef.current === currentPage) {
      return;
    }
    
    // Don't scroll if this page change came from user scrolling
    if (isScrollingFromUserRef.current) {
      previousPageRef.current = currentPage;
      return;
    }
    
    // This is an external action (thumbnail click, etc.) - scroll to the page
      requestAnimationFrame(() => {
        scrollToPage(currentPage, true);
      });
    
    previousPageRef.current = currentPage;
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

  const handleApplyDocumentSettings = async (width: number, height: number, applyToAll: boolean) => {
    const currentDoc = getCurrentDocument();
    if (!currentDoc) return;

    try {
      const mupdfModule = await import("mupdf");
      const editor = new PDFEditor(mupdfModule.default);
      
      if (applyToAll) {
        // Resize all pages
        await editor.resizeAllPages(currentDoc, width, height);
      } else {
        // Resize current page only
        await editor.resizePage(currentDoc, currentPage, width, height);
      }
      
      // Mark tab as modified
      const tab = useTabStore.getState().getTabByDocumentId(currentDoc.getId());
      if (tab) {
        useTabStore.getState().setTabModified(tab.id, true);
      }
    } catch (error) {
      console.error("Error applying document settings:", error);
      throw error;
    }
  };


  if (!isInitialized || !mupdf || !renderer) {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="text-muted-foreground">Initializing PDF viewer...</div>
      </div>
    );
  }

  if (!currentDocument) {
    return null; // Don't show anything - let App's drag and drop area handle it
  }

  const pageCount = currentDocument.getPageCount();
  const canGoPrevious = currentPage > 0;
  const canGoNext = currentPage < pageCount - 1;

  return (
    <div className="flex flex-col h-full w-full">
      {/* Page Canvas - Full Height */}
      {/* Cache both views for fast switching - both stay mounted but only one is visible */}
      <div className="flex-1 relative">
        {/* Read mode: Virtualized page list with native scrolling */}
        <div
          ref={scrollContainerRef}
          className={`absolute inset-0 bg-muted overflow-auto ${
            readMode ? "" : "hidden"
          }`}
          style={{ 
            scrollBehavior: "smooth",
          }}
        >
          <div 
            ref={pagesContainerRef}
            className="flex justify-center"
            style={{ 
              transform: fitMode === "custom" ? `scale(${zoomLevel / baseFitScale})` : undefined,
              transformOrigin: zoomAnchorPointRef.current && isZoomingRef.current
                ? `${zoomAnchorPointRef.current.x}px ${zoomAnchorPointRef.current.y}px`
                : "top left",
              willChange: "transform",
            }}
          >
            {currentDocument && renderer && (
              <VirtualizedPageList
                  document={currentDocument}
                  renderer={renderer}
                zoomLevel={zoomLevel}
                baseFitScale={baseFitScale}
                pageGap={24}
                bufferPages={2}
                onPageVisible={handlePageVisible}
                scrollContainerRef={scrollContainerRef}
              />
            )}
          </div>
        </div>
        
        {/* Normal mode: Single page */}
        <div className={`absolute inset-0 overflow-hidden ${
          readMode ? "hidden" : ""
        }`}>
          <PageCanvas
            document={currentDocument}
            pageNumber={currentPage}
            renderer={renderer}
          />
        </div>
      </div>
      
      {/* Bottom Navigation Bar with Read Mode Toggle */}
      <div className="flex items-center justify-between p-2 border-t bg-background">
        <div className="flex items-center gap-2">
          {!readMode && <PageTools />}
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
        </div>
        
        <div className="flex items-center gap-2">
          <Button
            variant={showRulers ? "default" : "outline"}
            size="icon"
            onClick={toggleRulers}
            title="Toggle Rulers"
            disabled={!currentDocument || readMode}
          >
            <Ruler className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setShowDocumentSettings(true)}
            title="Document Settings"
            disabled={!currentDocument}
          >
            <Settings className="h-4 w-4" />
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

      {/* Document Settings Dialog */}
      <DocumentSettingsDialog
        open={showDocumentSettings}
        onOpenChange={setShowDocumentSettings}
        document={currentDocument}
        currentPage={currentPage}
        onApply={handleApplyDocumentSettings}
      />
    </div>
  );
}

