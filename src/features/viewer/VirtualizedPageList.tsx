/**
 * VirtualizedPageList Component
 * 
 * Efficiently renders only visible PDF pages using virtual scrolling.
 * Uses IntersectionObserver to detect visible pages and renders a buffer zone.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { PageCanvas } from "./PageCanvas";
import { setTilesPaused } from "@/core/pdf/tiles/tileRendererPause";
import type { PDFDocument } from "@/core/pdf/PDFDocument";
import type { PDFRenderer } from "@/core/pdf/PDFRenderer";

/**
 * Scroll velocity (px/ms) above which we pause new tile requests. A typical
 * line-by-line wheel scroll is < 1 px/ms; flings on a trackpad easily hit
 * 5–10 px/ms. 2.0 keeps deliberate scrolls responsive while skipping work
 * during obvious "I'm not stopping here" flings.
 */
const FAST_SCROLL_PX_PER_MS = 2.0;
/** How long after the last scroll event we treat the scroll as ended. */
const SCROLL_END_MS = 120;

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

    // Binary search for first page whose bottom >= viewportTop (O(log n) vs O(n))
    let lo = 0, hi = pageData.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pageData[mid].top + pageData[mid].height < viewportTop) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    const start = Math.max(0, lo - bufferPages);

    // Binary search for last page whose top <= viewportBottom
    lo = start;
    hi = pageData.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pageData[mid].top <= viewportBottom) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    const end = Math.min(pageData.length - 1, lo + bufferPages);

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
    // Velocity tracking: if the user is flinging through pages, don't generate
    // tile requests for every page that flashes by — pause the tile renderer
    // until the scroll slows or ends. Cached LOD-0 prefetches still draw, so
    // pages aren't blank during the fling; we just stop paying for new tiles
    // the user has already passed.
    let lastScrollTop = container.scrollTop;
    let lastScrollAt = performance.now();
    let scrollEndTimer: NodeJS.Timeout | null = null;
    const handleScroll = () => {
      const now = performance.now();
      const dt = Math.max(1, now - lastScrollAt);
      const dy = Math.abs(container.scrollTop - lastScrollTop);
      const velocity = dy / dt; // px / ms
      lastScrollTop = container.scrollTop;
      lastScrollAt = now;

      if (velocity > FAST_SCROLL_PX_PER_MS) setTilesPaused(true);

      if (scrollEndTimer) clearTimeout(scrollEndTimer);
      scrollEndTimer = setTimeout(() => setTilesPaused(false), SCROLL_END_MS);

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
      if (scrollEndTimer) clearTimeout(scrollEndTimer);
      // Always release the pause on unmount — leaving it stuck-on would
      // freeze tile requests across mode switches.
      setTilesPaused(false);
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
            width: `${pageInfo.width}px`,
            height: `${pageInfo.height}px`,
            margin: 0,
            padding: 0,
            lineHeight: 0,
            fontSize: 0,
            display: "block",
            boxSizing: "border-box",
            overflow: "visible",
            backgroundColor: "var(--color-card, #ffffff)",
            boxShadow: "0 1px 3px 0 rgba(0,0,0,0.1)",
          }}
        >
          <PageCanvas
            document={document}
            pageNumber={i}
            renderer={renderer}
            readMode={true}
            displayWidth={pageInfo.width}
            displayHeight={pageInfo.height}
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
        // Smooth zoom transitions for width/height changes
        transition: "width 150ms ease-out, height 150ms ease-out",
      }}
    >
      {renderedPages}
    </div>
  );
}

