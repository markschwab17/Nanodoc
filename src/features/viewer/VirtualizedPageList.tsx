/**
 * VirtualizedPageList Component
 * 
 * Efficiently renders only visible PDF pages using virtual scrolling.
 * Uses IntersectionObserver to detect visible pages and renders a buffer zone.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { PageCanvas } from "./PageCanvas";
import { useUIStore } from "@/shared/stores/uiStore";
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
  zoomLevel: _zoomLevel, // Reserved for future use
  baseFitScale,
  pageGap = 24,
  bufferPages = 2,
  onPageVisible,
  scrollContainerRef,
}: VirtualizedPageListProps) {
  const { renderQuality, getEffectiveRenderQuality, zoomLevel } = useUIStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 0 });
  const pageCount = document.getPageCount();

  // Calculate page dimensions and positions at base fit scale
  // The transform scale on the parent container will handle zoom
  const pageData = useMemo(() => {
    const firstPageMetadata = document.getPageMetadata(0);
    if (!firstPageMetadata || baseFitScale <= 0) return [];

    const baseWidth = firstPageMetadata.width * baseFitScale;
    // const baseHeight = firstPageMetadata.height * baseFitScale; // Reserved for future use

    const data: Array<{ top: number; height: number; width: number }> = [];
    let currentTop = 0;

    for (let i = 0; i < pageCount; i++) {
      const pageMetadata = document.getPageMetadata(i);
      if (pageMetadata) {
        const pageHeight = pageMetadata.height * baseFitScale;
        data.push({
          top: currentTop,
          height: pageHeight,
          width: baseWidth,
        });
        currentTop += pageHeight + pageGap;
      }
    }

    return data;
  }, [document, pageCount, baseFitScale, pageGap]);

  // Calculate total height
  const totalHeight = useMemo(() => {
    if (pageData.length === 0) return 0;
    const lastPage = pageData[pageData.length - 1];
    return lastPage.top + lastPage.height;
  }, [pageData]);

  // Update visible range based on scroll position
  const updateVisibleRange = useCallback(() => {
    const container = scrollContainerRef?.current || containerRef.current;
    if (!container || pageData.length === 0) return;

    const containerRect = container.getBoundingClientRect();
    const scrollTop = container.scrollTop;
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
      // const pageBottom = pageTop + pageData[i].height; // Reserved for future use

      if (pageTop <= viewportBottom) {
        end = Math.min(pageData.length - 1, i + bufferPages);
        break;
      }
    }

    setVisibleRange({ start, end });
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

          // Pre-cache higher quality versions when pages become visible
          if (entry.isIntersecting && entry.intersectionRatio > 0.1) {
            const visiblePages = [pageNum]; // Could expand to include nearby pages
            const baseScale = 1.0; // Base scale for pre-caching
              const effectiveQuality = getEffectiveRenderQuality();
              renderer.preCacheHigherQuality(
                document.getMupdfDocument(),
                visiblePages,
                effectiveQuality,
                baseScale
              ).catch(err => {
                console.debug('Pre-cache failed:', err);
              });
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

    const handleScroll = () => {
      updateVisibleRange();
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
      container.removeEventListener("scroll", handleScroll);
      observer.disconnect();
    };
  }, [scrollContainerRef, pageData, onPageVisible, updateVisibleRange, renderQuality, getEffectiveRenderQuality, document, renderer]);

  // Pre-cache more aggressively when zoom level changes
  useEffect(() => {
    if (!document || !renderer) return;

    const effectiveQuality = getEffectiveRenderQuality();
    const baseScale = 1.0;

    // Adjust buffer size based on zoom level to prevent memory explosion
    const bufferPages = zoomLevel > 2.0 ? 1 : zoomLevel > 1.5 ? 2 : 3;

    // Pre-cache visible pages plus buffer pages for smooth zooming
    const pagesToCache: number[] = [];
    for (let i = Math.max(0, visibleRange.start - bufferPages);
         i <= Math.min(pageCount - 1, visibleRange.end + bufferPages);
         i++) {
      pagesToCache.push(i);
    }

    // Debounce pre-caching during rapid zoom changes (less aggressive during zoom)
    const timeoutId = setTimeout(() => {
      renderer.preCacheHigherQuality(
        document.getMupdfDocument(),
        pagesToCache,
        effectiveQuality,
        baseScale
      ).catch(err => {
        console.debug('Zoom pre-cache failed:', err);
      });
    }, zoomLevel > 2.0 ? 50 : 100); // Faster pre-caching at high zoom levels

    return () => clearTimeout(timeoutId);
  }, [zoomLevel, visibleRange, document, renderer, getEffectiveRenderQuality, pageCount]);

  // Initial visible range calculation
  useEffect(() => {
    updateVisibleRange();
  }, [updateVisibleRange]);

  // Render pages
  const renderedPages = useMemo(() => {
    const pages: JSX.Element[] = [];

    for (let i = visibleRange.start; i <= visibleRange.end && i < pageCount; i++) {
      const pageInfo = pageData[i];
      if (!pageInfo) continue;

      pages.push(
        <div
          key={`page-${i}`} // Stable key that doesn't change with zoom
          ref={(el) => {
            if (el) {
              pageRefs.current.set(i, el);
            } else {
              pageRefs.current.delete(i);
            }
          }}
          data-page-number={i}
          data-page-canvas={i}
          className="flex justify-center"
          style={{
            position: "absolute",
            top: `${pageInfo.top}px`,
            left: 0,
            width: "100%",
            height: `${pageInfo.height}px`,
            margin: 0,
            padding: 0,
            lineHeight: 0,
            fontSize: 0,
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
  }, [visibleRange, pageData, document, renderer, pageCount, renderQuality]);

  // Calculate container width based on base fit scale (transform will handle zoom)
  const containerWidth = useMemo(() => {
    const firstPageMetadata = document.getPageMetadata(0);
    if (!firstPageMetadata || baseFitScale <= 0) return "auto";
    return `${firstPageMetadata.width * baseFitScale}px`;
  }, [document, baseFitScale]);

  return (
    <div
      ref={containerRef}
      className="relative"
      style={{
        height: `${totalHeight}px`,
        width: containerWidth,
        margin: "0 auto",
        position: "relative",
      }}
    >
      {renderedPages}
    </div>
  );
}

