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
import { ChevronLeft, ChevronRight, BookOpen, Ruler, Settings, ZoomIn, ZoomOut, Maximize, RotateCw, FlipVertical, FlipHorizontal, PanelBottomOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { PageTools } from "@/features/toolbar/PageTools";
import { DocumentSettingsDialog } from "@/features/settings/DocumentSettingsDialog";
import { PDFEditor } from "@/core/pdf/PDFEditor";
import { useTabStore } from "@/shared/stores/tabStore";
import { wrapPageOperation } from "@/shared/stores/undoHelpers";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { SpecExtractionPanel } from "@/features/specs/SpecExtractionPanel";
import { QuestionAnswerPanel } from "@/features/specs/QuestionAnswerPanel";
import { StatusBar } from "./StatusBar";
import type { Annotation } from "@/core/pdf/types";
import { useSpecExtractionStore } from "@/shared/stores/specExtractionStore";

export function PDFViewer() {
  // Use individual selectors to avoid re-rendering when unrelated state (e.g. annotations) changes.
  // Without selectors, adding a highlight triggers a full PDFViewer re-render which can
  // cause the scroll position to jump back to page 1 in read mode.
  const currentPage = usePDFStore((s) => s.currentPage);
  const setCurrentPage = usePDFStore((s) => s.setCurrentPage);
  const getCurrentDocument = usePDFStore((s) => s.getCurrentDocument);
  const getAnnotations = usePDFStore((s) => s.getAnnotations);
  const updateAnnotation = usePDFStore((s) => s.updateAnnotation);
  const { readMode, toggleReadMode, zoomLevel, fitMode, setZoomLevel, setFitMode, zoomToCenter, splitScreenMode } = useUIStore();
  const { showRulers, toggleRulers } = useDocumentSettingsStore();
  const { setSelectedSpec, getSpecHighlights, setTemporaryHighlight } = useSpecExtractionStore();
  const { showNotification } = useNotificationStore();
  const currentDocument = getCurrentDocument();
  const [mupdf, setMupdf] = useState<any>(null);
  const [renderer, setRenderer] = useState<PDFRenderer | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [showDocumentSettings, setShowDocumentSettings] = useState(false);
  const [showProperties, setShowProperties] = useState(false);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);

  // Track selected annotation for properties panel
  useEffect(() => {
    const handleSelect = (e: Event) => {
      const detail = (e as CustomEvent<{ annotationId?: string }>).detail;
      if (detail?.annotationId) {
        setSelectedAnnotationId(detail.annotationId);
        setShowProperties(true);
      }
    };
    const handleDeselect = () => {
      setSelectedAnnotationId(null);
    };
    window.addEventListener("annotationSelected", handleSelect);
    window.addEventListener("annotationDeselected", handleDeselect);
    window.addEventListener("clearEditingAnnotation", handleDeselect);
    return () => {
      window.removeEventListener("annotationSelected", handleSelect);
      window.removeEventListener("annotationDeselected", handleDeselect);
      window.removeEventListener("clearEditingAnnotation", handleDeselect);
    };
  }, []);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const pagesContainerRef = useRef<HTMLDivElement>(null);
  const [baseFitScale, setBaseFitScale] = useState<number>(1.0);
  const isScrollingFromUserRef = useRef(false); // Track if page change is from user scroll vs external action
  const previousPageRef = useRef(currentPage); // Track previous page to detect actual changes
  const isZoomingRef = useRef(false); // Flag to prevent scroll interference during zoom
  const hasUserZoomedInReadModeRef = useRef(false); // Once user zooms in read mode, don't reset zoom to baseFitScale
  const previousReadModeRef = useRef(readMode); // Track previous read mode state
  const isProgrammaticScrollRef = useRef(false); // Track if we're programmatically scrolling to prevent IntersectionObserver from overwriting currentPage
  // Track the temporary highlight clear timer so subsequent scroll-to-spec
  // events (which fire 2-3x per click in CTO split-view) can cancel the prior
  // timer instead of letting overlapping clears wipe out a fresh highlight.
  const temporaryHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timestamp of the last scroll-to-spec event. While this is recent, the
  // page-change effect (line ~1227) bails out instead of running its own
  // scrollToPage(currentPage, true) without a bbox, which would override our
  // bbox-targeted scroll back to top-of-page.
  const lastScrollToSpecAtRef = useRef(0);
  const [isEditingPage, setIsEditingPage] = useState(false);
  const [pageInputValue, setPageInputValue] = useState("");
  const pageInputRef = useRef<HTMLInputElement>(null);
  const [showRotateDialog, setShowRotateDialog] = useState(false);
  const [pagesToRotate, setPagesToRotate] = useState<number[]>([]);
  const [rotationType, setRotationType] = useState<"clockwise" | "counterclockwise" | "vertical" | "horizontal">("clockwise");
  const [applyToRange, setApplyToRange] = useState(false);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(0);
  
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
    anchorX?: number,  // Mouse X in screen coordinates, or undefined for center
    anchorY?: number   // Mouse Y in screen coordinates, or undefined for center
  ) => {
    if (!readMode || !scrollContainerRef.current || !currentDocument) return;

    const scrollContainer = scrollContainerRef.current;
    const currentZoom = zoomLevelRef.current;

    // Get container dimensions and position
    const scrollRect = scrollContainer.getBoundingClientRect();
    const viewportWidth = scrollContainer.clientWidth;
    const viewportHeight = scrollContainer.clientHeight;

    // Determine anchor point in viewport coordinates (relative to scroll container)
    const anchorPointX = anchorX !== undefined
      ? anchorX - scrollRect.left
      : viewportWidth / 2;
    const anchorPointY = anchorY !== undefined
      ? anchorY - scrollRect.top
      : viewportHeight / 2;

    // Get current scroll position (in actual rendered coordinates)
    const scrollLeft = scrollContainer.scrollLeft;
    const scrollTop = scrollContainer.scrollTop;

    // Calculate zoom factors relative to baseFitScale
    const currentBaseFitScale = baseFitScaleRef.current;
    if (currentBaseFitScale <= 0) return;

    const currentZoomFactor = currentZoom / currentBaseFitScale;
    const newZoomFactor = newZoom / currentBaseFitScale;

    // Document position currently at the anchor (in base-scale coords)
    // = (scroll + anchor-within-viewport) / current zoom factor
    const documentXAtAnchorBase = (scrollLeft + anchorPointX) / currentZoomFactor;
    const documentYAtAnchorBase = (scrollTop + anchorPointY) / currentZoomFactor;

    // New scroll positions to keep that same document point at the anchor
    const newScrollLeft = (documentXAtAnchorBase * newZoomFactor) - anchorPointX;
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

    // Immediately set scroll after flushSync — force reflow first so scrollHeight is current.
    // This is critical for WKWebView (macOS Tauri) which may auto-adjust scroll position
    // before a microtask runs, causing zoom to jump to top-left.
    void scrollContainer.offsetHeight;
    {
      const maxScrollY = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
      const maxScrollX = Math.max(0, scrollContainer.scrollWidth - scrollContainer.clientWidth);
      scrollContainer.scrollTop = Math.max(0, Math.min(maxScrollY, newScrollTop));
      // Honor horizontal anchor when there's horizontal overflow; otherwise
      // there's no scroll room and 0 is correct (keeps content centered by
      // VirtualizedPageList's flex layout).
      if (maxScrollX > 0) {
        scrollContainer.scrollLeft = Math.max(0, Math.min(maxScrollX, newScrollLeft));
      } else {
        scrollContainer.scrollLeft = 0;
      }
    }

    // Backup: microtask + rAF correction for edge cases where the immediate set was overridden
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
    
    if (!bbox) {
      // If a scroll-to-spec is in flight (within the last 4s), refuse to do
      // a no-bbox scroll. This protects the bbox-targeted scroll from being
      // overridden by side-effect re-scrolls (page-change effect, baseFitScale
      // ripple, etc.) that would scroll to the top of the page.
      if (Date.now() - lastScrollToSpecAtRef.current < 4000) {
        return;
      }
    }
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
      const customEvent = event as CustomEvent<{ page: number; bbox?: number[]; specId?: string; quote?: string }>;
      const { page: requestedPage, bbox, specId, quote } = customEvent.detail;

      if (!currentDocument) return;

      const documentId = currentDocument.getId();

      // Helper: normalize text so PDF-embedded characters match AI-extracted text.
      // PDFs commonly use smart quotes, ligatures, and en/em dashes that fail exact
      // substring matches against the cleaned-up text the AI returns.
      const normalizeForSearch = (s: string): string => {
        return s
          // Smart quotes → straight
          .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
          .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
          // Dashes → hyphen
          .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
          // Common ligatures → ASCII
          .replace(/\uFB00/g, "ff").replace(/\uFB01/g, "fi").replace(/\uFB02/g, "fl")
          .replace(/\uFB03/g, "ffi").replace(/\uFB04/g, "ffl")
          // Non-breaking and weird spaces → space
          .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, " ")
          // Soft hyphens (often used at line-wrap points) → drop
          .replace(/\u00AD/g, "")
          // Collapse whitespace
          .replace(/\s+/g, " ")
          .trim();
      };

      // Helper: use mupdf page.search() to find quote text and return PDF-coordinate quads
      const searchQuoteOnPage = (quoteText: string, targetPage: number): number[][] | null => {
        try {
          const mupdfDoc = currentDocument.getMupdfDocument();
          const pageCount = currentDocument.getPageCount();
          if (targetPage < 0 || targetPage >= pageCount) return null;

          const pageMetadata = currentDocument.getPageMetadata(targetPage);
          const pageHeight = pageMetadata?.height || 792;

          const normalized = normalizeForSearch(quoteText);
          if (!normalized) return null;

          // Build a robust list of search candidates. We try multiple positions and
          // strategies because PDF text extraction quirks (hyphenation across lines,
          // unusual encoding, table/column flow) often break exact substring matches.
          const candidates: string[] = [];
          const seen = new Set<string>();
          const pushCandidate = (c: string) => {
            const trimmed = c.trim();
            if (trimmed.length >= 8 && !seen.has(trimmed)) {
              seen.add(trimmed);
              candidates.push(trimmed);
            }
          };

          // 1. Full normalized quote
          pushCandidate(normalized);

          // 2. Progressively shorter snippets from the START (trim to word boundary)
          for (const len of [120, 80, 60, 40, 25]) {
            if (normalized.length > len) {
              const sub = normalized.slice(0, len);
              const lastSpace = sub.lastIndexOf(" ");
              pushCandidate(lastSpace > 10 ? sub.slice(0, lastSpace) : sub);
            }
          }

          // 3. Snippets from the MIDDLE — bypasses problem characters at the start
          if (normalized.length > 60) {
            const mid = Math.floor(normalized.length / 2);
            for (const halfLen of [30, 20]) {
              const start = Math.max(0, mid - halfLen);
              const end = Math.min(normalized.length, mid + halfLen);
              const sub = normalized.slice(start, end);
              // Trim to whole words
              const firstSpace = sub.indexOf(" ");
              const lastSpace = sub.lastIndexOf(" ");
              if (firstSpace >= 0 && lastSpace > firstSpace) {
                pushCandidate(sub.slice(firstSpace + 1, lastSpace));
              }
            }
          }

          // 4. Snippet from the END
          if (normalized.length > 40) {
            const sub = normalized.slice(-60);
            const firstSpace = sub.indexOf(" ");
            if (firstSpace >= 0) pushCandidate(sub.slice(firstSpace + 1));
          }

          // 5. Longest run of distinctive words (3+ char alphanumeric tokens).
          // This is robust against punctuation and most encoding mismatches.
          const words = normalized.split(/\s+/).filter((w) => /[A-Za-z0-9]{3,}/.test(w));
          for (const runLen of [8, 6, 5, 4, 3]) {
            if (words.length >= runLen) {
              // Try a few starting positions, not just 0
              for (const startIdx of [0, Math.floor(words.length / 4), Math.floor(words.length / 2)]) {
                if (startIdx + runLen <= words.length) {
                  pushCandidate(words.slice(startIdx, startIdx + runLen).join(" "));
                }
              }
            }
          }

          // 6. Distinctive single tokens — split into HIGH priority (numeric values
          // like "132.5", "8.5") and LOW priority (long words / capitalized words).
          // High-priority tokens are tried BEFORE multi-word phrases because in
          // tables the actual data values are what the user wants highlighted,
          // not the column header label. Multi-word phrases tend to match the
          // header cell ("Maximum Dry Density") instead of the data row ("132.5").
          // Low-priority tokens are tried AFTER multi-word as a final fallback.
          const highPriorityTokens: string[] = [];
          const lowPriorityTokens: string[] = [];
          const seenTokens = new Set<string>();
          const pushHighPriorityToken = (t: string) => {
            const trimmed = t.trim();
            if (trimmed.length >= 2 && !seenTokens.has(trimmed) && !seen.has(trimmed)) {
              seenTokens.add(trimmed);
              highPriorityTokens.push(trimmed);
            }
          };
          const pushLowPriorityToken = (t: string) => {
            const trimmed = t.trim();
            if (trimmed.length >= 3 && !seenTokens.has(trimmed) && !seen.has(trimmed)) {
              seenTokens.add(trimmed);
              lowPriorityTokens.push(trimmed);
            }
          };

          // Score every word in the original normalized string. Higher = more
          // distinctive (less likely to collide elsewhere on the page).
          const rawTokens = normalized.split(/\s+/);
          const scoredTokens: { token: string; score: number }[] = [];
          for (const raw of rawTokens) {
            // Strip leading/trailing punctuation but keep internal (12.5%, $1,500)
            const token = raw.replace(/^[^A-Za-z0-9$]+|[^A-Za-z0-9%]+$/g, "");
            if (token.length < 3) continue;
            let score = 0;
            if (/\d/.test(token)) score += 10; // Numbers are very distinctive
            if (/[%$]/.test(token)) score += 5; // Units make it more distinctive
            if (/[.,]\d/.test(token)) score += 5; // Decimals like "12.5"
            if (token.length >= 8) score += 4;
            else if (token.length >= 6) score += 2;
            if (/^[A-Z][a-z]/.test(token)) score += 2; // Capitalized
            if (/^[A-Z]{2,}/.test(token)) score += 3; // Acronyms / all caps
            // Penalize common stopwords
            if (/^(the|and|for|with|that|this|from|have|will|been|were|are|was|but|not|all|any|can|may|one|two|see|page|table|figure)$/i.test(token)) {
              score -= 10;
            }
            if (score > 0) scoredTokens.push({ token, score });
          }
          // Sort by score descending and split into priority tiers.
          // Score >= 10 means the token contains a digit (numeric value) — these
          // are extremely distinctive and unlikely to false-match elsewhere on
          // the page. They go in the HIGH priority list and are tried first.
          scoredTokens.sort((a, b) => b.score - a.score);
          for (const { token, score } of scoredTokens.slice(0, 8)) {
            if (score >= 10) {
              pushHighPriorityToken(token);
            } else {
              pushLowPriorityToken(token);
            }
          }

          const mupdfPage = mupdfDoc.loadPage(targetPage);
          // Priority order:
          //   1. Highly-distinctive numeric tokens (e.g. "132.5", "8.5")
          //   2. Multi-word phrases
          //   3. Lower-priority single tokens
          const allCandidates = [...highPriorityTokens, ...candidates, ...lowPriorityTokens];

          // Collect ALL matches across ALL candidates, then pick the location
          // with the densest cluster of distinct-needle matches. This avoids
          // returning the FIRST occurrence of a generic word ("Moisture") when
          // the AI quote includes other words/numbers that, taken together,
          // pinpoint a specific cell. The "right" cell is wherever multiple
          // distinct quote tokens cluster together.
          type Match = { needle: string; rawQuad: number[]; centerX: number; centerY: number };
          const allFoundMatches: Match[] = [];
          const pushFlatQuad = (needle: string, q: any) => {
            if (q == null || typeof q.length !== "number" || q.length < 8) return;
            if (typeof q[0] !== "number") return;
            const raw = [q[0], q[1], q[2], q[3], q[4], q[5], q[6], q[7]];
            const centerX = (raw[0] + raw[2] + raw[4] + raw[6]) / 4;
            const centerY = (raw[1] + raw[3] + raw[5] + raw[7]) / 4;
            allFoundMatches.push({ needle, rawQuad: raw, centerX, centerY });
          };

          for (const candidate of allCandidates) {
            try {
              const results = mupdfPage.search(candidate, 10);
              if (!results) continue;
              for (const entry of results) {
                const isArrayLike = entry != null && typeof (entry as any).length === "number" && typeof entry !== "string";
                if (!isArrayLike) continue;
                if (typeof (entry as any)[0] === "number") {
                  pushFlatQuad(candidate, entry);
                } else {
                  for (const q of entry as any) pushFlatQuad(candidate, q);
                }
              }
            } catch {
              continue;
            }
          }

          if (allFoundMatches.length > 0) {
            // Convert raw display-coord quad to PDF-coord quad
            const toPdfQuad = (raw: number[]) => [
              raw[0], pageHeight - raw[1],
              raw[2], pageHeight - raw[3],
              raw[4], pageHeight - raw[5],
              raw[6], pageHeight - raw[7],
            ];

            if (allFoundMatches.length === 1) {
              return [toPdfQuad(allFoundMatches[0].rawQuad)];
            }

            // Score each match by proximity to OTHER matches with DIFFERENT needles.
            // A match that's near 2+ other distinct quote tokens is almost
            // certainly the right cell. A lone match of a generic word is not.
            const PROXIMITY_RADIUS = 250; // PDF units (~3.5 inches)
            let bestMatch = allFoundMatches[0];
            let bestScore = -1;
            // Tiebreaker: prefer high-priority tokens over low-priority ones
            // when scores are equal. Build a priority lookup.
            const needlePriority = new Map<string, number>();
            for (const t of highPriorityTokens) needlePriority.set(t, 3);
            for (const c of candidates) needlePriority.set(c, 2);
            for (const t of lowPriorityTokens) needlePriority.set(t, 1);

            for (const m of allFoundMatches) {
              let score = 0;
              const seenOtherNeedles = new Set<string>();
              for (const other of allFoundMatches) {
                if (other === m) continue;
                if (other.needle === m.needle) continue;
                const dx = other.centerX - m.centerX;
                const dy = other.centerY - m.centerY;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < PROXIMITY_RADIUS) {
                  // Closer = higher score; cap one match per other-needle
                  if (!seenOtherNeedles.has(other.needle)) {
                    seenOtherNeedles.add(other.needle);
                    score += 1 - (dist / PROXIMITY_RADIUS);
                  }
                }
              }
              // Add own priority as a small tiebreaker so high-priority tokens
              // win when nothing clusters
              const ownPriority = needlePriority.get(m.needle) ?? 0;
              const finalScore = score * 100 + ownPriority;
              if (finalScore > bestScore) {
                bestScore = finalScore;
                bestMatch = m;
              }
            }

            // Return all quads from the WINNING needle that are near the best match,
            // so the highlight covers the cluster, not just one word.
            const winningQuads: number[][] = [toPdfQuad(bestMatch.rawQuad)];
            for (const m of allFoundMatches) {
              if (m === bestMatch) continue;
              const dx = m.centerX - bestMatch.centerX;
              const dy = m.centerY - bestMatch.centerY;
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist < PROXIMITY_RADIUS && m.needle !== bestMatch.needle) {
                winningQuads.push(toPdfQuad(m.rawQuad));
              }
            }
            return winningQuads;
          }

          // Final fallback: walk structured text line-by-line. mupdf's page.search()
          // requires the search string to appear as a contiguous substring in the
          // PDF's text stream — which fails for tables, callout boxes, and any
          // multi-column layout where cells extract as separate text blocks. By
          // walking individual lines we can match text within each cell directly.
          try {
            const structuredText = mupdfPage.toStructuredText("preserve-whitespace");
            const jsonRaw = structuredText.asJSON();
            const jsonData = typeof jsonRaw === "string" ? JSON.parse(jsonRaw) : jsonRaw;
            const blocks: any[] = Array.isArray(jsonData?.blocks)
              ? jsonData.blocks
              : Array.isArray(jsonData)
                ? jsonData
                : [];

            // Collect all (text, bbox) pairs from every line in every block
            type Line = { text: string; normalized: string; bbox: [number, number, number, number] };
            const lines: Line[] = [];
            const flipBboxY = (x0: number, y0: number, x1: number, y1: number): [number, number, number, number] => {
              return [x0, pageHeight - y1, x1, pageHeight - y0];
            };
            const extractBbox = (bb: any): [number, number, number, number] | null => {
              if (!bb) return null;
              if (Array.isArray(bb) && bb.length >= 4) {
                return flipBboxY(bb[0], bb[1], bb[2], bb[3]);
              }
              if (typeof bb === "object" && "x" in bb && "y" in bb) {
                return flipBboxY(bb.x, bb.y, bb.x + (bb.w ?? 0), bb.y + (bb.h ?? 0));
              }
              return null;
            };

            const collectLine = (text: string, bb: any) => {
              if (!text || typeof text !== "string") return;
              const bbox = extractBbox(bb);
              if (!bbox) return;
              const norm = normalizeForSearch(text).toLowerCase();
              if (norm.length < 2) return;
              lines.push({ text, normalized: norm, bbox });
            };

            for (const block of blocks) {
              if (block?.type !== "text" && block?.type !== "paragraph") continue;
              if (!Array.isArray(block.lines)) continue;
              for (const line of block.lines) {
                if (!line) continue;
                if (line.text) {
                  collectLine(line.text, line.bbox);
                }
                // Some PDFs nest text in spans
                if (Array.isArray(line.spans)) {
                  for (const span of line.spans) {
                    if (span?.text) collectLine(span.text, span.bbox ?? line.bbox);
                  }
                }
              }
            }

            if (lines.length === 0) return null;

            // Build search needles in priority order. Lowercase to match line normalization.
            const normalizedLower = normalized.toLowerCase();
            const needles: string[] = [];
            const seenNeedles = new Set<string>();
            const addNeedle = (n: string) => {
              const t = n.trim().toLowerCase();
              if (t.length >= 3 && !seenNeedles.has(t)) {
                seenNeedles.add(t);
                needles.push(t);
              }
            };

            // Highly-distinctive numeric tokens first (table values), then
            // multi-word phrases, then lower-priority single tokens.
            for (const c of highPriorityTokens) addNeedle(c);
            for (const c of candidates) addNeedle(c);
            for (const c of lowPriorityTokens) addNeedle(c);
            // Plus a few additional substrings of the full quote
            for (const len of [25, 18, 12]) {
              if (normalizedLower.length > len) {
                addNeedle(normalizedLower.slice(0, len));
                if (normalizedLower.length > len * 2) {
                  addNeedle(normalizedLower.slice(Math.floor(normalizedLower.length / 2) - Math.floor(len / 2), Math.floor(normalizedLower.length / 2) + Math.ceil(len / 2)));
                }
              }
            }

            // Match needles against lines. For each needle, collect all lines that contain it.
            // Stop at the first needle that produces matches (most precise hits).
            const matchedBboxes: [number, number, number, number][] = [];
            for (const needle of needles) {
              for (const line of lines) {
                if (line.normalized.includes(needle)) {
                  matchedBboxes.push(line.bbox);
                  if (matchedBboxes.length >= 6) break; // cap to avoid runaway highlights
                }
              }
              if (matchedBboxes.length > 0) break;
            }

            if (matchedBboxes.length === 0) {
              return null;
            }

            // Convert matched line bboxes to quads (already in PDF coords from flipBboxY)
            const quads = matchedBboxes.map(([x0, y0, x1, y1]) => [
              x0, y1, x1, y1, x1, y0, x0, y0, // top-left, top-right, bottom-right, bottom-left
            ]);
            return quads;
          } catch (e) {
            console.warn("Scroll-to-spec: structured-text fallback failed", e);
            return null;
          }
        } catch (e) {
          console.warn("Scroll-to-spec: quote text search failed", e);
          return null;
        }
      };

      // Search for quote text — try target page first, then nearby pages (±3) since AI page numbers can be off
      const searchQuoteNearby = (quoteText: string, targetPage: number): { quads: number[][]; foundPage: number } | null => {
        const direct = searchQuoteOnPage(quoteText, targetPage);
        if (direct) return { quads: direct, foundPage: targetPage };
        const pageCount = currentDocument.getPageCount();
        for (const offset of [1, -1, 2, -2, 3, -3]) {
          const p = targetPage + offset;
          if (p >= 0 && p < pageCount) {
            const result = searchQuoteOnPage(quoteText, p);
            if (result) return { quads: result, foundPage: p };
          }
        }
        return null;
      };

      // When quote text is provided, find the actual page by text search BEFORE scrolling
      // This corrects wrong page numbers from AI extraction
      let page = requestedPage;
      let precomputedQuoteQuads: number[][] | null = null;
      if (quote) {
        const found = searchQuoteNearby(quote, requestedPage);
        if (found) {
          page = found.foundPage;
          precomputedQuoteQuads = found.quads;
          if (page !== requestedPage) {
            console.log("[nanodoc] quote found on different page:", { requested: requestedPage, actual: page });
          }
        }
      }

      // Pre-warm render cache for the target page so it appears quickly when we scroll.
      // We intentionally DO NOT pre-warm neighbors, and we render at displayScale only
      // (no quality multiplier, no DPR multiplier) to keep WASM heap pressure low.
      // The main PageCanvas render path will upgrade to full-quality after scroll lands.
      // Pre-warming the full neighbor window at quality*dpr previously caused mupdf
      // malloc failures in split-screen when hyperlinks were clicked rapidly, because
      // each goto-page queued 5 × 30-60 MB allocations into a fixed-size WASM heap.
      if (renderer && currentDocument.isDocumentLoaded()) {
        const firstMeta = currentDocument.getPageMetadata(0);
        if (firstMeta && baseFitScale > 0 && zoomLevel > 0) {
          const zoomFactor = zoomLevel / baseFitScale;
          const viewportWidth = firstMeta.width * baseFitScale * zoomFactor;
          const mupdfDoc = currentDocument.getMupdfDocument();
          const pageCount = currentDocument.getPageCount();
          if (page >= 0 && page < pageCount) {
            const pageMeta = currentDocument.getPageMetadata(page);
            if (pageMeta) {
              const displayScale = viewportWidth / pageMeta.width;
              renderer.renderPage(mupdfDoc, page, { scale: displayScale, rotation: 0 }, currentDocument.getPdfData?.(), currentDocument.getId?.());
            }
          }
        }
      }
      
      // When we have a specific specId, set it now so bbox is emphasized during scroll
      if (specId) {
        setSelectedSpec(documentId, specId);
      } else {
        setSelectedSpec(documentId, null);
      }
      
      // For page-only (e.g. CTO table): we'll set selected spec + temporary text highlight after scroll
      const allHighlights = getSpecHighlights(documentId);
      const forPage = allHighlights.filter((h) => h.page === page);
      const forAdjacent = allHighlights.filter((h) => h.page === page - 1 || h.page === page + 1);
      const pageHighlights = !specId && (forPage.length > 0 ? forPage : forAdjacent);
      const firstHighlight = Array.isArray(pageHighlights) && pageHighlights.length > 0 ? pageHighlights[0] : null;

      // Helper: schedule a single highlight-clear timer, cancelling any previous
      // one. This prevents multiple goto-page events from setting up overlapping
      // clear timers that prematurely wipe out the highlight.
      const HIGHLIGHT_DURATION_MS = 30_000;
      const scheduleHighlightClear = () => {
        if (temporaryHighlightTimerRef.current) {
          clearTimeout(temporaryHighlightTimerRef.current);
        }
        temporaryHighlightTimerRef.current = setTimeout(() => {
          setTemporaryHighlight(null);
          temporaryHighlightTimerRef.current = null;
        }, HIGHLIGHT_DURATION_MS);
      };

      const applyTemporaryHighlight = () => {
        // When quote quads were precomputed (from the text search before scrolling), use them directly
        if (precomputedQuoteQuads && precomputedQuoteQuads.length > 0) {
          setTemporaryHighlight({ page, quads: precomputedQuoteQuads, color: "#fbbf24", specId: "_quote" });
          scheduleHighlightClear();
          return;
        }
        // If the citation provided a quote but we couldn't find it on the page,
        // skip the page-strip fallback below — drawing a top-strip would clobber
        // a successful precomputed-quad highlight set by an earlier event in the
        // same click (CTO split-view fires 2-3 goto-page events per click).
        if (quote) {
          return;
        }

        if (firstHighlight) {
          setSelectedSpec(documentId, firstHighlight.specId);
          const [x0, y0, x1, y1] = firstHighlight.bbox;
          const color = firstHighlight.color || "#fbbf24";
          let quadsToUse: number[][] | null = null;
          try {
            const mupdfDoc = currentDocument.getMupdfDocument();
            const mupdfPage = mupdfDoc.loadPage(firstHighlight.page);
            const pageMetadata = currentDocument.getPageMetadata(firstHighlight.page);
            const pageHeight = pageMetadata?.height || 792;
            const displayMinY = pageHeight - y1;
            const displayMaxY = pageHeight - y0;
            const p = [x0, displayMinY];
            const q = [x1, displayMaxY];
            const structuredText = mupdfPage.toStructuredText("preserve-whitespace");
            let quads = structuredText.highlight(p, q);
            if (!quads || quads.length === 0) {
              const expandedP = [x0 - 2, displayMinY - 2];
              const expandedQ = [x1 + 2, displayMaxY + 2];
              quads = structuredText.highlight(expandedP, expandedQ);
            }
            if (quads && quads.length > 0) {
              quadsToUse = quads.map((quad: any) => {
                let rawQuad: number[];
                if (Array.isArray(quad) && quad.length >= 8) {
                  rawQuad = quad;
                } else {
                  rawQuad = [quad.x0 || 0, quad.y0 || 0, quad.x1 || 0, quad.y1 || 0, quad.x2 || 0, quad.y2 || 0, quad.x3 || 0, quad.y3 || 0];
                }
                return [
                  rawQuad[0], pageHeight - rawQuad[1],
                  rawQuad[2], pageHeight - rawQuad[3],
                  rawQuad[4], pageHeight - rawQuad[5],
                  rawQuad[6], pageHeight - rawQuad[7],
                ];
              });
            }
          } catch (e) {
            console.warn("Scroll-to-spec: text quads from mupdf failed", e);
          }
          if (!quadsToUse || quadsToUse.length === 0) {
            const bboxMinX = Math.min(x0, x1);
            const bboxMaxX = Math.max(x0, x1);
            const bboxMinY = Math.min(y0, y1);
            const bboxMaxY = Math.max(y0, y1);
            const bboxQuad = [bboxMinX, bboxMinY, bboxMaxX, bboxMinY, bboxMaxX, bboxMaxY, bboxMinX, bboxMaxY];
            quadsToUse = [bboxQuad];
          }
          setTemporaryHighlight({ page: firstHighlight.page, quads: quadsToUse, color, specId: firstHighlight.specId });
          scheduleHighlightClear();
          return;
        }
        // Fallback only when there is no spec data or quote match for this page at all
        try {
          const pageMetadata = currentDocument.getPageMetadata(page);
          if (pageMetadata) {
            const w = pageMetadata.width || 612;
            const h = pageMetadata.height || 792;
            const topStrip = Math.min(120, h * 0.2);
            const quad = [0, h - topStrip, w, h - topStrip, w, h, 0, h];
            setTemporaryHighlight({ page, quads: [quad], color: "#fbbf24", specId: "_page" });
            scheduleHighlightClear();
          }
        } catch (e) {
          console.warn("Scroll-to-spec: could not set page fallback highlight", e);
        }
      };
      
      // Compute a scroll-target bbox from the precomputed quote quads so the
      // viewer scrolls to the actual highlight location instead of the top of
      // the page. The first quad is the primary match.
      // Quads are stored in PDF coordinates [x0, y0, x1, y1, x2, y2, x3, y3]
      // where Y=0 is at the bottom.
      let scrollBbox: number[] | undefined = bbox;
      if (!scrollBbox && precomputedQuoteQuads && precomputedQuoteQuads.length > 0) {
        const q = precomputedQuoteQuads[0];
        if (q && q.length >= 8) {
          const xs = [q[0], q[2], q[4], q[6]];
          const ys = [q[1], q[3], q[5], q[7]];
          scrollBbox = [
            Math.min(...xs),
            Math.min(...ys),
            Math.max(...xs),
            Math.max(...ys),
          ];
        }
      }

      // Helper function to perform the scroll
      const performScroll = () => {
        // CRITICAL: pre-set previousPageRef to the new page BEFORE setCurrentPage
        // so the "external page change" effect (line ~1227) bails out at its
        // `previousPageRef.current === currentPage` guard. Also stamp the
        // scroll-to-spec timestamp so that effect (which has many deps and may
        // re-run after baseFitScale/fitMode/zoomLevel change) bails on its
        // secondary check too — otherwise it would call scrollToPage WITHOUT a
        // bbox and override our bbox-targeted scroll back to top-of-page.
        previousPageRef.current = page;
        lastScrollToSpecAtRef.current = Date.now();
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
                    scrollToPage(page, true, scrollBbox);
                    if (!specId || precomputedQuoteQuads) setTimeout(applyTemporaryHighlight, 280);
                  });
                } else {
                  scrollToPage(page, true, scrollBbox);
                  if (!specId || precomputedQuoteQuads) setTimeout(applyTemporaryHighlight, 280);
                }
              } else {
                scrollToPage(page, true, scrollBbox);
                if (!specId || precomputedQuoteQuads) setTimeout(applyTemporaryHighlight, 280);
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
  }, [currentDocument, readMode, setCurrentPage, scrollToPage, toggleReadMode, setSelectedSpec, getSpecHighlights, setTemporaryHighlight, baseFitScale, renderer, zoomLevel]);

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

  // Handle wheel zoom in read mode at container level.
  // Throttles zoomToPoint calls (same path as +/- buttons) via requestAnimationFrame
  // so each zoom step is perfectly positioned with zero drift.
  const pendingZoomRef = useRef<number | null>(null);
  const pendingZoomAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const zoomRAFRef = useRef<number | null>(null);

  useEffect(() => {
    if (!readMode || !scrollContainerRef.current) return;

    const container = scrollContainerRef.current;

    const handleWheelNative = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();

      const currentZoom = zoomLevelRef.current;
      const delta = e.deltaY > 0 ? 0.94 : 1.06;
      const newZoom = Math.max(0.25, Math.min(5, currentZoom * delta));
      if (Math.abs(newZoom - currentZoom) < 0.001) return;

      // Accumulate zoom target AND latest mouse position for zoom-at-cursor.
      pendingZoomRef.current = newZoom;
      pendingZoomAnchorRef.current = { x: e.clientX, y: e.clientY };

      // Throttle via rAF — at most one zoomToPoint per frame.
      // Each call uses the exact same code path as the +/- buttons.
      if (zoomRAFRef.current === null) {
        zoomRAFRef.current = requestAnimationFrame(() => {
          zoomRAFRef.current = null;
          const targetZoom = pendingZoomRef.current;
          if (targetZoom === null) return;
          pendingZoomRef.current = null;
          const anchor = pendingZoomAnchorRef.current;
          pendingZoomAnchorRef.current = null;

          if (anchor) {
            zoomToPoint(targetZoom, anchor.x, anchor.y);
          } else {
            const rect = container.getBoundingClientRect();
            zoomToPoint(
              targetZoom,
              rect.left + container.clientWidth / 2,
              rect.top + container.clientHeight / 2,
            );
          }
        });
      }
    };

    container.addEventListener("wheel", handleWheelNative, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheelNative);
      if (zoomRAFRef.current !== null) cancelAnimationFrame(zoomRAFRef.current);
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

    // Don't override an in-flight scroll-to-spec scroll. The handler at
    // handleScrollToSpec sets lastScrollToSpecAtRef before calling
    // setCurrentPage; this effect's `scrollToPage(currentPage, true)` (no
    // bbox) would otherwise reset the scroll back to top-of-page.
    if (Date.now() - lastScrollToSpecAtRef.current < 4000) {
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

  const handleRotatePages = async (pageNumbers: number[], rotationDegrees: number) => {
    if (!currentDocument || pageNumbers.length === 0) return;
    try {
      const mupdfModule = await import("mupdf");
      const editor = new PDFEditor(mupdfModule.default);
      const documentId = currentDocument.getId();
      await wrapPageOperation(
        async () => {
          for (const pageNum of pageNumbers) {
            await editor.rotatePage(currentDocument, pageNum, rotationDegrees);
          }
          currentDocument.refreshPageMetadata();
          await new Promise((resolve) => setTimeout(resolve, 50));
          currentDocument.refreshPageMetadata();
        },
        "rotatePages",
        documentId,
        pageNumbers
      );
      if (renderer) renderer.clearCache();
      const tab = useTabStore.getState().getTabByDocumentId(documentId);
      if (tab) useTabStore.getState().setTabModified(tab.id, true);
      showNotification(`Rotated ${pageNumbers.length} page${pageNumbers.length > 1 ? "s" : ""}`);
    } catch (error) {
      console.error("Error rotating pages:", error);
      showNotification("Failed to rotate pages", "error");
    }
  };

  const handleHorizontalFlipPages = async (pageNumbers: number[]) => {
    if (!currentDocument || pageNumbers.length === 0) return;
    try {
      const mupdfModule = await import("mupdf");
      const editor = new PDFEditor(mupdfModule.default);
      const documentId = currentDocument.getId();
      const pdfStore = usePDFStore.getState();
      await wrapPageOperation(
        async () => {
          for (const pageNum of pageNumbers) {
            pdfStore.togglePageHorizontalFlip(documentId, pageNum);
            await editor.flipPageHorizontal(currentDocument, pageNum);
          }
        },
        "rotatePages",
        documentId,
        pageNumbers
      );
      if (renderer) renderer.clearCache();
      const tab = useTabStore.getState().getTabByDocumentId(documentId);
      if (tab) useTabStore.getState().setTabModified(tab.id, true);
      showNotification(`Flipped ${pageNumbers.length} page${pageNumbers.length > 1 ? "s" : ""} horizontally`);
    } catch (error) {
      console.error("Error flipping pages:", error);
      showNotification("Failed to flip pages", "error");
    }
  };

  const handleConfirmRotate = () => {
    let pagesToRotateFinal: number[] = [];
    if (applyToRange && currentDocument) {
      const start = Math.min(rangeStart, rangeEnd);
      const end = Math.max(rangeStart, rangeEnd);
      pagesToRotateFinal = Array.from({ length: end - start + 1 }, (_, i) => start + i);
    } else {
      pagesToRotateFinal = pagesToRotate;
    }
    if (rotationType === "horizontal") {
      handleHorizontalFlipPages(pagesToRotateFinal);
    } else {
      // UI degrees: clockwise 90, counterclockwise 270, vertical = 180° rotation
      const rotationMap: Record<"clockwise" | "counterclockwise" | "vertical", number> = {
        clockwise: 90,
        counterclockwise: 270,
        vertical: 180,
      };
      const degrees = rotationMap[rotationType];
      handleRotatePages(pagesToRotateFinal, degrees);
    }
    setShowRotateDialog(false);
    setPagesToRotate([]);
  };

  const openRotateDialog = () => {
    if (!currentDocument || pageCount === 0) return;
    setPagesToRotate([currentPage]);
    setRangeStart(currentPage);
    setRangeEnd(currentPage);
    setApplyToRange(false);
    setRotationType("clockwise");
    setShowRotateDialog(true);
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

  // Resolve selected annotation for properties panel
  const selectedAnnotation: Annotation | null = (() => {
    if (!selectedAnnotationId || !currentDocument) return null;
    const anns = getAnnotations(currentDocument.getId());
    return anns.find((a) => a.id === selectedAnnotationId) ?? null;
  })();

  const propertyLabel = (() => {
    if (!selectedAnnotation) return "Properties";
    if (selectedAnnotation.type === "formField") {
      const labels: Record<string, string> = {
        text: "Text Field", number: "Number Field", email: "Email Field",
        checkbox: "Checkbox", radio: "Radio Button", dropdown: "Dropdown",
        listbox: "List Box", date: "Date Picker", signature: "Signature",
      };
      const name = selectedAnnotation.fieldName || selectedAnnotation.fieldLabel;
      const typeLabel = labels[selectedAnnotation.fieldType || "text"] || "Form Field";
      return name ? `${typeLabel}: ${name}` : typeLabel;
    }
    const typeLabels: Record<string, string> = {
      text: "Text Box", highlight: "Highlight", note: "Note", callout: "Callout",
      redact: "Redaction", image: "Image", draw: "Drawing", shape: "Shape",
      stamp: "Stamp", signatureField: "Signature",
    };
    return typeLabels[selectedAnnotation.type] ?? "Properties";
  })();

  return (
    <div className="flex flex-col h-full w-full min-h-0">
      {/* Page Canvas - Full Height */}
      {/* Cache both views for fast switching - both stay mounted but only one is visible */}
      <div className="flex-1 min-h-0 relative">
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
                bufferPages={(() => {
                  // Buffer pages stay mounted so scrolling back is instant (cache hit).
                  // Worker renders off-thread so more mounted pages don't block the UI.
                  const meta = currentDocument.getPageMetadata(0);
                  if (!meta) return 6;
                  const pageArea = meta.width * meta.height;
                  const letterArea = 612 * 792;
                  if (pageArea > letterArea * 4) return 3; // Large plans (24x36"+)
                  if (pageArea > letterArea * 2) return 4; // Tabloid+
                  return 6; // Normal documents
                })()}
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
      
      {/* Properties panel - expands upward from bottom bar */}
      {showProperties && currentDocument && (
        <div className="relative z-10 flex-shrink-0 border-t border-border bg-background px-3 py-2 text-xs">
          {!selectedAnnotation ? (
            <div className="text-muted-foreground text-center py-1">Select an annotation to view properties</div>
          ) : selectedAnnotation.type === "formField" ? (
            <FormFieldProperties annotation={selectedAnnotation} onUpdate={(updates) => updateAnnotation(currentDocument!.getId(), selectedAnnotation.id, updates)} allAnnotations={getAnnotations(currentDocument!.getId())} />
          ) : (
            <AnnotationProperties annotation={selectedAnnotation} />
          )}
        </div>
      )}

      {/* Bottom toolbar: always show; z-10 so it stays above PDF content and is clickable */}
      <div className="relative z-10 flex flex-shrink-0 items-center justify-between border-t bg-background px-2 py-1.5">
        <div className="flex items-center gap-1">
          {!readMode && !splitScreenMode && <PageTools />}
          {!readMode && !splitScreenMode && <div className="h-4 w-px bg-border mx-0.5" />}
          <Button
            variant="outline"
            size="icon"
            className="h-7 w-7"
            onClick={handlePreviousPage}
            disabled={!canGoPrevious}
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
            disabled={!canGoNext}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          <div className="h-4 w-px bg-border mx-0.5" />
          <Button
            variant={showProperties ? "default" : "outline"}
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => setShowProperties((v) => !v)}
            title={showProperties ? "Hide properties" : "Show properties"}
            disabled={!currentDocument}
          >
            <PanelBottomOpen className="h-3.5 w-3.5" />
            <span className="truncate max-w-[160px]">{propertyLabel}</span>
          </Button>
        </div>
        
        <div className="flex items-center gap-1">
          {!readMode && !splitScreenMode && (
            <>
              <Button
                variant="outline"
                size="icon"
                className="h-7 w-7"
                onClick={openRotateDialog}
                disabled={!currentDocument || pageCount === 0}
                title="Rotate page"
              >
                <RotateCw className="h-3.5 w-3.5" />
              </Button>
              <div className="h-5 w-px bg-border mx-0.5" />
            </>
          )}
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
          
          {!splitScreenMode && (
            <>
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
            </>
          )}
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

      {/* Rotate Page Dialog */}
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
            <div className="space-y-3">
              <Label className="text-sm font-medium">Select Rotation</Label>
              <div className="grid grid-cols-2 gap-3">
                <div
                  onClick={() => setRotationType("clockwise")}
                  className={cn(
                    "relative p-4 border-2 rounded-lg cursor-pointer transition-all hover:border-primary/50",
                    rotationType === "clockwise" ? "border-primary bg-primary/5" : "border-border"
                  )}
                >
                  <div className="flex flex-col items-center space-y-2">
                    <div className={cn("p-2 rounded-full transition-colors", rotationType === "clockwise" ? "bg-primary/10" : "bg-muted")}>
                      <RotateCw className={cn("h-6 w-6 transition-colors", rotationType === "clockwise" ? "text-primary" : "text-muted-foreground")} />
                    </div>
                    <div className="text-center">
                      <div className="text-sm font-medium">Clockwise</div>
                      <div className="text-xs text-muted-foreground">90°</div>
                    </div>
                  </div>
                  {rotationType === "clockwise" && <div className="absolute top-2 right-2 h-2 w-2 rounded-full bg-primary" />}
                </div>
                <div
                  onClick={() => setRotationType("counterclockwise")}
                  className={cn(
                    "relative p-4 border-2 rounded-lg cursor-pointer transition-all hover:border-primary/50",
                    rotationType === "counterclockwise" ? "border-primary bg-primary/5" : "border-border"
                  )}
                >
                  <div className="flex flex-col items-center space-y-2">
                    <div className={cn("p-2 rounded-full transition-colors", rotationType === "counterclockwise" ? "bg-primary/10" : "bg-muted")}>
                      <RotateCw className={cn("h-6 w-6 rotate-180 transition-colors", rotationType === "counterclockwise" ? "text-primary" : "text-muted-foreground")} />
                    </div>
                    <div className="text-center">
                      <div className="text-sm font-medium">Counter-clockwise</div>
                      <div className="text-xs text-muted-foreground">90°</div>
                    </div>
                  </div>
                  {rotationType === "counterclockwise" && <div className="absolute top-2 right-2 h-2 w-2 rounded-full bg-primary" />}
                </div>
                <div
                  onClick={() => setRotationType("vertical")}
                  className={cn(
                    "relative p-4 border-2 rounded-lg cursor-pointer transition-all hover:border-primary/50",
                    rotationType === "vertical" ? "border-primary bg-primary/5" : "border-border"
                  )}
                >
                  <div className="flex flex-col items-center space-y-2">
                    <div className={cn("p-2 rounded-full transition-colors", rotationType === "vertical" ? "bg-primary/10" : "bg-muted")}>
                      <FlipVertical className={cn("h-6 w-6 transition-colors", rotationType === "vertical" ? "text-primary" : "text-muted-foreground")} />
                    </div>
                    <div className="text-center">
                      <div className="text-sm font-medium">Vertical Flip</div>
                      <div className="text-xs text-muted-foreground">180°</div>
                    </div>
                  </div>
                  {rotationType === "vertical" && <div className="absolute top-2 right-2 h-2 w-2 rounded-full bg-primary" />}
                </div>
                <div
                  onClick={() => setRotationType("horizontal")}
                  className={cn(
                    "relative p-4 border-2 rounded-lg cursor-pointer transition-all hover:border-primary/50",
                    rotationType === "horizontal" ? "border-primary bg-primary/5" : "border-border"
                  )}
                >
                  <div className="flex flex-col items-center space-y-2">
                    <div className={cn("p-2 rounded-full transition-colors", rotationType === "horizontal" ? "bg-primary/10" : "bg-muted")}>
                      <FlipHorizontal className={cn("h-6 w-6 transition-colors", rotationType === "horizontal" ? "text-primary" : "text-muted-foreground")} />
                    </div>
                    <div className="text-center">
                      <div className="text-sm font-medium">Horizontal Flip</div>
                      <div className="text-xs text-muted-foreground">180°</div>
                    </div>
                  </div>
                  {rotationType === "horizontal" && <div className="absolute top-2 right-2 h-2 w-2 rounded-full bg-primary" />}
                </div>
              </div>
            </div>
            <div className="space-y-3 border-t pt-4">
              <div className="flex items-center space-x-3">
                <input
                  type="checkbox"
                  id="applyToRangeViewer"
                  checked={applyToRange}
                  onChange={(e) => setApplyToRange(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                />
                <Label htmlFor="applyToRangeViewer" className="text-sm font-medium cursor-pointer">
                  Apply to range of pages
                </Label>
              </div>
              {applyToRange && currentDocument && (
                <div className="grid grid-cols-2 gap-3 ml-7">
                  <div className="space-y-1.5">
                    <Label htmlFor="rangeStartViewer" className="text-xs font-medium text-muted-foreground">From Page</Label>
                    <Input
                      id="rangeStartViewer"
                      type="number"
                      min={1}
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
                    <Label htmlFor="rangeEndViewer" className="text-xs font-medium text-muted-foreground">To Page</Label>
                    <Input
                      id="rangeEndViewer"
                      type="number"
                      min={1}
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

      {/* Document Settings Dialog */}
      <DocumentSettingsDialog
        open={showDocumentSettings}
        onOpenChange={setShowDocumentSettings}
        document={currentDocument}
        currentPage={currentPage}
        onApply={handleApplyDocumentSettings}
      />

      {/* Status Bar */}
      {currentDocument && <StatusBar />}

      {/* Spec Extraction Panel */}
      {currentDocument && <SpecExtractionPanel />}

      {/* Question Answer Panel */}
      {currentDocument && <QuestionAnswerPanel />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline property components for the bottom-bar expansion
// ---------------------------------------------------------------------------

function AnnotationProperties({ annotation }: { annotation: Annotation }) {
  const x = Math.round(annotation.x);
  const y = Math.round(annotation.y);
  const w = annotation.width != null ? Math.round(annotation.width) : null;
  const h = annotation.height != null ? Math.round(annotation.height) : null;
  const typeLabels: Record<string, string> = {
    text: "Text Box", highlight: "Highlight", note: "Note", callout: "Callout",
    redact: "Redaction", image: "Image", draw: "Drawing", shape: "Shape",
    stamp: "Stamp", signatureField: "Signature",
  };
  return (
    <div className="flex items-center gap-4 text-muted-foreground">
      <span className="font-medium text-foreground">{typeLabels[annotation.type] ?? annotation.type}</span>
      <span>Page {annotation.pageNumber + 1}</span>
      <span>Pos: {x}, {y}</span>
      {w != null && h != null && <span>Size: {w} &times; {h}</span>}
    </div>
  );
}

function FormFieldProperties({ annotation, onUpdate, allAnnotations }: { annotation: Annotation; onUpdate: (u: Partial<Annotation>) => void; allAnnotations: Annotation[] }) {
  const radioGroups = Array.from(new Set(
    allAnnotations.filter((a) => a.type === "formField" && a.fieldType === "radio" && a.radioGroup).map((a) => a.radioGroup!)
  ));

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {/* Layout info */}
      <span className="text-muted-foreground">
        Page {annotation.pageNumber + 1} &middot; {Math.round(annotation.x)}, {Math.round(annotation.y)}
        {annotation.width != null && annotation.height != null && ` \u00b7 ${Math.round(annotation.width)}\u00d7${Math.round(annotation.height)}`}
      </span>

      {/* Identity */}
      <PropInput label="Name" value={annotation.fieldName || ""} onChange={(v) => onUpdate({ fieldName: v })} placeholder="field_name" />
      <PropInput label="Label" value={annotation.fieldLabel || ""} onChange={(v) => onUpdate({ fieldLabel: v })} placeholder="Label" />
      <PropInput label="Tooltip" value={annotation.tooltip || ""} onChange={(v) => onUpdate({ tooltip: v })} placeholder="Hover text" />

      {/* Toggles */}
      <PropToggle label="Required" checked={!!annotation.required} onChange={(v) => onUpdate({ required: v })} />
      <PropToggle label="Read Only" checked={!!annotation.readOnly} onChange={(v) => onUpdate({ readOnly: v })} />
      <PropToggle label="Locked" checked={!!annotation.locked} onChange={(v) => onUpdate({ locked: v })} />

      {/* Text-specific */}
      {(annotation.fieldType === "text" || annotation.fieldType === "number" || annotation.fieldType === "email") && (
        <>
          <PropInput label="Placeholder" value={annotation.placeholder || ""} onChange={(v) => onUpdate({ placeholder: v })} placeholder="Placeholder" />
          {annotation.fieldType === "text" && (
            <PropToggle label="Multiline" checked={!!annotation.multiline} onChange={(v) => onUpdate({ multiline: v })} />
          )}
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Max:</span>
            <input type="number" value={annotation.maxLength || ""} onChange={(e) => onUpdate({ maxLength: e.target.value ? parseInt(e.target.value) : undefined })} className="w-12 px-1 py-0.5 text-xs border rounded bg-background" placeholder="–" min={0} />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Align:</span>
            <select value={annotation.textAlignment || "left"} onChange={(e) => onUpdate({ textAlignment: e.target.value as "left" | "center" | "right" })} className="px-1 py-0.5 text-xs border rounded bg-background">
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </div>
        </>
      )}

      {/* Radio */}
      {annotation.fieldType === "radio" && (
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">Group:</span>
          <input type="text" value={annotation.radioGroup || ""} onChange={(e) => onUpdate({ radioGroup: e.target.value })} className="w-24 px-1 py-0.5 text-xs border rounded bg-background" placeholder="Group name" list="radio-groups-list" />
          <datalist id="radio-groups-list">{radioGroups.map((g) => <option key={g} value={g} />)}</datalist>
        </div>
      )}

      {/* Dropdown/Listbox */}
      {(annotation.fieldType === "dropdown" || annotation.fieldType === "listbox") && (
        <PropInput label="Options" value={(annotation.options || []).join(", ")} onChange={(v) => onUpdate({ options: v.split(",").map((o) => o.trim()).filter(Boolean) })} placeholder="Opt 1, Opt 2" width="w-40" />
      )}

      {/* Tab order */}
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground">Tab:</span>
        <input type="number" value={annotation.tabOrder ?? ""} onChange={(e) => onUpdate({ tabOrder: e.target.value ? parseInt(e.target.value) : undefined })} className="w-10 px-1 py-0.5 text-xs border rounded bg-background" placeholder="–" min={0} />
      </div>
    </div>
  );
}

function PropInput({ label, value, onChange, placeholder, width = "w-24" }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; width?: string }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-muted-foreground">{label}:</span>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} className={`${width} px-1 py-0.5 text-xs border rounded bg-background`} placeholder={placeholder} />
    </div>
  );
}

function PropToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1 cursor-pointer">
      <span className="text-muted-foreground">{label}</span>
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={`relative inline-flex h-3.5 w-6 items-center rounded-full transition-colors ${checked ? "bg-blue-500" : "bg-gray-300"}`}>
        <span className={`inline-block h-2.5 w-2.5 transform rounded-full bg-white transition-transform ${checked ? "translate-x-3" : "translate-x-0.5"}`} />
      </button>
    </label>
  );
}
