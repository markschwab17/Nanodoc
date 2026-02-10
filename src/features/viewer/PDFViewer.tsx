/**
 * PDF Viewer Component
 * 
 * Main component for viewing PDF documents with mupdf-js integration.
 */

import { useEffect, useState, useRef, useCallback } from "react";
import { flushSync } from "react-dom";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useUIStore } from "@/shared/stores/uiStore";
import { useDocumentSettingsStore } from "@/shared/stores/documentSettingsStore";
import { PageCanvas } from "./PageCanvas";
import { PDFRenderer } from "@/core/pdf/PDFRenderer";
import { VirtualizedPageList } from "./VirtualizedPageList";
import { ChevronLeft, ChevronRight, BookOpen, Ruler, Settings, ZoomIn, ZoomOut, Maximize } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageTools } from "@/features/toolbar/PageTools";
import { DocumentSettingsDialog } from "@/features/settings/DocumentSettingsDialog";
import { PDFEditor } from "@/core/pdf/PDFEditor";
import { useTabStore } from "@/shared/stores/tabStore";
import { SpecExtractionPanel } from "@/features/specs/SpecExtractionPanel";
import { QuestionAnswerPanel } from "@/features/specs/QuestionAnswerPanel";
import { useSpecExtractionStore } from "@/shared/stores/specExtractionStore";

