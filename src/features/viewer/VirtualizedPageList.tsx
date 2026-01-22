/**
 * VirtualizedPageList Component
 * 
 * Efficiently renders only visible PDF pages using virtual scrolling.
 * Uses IntersectionObserver to detect visible pages and renders a buffer zone.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { PageCanvas } from "./PageCanvas";
import type { PDFDocument } from "@/core/pdf/PDFDocument";
import type { PDFRenderer } from "@/core/pdf/PDFRenderer";

interface VirtualizedPageListProps {
  document: PDFDocument;
  renderer: PDFRenderer;
  zoomLevel: number;
  baseFitScale: number;
  pageGap?: number;
  bufferPages?: number;
  onPageVisible?: (pageNumber: number) => void;
  scrollContainerRef?: React.RefObject<HTMLDivElement>;
}

export function VirtualizedPageList({
  document,
  renderer,
  zoomLevel,
  baseFitScale,
  pageGap = 1,
  bufferPages = 2,
  onPageVisible,
  scrollContainerRef,
}: VirtualizedPageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 0 });
  const pageCount = document.getPageCount();

  // Calculate page dimensions and positions at actual zoom level
  // Each page is scaled to fit the viewport width while maintaining aspect ratio
  // Pages are scaled directly by zoomLevel, not via CSS transform
  const pageData = useMemo(() => {
    const firstPageMetadata = document.getPageMetadata(0);
    if (!firstPageMetadata || zoomLevel <= 0 || baseFitScale <= 0) return [];

    // Calculate the actual scale factor relative to baseFitScale
    // baseFitScale is the fit-to-width scale, zoomLevel is the current scale
    // When zoomLevel === baseFitScale, we're at 100% (fit-to-width)
    const zoomFactor = zoomLevel / baseFitScale;
    
    // Calculate viewport width: base width scaled by zoom factor
    // This ensures all pages have the same visual width in the viewport
    const viewportWidth = firstPageMetadata.width * baseFitScale * zoomFactor;

    const data: Array<{ top: number; height: number; width: number }> = [];
    let currentTop = 0;

    for (let i = 0; i < pageCount; i++) {
      const pageMetadata = document.getPageMetadata(i);
      if (pageMetadata) {
        // Scale each page to fit the viewport width while maintaining aspect ratio
        // If a page has a different width, it will be scaled proportionally
        const pageScale = viewportWidth / pageMetadata.width;
        const pageHeight = pageMetadata.height * pageScale;
        const pageWidth = viewportWidth; // All pages have the same visual width
        
        data.push({
          top: currentTop,
          height: pageHeight,
          width: pageWidth,
        });
        // Keep gap fixed in screen pixels (not scaled) for consistent visual appearance
        currentTop += pageHeight + pageGap;
      }
    }

    return data;
  }, [document, pageCount, zoomLevel, baseFitScale, pageGap]);

  // Calculate total height
  const totalHeight = useMemo(() => {
    if (pageData.length === 0) return 0;
    const lastPage = pageData[pageData.length - 1];
    return lastPage.top + lastPage.height;
  }, [pageData]);

  // Update visible range based on scroll position
  // Positions are now in actual rendered coordinates (at zoom level)
  // Debounced to prevent excessive recalculations during zoom
  const updateVisibleRange = useCallback(() => {
    const container = scrollContainerRef?.current || containerRef.current;
    if (!container || pageData.length === 0) return;

    const scrollTop = container.scrollTop; // In actual rendered coordinates
    const containerRect = container.getBoundingClientRect();
    
    // Use scrollTop and viewport height directly since positions are at zoom level
    const viewportTop = scrollTop;
    const viewportBottom = scrollTop + containerRect.height;

    // Find first and last visible pages
    let start = 0;
    let end = pageData.length - 1;

    for (let i = 0; i < pageData.length; i++) {
      const pageTop = pageData[i].top;
      const pageBottom = pageTop + pageData[i].height;

      if (pageBottom >= viewportTop) {
        start = Math.max(0, i - bufferPages);
        break;
      }
    }

    for (let i = pageData.length - 1; i >= 0; i--) {
      const pageTop = pageData[i].top;

      if (pageTop <= viewportBottom) {
        end = Math.min(pageData.length - 1, i + bufferPages);
        break;
      }
    }

    setVisibleRange(prev => {
      // Only update if range actually changed to prevent unnecessary re-renders
      if (prev.start === start && prev.end === end) {
        return prev;
      }
      return { start, end };
    });
  }, [pageData, bufferPages, scrollContainerRef]);

  // Track visible pages for current page detection
  useEffect(() => {
    if (!scrollContainerRef?.current || pageData.length === 0) return;

    const container = scrollContainerRef.current;
    let updateTimeout: NodeJS.Timeout | null = null;

    const observer = new IntersectionObserver(
      (entries) => {
        let maxRatio = 0;
        let visiblePage = -1;
        const containerRect = container.getBoundingClientRect();
        const viewportCenterY = containerRect.top + containerRect.height / 2;

        entries.forEach((entry) => {
          const pageNum = parseInt(entry.target.getAttribute("data-page-number") || "0");
          const pageRect = entry.boundingClientRect;
          const pageCenterY = pageRect.top + pageRect.height / 2;

          const distanceFromCenter = Math.abs(pageCenterY - viewportCenterY);
          const maxDistance = containerRect.height / 2;
          const centerScore = Math.max(0, 1 - Math.min(1, distanceFromCenter / maxDistance));
          const combinedScore = entry.intersectionRatio * 0.5 + centerScore * 0.5;

          if (combinedScore > maxRatio) {
            maxRatio = combinedScore;
            visiblePage = pageNum;
          }
        });

        // Debounce updates to avoid too many rapid changes during scrolling
        // But still allow updates while scrolling
        if (visiblePage >= 0 && maxRatio > 0.3 && onPageVisible) {
          if (updateTimeout) clearTimeout(updateTimeout);
          updateTimeout = setTimeout(() => {
            onPageVisible(visiblePage);
          }, 100); // Small delay to batch rapid scroll updates
        }
      },
      {
        root: container,
        rootMargin: "-10% 0px -10% 0px",
        threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
      }
    );

    // Debounce scroll handler to prevent excessive updates during zoom
    let scrollTimeout: NodeJS.Timeout | null = null;
    const handleScroll = () => {
      if (scrollTimeout) clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        updateVisibleRange();
      }, 16); // ~60fps throttle
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    updateVisibleRange();

    const timeoutId = setTimeout(() => {
      pageRefs.current.forEach((pageEl) => {
        if (pageEl) observer.observe(pageEl);
      });
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      if (updateTimeout) clearTimeout(updateTimeout);
      if (scrollTimeout) clearTimeout(scrollTimeout);
      container.removeEventListener("scroll", handleScroll);
      observer.disconnect();
    };
  }, [scrollContainerRef, pageData, onPageVisible, updateVisibleRange]);

  // Initial visible range calculation and update when zoom changes
  useEffect(() => {
    updateVisibleRange();
  }, [updateVisibleRange, zoomLevel]);

  // Render pages
  // Include zoomLevel in dependencies to force re-render when zoom changes
  // This ensures all pages update to the correct zoom level
  const renderedPages = useMemo(() => {
    const pages: JSX.Element[] = [];

    for (let i = visibleRange.start; i <= visibleRange.end && i < pageCount; i++) {
      const pageInfo = pageData[i];
      if (!pageInfo) continue;

      pages.push(
        <div
          key={i} // Use stable key - zoom changes handled via props/style, not remounting
          ref={(el) => {
            if (el) {
              pageRefs.current.set(i, el);
            } else {
              pageRefs.current.delete(i);
            }
          }}
          data-page-number={i}
          data-page-canvas={i}
          className=""
          style={{
            position: "absolute",
            top: `${pageInfo.top}px`,
            left: 0,
            width: `${pageInfo.width}px`, // Use exact width from pageData
            height: `${pageInfo.height}px`,
            margin: 0,
            padding: 0,
            lineHeight: 0,
            fontSize: 0,
            display: "block", // Block display to eliminate flex spacing
            boxSizing: "border-box", // Ensure no extra spacing from borders/padding
            overflow: "visible", // Allow gap to be visible between pages
          }}
        >
          <PageCanvas
            document={document}
            pageNumber={i}
            renderer={renderer}
            readMode={true}
          />
        </div>
      );
    }

    return pages;
  }, [visibleRange, pageData, document, renderer, pageCount, zoomLevel]);

  // Calculate container width - use the maximum page width to accommodate all pages
  // Each page will be positioned absolutely, so container just needs to be wide enough
  const containerWidth = useMemo(() => {
    if (pageData.length === 0) return "auto";
    // Find the maximum page width
    const maxWidth = Math.max(...pageData.map(p => p.width));
    return `${maxWidth}px`;
  }, [pageData]);

  return (
    <div
      ref={containerRef}
      className="relative"
      style={{
        height: `${totalHeight}px`,
        width: containerWidth,
        margin: "0 auto",
        position: "relative",
        // Ensure background is visible to show gaps between pages
        backgroundColor: "transparent",
      }}
    >
      {renderedPages}
    </div>
  );
}