export function PDFViewer() {
  const { currentPage, setCurrentPage, getCurrentDocument } = usePDFStore();
  const { readMode, toggleReadMode, zoomLevel, fitMode, setZoomLevel, setFitMode, zoomToCenter } = useUIStore();
  const { showRulers, toggleRulers } = useDocumentSettingsStore();
  const { setSelectedSpec } = useSpecExtractionStore();
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
  const isZoomingRef = useRef(false); // Flag to prevent scroll interference during zoom
  const hasUserZoomedInReadModeRef = useRef(false); // Once user zooms in read mode, don't reset zoom to baseFitScale
  const previousReadModeRef = useRef(readMode); // Track previous read mode state
  const isProgrammaticScrollRef = useRef(false); // Track if we're programmatically scrolling to prevent IntersectionObserver from overwriting currentPage
  const [isEditingPage, setIsEditingPage] = useState(false);
  const [pageInputValue, setPageInputValue] = useState("");
  const pageInputRef = useRef<HTMLInputElement>(null);
  
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

  // Initialize mupdf - simplified to match working ThumbnailCarousel pattern
  useEffect(() => {
    const initMupdf = async () => {
      try {
        const mupdfModule = await import("mupdf");
        setMupdf(mupdfModule.default);
        setRenderer(new PDFRenderer(mupdfModule.default));
        setIsInitialized(true);
      } catch (error) {
        // Set initialized to true anyway to show error state instead of infinite loading
        setIsInitialized(true);
        usePDFStore.getState().setError(
          error instanceof Error ? error.message : "Failed to initialize PDF viewer"
        );
      }
    };

    initMupdf();
  }, []);

  // Zoom function for read mode - zooms to anchor point (mouse cursor or viewport center)
  const zoomToPoint = useCallback((
    newZoom: number,
    _anchorX?: number,  // Mouse X in screen coordinates, or undefined for center (not used in read mode)
    anchorY?: number   // Mouse Y in screen coordinates, or undefined for center
  ) => {
    if (!readMode || !scrollContainerRef.current || !currentDocument) return;

    const scrollContainer = scrollContainerRef.current;
    const currentZoom = zoomLevelRef.current;
    
    // Get container dimensions and position
    const scrollRect = scrollContainer.getBoundingClientRect();
    const viewportHeight = scrollContainer.clientHeight;
    
    // Determine anchor point in viewport coordinates (relative to scroll container)
    const anchorPointY = anchorY !== undefined
      ? anchorY - scrollRect.top
      : viewportHeight / 2;
    
    // Get current scroll position (in actual rendered coordinates)
    const scrollTop = scrollContainer.scrollTop;
    
    // Calculate zoom factors relative to baseFitScale
    const currentBaseFitScale = baseFitScaleRef.current;
    if (currentBaseFitScale <= 0) return;
    
    const currentZoomFactor = currentZoom / currentBaseFitScale;
    const newZoomFactor = newZoom / currentBaseFitScale;
    
    // Calculate the document position that is currently at the anchor point
    // scrollTop is the scroll position in rendered coordinates at currentZoom
    // anchorPointY is the viewport position where we want to maintain focus
    // Total document position at anchor in current coordinates: scrollTop + anchorPointY
    // Convert to base scale: (scrollTop + anchorPointY) / currentZoomFactor
    const documentYAtAnchorBase = (scrollTop + anchorPointY) / currentZoomFactor;
    
    // Calculate new scroll position to keep the same document point at the anchor
    // After zooming, convert back to new rendered coordinates
    // newScrollTop = (documentYAtAnchorBase * newZoomFactor) - anchorPointY
    const newScrollTop = (documentYAtAnchorBase * newZoomFactor) - anchorPointY;
    
    // Set zooming flag to prevent interference from other effects
    isZoomingRef.current = true;
    hasUserZoomedInReadModeRef.current = true; // So reset effect won't overwrite this zoom
    // Temporarily disable smooth scrolling to prevent browser auto-adjustment
    const originalScrollBehavior = scrollContainer.style.scrollBehavior;
    scrollContainer.style.scrollBehavior = 'auto';
    
    // Use flushSync to force synchronous state updates and layout recalculation
    // This allows us to set scroll position in the same frame, preventing browser auto-adjustment
    flushSync(() => {
      zoomLevelRef.current = newZoom;
      setFitMode("custom");
      setZoomLevel(newZoom);
    });
    
    // Immediately after flushSync, the layout should be recalculated
    // Set scroll position synchronously in the same frame to prevent browser auto-adjustment
    // Use a microtask to ensure DOM has updated but before browser can auto-adjust
    Promise.resolve().then(() => {
      if (!scrollContainer) {
        isZoomingRef.current = false;
        return;
      }
      
      // Force a synchronous layout read to ensure DOM is updated
      void scrollContainer.offsetHeight;
      
      const currentScrollHeight = scrollContainer.scrollHeight;
      const currentViewportHeight = scrollContainer.clientHeight;
      
      if (currentScrollHeight > 0) {
        const maxScroll = Math.max(0, currentScrollHeight - currentViewportHeight);
        const clampedTarget = Math.max(0, Math.min(maxScroll, newScrollTop));
        
        // Apply scroll position immediately and synchronously
        scrollContainer.scrollTop = clampedTarget;
        
        // Maintain horizontal center
        if (scrollContainer.scrollWidth > scrollContainer.clientWidth) {
          scrollContainer.scrollLeft = (scrollContainer.scrollWidth - scrollContainer.clientWidth) / 2;
        } else {
          scrollContainer.scrollLeft = 0;
        }
        
        // Verify and correct if needed in the next frame
        requestAnimationFrame(() => {
          if (!scrollContainer) {
            isZoomingRef.current = false;
            return;
          }
          
          const finalScrollHeight = scrollContainer.scrollHeight;
          const finalViewportHeight = scrollContainer.clientHeight;
          const finalMaxScroll = Math.max(0, finalScrollHeight - finalViewportHeight);
          const finalTarget = Math.max(0, Math.min(finalMaxScroll, newScrollTop));
          
          // Only correct if significantly off (browser may have adjusted slightly)
          if (Math.abs(scrollContainer.scrollTop - finalTarget) > 2) {
            scrollContainer.scrollTop = finalTarget;
            
            if (scrollContainer.scrollWidth > scrollContainer.clientWidth) {
              scrollContainer.scrollLeft = (scrollContainer.scrollWidth - scrollContainer.clientWidth) / 2;
            } else {
              scrollContainer.scrollLeft = 0;
            }
          }
          
          // Restore smooth scrolling
          scrollContainer.style.scrollBehavior = originalScrollBehavior || 'smooth';
          isZoomingRef.current = false;
        });
      } else {
        // Layout not ready yet, wait for it
        let attempts = 0;
        const checkLayout = () => {
          if (!scrollContainer || attempts >= 5) {
            isZoomingRef.current = false;
            return;
          }
          
          const scrollHeight = scrollContainer.scrollHeight;
          if (scrollHeight > 0) {
            const maxScroll = Math.max(0, scrollHeight - scrollContainer.clientHeight);
            const clampedTarget = Math.max(0, Math.min(maxScroll, newScrollTop));
            scrollContainer.scrollTop = clampedTarget;
            
            if (scrollContainer.scrollWidth > scrollContainer.clientWidth) {
              scrollContainer.scrollLeft = (scrollContainer.scrollWidth - scrollContainer.clientWidth) / 2;
            } else {
              scrollContainer.scrollLeft = 0;
            }
            
            scrollContainer.style.scrollBehavior = originalScrollBehavior || 'smooth';
            isZoomingRef.current = false;
          } else {
            attempts++;
            requestAnimationFrame(checkLayout);
          }
        };
        requestAnimationFrame(checkLayout);
      }
    });
  }, [readMode, currentDocument, setZoomLevel, setFitMode]);

  // Scroll to current page in read mode
  // Pages are positioned at zoomLevel scale, so scroll coordinates are at zoom level
  const scrollToPage = useCallback((pageNumber: number, center: boolean = true, bbox?: number[]) => {
    if (!readMode || !scrollContainerRef.current || !currentDocument) return;
    
    // Validate page number is within bounds
    const pageCount = currentDocument.getPageCount();
    if (pageNumber < 0 || pageNumber >= pageCount) {
      console.warn(`Invalid page number: ${pageNumber}, valid range: 0-${pageCount - 1}`);
      return;
    }
    
    const container = scrollContainerRef.current;
    const pageGap = 1;
    
    // Use zoomLevel and baseFitScale for positioning
    // Calculate zoom factor relative to baseFitScale
    if (baseFitScale <= 0 || zoomLevel <= 0) {
      console.warn("Cannot calculate scroll position: invalid baseFitScale or zoomLevel");
      return;
    }
    
    const zoomFactor = zoomLevel / baseFitScale;
    const firstPageMetadata = currentDocument.getPageMetadata(0);
    if (!firstPageMetadata) {
      console.warn("Cannot calculate scroll position: first page metadata not found");
      return;
    }
    
    // Calculate viewport width: base width scaled by zoom factor
    const viewportWidth = firstPageMetadata.width * baseFitScale * zoomFactor;
    
    let pageTop = 0;
    for (let i = 0; i < pageNumber; i++) {
      const pageMetadata = currentDocument.getPageMetadata(i);
      if (pageMetadata) {
        // Scale each page to fit viewport width while maintaining aspect ratio
        const pageScale = viewportWidth / pageMetadata.width;
        const pageHeight = pageMetadata.height * pageScale;
        // Gap is fixed in screen pixels (not scaled) for consistent visual appearance
        pageTop += pageHeight + pageGap;
      }
    }
    
    // Get the target page's metadata
    const pageMetadata = currentDocument.getPageMetadata(pageNumber);
    if (!pageMetadata) {
      console.warn(`Page metadata not found for page ${pageNumber}`);
      return;
    }
    
    // Calculate target page dimensions at zoom level
    const pageScale = viewportWidth / pageMetadata.width;
    const pageHeight = pageMetadata.height * pageScale;
    
    // If bbox is provided, scroll to that specific location on the page
    if (bbox && bbox.length >= 4) {
      const [, y0, , y1] = bbox;
      const pageHeightPdf = pageMetadata.height;
      
      // Convert PDF coordinates (Y=0 at bottom) to canvas coordinates (Y=0 at top)
      const bboxTopPdf = Math.min(y0, y1);
      const bboxBottomPdf = Math.max(y0, y1);
      const bboxHeightPdf = bboxBottomPdf - bboxTopPdf;
      const bboxTopCanvas = pageHeightPdf - bboxBottomPdf;
      const bboxCenterCanvas = bboxTopCanvas + (bboxHeightPdf / 2);
      
      // Convert to scroll coordinates at zoom level
      const bboxScrollY = pageTop + (bboxCenterCanvas * pageScale);
      const containerHeight = container.clientHeight;
      const targetScroll = bboxScrollY - (containerHeight / 2);
      
      // Set flag to prevent IntersectionObserver from overwriting currentPage during programmatic scroll
      isProgrammaticScrollRef.current = true;
      container.scrollTo({
        top: Math.max(0, targetScroll),
        behavior: "smooth"
      });
      // Re-enable IntersectionObserver updates after scroll completes
      let scrollEndTimeout: NodeJS.Timeout | null = null;
      const scrollEndHandler = () => {
        if (scrollEndTimeout) clearTimeout(scrollEndTimeout);
        scrollEndTimeout = setTimeout(() => {
          isProgrammaticScrollRef.current = false;
          container.removeEventListener('scroll', scrollEndHandler);
        }, 100);
      };
      container.addEventListener('scroll', scrollEndHandler, { passive: true });
      return;
    }
    
    if (center) {
      // Center the page in the viewport
      // All calculations are at zoom level scale
      const containerHeight = container.clientHeight;
      const pageCenter = pageTop + (pageHeight / 2);
      const viewportCenter = containerHeight / 2;
      const targetScroll = pageCenter - viewportCenter;
      
      // Set flag to prevent IntersectionObserver from overwriting currentPage during programmatic scroll
      isProgrammaticScrollRef.current = true;
      container.scrollTo({
        top: Math.max(0, targetScroll),
        behavior: "smooth"
      });
      
      // Listen for scroll end to re-enable IntersectionObserver updates
      let scrollEndTimeout: NodeJS.Timeout | null = null;
      const scrollEndHandler = () => {
        if (scrollEndTimeout) clearTimeout(scrollEndTimeout);
        scrollEndTimeout = setTimeout(() => {
          // Re-enable IntersectionObserver updates after scroll completes
          isProgrammaticScrollRef.current = false;
          container.removeEventListener('scroll', scrollEndHandler);
        }, 100);
      };
      container.addEventListener('scroll', scrollEndHandler, { passive: true });
    } else {
      // Set flag to prevent IntersectionObserver from overwriting currentPage during programmatic scroll
      isProgrammaticScrollRef.current = true;
      container.scrollTo({
        top: Math.max(0, pageTop),
        behavior: "smooth"
      });
      // Re-enable IntersectionObserver updates after scroll completes
      let scrollEndTimeout: NodeJS.Timeout | null = null;
      const scrollEndHandler = () => {
        if (scrollEndTimeout) clearTimeout(scrollEndTimeout);
        scrollEndTimeout = setTimeout(() => {
          isProgrammaticScrollRef.current = false;
          container.removeEventListener('scroll', scrollEndHandler);
        }, 100);
      };
      container.addEventListener('scroll', scrollEndHandler, { passive: true });
    }
  }, [readMode, currentDocument, zoomLevel, baseFitScale]);
  
  // Handle scroll-to-spec events
  useEffect(() => {
    const handleScrollToSpec = (event: Event) => {
      const customEvent = event as CustomEvent<{ page: number; bbox?: number[]; specId?: string }>;
      const { page, bbox, specId } = customEvent.detail;
      
      if (!currentDocument) return;
      
      const documentId = currentDocument.getId();
      
      // Set selected spec for highlighting
      if (specId) {
        setSelectedSpec(documentId, specId);
      }
      
      // Helper function to perform the scroll
      const performScroll = () => {
        setCurrentPage(page);
        // Wait for page state to update, viewport to be ready, and baseFitScale to be calculated
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            // Double-check read mode is active and container exists
            const isReadModeActive = useUIStore.getState().readMode;
            if (isReadModeActive && scrollContainerRef.current) {
              // Ensure baseFitScale is calculated before scrolling
              const container = scrollContainerRef.current;
              const containerWidth = container.clientWidth || 800;
              const firstPageMetadata = currentDocument.getPageMetadata(0);
              if (firstPageMetadata && containerWidth > 0) {
                const calculatedScale = containerWidth / firstPageMetadata.width;
                // Update baseFitScale if it's significantly different (viewport may have changed)
                if (Math.abs(calculatedScale - baseFitScale) > 0.01) {
                  setBaseFitScale(calculatedScale);
                  // Wait one more frame for state to update
                  requestAnimationFrame(() => {
                    scrollToPage(page, true, bbox);
                  });
                } else {
                  scrollToPage(page, true, bbox);
                }
              } else {
                scrollToPage(page, true, bbox);
              }
            }
          });
        });
      };
      
      // Switch to read mode if not already
      if (!readMode) {
        toggleReadMode();
        // Wait for read mode to fully activate - use polling to check when ready
        let attempts = 0;
        const maxAttempts = 30; // 1.5 seconds max wait
        const checkReadMode = setInterval(() => {
          attempts++;
          const isReadModeActive = useUIStore.getState().readMode;
          if (isReadModeActive && scrollContainerRef.current) {
            clearInterval(checkReadMode);
            // Wait a bit more for viewport to settle
            setTimeout(() => {
              performScroll();
            }, 100);
          } else if (attempts >= maxAttempts) {
            clearInterval(checkReadMode);
            // Try anyway after max attempts
            performScroll();
          }
        }, 50);
      } else {
        // Already in read mode, scroll immediately
        performScroll();
      }
    };
    
    window.addEventListener('scroll-to-spec', handleScrollToSpec);
    return () => {
      window.removeEventListener('scroll-to-spec', handleScrollToSpec);
    };
  }, [currentDocument, readMode, setCurrentPage, scrollToPage, toggleReadMode, setSelectedSpec, baseFitScale]);

  // Handle page visibility changes from VirtualizedPageList
  // This updates the current page as the user scrolls
  const handlePageVisible = useCallback((pageNumber: number) => {
    // Don't update if we're in the middle of a programmatic scroll - wait for it to complete
    if (isProgrammaticScrollRef.current) {
      return;
    }
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
      const delta = e.deltaY > 0 ? 0.988 : 1.012; // 1.2x faster than previous 0.99/1.01
      const newZoom = Math.max(0.25, Math.min(5, currentZoom * delta));

      if (Math.abs(newZoom - currentZoom) > 0.001) {
        // In read mode, zoom to viewport center instead of mouse cursor position
        // This provides a more predictable zoom experience
        const containerRect = container.getBoundingClientRect();
        const viewportCenterX = containerRect.left + container.clientWidth / 2;
        const viewportCenterY = containerRect.top + container.clientHeight / 2;
        
        zoomToPoint(newZoom, viewportCenterX, viewportCenterY);
      }
    };

    // Track scroll events during zoom to detect unexpected changes
    const handleScroll = () => {
      // Track scroll position for potential future use
      container.scrollTop;
    };

    container.addEventListener("wheel", handleWheelNative, { passive: false });
    container.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      container.removeEventListener("wheel", handleWheelNative);
      container.removeEventListener("scroll", handleScroll);
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
        // Use clientHeight instead of containerRect.height to get the actual viewport height
        // containerRect.height might include scrollbars or other elements
        const viewportCenterX = containerRect.left + container.clientWidth / 2;
        const viewportCenterY = containerRect.top + container.clientHeight / 2;
        
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
    
    // This is an external action (thumbnail click, keyboard navigation, etc.)
    // Preserve the current zoom level when switching pages in read mode
    // Only scroll to the new page without resetting zoom
    
    // Wait for viewport to be ready, baseFitScale to be calculated, and page to be rendered
    const performScroll = () => {
      if (!scrollContainerRef.current || !currentDocument) return;
      
      const container = scrollContainerRef.current;
      const containerWidth = container.clientWidth || 800;
      const firstPageMetadata = currentDocument.getPageMetadata(0);
      if (firstPageMetadata && containerWidth > 0) {
        const calculatedScale = containerWidth / firstPageMetadata.width;
        // Update baseFitScale if it's significantly different (viewport may have changed)
        if (Math.abs(calculatedScale - baseFitScale) > 0.01) {
          setBaseFitScale(calculatedScale);
          // Wait for state update and page rendering
          setTimeout(() => {
            scrollToPage(currentPage, true);
          }, 50);
        } else {
          // Still wait a bit to ensure page is rendered
          setTimeout(() => {
            scrollToPage(currentPage, true);
          }, 50);
        }
      } else {
        // Fallback: try scrolling anyway after a delay
        setTimeout(() => {
          scrollToPage(currentPage, true);
        }, 100);
      }
    };
    
    // Use multiple requestAnimationFrame calls plus a small timeout to ensure DOM is ready
    const delay = 50;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // Additional small delay to ensure VirtualizedPageList has rendered the page
        setTimeout(() => {
          performScroll();
        }, delay);
      });
    });
    
    previousPageRef.current = currentPage;
  }, [currentPage, readMode, scrollToPage, currentDocument, baseFitScale, fitMode, zoomLevel, setFitMode, setZoomLevel]);

  // Fit to page when switching pages in normal mode
  useEffect(() => {
    if (readMode || !currentDocument) return;
    
    // Skip if page didn't actually change
    if (previousPageRef.current === currentPage) {
      return;
    }
    
    // Set fit mode to "page" to fit the new page to the viewport
    setFitMode("page");
    
    previousPageRef.current = currentPage;
  }, [currentPage, readMode, currentDocument, setFitMode]);

  // Listen for page deletion events and refresh the viewport
  useEffect(() => {
    const handlePagesChanged = (event: Event) => {
      const customEvent = event as CustomEvent<{ documentId: string; newPageCount: number; newCurrentPage: number }>;
      const { documentId } = customEvent.detail;
      
      // Only handle if it's for the current document
      if (!currentDocument || currentDocument.getId() !== documentId) {
        return;
      }
      
      // Clear renderer cache to force fresh rendering
      if (renderer) {
        renderer.clearCache();
      }
      
      // Force viewport refresh
      if (readMode) {
        // In read mode, wait for VirtualizedPageList to remount and update before scrolling
        // The key change will force a remount, so we need to wait for that
        const performScroll = () => {
          if (!scrollContainerRef.current || !currentDocument) return;
          
          // Use current page from store (more reliable than event detail)
          const storeCurrentPage = usePDFStore.getState().currentPage;
          const pageCount = currentDocument.getPageCount();
          if (pageCount === 0) return;
          
          const targetPage = Math.min(storeCurrentPage, Math.max(0, pageCount - 1));
          
          // Verify the page exists by checking metadata
          const pageMetadata = currentDocument.getPageMetadata(targetPage);
          if (!pageMetadata) {
            // Page not ready yet, try again after a short delay
            setTimeout(() => {
              requestAnimationFrame(() => {
                requestAnimationFrame(performScroll);
              });
            }, 50);
            return;
          }
          
          // Recalculate baseFitScale in case viewport changed
          const container = scrollContainerRef.current;
          const containerWidth = container.clientWidth || 800;
          const firstPageMetadata = currentDocument.getPageMetadata(0);
          if (firstPageMetadata && containerWidth > 0) {
            const calculatedScale = containerWidth / firstPageMetadata.width;
            if (Math.abs(calculatedScale - baseFitScale) > 0.01) {
              setBaseFitScale(calculatedScale);
              // Wait for baseFitScale to update and VirtualizedPageList to remount
              setTimeout(() => {
                scrollToPage(targetPage, true);
              }, 150);
            } else {
              // Still wait a bit for VirtualizedPageList to remount
              setTimeout(() => {
                scrollToPage(targetPage, true);
              }, 150);
            }
          } else {
            setTimeout(() => {
              scrollToPage(targetPage, true);
            }, 150);
          }
        };
        
        // Wait for VirtualizedPageList to remount (key change triggers remount)
        // Use multiple animation frames and a delay to ensure React has remounted the component
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            // Wait for remount to complete
            setTimeout(() => {
              requestAnimationFrame(() => {
                performScroll();
              });
            }, 100);
          });
        });
      } else {
        // In normal mode, force a re-render by updating fit mode
        // This will trigger the page canvas to refresh
        setFitMode("page");
      }
    };
    
    window.addEventListener('pdf-pages-changed', handlePagesChanged);
    return () => {
      window.removeEventListener('pdf-pages-changed', handlePagesChanged);
    };
  }, [currentDocument, readMode, renderer, scrollToPage, setFitMode, baseFitScale, setBaseFitScale]);

  // Calculate base fit-to-width scale when entering read mode or document changes
  useEffect(() => {
    if (readMode && currentDocument && scrollContainerRef.current) {
      const recalculateBaseFitScale = () => {
        const container = scrollContainerRef.current;
        if (!container) return;
        
        const containerWidth = container.clientWidth || 800;
        const firstPageMetadata = currentDocument.getPageMetadata(0);
        if (firstPageMetadata && containerWidth > 0) {
          const scale = containerWidth / firstPageMetadata.width;
          setBaseFitScale(scale);
        }
      };
      
      // Calculate immediately
      recalculateBaseFitScale();
      
      // Recalculate on resize
      const resizeObserver = new ResizeObserver(() => {
        recalculateBaseFitScale();
      });
      
      resizeObserver.observe(scrollContainerRef.current);
      
      return () => {
        resizeObserver.disconnect();
      };
    }
  }, [readMode, currentDocument]);

  // Set fit mode to width when entering read mode
  useEffect(() => {
    if (readMode && fitMode !== "width" && fitMode !== "custom") {
      const { setFitMode } = useUIStore.getState();
      setFitMode("width");
    }
  }, [readMode, fitMode]);

  // When entering read mode, allow reset-to-fit once; after user zooms we stop resetting (hasUserZoomedInReadModeRef).
  useEffect(() => {
    const justEnteredReadMode = !previousReadModeRef.current && readMode;
    if (justEnteredReadMode) {
      hasUserZoomedInReadModeRef.current = false; // Allow initial fit-to-width when entering read mode
    }
  }, [readMode]);

  // When fitMode is "width" in read mode, set zoomLevel to baseFitScale only if user hasn't manually zoomed
  useEffect(() => {
    if (!readMode || fitMode !== "width" || baseFitScale <= 0 || isZoomingRef.current || hasUserZoomedInReadModeRef.current) return;
    if (Math.abs(zoomLevel - baseFitScale) > 0.01) {
      setZoomLevel(baseFitScale);
    }
  }, [readMode, fitMode, baseFitScale, zoomLevel, setZoomLevel]);


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

  const handlePageNumberClick = () => {
    if (!currentDocument) return;
    setPageInputValue(String(currentPage + 1));
    setIsEditingPage(true);
  };

  const handlePageNumberSubmit = () => {
    if (!currentDocument) return;
    const pageNum = parseInt(pageInputValue, 10);
    const pageCount = currentDocument.getPageCount();
    
    if (!isNaN(pageNum) && pageNum >= 1 && pageNum <= pageCount) {
      setCurrentPage(pageNum - 1); // Convert to 0-based index
    }
    setIsEditingPage(false);
  };

  const handlePageNumberKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handlePageNumberSubmit();
    } else if (e.key === "Escape") {
      setIsEditingPage(false);
    }
  };

  // Focus input when editing starts
  useEffect(() => {
    if (isEditingPage && pageInputRef.current) {
      pageInputRef.current.focus();
      pageInputRef.current.select();
    }
  }, [isEditingPage]);

  // Reset editing state when page changes externally
  useEffect(() => {
    if (isEditingPage) {
      setIsEditingPage(false);
    }
  }, [currentPage]);

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


  // Retry initialization if we have a document but no renderer (thumbnails work, so mupdf must be available)
  useEffect(() => {
    if (currentDocument && (!mupdf || !renderer)) {
      const retryInit = async () => {
        try {
          const mupdfModule = await import("mupdf");
          if (mupdfModule?.default) {
            setMupdf(mupdfModule.default);
            setRenderer(new PDFRenderer(mupdfModule.default));
            setIsInitialized(true);
          }
        } catch (error) {
          // Still set initialized to true to prevent infinite loading
          setIsInitialized(true);
        }
      };
      retryInit();
    }
  }, [currentDocument, mupdf, renderer]);

  // Show initialization message only if we don't have mupdf/renderer
  // But if we have a document, thumbnails work so mupdf must be loading - give it a moment
  if (!isInitialized || !mupdf || !renderer) {
    // If we have a document, show a shorter message since initialization should complete soon
    if (currentDocument) {
      return (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-muted-foreground">Loading PDF viewer...</div>
        </div>
      );
    }
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
            overflowAnchor: "none", // Prevent browser from auto-adjusting scroll position during layout changes
          }}
        >
          <div 
            ref={pagesContainerRef}
            className="flex justify-center"
          >
            {currentDocument && renderer && (
              <VirtualizedPageList
                key={`${currentDocument.getId()}-${currentDocument.getPageCount()}`}
                document={currentDocument}
                renderer={renderer}
                zoomLevel={zoomLevel}
                baseFitScale={baseFitScale}
                pageGap={8}
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
      <div className="flex items-center justify-between px-2 py-1.5 border-t bg-background">
        <div className="flex items-center gap-1">
          {!readMode && <PageTools />}
          {!readMode && <div className="h-4 w-px bg-border mx-0.5" />}
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            onClick={handlePreviousPage}
            disabled={!canGoPrevious || readMode}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          {isEditingPage ? (
            <div className="flex items-center gap-1 min-w-[80px]">
              <Input
                ref={pageInputRef}
                type="number"
                min={1}
                max={pageCount}
                value={pageInputValue}
                onChange={(e) => setPageInputValue(e.target.value)}
                onKeyDown={handlePageNumberKeyDown}
                onBlur={handlePageNumberSubmit}
                className="h-7 w-12 px-1.5 text-xs text-center"
                autoFocus
              />
              <span className="text-xs text-muted-foreground">of {pageCount}</span>
            </div>
          ) : (
            <button
              onClick={handlePageNumberClick}
              className="text-xs text-muted-foreground min-w-[80px] text-center hover:text-foreground transition-colors cursor-pointer px-1 py-0.5 rounded"
              title="Click to enter page number"
            >
              Page {currentPage + 1} of {pageCount}
            </button>
          )}
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            onClick={handleNextPage}
            disabled={!canGoNext || readMode}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
        
        <div className="flex items-center gap-1">
          {/* Zoom Controls - Grouped with better styling */}
          <div className="flex items-center gap-0.5 px-1 py-0.5 rounded-md border bg-muted/50">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => {
                const newZoom = Math.max(0.25, zoomLevel - 0.1); // Reduced from 0.25 to 0.1 for slower zoom
                zoomToCenter(newZoom);
              }}
              title="Zoom Out"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </Button>
            <div className="px-1.5 py-0.5 min-w-[45px] text-center">
              <span className="text-xs font-medium text-foreground">
                {Math.round(zoomLevel * 100)}%
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => {
                const newZoom = Math.min(5, zoomLevel + 0.1); // Reduced from 0.25 to 0.1 for slower zoom
                zoomToCenter(newZoom);
              }}
              title="Zoom In"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </Button>
            <div className="h-4 w-px bg-border mx-0.5" />
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setFitMode("page")}
              title="Fit Page"
              disabled={readMode}
            >
              <Maximize className="h-3.5 w-3.5" />
            </Button>
          </div>
          
          <div className="h-5 w-px bg-border mx-0.5" />
          
          <Button
            variant={showRulers ? "default" : "outline"}
            size="icon"
            className="h-7 w-7"
            onClick={toggleRulers}
            title="Toggle Rulers"
            disabled={!currentDocument || readMode}
          >
            <Ruler className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            onClick={() => setShowDocumentSettings(true)}
            title="Document Settings"
            disabled={!currentDocument}
          >
            <Settings className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant={readMode ? "default" : "outline"}
            size="icon"
            className="h-7 w-7"
            onClick={toggleReadMode}
            title={readMode ? "Exit read mode (R)" : "Enter read mode (R)"}
          >
            <BookOpen className="h-3.5 w-3.5" />
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

      {/* Spec Extraction Panel */}
      {currentDocument && <SpecExtractionPanel />}
      
      {/* Question Answer Panel */}
      {currentDocument && <QuestionAnswerPanel />}
    </div>
  );
}

