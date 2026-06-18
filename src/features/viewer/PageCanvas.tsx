/**
 * PageCanvas Component
 * 
 * Renders a single PDF page with enhanced zoom and pan support.
 */

import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from "react";
import { flushSync } from "react-dom";
import { useUIStore } from "@/shared/stores/uiStore";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useDocumentSettingsStore, getRenderQualityScale } from "@/shared/stores/documentSettingsStore";
import { cn } from "@/lib/utils";
import { PDFEditor } from "@/core/pdf/PDFEditor";
import type { PDFRenderer } from "@/core/pdf/PDFRenderer";
import type { PDFDocument } from "@/core/pdf/PDFDocument";
import type { Annotation } from "@/core/pdf/PDFEditor";
import { RichTextEditor } from "./RichTextEditor";
import { ImageAnnotation } from "./ImageAnnotation";
import { StampAnnotation } from "./StampAnnotation";
import { FormField } from "./FormField";
import { CalloutAnnotation } from "./CalloutAnnotation";
import { RedlinePopupPortal } from "@/features/redline/RedlinePopup";
import { FormFieldHandles } from "./FormFieldHandles";
import { ShapeHandles } from "./ShapeHandles";
import { HorizontalRuler } from "./HorizontalRuler";
import { VerticalRuler } from "./VerticalRuler";
import { wrapAnnotationUpdate, wrapAnnotationOperation } from "@/shared/stores/undoHelpers";
import { PDFDocument as PDFDocumentClass } from "@/core/pdf/PDFDocument";
// Render queue no longer used — worker handles off-thread rendering,
// each page calls runQueuedRender() directly after debounce.
import { toolHandlers } from "@/features/tools";
import { getSelectedStamp, getStampPreviewPosition, setPreviewUpdateCallback } from "@/features/tools/StampTool";
import { getDrawingPath, isCurrentlyDrawing, setDrawPreviewCallback } from "@/features/tools/DrawTool";
import { useStampStore } from "@/shared/stores/stampStore";
import { getStampPlacementDimensions } from "@/features/stamps/stampUtils";
import { StampEditor } from "@/features/stamps/StampEditor";
import SignatureFieldAnnotation from "@/features/esign/SignatureFieldAnnotation";
import { getSpansInSelectionFromPage, getStructuredTextForPage, type TextSpan } from "@/core/pdf/PDFTextExtractor";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { useTextAnnotationClipboardStore } from "@/shared/stores/textAnnotationClipboardStore";
import { AnnotationContextMenu, type ContextMenuItem } from "./AnnotationContextMenu";
import { useSpecExtractionStore } from "@/shared/stores/specExtractionStore";
import { useCtoTextSelectionStore } from "@/shared/stores/ctoTextSelectionStore";
import { parseCiviltakeoffViewParams } from "@/shared/civiltakeoffViewParams";
import { TiledCanvas } from "./TiledCanvas";
import { getOrCreateTiledRenderer } from "@/core/pdf/tiles/tiledRendererRegistry";

interface PageCanvasProps {
  document: PDFDocument;
  pageNumber: number;
  renderer: PDFRenderer;
  onPageClick?: (x: number, y: number) => void;
  readMode?: boolean;
  /** When in read mode, display dimensions from VirtualizedPageList (single source of truth for overlay scale) */
  displayWidth?: number;
  displayHeight?: number;
}

/** Stable wrapper so React doesn't remount canvas on every render. Uses display dimensions for layout so the cell is filled. */
function ReadModeScaleWrapper({
  active,
  pageWidth,
  pageHeight,
  displayWidth,
  displayHeight,
  scale,
  children,
}: {
  active: boolean;
  pageWidth: number;
  pageHeight: number;
  displayWidth: number;
  displayHeight: number;
  scale: number;
  children: React.ReactNode;
}) {
  if (!active) return <>{children}</>;
  return (
    <div
      style={{
        width: displayWidth,
        height: displayHeight,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: pageWidth,
          height: pageHeight,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
          position: "relative",
          // GPU-promote so per-frame scale changes during zoom don't trigger
          // full layout reflows — they animate as composited transforms instead.
          willChange: "transform",
        }}
      >
        {children}
      </div>
    </div>
  );
}

export const PageCanvas = React.memo(function PageCanvas({
  document,
  pageNumber,
  renderer,
  onPageClick,
  readMode = false,
  displayWidth: displayWidthProp,
  displayHeight: displayHeightProp,
}: PageCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Stable ref to whichever element occupies the page-bitmap slot (legacy canvas
  // OR the TiledCanvas wrapper div). Used by getPDFCoordinates and similar
  // coord-calc paths so tools work in either rendering mode.
  const pageContentRef = useRef<HTMLElement | null>(null);
  const transformDivRef = useRef<HTMLDivElement>(null);
  const [hasRendered, setHasRendered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actualScale, setActualScale] = useState<number>(1.0); // Store the actual scale used for rendering
  const { renderQuality } = useDocumentSettingsStore();
  const BASE_SCALE = 1.0; // Fixed 1:1 mapping between canvas pixels and PDF points
  const RENDER_SCALE = getRenderQualityScale(renderQuality); // Quality multiplier for rendering

  // Shared pixel budget cap — adaptive based on page area.
  //
  //   Page size          Area (sq pts)   Budget    Notes
  //   ─────────────────  ─────────────   ────────  ──────────────────────────
  //   Letter (8.5×11")       484,704      8 MP     Baseline
  //   Tabloid (11×17")       950,400     ~11 MP
  //   Arch D (24×36")      4,478,976     ~24 MP    Standard construction plan
  //   Arch E (30×42")      6,531,840     ~29 MP
  //   ≥ 36×48" (huge)     ≥ 8,957,952    2 MP     Site plans, mega sheets — hard cap
  //
  const LETTER_AREA = 612 * 792; // ~484,704 sq points
  const HUGE_PAGE_AREA = LETTER_AREA * 18; // ~36×48" and above
  const capRenderScale = useCallback((pageW: number, pageH: number, idealScale: number): number => {
    const pageArea = pageW * pageH;

    // Huge pages (site plans, oversized sheets) get a hard 2MP cap
    // so they render in < 1 second instead of blocking the worker for 30s+
    if (pageArea >= HUGE_PAGE_AREA) {
      const maxPixels = 2_000_000;
      const estimated = (pageW * idealScale) * (pageH * idealScale);
      if (estimated > maxPixels) {
        return Math.sqrt(maxPixels / pageArea);
      }
      return idealScale;
    }

    // Normal large pages: scale budget with sqrt of area ratio, cap at 32MP
    const sizeRatio = pageArea / LETTER_AREA;
    const maxPixels = Math.min(32_000_000, Math.max(8_000_000, 8_000_000 * Math.sqrt(sizeRatio)));
    const estimated = (pageW * idealScale) * (pageH * idealScale);
    if (estimated > maxPixels) {
      return Math.sqrt(maxPixels / pageArea);
    }
    return idealScale;
  }, []);

  const [editor, setEditor] = useState<PDFEditor | null>(null);
  
  const { zoomLevel, fitMode, activeTool, setActiveTool, setZoomLevel, setFitMode, setZoomToCenterCallback, readMode: globalReadMode, useTiledRenderer } = useUIStore();
  const { 
    getCurrentDocument, 
    getAnnotations, 
    addAnnotation, 
    removeAnnotation, 
    updateAnnotation, 
    setCurrentPage, 
    currentPage
  } = usePDFStore();
  const horizontalFlip = usePDFStore((state) => {
    const docId = document?.getId?.() ?? "";
    const set = state.pageHorizontalFlips.get(docId);
    return set ? set.has(pageNumber) : false;
  });
  
  // Use separate selector for search state to ensure reactivity
  const currentSearchResult = usePDFStore(state => state.currentSearchResult);
  const searchResultsMap = usePDFStore(state => state.searchResults);
  
  const { showRulers } = useDocumentSettingsStore();
  const { showNotification } = useNotificationStore();
  const { copyTextAnnotation, pasteTextAnnotation, hasTextAnnotation, clear: clearTextAnnotationClipboard } = useTextAnnotationClipboardStore();
  const temporaryHighlight = useSpecExtractionStore((s) => s.temporaryHighlight);
  const currentDocument = getCurrentDocument();
  
  // Get search data reactively from the store
  const documentSearchData = useMemo(() => {
    if (!currentDocument) return null;
    return searchResultsMap.get(currentDocument.getId()) || null;
  }, [currentDocument, searchResultsMap]);
  
  // Get all search matches for this page
  const pageSearchMatches = useMemo(() => {
    if (!documentSearchData) return [];
    return documentSearchData.matches.filter(m => m.pageNumber === pageNumber);
  }, [documentSearchData, pageNumber]);
  
  // Get the current active match to highlight it differently
  const currentSearchMatch = useMemo(() => {
    if (!documentSearchData || currentSearchResult < 0 || currentSearchResult >= documentSearchData.matches.length) {
      return null;
    }
    return documentSearchData.matches[currentSearchResult];
  }, [documentSearchData, currentSearchResult]);

  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [draggingShapeId, setDraggingShapeId] = useState<string | null>(null);
  const shapeDragStartRef = useRef<{ x: number; y: number; annotX: number; annotY: number; points?: Array<{ x: number; y: number }> } | null>(null);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  
  // Use refs for smooth wheel zoom to avoid jitter
  const panOffsetRef = useRef(panOffset);
  const actualScaleRef = useRef(actualScale);
  const zoomLevelRef = useRef(zoomLevel);
  const fitModeRef = useRef(fitMode);
  const isMiddleMouseDownRef = useRef(false); // Track middle mouse button for horizontal scroll
  const renderDebounceTimeoutRef = useRef<NodeJS.Timeout | null>(null); // Track debounce timeout for PDF rendering (both read and normal mode)
  const highResRenderIdRef = useRef(0); // Incremented on effect cleanup so in-flight/queued renders are discarded
  const scheduledRunIdRef = useRef<number | null>(null); // Cancel scheduled enqueue on cleanup (never block zoom turn)
  
  // Keep refs in sync with state
  useEffect(() => {
    panOffsetRef.current = panOffset;
  }, [panOffset, fitMode]);
  
  useEffect(() => {
    actualScaleRef.current = actualScale;
  }, [actualScale]);
  
  useEffect(() => {
    zoomLevelRef.current = zoomLevel;
  }, [zoomLevel]);
  
  useEffect(() => {
    fitModeRef.current = fitMode;
  }, [fitMode]);
  
  // Register stamp preview update callback
  useEffect(() => {
    if (activeTool === "stamp") {
      setPreviewUpdateCallback(() => {
        const pos = getStampPreviewPosition();
        setStampPreviewPosition(pos ? { ...pos } : null);
      });
    } else {
      setPreviewUpdateCallback(null);
      setStampPreviewPosition(null);
    }
    return () => setPreviewUpdateCallback(null);
  }, [activeTool]);
  
  // Register draw preview update callback
  useEffect(() => {
    if (activeTool === "draw") {
      setDrawPreviewCallback(() => {
        setDrawingPathVersion(v => v + 1);
      });
    } else {
      setDrawPreviewCallback(null);
    }
    return () => setDrawPreviewCallback(null);
  }, [activeTool]);
  const [editingAnnotation, setEditingAnnotation] = useState<Annotation | null>(null);
  const [annotationText, setAnnotationText] = useState("");
  const [isEditingMode, setIsEditingMode] = useState(false);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<{ x: number; y: number } | null>(null);
  const [isCreatingTextBox, setIsCreatingTextBox] = useState(false);
  const [textBoxStart, setTextBoxStart] = useState<{ x: number; y: number } | null>(null);
  const [isDragOverPage, setIsDragOverPage] = useState(false);
  const [stampPreviewPosition, setStampPreviewPosition] = useState<{ x: number; y: number } | null>(null);
  const [drawingPathVersion, setDrawingPathVersion] = useState(0); // Incremented to force re-render of drawing preview
  const [editingStampAnnotation, setEditingStampAnnotation] = useState<Annotation | null>(null);
  const { getStamp, stampSizeMultiplier } = useStampStore();
  // Track drag/resize/rotate state for annotations to only record undo on operation end
  const draggingAnnotationRef = useRef<{ id: string; initialX: number; initialY: number } | null>(null);
  const resizingAnnotationRef = useRef<{ id: string; initialWidth: number; initialHeight: number } | null>(null);
  const rotatingAnnotationRef = useRef<{ id: string; initialRotation: number } | null>(null);
  // Track if we're duplicating and dragging a new annotation
  const duplicatingAnnotationRef = useRef<{ duplicateId: string; startX: number; startY: number; mouseStartX: number; mouseStartY: number } | null>(null);
  // Text selection state
  const [selectedTextSpans, setSelectedTextSpans] = useState<TextSpan[]>([]);
  const selectedTextRef = useRef<string>("");
  // Track if hovering over selectable text for cursor changes
  const [isHoveringOverText, setIsHoveringOverText] = useState(false);
  // Overlay highlight path for preview
  const [overlayHighlightPath, setOverlayHighlightPath] = useState<Array<{ x: number; y: number }>>([]);
  // Track if highlight tool is in text mode (text detected at start) vs overlay mode (no text)
  const [isHighlightTextMode, setIsHighlightTextMode] = useState(false);
  // Mouse position for cursor preview and paste location
  const [mousePosition, setMousePosition] = useState<{ x: number; y: number } | null>(null);
  const mousePositionRef = useRef<{ x: number; y: number } | null>(null);
  // Global mouse position tracker - tracks mouse position even when not over the page
  const globalMousePositionRef = useRef<{ clientX: number; clientY: number } | null>(null);
  // Track if shift is pressed for locked line preview
  const [isShiftPressed, setIsShiftPressed] = useState(false);
  // Cache all text spans for the current page for hover detection
  const allTextSpansRef = useRef<TextSpan[]>([]);
  // Track which annotation is being hovered (for visual feedback when select tool is active)
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null);
  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; annotationId: string } | null>(null);

  // Get annotations for current page - force re-render when annotations change
  const allAnnotations = currentDocument
    ? getAnnotations(currentDocument.getId())
    : [];
  const annotations = allAnnotations.filter(
    (a) => a.pageNumber === pageNumber
  );
  
  // Force re-render when annotations change
  useEffect(() => {
    // This effect ensures component re-renders when annotations are added/updated
  }, [allAnnotations.length, annotations.length]);
  
  // Dispatch event when editingAnnotation changes (so App.tsx can update styling bar)
  useEffect(() => {
    if (editingAnnotation) {
      // Wait for DOM to update, then notify App.tsx
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent("annotationSelected", { detail: { annotationId: editingAnnotation.id } }));
      });
    } else {
      // Dispatch clear event when annotation is deselected
      // Skip if view mode is switching — the null is from unmounting, not a real deselection
      requestAnimationFrame(() => {
        const currentReadMode = useUIStore.getState().readMode;
        const isViewModeSwitch = currentReadMode !== readMode;
        if (!isViewModeSwitch) {
          window.dispatchEvent(new CustomEvent("clearEditingAnnotation"));
        }
      });
    }
  }, [editingAnnotation?.id, readMode]);
  
  // Listen for clearEditingAnnotation event (from delete handler)
  useEffect(() => {
    const handleClearEditingAnnotation = (e: CustomEvent) => {
      // If no detail or no annotationId, it's a generic clear-all — always clear
      // If annotationId is provided, only clear if it matches the current editing annotation
      if (!e.detail?.annotationId || (editingAnnotation && editingAnnotation.id === e.detail.annotationId)) {
        setEditingAnnotation(null);
        setAnnotationText("");
        setIsEditingMode(false);
      }
    };
    
    window.addEventListener("clearEditingAnnotation", handleClearEditingAnnotation as EventListener);
    
    return () => {
      window.removeEventListener("clearEditingAnnotation", handleClearEditingAnnotation as EventListener);
    };
  }, [editingAnnotation]);

  // Ensure only one text box is in edit mode at a time
  // When editingAnnotation changes, ensure all other text boxes exit edit mode
  useEffect(() => {
    if (!editingAnnotation || editingAnnotation.type !== "text") {
      // If no annotation is being edited, ensure edit mode is off
      if (isEditingMode) {
        setIsEditingMode(false);
      }
      return;
    }

    // Ensure all text box editors that are not the current one are not contentEditable
    const allEditors = window.document.querySelectorAll('[data-rich-text-editor="true"]') as NodeListOf<HTMLElement>;
    allEditors.forEach((editor) => {
      const editorAnnotationId = editor.getAttribute("data-annotation-id");
      if (editorAnnotationId && editorAnnotationId !== editingAnnotation.id) {
        // This editor is not the current one - ensure it's not contentEditable
        if (editor.isContentEditable) {
          editor.contentEditable = "false";
        }
      }
    });
  }, [editingAnnotation?.id, isEditingMode]);

  // Load all text spans for the current page when document/page changes (for hover detection)
  useEffect(() => {
    if (currentDocument) {
      getStructuredTextForPage(currentDocument, pageNumber)
        .then((spans) => {
          allTextSpansRef.current = spans;
        })
        .catch((error) => {
          console.error("Error loading text spans for hover detection:", error);
          allTextSpansRef.current = [];
        });
    } else {
      allTextSpansRef.current = [];
    }
  }, [currentDocument, pageNumber]);

  // Reset hover state when tool changes
  useEffect(() => {
    if (activeTool !== "selectText" && activeTool !== "highlight") {
      setIsHoveringOverText(false);
    }
  }, [activeTool]);

  // Initialize PDF editor
  useEffect(() => {
    const initEditor = async () => {
      try {
        const mupdfModule = await import("mupdf");
        setEditor(new PDFEditor(mupdfModule.default));
      } catch (error) {
        console.error("Error initializing PDF editor:", error);
      }
    };
    initEditor();
  }, []);

  // Reset and center page when page changes or when entering fit modes
  // DON'T touch panOffset in custom mode - zoom/pan handlers manage it directly
  useEffect(() => {
    if (readMode) return; // In read mode, VirtualizedPageList handles positioning
    if (fitMode === "custom") return; // In custom mode, panOffset is managed by zoom/pan handlers
    
    // Calculate centered position for the new page
    if (containerRef.current && document.isDocumentLoaded()) {
      const pageMetadata = document.getPageMetadata(pageNumber);
      if (pageMetadata) {
        const container = containerRef.current;
        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;
        
        if (containerWidth > 0 && containerHeight > 0) {
          let viewportScale = zoomLevel;
          
          // Calculate appropriate scale based on fitMode
          if (fitMode === "width") {
            viewportScale = containerWidth / pageMetadata.width;
          } else if (fitMode === "page") {
            const scaleX = containerWidth / pageMetadata.width;
            const scaleY = containerHeight / pageMetadata.height;
            viewportScale = Math.min(scaleX, scaleY);
          }
          
          const scaledWidth = pageMetadata.width * viewportScale;
          const scaledHeight = pageMetadata.height * viewportScale;
          
          const centerX = (containerWidth - scaledWidth) / 2;
          const centerY = (containerHeight - scaledHeight) / 2;
          
          setPanOffset({ x: centerX, y: centerY });
          return;
        }
      }
    }
    
    // Fallback to (0, 0) if we can't calculate centering
    setPanOffset({ x: 0, y: 0 });
  }, [pageNumber, readMode, document, fitMode, zoomLevel]);

  // Clear text selection when page changes or tool changes
  useEffect(() => {
    if (activeTool !== "selectText") {
      setSelectedTextSpans([]);
      selectedTextRef.current = "";
    }
  }, [pageNumber, activeTool]);

  // Global mouseup listener to catch mouse release outside browser window
  useEffect(() => {
    const handleGlobalMouseUp = (e: MouseEvent) => {
      // Clear middle mouse button tracking on any mouseup
      if (e.button === 1) {
        isMiddleMouseDownRef.current = false;
      }
      
      // Only handle if we're in the middle of a highlight drag
      if ((activeTool === "highlight" || activeTool === "strikethrough") && isSelecting && selectionStart && overlayHighlightPath.length > 0 && !selectionEnd) {
        // Use the last point in the path as selectionEnd
        const lastPoint = overlayHighlightPath[overlayHighlightPath.length - 1];
        if (lastPoint) {
          // Create a synthetic event
          const syntheticEvent = {
            clientX: e.clientX,
            clientY: e.clientY,
            button: e.button,
            shiftKey: false,
            preventDefault: () => {},
            stopPropagation: () => {},
          } as unknown as React.MouseEvent;
          
          // Set selectionEnd before calling handleMouseUp
          setSelectionEnd(lastPoint);
          
          // Small delay to ensure state is updated
          setTimeout(() => {
            handleMouseUp(syntheticEvent);
          }, 0);
        }
      }
    };

    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => {
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [activeTool, isSelecting, selectionStart, selectionEnd, overlayHighlightPath]);

  // Keyboard handler for copy (Ctrl+C / Cmd+C)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if typing in inputs or contenteditable (unless it's a text box we want to copy)
      const isInInput = e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable);
      
      // Handle copy for text box annotations (when not in edit mode)
      if ((e.metaKey || e.ctrlKey) && e.key === "c") {
        // Check if a text annotation is selected (but not being edited)
        // Also check if we're in text tool and there's a selected annotation
        const hasSelectedTextBox = editingAnnotation && 
          editingAnnotation.type === "text" && 
          !isEditingMode && 
          !isInInput;
        
        // Also check if there's a focused text editor (even if not in edit mode, it means a text box is selected)
        const activeElement = window.document.activeElement as HTMLElement;
        const hasFocusedTextBox = activeElement && 
          activeElement.hasAttribute("data-rich-text-editor") &&
          !isEditingMode;
        
        if (hasSelectedTextBox || (hasFocusedTextBox && activeTool === "text")) {
          // Get the annotation to copy
          let annotationToCopy = editingAnnotation;
          
          // If we don't have editingAnnotation but have a focused editor, find the annotation
          if (!annotationToCopy && hasFocusedTextBox) {
            const annotationId = activeElement.getAttribute("data-annotation-id");
            if (annotationId && currentDocument) {
              const annotations = getAnnotations(currentDocument.getId());
              annotationToCopy = annotations.find(a => a.id === annotationId && a.type === "text") || null;
            }
          }
          
          if (annotationToCopy && annotationToCopy.type === "text") {
            e.preventDefault();
            e.stopPropagation();
            copyTextAnnotation(annotationToCopy);
            showNotification("Text box copied", "success");
            return;
          }
        }
        
        // Handle copy for selectText tool
        if (activeTool === "selectText" && selectedTextSpans.length > 0 && !isInInput) {
          e.preventDefault();
          
          const textToCopy = selectedTextRef.current;
          if (textToCopy) {
            navigator.clipboard.writeText(textToCopy).then(() => {
              showNotification("Text copied to clipboard", "success");
            }).catch((error) => {
              console.error("Error copying text:", error);
              showNotification("Failed to copy text", "error");
            });
          }
          return;
        }
      }
      
      // Handle paste for text box annotations
      // Only handle paste on the currently visible page to avoid pasting on wrong page
      if ((e.metaKey || e.ctrlKey) && e.key === "v") {
        // Only handle if we have a text annotation in clipboard and not in a text input
        // Only paste on the current page (the one the user is viewing)
        if (hasTextAnnotation() && !isInInput && currentDocument && pageNumber === currentPage) {
          // Prevent default and stop propagation to prevent other handlers from firing
          e.preventDefault();
          e.stopPropagation();
          
          const clipboardData = pasteTextAnnotation();
          if (clipboardData) {
            // Don't clear clipboard - allow multiple pastes of the same text box
            // The pageNumber === currentPage check ensures only the current page's PageCanvas handles paste
                  
                  // Use mouse position if available, otherwise use center of viewport
                  let pasteX = 0;
                  let pasteY = 0;
            
            // Try to get current mouse position from the browser
            // Since keyboard events don't have mouse coordinates, we'll try to get it from the last known position
            // or calculate from viewport center
            let currentMouseCoords: { x: number; y: number } | null = null;
            
            // First, try the tracked mouse position (most reliable if mouse was recently over the page)
            if (mousePositionRef.current && pageNumber === currentPage) {
              currentMouseCoords = mousePositionRef.current;
            }
            
            // If we don't have a tracked position, try to get it from the global mouse position
            // Convert global mouse position to PDF coordinates if mouse is over the page
            if (!currentMouseCoords && globalMousePositionRef.current && (pageContentRef.current ?? canvasRef.current)) {
              // Always try to convert the global mouse position directly
              // getPDFCoordinates will return null if canvas isn't ready, but we should still try
              let coords = getPDFCoordinates({ 
                clientX: globalMousePositionRef.current.clientX, 
                clientY: globalMousePositionRef.current.clientY 
              } as React.MouseEvent);
              
              // If conversion failed due to zero display dimensions, try using canvas pixel dimensions directly
              if (!coords && canvasRef.current) {
                const canvasElement = canvasRef.current;
                const canvasRect = canvasElement.getBoundingClientRect();
                const pageMetadata = document.getPageMetadata(pageNumber);
                
                
                // If canvas has pixel dimensions but zero display size, calculate directly
                if (canvasElement.width > 0 && canvasElement.height > 0 && pageMetadata && 
                    (canvasRect.width === 0 || canvasRect.height === 0)) {
                  let canvasScreenX = globalMousePositionRef.current.clientX;
                  let canvasScreenY = globalMousePositionRef.current.clientY;
                  
                  // Try container first
                  if (containerRef.current) {
                    const containerRect = containerRef.current.getBoundingClientRect();
                    if (containerRect.width > 0 && containerRect.height > 0) {
                      // Clamp mouse to container bounds
                      canvasScreenX = Math.max(containerRect.left, Math.min(containerRect.right, canvasScreenX));
                      canvasScreenY = Math.max(containerRect.top, Math.min(containerRect.bottom, canvasScreenY));
                      // Calculate relative to container
                      const relativeX = (canvasScreenX - containerRect.left) / containerRect.width;
                      const relativeY = (canvasScreenY - containerRect.top) / containerRect.height;
                      // Convert to PDF coordinates
                      const pdfX = (relativeX * pageMetadata.width);
                      const pdfY = pageMetadata.height - (relativeY * pageMetadata.height); // Flip Y
                      coords = { x: pdfX, y: pdfY };
                    }
                  }
                  
                  // If container also has zero dimensions, try parent container or viewport as last resort
                  if (!coords) {
                    // Try to find a parent container with valid dimensions
                    let parentElement: HTMLElement | null = canvasElement.parentElement;
                    let foundParent = false;
                    
                    while (parentElement && !foundParent) {
                      const parentRect = parentElement.getBoundingClientRect();
                      if (parentRect.width > 0 && parentRect.height > 0) {
                        // Found a parent with valid dimensions
                        const relativeX = (canvasScreenX - parentRect.left) / parentRect.width;
                        const relativeY = (canvasScreenY - parentRect.top) / parentRect.height;
                        const pdfX = (relativeX * pageMetadata.width);
                        const pdfY = pageMetadata.height - (relativeY * pageMetadata.height); // Flip Y
                        coords = { x: pdfX, y: pdfY };
                        foundParent = true;
                      } else {
                        parentElement = parentElement.parentElement;
                      }
                    }
                    
                    // If no parent found, use window viewport dimensions as last resort
                    if (!coords) {
                      const viewportWidth = window.innerWidth;
                      const viewportHeight = window.innerHeight;
                      if (viewportWidth > 0 && viewportHeight > 0) {
                        // Calculate relative to viewport center (rough estimate)
                        // This is less accurate but better than page center
                        const relativeX = Math.max(0, Math.min(1, canvasScreenX / viewportWidth));
                        const relativeY = Math.max(0, Math.min(1, canvasScreenY / viewportHeight));
                        const pdfX = (relativeX * pageMetadata.width);
                        const pdfY = pageMetadata.height - (relativeY * pageMetadata.height); // Flip Y
                        coords = { x: pdfX, y: pdfY };
                      }
                    }
                  }
                }
              }
              
              if (coords && coords.x != null && coords.y != null) {
                currentMouseCoords = coords;
              }
            }
            
            // If we still don't have coordinates, try to get it from the viewport center
            // This is better than page center because it uses the visible area
            if (!currentMouseCoords && containerRef.current) {
              const containerRect = containerRef.current.getBoundingClientRect();
              if (containerRect.width > 0 && containerRect.height > 0) {
                // Use viewport center (what the user is currently looking at)
                const viewportCenterX = containerRect.left + containerRect.width / 2;
                const viewportCenterY = containerRect.top + containerRect.height / 2;
                const coords = getPDFCoordinates({ clientX: viewportCenterX, clientY: viewportCenterY } as React.MouseEvent);
                if (coords && coords.x != null && coords.y != null) {
                  currentMouseCoords = coords;
                }
              }
            }
            
            
            // Use the current mouse coordinates if we have them
            if (currentMouseCoords && pageNumber === currentPage) {
              pasteX = currentMouseCoords.x;
              pasteY = currentMouseCoords.y;
            } else {
              // Fallback: try to use canvas element if container has zero dimensions
              // This can happen during initial render or when the page is not fully loaded
              let fallbackCoords: { x: number; y: number } | null = null;
              
              if (containerRef.current) {
                const containerRect = containerRef.current.getBoundingClientRect();
                if (containerRect.width > 0 && containerRect.height > 0) {
                  // Use viewport center
                  const centerX = containerRect.left + containerRect.width / 2;
                  const centerY = containerRect.top + containerRect.height / 2;
                  const coords = getPDFCoordinates({ clientX: centerX, clientY: centerY } as React.MouseEvent);
                  if (coords && coords.x != null && coords.y != null) {
                    fallbackCoords = coords;
                  }
                }
              }
              
              // If container method failed, try using the page-content element directly
              const pageEl = pageContentRef.current ?? canvasRef.current;
              if (!fallbackCoords && pageEl) {
                const canvasRect = pageEl.getBoundingClientRect();
                if (canvasRect.width > 0 && canvasRect.height > 0) {
                  const centerX = canvasRect.left + canvasRect.width / 2;
                  const centerY = canvasRect.top + canvasRect.height / 2;
                  const coords = getPDFCoordinates({ clientX: centerX, clientY: centerY } as React.MouseEvent);
                  if (coords && coords.x != null && coords.y != null) {
                    fallbackCoords = coords;
                  }
                }
              }
              
              if (fallbackCoords) {
                pasteX = fallbackCoords.x;
                pasteY = fallbackCoords.y;
              } else {
                // Last resort: use page center
                const pageMetadata = document.getPageMetadata(currentPage);
                if (pageMetadata) {
                  pasteX = pageMetadata.width / 2;
                  pasteY = pageMetadata.height / 2;
                }
              }
            }
            
            
            // Ensure we have valid coordinates and they're within page bounds
            const pageMetadata = document.getPageMetadata(currentPage);
            if (pageMetadata) {
              // Validate coordinates - check for null, undefined, NaN, or zero values
              const isInvalid = pasteX == null || pasteY == null || isNaN(pasteX) || isNaN(pasteY) || (pasteX === 0 && pasteY === 0);
              if (isInvalid) {
                // Use page center as fallback
                pasteX = pageMetadata.width / 2;
                pasteY = pageMetadata.height / 2;
              } else {
                // Clamp coordinates to page bounds
                pasteX = Math.max(0, Math.min(pageMetadata.width, pasteX));
                pasteY = Math.max(0, Math.min(pageMetadata.height, pasteY));
              }
            } else {
              // No page metadata - use default coordinates
              pasteX = 100;
              pasteY = 100;
            }
            
            const pastedAnnotation: Annotation = {
              ...clipboardData.annotation,
              id: `text_annot_${Date.now()}`,
              pageNumber: currentPage, // Use currentPage from store, not pageNumber prop
              x: pasteX,
              y: pasteY,
              // Ensure all required properties are preserved
              content: clipboardData.annotation.content || "",
              fontSize: clipboardData.annotation.fontSize || 12,
              fontFamily: clipboardData.annotation.fontFamily || "Arial",
              color: clipboardData.annotation.color || "#000000",
              width: clipboardData.annotation.width,
              height: clipboardData.annotation.height,
              autoFit: clipboardData.annotation.autoFit,
            };
            
            // Add the annotation
            addAnnotation(currentDocument.getId(), pastedAnnotation);
            // Select the pasted annotation so it's visible and can be moved
            setEditingAnnotation(pastedAnnotation);
            showNotification("Text box pasted", "success");
          }
          return;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeTool, selectedTextSpans, showNotification, editingAnnotation, isEditingMode, currentDocument, pageNumber, currentPage, copyTextAnnotation, pasteTextAnnotation, hasTextAnnotation, addAnnotation, clearTextAnnotationClipboard]);

  // Create a highlight annotation from the current text selection (fired by the
  // floating selection toolbar's "Highlight" action). Only the page canvas that
  // holds the active selection (non-empty selectedTextSpans) acts. Reuses the same
  // mupdf text-quad path as the Highlight tool so saved highlights render correctly.
  useEffect(() => {
    const handleHighlightSelection = () => {
      if (!currentDocument || selectedTextSpans.length === 0) return;
      try {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        selectedTextSpans.forEach((span) => {
          const [x0, y0, x1, y1] = span.bbox;
          minX = Math.min(minX, x0); maxX = Math.max(maxX, x1);
          minY = Math.min(minY, y0); maxY = Math.max(maxY, y1);
        });
        const selectedText = selectedTextSpans.map((s) => s.text).join(" ").trim();

        const mupdfDoc = currentDocument.getMupdfDocument();
        const page = mupdfDoc.loadPage(pageNumber);
        const pageMetadata = currentDocument.getPageMetadata(pageNumber);
        const pageHeight = pageMetadata?.height || 792;
        // mupdf highlight() takes display coords (Y=0 top); selection bbox is PDF coords (Y=0 bottom).
        const displayMinY = pageHeight - maxY;
        const displayMaxY = pageHeight - minY;
        const structuredText = page.toStructuredText("preserve-whitespace");
        let quads = structuredText.highlight([minX, displayMinY], [maxX, displayMaxY]);
        if (!quads || quads.length === 0) {
          quads = structuredText.highlight([minX - 2, displayMinY - 2], [maxX + 2, displayMaxY + 2]);
        }
        const { highlightColor, highlightOpacity } = useUIStore.getState();
        // Convert mupdf display-coord quads back to PDF coords for storage/render.
        const quadArray = (quads || []).map((quad: any) => {
          const raw = Array.isArray(quad) && quad.length >= 8
            ? quad
            : [quad.x0 || 0, quad.y0 || 0, quad.x1 || 0, quad.y1 || 0, quad.x2 || 0, quad.y2 || 0, quad.x3 || 0, quad.y3 || 0];
          return [
            raw[0], pageHeight - raw[1], raw[2], pageHeight - raw[3],
            raw[4], pageHeight - raw[5], raw[6], pageHeight - raw[7],
          ];
        });
        const annotation: Annotation = {
          id: `highlight_${Date.now()}`,
          type: "highlight",
          pageNumber,
          x: minX,
          y: minY,
          width: Math.max(1, maxX - minX),
          height: Math.max(1, maxY - minY),
          quads: quadArray.length > 0 ? quadArray : undefined,
          selectedText,
          color: highlightColor,
          opacity: highlightOpacity,
          highlightMode: "text",
        };
        const docId = currentDocument.getId();
        wrapAnnotationOperation(
          () => addAnnotation(docId, annotation),
          "addAnnotation",
          docId,
          annotation.id,
          annotation,
        );
        setSelectedTextSpans([]);
        useCtoTextSelectionStore.getState().clearSelection();
        showNotification("Highlight added", "success");
      } catch (e) {
        console.error("Error highlighting selection:", e);
        showNotification("Could not highlight selection", "error");
      }
    };
    window.addEventListener("highlight-selected-text", handleHighlightSelection);
    return () => window.removeEventListener("highlight-selected-text", handleHighlightSelection);
  }, [currentDocument, pageNumber, selectedTextSpans, addAnnotation, showNotification]);

  // Global mouse position tracker - tracks mouse position across the entire window
  // This helps us get the mouse position when paste happens, even if mouse hasn't moved over the page recently
  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      globalMousePositionRef.current = { clientX: e.clientX, clientY: e.clientY };
    };
    
    window.addEventListener("mousemove", handleGlobalMouseMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", handleGlobalMouseMove);
    };
  }, []);

  // Handle keyboard for space+drag pan (temporary hand/pan - does NOT change selected tool)
  // Use capture: true so we run before focused toolbar buttons; Space must not re-activate the last tool.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't prevent space if user is typing in an input field
      const domDocument = window.document;
      const activeElement = domDocument.activeElement as HTMLElement;
      
      // Check if user is focused on any text input element
      if (activeElement) {
        const tagName = activeElement.tagName.toLowerCase();
        // Allow spacebar in text inputs, textareas, selects, and contenteditable elements
        if (
          tagName === "input" ||
          tagName === "textarea" ||
          tagName === "select" ||
          activeElement.isContentEditable ||
          (activeElement.hasAttribute("contenteditable") && activeElement.getAttribute("data-rich-text-editor") === "true")
        ) {
          return; // Allow spacebar to work in input fields
        }
      }
      
      if (e.code === "Space" && !e.repeat) {
        setIsSpacePressed(true);
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        setIsSpacePressed(false);
      }
    };

    const capture = true;
    window.addEventListener("keydown", handleKeyDown, capture);
    window.addEventListener("keyup", handleKeyUp, capture);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, capture);
      window.removeEventListener("keyup", handleKeyUp, capture);
    };
  }, []);

  // Use native event listener for wheel to properly prevent default (React synthetic events are passive)
  // In read mode, wheel zoom is handled at the container level, not per-page
  useEffect(() => {
    const container = containerRef.current;
    if (!container || readMode) return; // Don't handle wheel zoom in read mode at page level

    // Timer for debouncing single-page zoom commit
    let spZoomTimer: ReturnType<typeof setTimeout> | null = null;

    const handleWheelNative = (e: WheelEvent) => {
      // Get current values from refs
      const currentZoomLevel = zoomLevelRef.current;
      const currentFitMode = fitModeRef.current;
      const currentPanOffset = panOffsetRef.current;

      // Handle zoom if ctrl/meta is pressed
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();

        const delta = e.deltaY > 0 ? 0.95 : 1.05;
        const currentScale = currentZoomLevel;
        const newZoom = Math.max(0.25, Math.min(5, currentScale * delta));

        if (Math.abs(newZoom - currentScale) > 0.001) {
          // Use pageContentRef so pinch-to-zoom works whether the legacy
          // canvas or TiledCanvas wrapper is mounted.
          const canvas = pageContentRef.current ?? canvasRef.current;
          const tDiv = transformDivRef.current;
          if (!canvas || !tDiv) return;

          const canvasRect = canvas.getBoundingClientRect();
          const mouseRelativeToCanvasX = e.clientX - canvasRect.left;
          const mouseRelativeToCanvasY = e.clientY - canvasRect.top;
          const canvasX = mouseRelativeToCanvasX / currentScale;
          const canvasY = mouseRelativeToCanvasY / currentScale;

          const containerRect = container.getBoundingClientRect();
          const mouseX = e.clientX - containerRect.left;
          const mouseY = e.clientY - containerRect.top;

          const newCanvasRelativeX = canvasX * newZoom;
          const newCanvasRelativeY = canvasY * newZoom;
          const newPanX = mouseX - newCanvasRelativeX;
          const newPanY = mouseY - newCanvasRelativeY;

          // Update refs immediately
          panOffsetRef.current = { x: newPanX, y: newPanY };
          zoomLevelRef.current = newZoom;
          fitModeRef.current = "custom";

          // Apply CSS transform directly — instant, no React re-render
          tDiv.style.transform = `scale(${newZoom}) translate(${newPanX / newZoom}px, ${newPanY / newZoom}px)`;

          // Debounce the React state commit
          if (spZoomTimer) clearTimeout(spZoomTimer);
          spZoomTimer = setTimeout(() => {
            spZoomTimer = null;
            flushSync(() => {
              setFitMode("custom");
              setZoomLevel(zoomLevelRef.current);
              setPanOffset({ ...panOffsetRef.current });
            });
          }, 100);
        }
        return;
      }

      // Handle scroll/pan when no modifier is pressed
      e.preventDefault();
      e.stopPropagation();

      // Calculate pan delta
      // Shift+scroll or middle mouse+scroll = horizontal pan
      // Normal scroll = vertical pan, deltaX = horizontal pan
      const scrollSensitivity = 1.0;
      let panDeltaX = 0;
      let panDeltaY = 0;

      if (e.shiftKey || isMiddleMouseDownRef.current) {
        // Shift+scroll or middle mouse+scroll = horizontal pan (side scroll)
        panDeltaX = -e.deltaY * scrollSensitivity;
      } else {
        // Normal scroll = vertical pan, also handle deltaX for horizontal wheel tilt
        panDeltaX = -e.deltaX * scrollSensitivity;
        panDeltaY = -e.deltaY * scrollSensitivity;
      }

      const newPanX = currentPanOffset.x + panDeltaX;
      const newPanY = currentPanOffset.y + panDeltaY;

      // Update refs immediately
      panOffsetRef.current = { x: newPanX, y: newPanY };
      
      // Switch to custom mode if needed and update pan offset
      if (currentFitMode !== "custom") {
        fitModeRef.current = "custom";
        flushSync(() => {
          setFitMode("custom");
          setPanOffset({ x: newPanX, y: newPanY });
        });
      } else {
        setPanOffset({ x: newPanX, y: newPanY });
      }
    };

    // Use native listener with passive: false to allow preventDefault
    container.addEventListener("wheel", handleWheelNative, { passive: false });

    return () => {
      container.removeEventListener("wheel", handleWheelNative);
      if (spZoomTimer) clearTimeout(spZoomTimer);
    };
  }, [setZoomLevel, setFitMode, readMode]);

  // In read mode, set canvas display size before paint so it matches overlay scale in the same frame (avoids bounce when zoom changes)
  useLayoutEffect(() => {
    if (!readMode || !canvasRef.current || !document.isDocumentLoaded()) return;
    const pageMetadata = document.getPageMetadata(pageNumber);
    if (!pageMetadata) return;
    let w: number;
    let h: number;
    if (displayWidthProp != null && displayHeightProp != null && displayWidthProp > 0 && displayHeightProp > 0) {
      w = displayWidthProp;
      h = displayHeightProp;
    } else {
      const first = document.getPageMetadata(0);
      const scale = first ? (first.width * zoomLevel) / pageMetadata.width : zoomLevel;
      w = pageMetadata.width * scale;
      h = pageMetadata.height * scale;
    }
    canvasRef.current.style.width = `${w}px`;
    canvasRef.current.style.height = `${h}px`;
  }, [readMode, pageNumber, document, displayWidthProp, displayHeightProp, zoomLevel]);

  useEffect(() => {
    // NOTE: when useTiledRenderer is on we still let computeScaleParams run
    // (further down inside runQueuedRender) because its fit-mode side
    // effects — setZoomLevel for fit-width and setPanOffset for centering —
    // are needed for the parent's CSS transform regardless of which
    // bitmap renderer is active. The actual renderer.renderPage call is
    // skipped via a check inside runQueuedRender after computeScaleParams.
    //
    // Early return: if global read mode is active but this is the normal mode canvas
    // Skip rendering to prevent unnecessary work during zoom
    if (globalReadMode && !readMode) {
      // This is the normal mode canvas, skip rendering when read mode is globally active
      return;
    }

    type ScaleParams = {
      displayScale: number;
      canvasDisplayWidth: number;
      canvasDisplayHeight: number;
    };

    const computeScaleParams = async (): Promise<ScaleParams | null> => {
      const pageMetadata = document.getPageMetadata(pageNumber);
      if (!pageMetadata) return null;

      let viewportScale = zoomLevel;
      let displayScale = zoomLevel;

      if (readMode) {
        if (displayWidthProp != null && displayHeightProp != null && displayWidthProp > 0 && displayHeightProp > 0) {
          displayScale = displayWidthProp / pageMetadata.width;
        } else {
          const firstPageMetadata = document.getPageMetadata(0);
          if (firstPageMetadata) {
            const viewportWidth = firstPageMetadata.width * zoomLevel;
            displayScale = viewportWidth / pageMetadata.width;
          } else {
            displayScale = zoomLevel;
          }
        }
      } else {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const currentFitMode = fitModeRef.current;
        const currentZoomLevel = zoomLevelRef.current;
        if (currentFitMode === "width" && containerRef.current) {
          const containerWidth = containerRef.current.clientWidth;
          if (containerWidth > 0) {
            viewportScale = containerWidth / pageMetadata.width;
            if (Math.abs(viewportScale - currentZoomLevel) > 0.01) {
              setZoomLevel(viewportScale);
            }
          }
        } else if (currentFitMode === "page" && containerRef.current) {
          const containerWidth = containerRef.current.clientWidth;
          const containerHeight = containerRef.current.clientHeight;
          const scaleX = containerWidth / pageMetadata.width;
          const scaleY = containerHeight / pageMetadata.height;
          viewportScale = Math.min(scaleX, scaleY);
          setZoomLevel(viewportScale);
        }

        if ((currentFitMode === "page" || currentFitMode === "width") && containerRef.current) {
          const containerWidth = containerRef.current.clientWidth;
          const containerHeight = containerRef.current.clientHeight;
          const scaledWidth = pageMetadata.width * viewportScale;
          const scaledHeight = pageMetadata.height * viewportScale;
          const centerX = (containerWidth - scaledWidth) / 2;
          const centerY = (containerHeight - scaledHeight) / 2;
          if (Math.abs(panOffset.x - centerX) > 1 || Math.abs(panOffset.y - centerY) > 1) {
            setTimeout(() => {
              setPanOffset({ x: centerX, y: centerY });
            }, 0);
          }
          displayScale = viewportScale;
        }
      }

      const canvasDisplayWidth = pageMetadata.width;
      const canvasDisplayHeight = pageMetadata.height;
      return { displayScale, canvasDisplayWidth, canvasDisplayHeight };
    };

    const applyRenderedToCanvas = (
      canvas: HTMLCanvasElement,
      rendered: { width: number; height: number; imageData: ImageData | string },
      canvasDisplayWidth: number,
      canvasDisplayHeight: number
    ) => {
      canvas.width = rendered.width;
      canvas.height = rendered.height;
      canvas.style.width = `${canvasDisplayWidth}px`;
      canvas.style.height = `${canvasDisplayHeight}px`;
      const ctx = canvas.getContext("2d", { willReadFrequently: false, colorSpace: "srgb" });
      if (ctx && rendered.imageData instanceof ImageData) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.putImageData(rendered.imageData, 0, 0);
        setHasRendered(true);
      }
    };

    const runQueuedRender = async () => {
      if (!document.isDocumentLoaded()) return;

      const thisRenderId = ++highResRenderIdRef.current;

      setError(null);
      const mupdfDoc = document.getMupdfDocument();
      const pageMetadata = document.getPageMetadata(pageNumber);
      if (!pageMetadata) {
        setError(`Page ${pageNumber} not found`);
        return;
      }

      const dpr = window.devicePixelRatio || 1;
      // Always compute scale params: it has fit-mode centering / fit-width
      // zoom side effects that the parent's CSS transform relies on, in BOTH
      // tile mode and legacy mode.
      const params = await computeScaleParams();
      if (!params) return;
      // From here on we paint to the legacy <canvas>. In tile mode the
      // canvas isn't mounted (canvasRef is null) and TiledCanvas handles
      // painting via its own setViewport/onTileReady cycle, so bail.
      if (useTiledRenderer || !canvasRef.current) return;
      if (thisRenderId !== highResRenderIdRef.current) return;

      const { displayScale, canvasDisplayWidth, canvasDisplayHeight } = params;
      const pdfData = document.getPdfData?.();
      const docId = document.getId?.();

      try {
        const idealRenderScale = displayScale * RENDER_SCALE * dpr;
        const renderScale = capRenderScale(pageMetadata.width, pageMetadata.height, idealRenderScale);

        const rendered = await renderer.renderPage(
          mupdfDoc, pageNumber, { scale: renderScale, rotation: 0 },
          pdfData, docId
        );
        if (thisRenderId !== highResRenderIdRef.current || !canvasRef.current) return;
        applyRenderedToCanvas(canvasRef.current, rendered, canvasDisplayWidth, canvasDisplayHeight);
        setActualScale(RENDER_SCALE);
      } catch (err) {
        if (thisRenderId !== highResRenderIdRef.current) return;

        // If the worker timed out on a massive page, retry at very low quality
        // so the page shows *something* instead of staying permanently blank.
        const isTimeout = err instanceof Error && err.message.includes("timeout");
        if (isTimeout) {
          console.warn(`Page ${pageNumber}: worker timed out, retrying at low quality`);
          try {
            // Render at ~0.5MP — fast enough even for the most complex pages
            const fallbackScale = Math.sqrt(500_000 / (pageMetadata.width * pageMetadata.height));
            const fallback = await renderer.renderPage(
              mupdfDoc, pageNumber, { scale: Math.max(0.25, fallbackScale), rotation: 0 },
              pdfData, docId
            );
            if (thisRenderId !== highResRenderIdRef.current || !canvasRef.current) return;
            applyRenderedToCanvas(canvasRef.current, fallback, canvasDisplayWidth, canvasDisplayHeight);
            setActualScale(RENDER_SCALE);
            return;
          } catch {
            // Even fallback failed — show error
          }
        }

        setError(err instanceof Error ? err.message : "Failed to render page");
        console.error("Error rendering page:", err);
      }
    };

    // In read mode, update canvas CSS size immediately so it matches the
    // ReadModeScaleWrapper layout. The wrapper already CSS-scales both canvas
    // AND annotations uniformly, so the old pixel buffer will appear slightly
    // blurry at the new zoom but annotations stay perfectly aligned.
    // The debounced re-render below will produce a crisp buffer.
    if (readMode && canvasRef.current && document.isDocumentLoaded()) {
      const pageMetadata = document.getPageMetadata(pageNumber);
      if (pageMetadata) {
        const canvas = canvasRef.current;
        canvas.style.width = `${pageMetadata.width}px`;
        canvas.style.height = `${pageMetadata.height}px`;
      }
    }

    if (renderDebounceTimeoutRef.current) {
      clearTimeout(renderDebounceTimeoutRef.current);
    }

    const scheduleRender = () => {
      scheduledRunIdRef.current = null;
      runQueuedRender();
    };

    // Fast path: if the render is already cached, apply immediately with no debounce.
    // This makes scrolling back to previously-viewed pages instant.
    const currentPageMeta = document.getPageMetadata(pageNumber);
    if (currentPageMeta && readMode) {
      const dpr = window.devicePixelRatio || 1;
      let checkScale: number;
      if (displayWidthProp != null && displayWidthProp > 0) {
        checkScale = (displayWidthProp / currentPageMeta.width) * RENDER_SCALE * dpr;
      } else {
        const firstMeta = document.getPageMetadata(0);
        const viewportWidth = firstMeta ? firstMeta.width * zoomLevel : currentPageMeta.width * zoomLevel;
        checkScale = (viewportWidth / currentPageMeta.width) * RENDER_SCALE * dpr;
      }
      const cappedScale = capRenderScale(currentPageMeta.width, currentPageMeta.height, checkScale);
      if (renderer.hasCachedRender(pageNumber, cappedScale, 0)) {
        // Cache hit — render immediately, no debounce
        scheduleRender();
        return () => {
          highResRenderIdRef.current += 1;
          if (renderDebounceTimeoutRef.current) {
            clearTimeout(renderDebounceTimeoutRef.current);
            renderDebounceTimeoutRef.current = null;
          }
        };
      }
    }

    // Cache miss — debounce to avoid spamming the worker during rapid zoom/scroll.
    // Larger pages get more time since the CSS transform preview covers the gap.
    const pageArea = (currentPageMeta?.width ?? 612) * (currentPageMeta?.height ?? 792);
    const sizeRatio = pageArea / LETTER_AREA;
    const debounceMs = readMode
      ? Math.min(300, Math.max(50, Math.round(50 * Math.sqrt(sizeRatio))))
      : 100;
    renderDebounceTimeoutRef.current = setTimeout(() => {
      renderDebounceTimeoutRef.current = null;
      scheduleRender();
    }, debounceMs);

    return () => {
      highResRenderIdRef.current += 1;
      if (renderDebounceTimeoutRef.current) {
        clearTimeout(renderDebounceTimeoutRef.current);
        renderDebounceTimeoutRef.current = null;
      }
    };
  }, [document, pageNumber, renderer, zoomLevel, fitMode, setZoomLevel, readMode, globalReadMode, displayWidthProp, displayHeightProp, useTiledRenderer]);
  
  // Effect to ensure centering when fitMode changes to "page" or "width"
  // Don't run while actively panning to prevent resetting the view
  useEffect(() => {
    if (readMode || !containerRef.current || !document.isDocumentLoaded() || isDragging) return;
    
    const pageMetadata = document.getPageMetadata(pageNumber);
    if (!pageMetadata) return;
    
    if (fitMode === "page" || fitMode === "width") {
      const container = containerRef.current;
      const containerWidth = container.clientWidth;
      const containerHeight = container.clientHeight;
      
      if (containerWidth > 0 && containerHeight > 0) {
        let viewportScale = zoomLevel;
        
        if (fitMode === "width") {
          viewportScale = containerWidth / pageMetadata.width;
        } else if (fitMode === "page") {
          const scaleX = containerWidth / pageMetadata.width;
          const scaleY = containerHeight / pageMetadata.height;
          viewportScale = Math.min(scaleX, scaleY);
        }
        
        const scaledWidth = pageMetadata.width * viewportScale;
        const scaledHeight = pageMetadata.height * viewportScale;
        
        const centerX = (containerWidth - scaledWidth) / 2;
        const centerY = (containerHeight - scaledHeight) / 2;
        
        // Use requestAnimationFrame to ensure DOM is ready
        requestAnimationFrame(() => {
          setPanOffset({ x: centerX, y: centerY });
        });
      }
    }
  }, [fitMode, readMode, document, pageNumber, zoomLevel, isDragging]);
  
  // Get page metadata to watch for rotation changes specifically.
  // We deliberately do NOT watch width/height — those change as a side effect
  // of either (a) rotation (already handled here) or (b) metadata loading
  // lazily after mount. Case (b) is handled by the main render path; firing
  // the force-re-render effect there causes duplicate full-quality renders
  // that exhaust the mupdf WASM heap.
  const pageMetadata = document?.getPageMetadata(pageNumber);
  const pageRotation = pageMetadata?.rotation ?? 0;

  // EXPERIMENTAL: tile-pyramid renderer. Memoized per-document instance shared
  // across all PageCanvas instances of the same doc. Returns null when the
  // feature flag is off so the legacy bitmap path stays exclusive.
  const tiledRenderer = useMemo(() => {
    if (!useTiledRenderer) return null;
    const docId = document?.getId?.();
    const pdfData = document?.getPdfData?.();
    if (!docId || !pdfData) return null;
    return getOrCreateTiledRenderer({
      docId,
      pdfBytes: pdfData,
      pageDims: (page) => {
        const meta = document.getPageMetadata(page);
        return meta
          ? { widthPt: meta.width, heightPt: meta.height }
          : { widthPt: 612, heightPt: 792 };
      },
    });
  }, [useTiledRenderer, document]);

  // Eagerly prefetch every page's LOD-0 tile once per (doc, renderer). LOD-0
  // is the never-blank fallback walked by findCoarserAncestor, so seeding it
  // for all pages on doc open means a fast scroll/page-jump always has *some*
  // ancestor cached to draw immediately. The renderer itself dedupes repeat
  // calls via an internal `lod0PrefetchDone` flag.
  useEffect(() => {
    if (!tiledRenderer || !document) return;
    const pageCount = document.getMetadata?.()?.pageCount ?? 0;
    if (pageCount > 0) tiledRenderer.prefetchAllLod0(pageCount);
  }, [tiledRenderer, document]);

  // Effective screen resolution for LOD selection inside TiledCanvas.
  // Mirrors what the legacy renderer would compute as displayScale, then
  // multiplies by devicePixelRatio so high-DPI displays pick a sharper LOD.
  const tiledDisplayPxPerPoint = (() => {
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    if (
      readMode &&
      displayWidthProp != null &&
      displayHeightProp != null &&
      pageMetadata?.width
    ) {
      return (displayWidthProp / pageMetadata.width) * dpr;
    }
    return zoomLevel * dpr;
  })();

  // Visible PDF-rect of this page on screen — intersection of the container's
  // viewport with the page element's bounding rect, mapped from CSS px back
  // to PDF points. Used by TiledCanvas so the worker pool only renders tiles
  // the user can actually see (instead of the whole page at every LOD).
  // Updated via useLayoutEffect after every render so scroll / pan / zoom
  // changes flow through.
  const [tiledViewportPdfRect, setTiledViewportPdfRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  }>({ x: 0, y: 0, w: 0, h: 0 });

  useLayoutEffect(() => {
    if (!useTiledRenderer || !pageMetadata) return;
    const containerEl = containerRef.current;
    const pageEl = pageContentRef.current;
    if (!containerEl || !pageEl) return;

    const containerRect = containerEl.getBoundingClientRect();
    const pageRect = pageEl.getBoundingClientRect();

    if (pageRect.width <= 0 || pageRect.height <= 0) return;

    const left = Math.max(containerRect.left, pageRect.left);
    const top = Math.max(containerRect.top, pageRect.top);
    const right = Math.min(containerRect.right, pageRect.right);
    const bottom = Math.min(containerRect.bottom, pageRect.bottom);

    let next: { x: number; y: number; w: number; h: number };
    if (left >= right || top >= bottom) {
      next = { x: 0, y: 0, w: 0, h: 0 };
    } else {
      // pageRect already accounts for the parent CSS transform, so px-per-pt
      // here = pageRect.width / pageMetadata.width.
      const pxPerPt = pageRect.width / pageMetadata.width;
      // Expand the visible rect by a margin in each direction so small pans
      // or scrolls don't expose un-rendered edges. Clamped to page bounds.
      const MARGIN = 0.25; // 25% of the visible region in each direction
      const cssW = right - left;
      const cssH = bottom - top;
      const marginCssX = cssW * MARGIN;
      const marginCssY = cssH * MARGIN;
      const expandedX = Math.max(0, (left - pageRect.left - marginCssX) / pxPerPt);
      const expandedY = Math.max(0, (top - pageRect.top - marginCssY) / pxPerPt);
      const expandedRight = Math.min(
        pageMetadata.width,
        (right - pageRect.left + marginCssX) / pxPerPt,
      );
      const expandedBottom = Math.min(
        pageMetadata.height,
        (bottom - pageRect.top + marginCssY) / pxPerPt,
      );
      next = {
        x: expandedX,
        y: expandedY,
        w: expandedRight - expandedX,
        h: expandedBottom - expandedY,
      };
    }

    setTiledViewportPdfRect((prev) => {
      // Only update on meaningful change to avoid render loops. 1pt threshold
      // is plenty — sub-pt movement won't change the visible tile set.
      if (
        Math.abs(prev.x - next.x) < 1 &&
        Math.abs(prev.y - next.y) < 1 &&
        Math.abs(prev.w - next.w) < 1 &&
        Math.abs(prev.h - next.h) < 1
      ) {
        return prev;
      }
      return next;
    });
  });

  // Debounce propagation of tile-renderer inputs. During rapid zoom,
  // displayPxPerPoint and viewportPdfRect change every frame; firing
  // setViewport / getVisibleTiles per change cascades into pool churn,
  // forced layouts, and React reconciliation across many Tile children.
  // Holding the propagation for 100ms after the last change lets the
  // parent's CSS transform handle the in-flight visual (cached tiles
  // CSS-scale smoothly) while the worker pool stays idle until the user
  // settles. Initial mount fires immediately so first paint isn't delayed.
  const [debouncedTiledInputs, setDebouncedTiledInputs] = useState(() => ({
    displayPxPerPoint: tiledDisplayPxPerPoint,
    viewportRect: tiledViewportPdfRect,
  }));
  const debouncedFirstMountRef = useRef(true);

  useEffect(() => {
    const delay = debouncedFirstMountRef.current ? 0 : 100;
    debouncedFirstMountRef.current = false;
    const id = setTimeout(() => {
      setDebouncedTiledInputs({
        displayPxPerPoint: tiledDisplayPxPerPoint,
        viewportRect: tiledViewportPdfRect,
      });
    }, delay);
    return () => clearTimeout(id);
  }, [tiledDisplayPxPerPoint, tiledViewportPdfRect]);

  // State to track rotation changes and force re-render
  const [metadataVersion, setMetadataVersion] = useState(0);

  // Ref to track previous rotation for change detection
  const previousRotationRef = useRef<number | null>(null);

  // Listen for rotation changes via event-driven notification.
  // Only bump the version when ROTATION actually changes — not on initial
  // load, and not on width/height changes from lazy metadata loading.
  useEffect(() => {
    const checkRotation = () => {
      const currentMetadata = document?.getPageMetadata(pageNumber);
      const currentRotation = currentMetadata?.rotation ?? 0;
      const prevRotation = previousRotationRef.current;

      if (prevRotation === null) {
        // First observation — record but don't trigger re-render
        previousRotationRef.current = currentRotation;
        return;
      }
      if (currentRotation !== prevRotation) {
        previousRotationRef.current = currentRotation;
        setMetadataVersion(prev => prev + 1);
      }
    };

    // Check immediately on mount / dependency change
    checkRotation();

    // Subscribe to metadata change events (fired by refreshPageMetadata)
    const unsubscribe = document.onMetadataChange(checkRotation);

    return () => unsubscribe();
  }, [document, pageNumber]);
  
  // Clear renderer cache and canvas when switching to a DIFFERENT document.
  // Uses a ref to track the previous document ID so we only clear on actual changes,
  // NOT on every PageCanvas mount (which would nuke the cache for all pages in read mode).
  const prevDocIdRef = useRef<string | undefined>(document?.getId());
  useEffect(() => {
    const currentDocId = document?.getId();
    if (prevDocIdRef.current !== undefined && prevDocIdRef.current !== currentDocId) {
      // Document actually changed — clear cache and canvas
      if (renderer) {
        renderer.clearCache();
      }
      if (canvasRef.current) {
        const ctx = canvasRef.current.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
        }
      }
      setEditingAnnotation(null);
      setAnnotationText("");
      setIsEditingMode(false);
    }
    prevDocIdRef.current = currentDocId;
  }, [document?.getId(), renderer]);
  
  // Effect to force re-render when ROTATION changes.
  // metadataVersion only bumps when rotation actually changes (see checkRotation
  // above), and we additionally skip the initial mount run as a belt-and-suspenders
  // guard. The main render effect handles first-render and width/height changes.
  const forceReRenderInitializedRef = useRef(false);
  useEffect(() => {

    if (!document.isDocumentLoaded() || !renderer || !canvasRef.current) return;

    // First run = component mount. Skip — the main render path handles initial render.
    if (!forceReRenderInitializedRef.current) {
      forceReRenderInitializedRef.current = true;
      return;
    }

    // Only clear cache for the affected page (preserve other pages' cache)
    renderer.clearCacheForPage(pageNumber);

    // Force a re-render by re-running the render logic
    const forceReRender = async () => {
      try {
        const mupdfDoc = document.getMupdfDocument();
        const metadata = document.getPageMetadata(pageNumber);
        if (!metadata) return;

        // High-DPI rendering for crisp text — apply same pixel budget cap as main render path
        const dpr = window.devicePixelRatio || 1;
        const idealRenderScale = BASE_SCALE * RENDER_SCALE * dpr;
        const renderScale = capRenderScale(metadata.width, metadata.height, idealRenderScale);

        // Render without additional rotation (PDF Rotate is already applied by mupdf)
        const rendered = await renderer.renderPage(mupdfDoc, pageNumber, {
          scale: renderScale, rotation: 0,
        }, document.getPdfData?.(), document.getId?.());

        const canvas = canvasRef.current;
        if (canvas) {
          // High-DPI: canvas backing buffer is DPR times larger than display
          const pdfDisplayWidth = metadata.width;
          const pdfDisplayHeight = metadata.height;
          
          // Canvas backing size = rendered size (high-res)
          canvas.width = rendered.width;
          canvas.height = rendered.height;
          
          // Canvas display size = PDF dimensions
          canvas.style.width = `${pdfDisplayWidth}px`;
          canvas.style.height = `${pdfDisplayHeight}px`;
          
          const ctx = canvas.getContext("2d", {
            willReadFrequently: false,
            colorSpace: "srgb"
          });
          
          if (ctx && rendered.imageData instanceof ImageData) {
            // Enable smoothing for crisp downscaling on high-DPI
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            
            // Draw the rendered image data
            ctx.putImageData(rendered.imageData, 0, 0);
            setHasRendered(true);
          }
        }
      } catch (err) {
        console.error("Error force re-rendering page after rotation:", err);
      }
    };
    
    // Small delay to ensure metadata is updated
    const timeoutId = setTimeout(() => {
      forceReRender();
    }, 50);
    
    return () => clearTimeout(timeoutId);
  }, [document, pageNumber, renderer, pageRotation, metadataVersion]);

  // Helper function to convert mouse coordinates to PDF coordinates
  // PDF uses bottom-up Y coordinate system, canvas uses top-down
  const getPDFCoordinates = (e: React.MouseEvent): { x: number; y: number } | null => {
    // Prefer pageContentRef (works for both legacy canvas and TiledCanvas wrapper);
    // fall back to canvasRef so existing code paths still work if the new ref
    // hasn't been wired (defensive).
    const canvasElement = pageContentRef.current ?? canvasRef.current;
    if (!canvasElement) return null;

    const pageMetadata = document.getPageMetadata(pageNumber);

    if (!pageMetadata) return null;

    // Step 1: Get element position on screen (accounts for ALL CSS transforms automatically)
    const canvasRect = canvasElement.getBoundingClientRect();

    // Reject when the page element has no display size on screen. We DO NOT
    // check canvas-buffer width/height anymore — when the tiled renderer is on,
    // canvasElement is a <div> and has no .width/.height pixel buffer.
    if (canvasRect.width === 0 || canvasRect.height === 0) {
      return null;
    }
    
    // Step 2: Calculate mouse position relative to canvas element
    const canvasRelativeX = e.clientX - canvasRect.left;
    const canvasRelativeY = e.clientY - canvasRect.top;
    
    // Step 3: Convert directly from canvas display size (CSS pixels) to PDF coordinates
    // Use display size (canvasRect) instead of backing buffer (canvasElement) to make coordinates
    // independent of RENDER_SCALE. The display size is constant regardless of render quality.
    // When rotated 90/270, getBounds() returns display dimensions (width x height = short x long).
    // Use display dimensions for 1:1 mapping so overlay coordinates align with the canvas.
    let mediaboxHeight: number;
    let mediaboxWidth: number;
    if (pageMetadata.rotation === 90 || pageMetadata.rotation === 270) {
      // 1:1 with display: mediabox = display width/height so canvas position maps directly to stored coords
      mediaboxWidth = pageMetadata.width;
      mediaboxHeight = pageMetadata.height;
    } else {
      mediaboxWidth = pageMetadata.width;
      mediaboxHeight = pageMetadata.height;
    }
    
    // Convert directly from display size ratio to PDF coordinates
    // This makes the coordinate system independent of RENDER_SCALE
    // canvasRect.width/height are the CSS display dimensions (independent of render quality)
    const pdfX = (canvasRelativeX / canvasRect.width) * mediaboxWidth;
    const pdfY = mediaboxHeight - ((canvasRelativeY / canvasRect.height) * mediaboxHeight);  // Flip Y: PDF Y=0 is at bottom
    
    return { x: pdfX, y: pdfY };
  };

  // Helper function to convert PDF coordinates to canvas coordinates for rendering overlays
  // Must match getPDFCoordinates - both flip Y-axis since PDF Y=0 is at bottom, canvas Y=0 is at top
  // getPDFCoordinates: mediaboxHeight - ((canvasRelativeY / canvasRect.height) * mediaboxHeight) → pdfY (flipped)
  // pdfToCanvas: mediaboxHeight - pdfY → canvasY (flipped, to match, 1:1 mapping)
  // IMPORTANT: Use original mediabox dimensions (not swapped display dimensions) for coordinate conversion
  // because annotations are stored in mediabox coordinate space
  // Coordinate system is independent of RENDER_SCALE - uses display size (1:1 with PDF points)
  // In read mode, we need to account for the actual canvas display size which may differ from PDF dimensions
  const pdfToCanvas = (pdfX: number, pdfY: number, _useRefs: boolean = false): { x: number; y: number } => {
    const pageMetadata = document.getPageMetadata(pageNumber);
    
    if (!pageMetadata) {
      // Return 1:1 coordinates when metadata is unavailable
      return { x: pdfX, y: pdfY };
    }
    
    // Use display dimensions for 1:1 mapping (same as getPDFCoordinates).
    // When rotated 90/270, pageMetadata.width/height are already the display dimensions.
    const mediaboxHeight = pageMetadata.height;
    
    // PDF Y=0 is at bottom, canvas Y=0 is at top - flip Y-axis using mediabox height
    const flippedY = mediaboxHeight - pdfY;
    
    // In read mode we use a scale wrapper (same coordinate scale as single-page: 1:1 PDF inside, one scale on wrapper).
    // So return 1:1 here; the wrapper's transform handles zoom.
    let scaleX = 1;
    let scaleY = 1;
    if (!readMode) {
      // single-page: keep 1:1 (container has scale(zoomLevel))
    } else {
      // read mode: 1:1 so overlays match single-page coordinate scale; wrapper applies readModeAnnotationScale
      scaleX = 1;
      scaleY = 1;
    }
    
    // Return CSS coordinates for overlay positioning (1:1 PDF in read mode, same as single)
    // Apply scaling in read mode to account for canvas display size differences
    // This ensures annotations align with the actual canvas rendering
    const result = {
      x: pdfX * scaleX,      // Scale X in read mode to match canvas display size
      y: flippedY * scaleY,  // Scale Y in read mode to match canvas display size
    };
    
    // Debug logging for arrow points specifically
    if (Math.abs(pdfX) < 10000 && Math.abs(pdfY) < 10000) { // Only log reasonable values to avoid spam
      // Debug log removed - was causing excessive console output
      // console.log("🔴 [pdfToCanvas] Converting:", { pdfX, pdfY, mediaboxHeight, flippedY, result });
    }
    
    return result;
  };

  // Single source of truth for read-mode scale: must match pdfToCanvas scaleX/scaleY so overlay dimensions match at any zoom
  const readModeAnnotationScale = useMemo(() => {
    if (!readMode) return 1;
    const pageMetadata = document.getPageMetadata(pageNumber);
    if (!pageMetadata) return 1;
    const mediaboxWidth = pageMetadata.width;
    if (mediaboxWidth <= 0) return 1;
    if (displayWidthProp != null && displayHeightProp != null && displayWidthProp > 0 && displayHeightProp > 0) {
      return displayWidthProp / mediaboxWidth;
    }
    const firstPageMetadata = document.getPageMetadata(0);
    if (!firstPageMetadata) return zoomLevel;
    return (firstPageMetadata.width * zoomLevel) / mediaboxWidth;
  }, [readMode, pageNumber, document, pageRotation, displayWidthProp, displayHeightProp, zoomLevel]);

  // Helper function to convert PDF coordinates to container-relative (screen) coordinates
  // This is the REVERSE of getPDFCoordinates
  // Returns CSS coordinates (display size) independent of RENDER_SCALE
  const pdfToContainer = (pdfX: number, pdfY: number, _useRefs: boolean = false): { x: number; y: number } => {
    if (!canvasRef.current) {
      return { x: 0, y: 0 };
    }
    
    const pageMetadata = document.getPageMetadata(pageNumber);
    
    if (!pageMetadata) {
      return { x: 0, y: 0 };
    }
    
    // Must match getPDFCoordinates: use display dimensions for 1:1 mapping
    let mediaboxHeight: number;
    if (pageMetadata.rotation === 90 || pageMetadata.rotation === 270) {
      mediaboxHeight = pageMetadata.height;
    } else {
      mediaboxHeight = pageMetadata.height;
    }
    
    // Convert PDF coordinates to canvas display coordinates (CSS pixels, 1:1 with PDF points)
    // PDF Y=0 is at bottom, canvas Y=0 is at top - flip Y-axis
    // Canvas display size is 1:1 with PDF points, independent of RENDER_SCALE
    const canvasDisplayX = pdfX;  // 1:1 mapping
    const canvasDisplayY = mediaboxHeight - pdfY;  // Flip Y: 1:1 mapping
    
    // Return container-relative coordinates (same as canvas-relative since canvas is in container)
    return {
      x: canvasDisplayX,
      y: canvasDisplayY,
    };
  };

  // Helper function to zoom to center of canvas
  const zoomToCenter = useCallback((newZoom: number) => {
    if (!containerRef.current) return;
    
    // In read mode, don't use this function - zoom is handled at container level
    if (readMode) return;
    
    const container = containerRef.current;
    const containerRect = container.getBoundingClientRect();
    
    // Get container center
    const centerX = containerRect.width / 2;
    const centerY = containerRect.height / 2;
    
    // Use refs to get current values to avoid stale closures
    const currentPanOffset = panOffsetRef.current;
    const currentZoomLevel = zoomLevelRef.current;
    const currentActualScale = actualScaleRef.current;
    const currentFitMode = fitModeRef.current;
    
    // Get current scale (use actualScale if available, otherwise zoomLevel)
    const currentScale = currentFitMode === "custom" ? currentZoomLevel : (currentActualScale > 0 ? currentActualScale : currentZoomLevel);
    
    // Convert center to document coordinates
    // Remove pan offset to get canvas-relative coordinates
    const canvasX = centerX - currentPanOffset.x;
    const canvasY = centerY - currentPanOffset.y;
    // Divide by current scale to get document coordinates
    const documentX = canvasX / currentScale;
    const documentY = canvasY / currentScale;
    
    // Apply new zoom
    const newCanvasX = documentX * newZoom;
    const newCanvasY = documentY * newZoom;
    
    // Adjust pan to keep center fixed
    const newPanX = centerX - newCanvasX;
    const newPanY = centerY - newCanvasY;
    
    // Update refs immediately
    panOffsetRef.current = { x: newPanX, y: newPanY };
    zoomLevelRef.current = newZoom;
    fitModeRef.current = "custom";
    
    // Batch state updates
    requestAnimationFrame(() => {
      setFitMode("custom");
      setZoomLevel(newZoom);
      setPanOffset({ x: newPanX, y: newPanY });
    });
  }, [readMode, setZoomLevel, setFitMode]);

  // Expose zoomToCenter via UI store (only when not in read mode)
  useEffect(() => {
    if (readMode) {
      // In read mode, zoom is handled at the PDFViewer level
      return;
    }
    setZoomToCenterCallback(zoomToCenter);
    return () => {
      setZoomToCenterCallback(null);
    };
  }, [zoomToCenter, setZoomToCenterCallback, readMode]);

  // Note: Focus is now handled by RichTextEditor component

  // Shared base tool context — avoids creating 10 identical objects per mouse event.
  // Extended with extra props (overlayHighlightPath, setActiveTool, etc.) at call sites that need them.
  const baseToolContext = useMemo(() => ({
    document,
    pageNumber,
    currentDocument,
    annotations,
    activeTool,
    readMode,
    getPDFCoordinates,
    pdfToCanvas,
    pdfToContainer,
    addAnnotation: (documentId: string, annotation: Annotation) => addAnnotation(documentId, annotation),
    removeAnnotation: (documentId: string, annotationId: string) => removeAnnotation(documentId, annotationId),
    setEditingAnnotation,
    setAnnotationText,
    setIsEditingMode,
    setIsSelecting,
    setSelectionStart,
    setSelectionEnd,
    setIsCreatingTextBox,
    setTextBoxStart,
    editor,
    renderer,
    canvasRef,
    containerRef,
    BASE_SCALE,
    zoomLevelRef,
    fitMode,
    panOffset,
    panOffsetRef,
    isSelecting,
    selectionStart,
    setSelectedTextSpans,
    setIsHighlightTextMode,
  }), [document, pageNumber, currentDocument, annotations, activeTool, readMode,
       editor, renderer, fitMode, panOffset, isSelecting, selectionStart]);

  const handleMouseDown = async (e: React.MouseEvent) => {
    // Skip tool handling when clicking inside form fields (let inputs handle natively)
    const target = e.target as HTMLElement;
    if (target.closest?.("[data-form-field]")) {
      return;
    }

    // Update mouse position for paste location
    const coords = getPDFCoordinates(e);
    if (coords) {
      mousePositionRef.current = coords;
    }
    
    // Track middle mouse button for horizontal scroll
    if (e.button === 1) {
      isMiddleMouseDownRef.current = true;
    }
    
    // Middle mouse button or space+drag for pan
    // In read mode, don't handle pan here - let native scrolling work
    if (!readMode && (e.button === 1 || (e.button === 0 && (isSpacePressed || activeTool === "pan")))) {
      e.preventDefault();
      e.stopPropagation();
      if (e.nativeEvent && 'stopImmediatePropagation' in e.nativeEvent) {
        e.nativeEvent.stopImmediatePropagation();
      }
      setIsDragging(true);
      
      // Switch to custom mode when panning starts to prevent centering effect from interfering
      if (fitMode !== "custom") {
        fitModeRef.current = "custom";
        setFitMode("custom");
      }
      
      // Use ref value in custom mode to avoid stale state
      const currentPanForDrag = fitMode === "custom" ? panOffsetRef.current : panOffset;
      setDragStart({ x: e.clientX - currentPanForDrag.x, y: e.clientY - currentPanForDrag.y });
      return;
    }

    // Initialize overlay path for highlight tool - will be set based on text detection
    if ((activeTool === "highlight" || activeTool === "strikethrough")) {
      const coords = getPDFCoordinates(e);
      if (coords) {
        // Clear previous state
        setOverlayHighlightPath([]);
        setIsHighlightTextMode(false);
        // Hide cursor preview when starting to draw
        setMousePosition(null);
      }
    }

    // Use tool handlers for tool-specific interactions
    if (currentDocument && activeTool !== "select" && activeTool !== "pan") {
      const toolHandler = toolHandlers[activeTool];
      if (toolHandler) {
        const toolContext = (activeTool === "highlight" || activeTool === "strikethrough")
          ? { ...baseToolContext, overlayHighlightPath, setOverlayHighlightPath }
          : baseToolContext;

        const result = await toolHandler.handleMouseDown(e, toolContext);
        if (result === true) {
          // Handler indicates it fully handled the event
          return;
        }
      }
    }

    // Handle selectText tool - always clear previous selection when starting a new drag
    // This ensures clicking and dragging again ends the previous selection and starts fresh
    if (activeTool === "selectText" && currentDocument) {
      // Always clear previous selection when starting a new drag
      // The user expects clicking and dragging to start a fresh selection
      setSelectedTextSpans([]);
      selectedTextRef.current = "";
      setIsSelecting(false);
      setSelectionStart(null);
      setSelectionEnd(null);
      
      const toolHandler = toolHandlers[activeTool];
      if (toolHandler) {
        await toolHandler.handleMouseDown(e, baseToolContext);
      }
    }

    // Handle select tool - deselect annotation when clicking empty space
    if (activeTool === "select" && editingAnnotation) {
      // Check if click target is the text editor or its children - if so, don't deselect
      const target = e.target as HTMLElement;
      const isClickingOnEditor = target.closest('[data-rich-text-editor]') || 
                                 target.closest('[data-annotation-id]') ||
                                 target.closest('[data-corner-handle]') ||
                                 target.closest('[data-rotation-handle]') ||
                                 target.closest('[data-form-field-button]');
      
      // Don't deselect if clicking on the formatting toolbar or popover
      const isClickingOnToolbar = target.closest('[data-formatting-toolbar]') ||
                                  target.closest('[role="dialog"]') ||
                                  target.closest('[data-radix-portal]');
      
      // If not clicking on the editor or toolbar, completely deselect the annotation
      if (!isClickingOnEditor && !isClickingOnToolbar) {
        setIsEditingMode(false);
        setEditingAnnotation(null);
        setAnnotationText("");
      }
    }

    // Fallback to page click handler
    if (onPageClick) {
      const coords = getPDFCoordinates(e);
      if (coords) {
        onPageClick(coords.x, coords.y);
      }
    }
  };

  // Handle shape dragging
  useEffect(() => {
    if (!draggingShapeId || !shapeDragStartRef.current || !currentDocument) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!shapeDragStartRef.current) return;

      const screenDx = e.clientX - shapeDragStartRef.current.x;
      const screenDy = e.clientY - shapeDragStartRef.current.y;
      
      // Only move if we've actually dragged (moved more than a few pixels)
      const moveDistance = Math.sqrt(screenDx * screenDx + screenDy * screenDy);
      if (moveDistance < 3) return;

      // Convert screen delta to PDF delta
      const currentZoomLevel = zoomLevelRef.current;
      const pdfDx = screenDx / currentZoomLevel;
      const pdfDy = -screenDy / currentZoomLevel; // Flip Y for PDF coordinates

      const annotations = getAnnotations(currentDocument.getId());
      const annot = annotations.find(a => a.id === draggingShapeId);
      if (!annot) return;

      if (annot.shapeType === "arrow" && annot.points && shapeDragStartRef.current.points) {
        // For arrows, move the points from initial position
        const initialPoints = shapeDragStartRef.current.points;
        
        // Calculate total delta from initial mouse position
        const totalScreenDx = e.clientX - shapeDragStartRef.current.x;
        const totalScreenDy = e.clientY - shapeDragStartRef.current.y;
        const totalPdfDx = totalScreenDx / currentZoomLevel;
        const totalPdfDy = -totalScreenDy / currentZoomLevel;
        
        const newPoints = initialPoints.map(p => ({
          x: p.x + totalPdfDx,
          y: p.y + totalPdfDy,
        }));
        
        // Update bounding box
        const minX = Math.min(newPoints[0].x, newPoints[1].x);
        const maxX = Math.max(newPoints[0].x, newPoints[1].x);
        const minY = Math.min(newPoints[0].y, newPoints[1].y);
        const maxY = Math.max(newPoints[0].y, newPoints[1].y);
        
        updateAnnotation(
          currentDocument.getId(),
          draggingShapeId,
          {
            points: newPoints,
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY,
          }
        );

        // Update editingAnnotation if it's the one being dragged
        if (editingAnnotation?.id === draggingShapeId) {
          setEditingAnnotation({
            ...editingAnnotation,
            points: newPoints,
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY,
          });
        }
      } else {
        // For rectangles and circles, move x and y
        const newX = shapeDragStartRef.current.annotX + pdfDx;
        const newY = shapeDragStartRef.current.annotY + pdfDy;

        updateAnnotation(
          currentDocument.getId(),
          draggingShapeId,
          { x: newX, y: newY }
        );

        // Update editingAnnotation if it's the one being dragged
        if (editingAnnotation?.id === draggingShapeId) {
          setEditingAnnotation({
            ...editingAnnotation,
            x: newX,
            y: newY,
          });
        }

        // Update drag start for incremental movement
        shapeDragStartRef.current = {
          x: e.clientX,
          y: e.clientY,
          annotX: newX,
          annotY: newY,
        };
      }
    };

    const handleMouseUp = () => {
      if (draggingShapeId && shapeDragStartRef.current && currentDocument) {
        // Get the initial position from when drag started
        const annotations = getAnnotations(currentDocument.getId());
        const annot = annotations.find(a => a.id === draggingShapeId);
        
        if (!annot) {
          setDraggingShapeId(null);
          shapeDragStartRef.current = null;
          return;
        }

        // Check if position actually changed
        if (annot.shapeType === "arrow" && annot.points && shapeDragStartRef.current.points) {
          // For arrows, check if points changed
          const initialPoints = shapeDragStartRef.current.points;
          const pointsChanged = initialPoints.some((p, i) => 
            Math.abs(p.x - annot.points![i].x) > 0.01 || 
            Math.abs(p.y - annot.points![i].y) > 0.01
          );
          
          if (pointsChanged) {
            wrapAnnotationUpdate(
              currentDocument.getId(),
              draggingShapeId,
              {
                points: annot.points,
                x: annot.x,
                y: annot.y,
                width: annot.width,
                height: annot.height,
              }
            );
          }
        } else {
          // For rectangles and circles, check if x/y changed
          const initialX = shapeDragStartRef.current.annotX;
          const initialY = shapeDragStartRef.current.annotY;
          const finalX = annot.x;
          const finalY = annot.y;

          if (Math.abs(initialX - finalX) > 0.01 || Math.abs(initialY - finalY) > 0.01) {
            wrapAnnotationUpdate(
              currentDocument.getId(),
              draggingShapeId,
              { x: finalX, y: finalY }
            );
          }
        }
      }
      setDraggingShapeId(null);
      shapeDragStartRef.current = null;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [draggingShapeId, currentDocument, zoomLevel, editingAnnotation, updateAnnotation, getAnnotations, zoomLevelRef]);

  // RAF coalescing for per-mousemove store writes. mousemove can fire at
  // 120+ events/sec; updateAnnotation/setPanOffset each re-render every
  // subscriber, so we batch to at most one store write per frame. The refs
  // hold the LATEST values; the RAF callback applies them.
  const dupDragRafRef = useRef<number | null>(null);
  const pendingDupUpdateRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const panRafRef = useRef<number | null>(null);

  const handleMouseMove = (e: React.MouseEvent) => {
    // Track shift key state
    setIsShiftPressed(e.shiftKey);
    
    // Always track mouse position in PDF coordinates for paste operations
    // This ensures we know where to paste even when not using highlight tool
    const coords = getPDFCoordinates(e);
    if (coords) {
      mousePositionRef.current = coords;
    }
    
    // Track mouse position for cursor preview (when highlight tool is active)
    if ((activeTool === "highlight" || activeTool === "strikethrough") && !isDragging && !isSelecting) {
      if (coords) {
        const canvasPos = pdfToCanvas(coords.x, coords.y);
        // Canvas pixel = display coordinates (1:1 mapping)
        setMousePosition(canvasPos);
      }
    } else if (activeTool !== "highlight" || isSelecting) {
      setMousePosition(null);
    }

    // Handle duplicate drag if active
    if (duplicatingAnnotationRef.current && currentDocument) {
      const dupInfo = duplicatingAnnotationRef.current;
      const annotations = getAnnotations(currentDocument.getId());
      const duplicateAnnotation = annotations.find(a => a.id === dupInfo.duplicateId);
      
      if (duplicateAnnotation) {
        // Calculate mouse delta in screen coordinates
        const screenDeltaX = e.clientX - dupInfo.mouseStartX;
        const screenDeltaY = e.clientY - dupInfo.mouseStartY;
        
        // Convert screen pixels to PDF coordinates (1:1 mapping with BASE_SCALE = 1.0)
        const currentZoomLevel = zoomLevelRef.current;
        
        const pdfDeltaX = screenDeltaX / currentZoomLevel;
        const pdfDeltaY = -screenDeltaY / currentZoomLevel; // Negate Y
        
        // Update duplicate position — coalesced to one store write per frame
        const newX = dupInfo.startX + pdfDeltaX;
        const newY = dupInfo.startY + pdfDeltaY;

        pendingDupUpdateRef.current = { id: dupInfo.duplicateId, x: newX, y: newY };
        if (dupDragRafRef.current === null) {
          dupDragRafRef.current = requestAnimationFrame(() => {
            dupDragRafRef.current = null;
            const pending = pendingDupUpdateRef.current;
            if (!pending || !currentDocument) return;
            updateAnnotation(currentDocument.getId(), pending.id, { x: pending.x, y: pending.y });

            // Update editing annotation if it's the duplicate
            if (editingAnnotation && editingAnnotation.id === pending.id) {
              setEditingAnnotation({
                ...editingAnnotation,
                x: pending.x,
                y: pending.y,
              });
            }
          });
        }
      }
    } else if (isDragging && !readMode) {
      // Pan dragging - update pan offset and ensure we're in custom mode
      // Skip in read mode - native scrolling handles panning there
      const newPanX = e.clientX - dragStart.x;
      const newPanY = e.clientY - dragStart.y;
      
      // Update ref immediately for smooth operation
      panOffsetRef.current = { x: newPanX, y: newPanY };

      // Switch to custom mode if needed (only once, not on every move)
      if (fitMode !== "custom") {
        fitModeRef.current = "custom";
        setFitMode("custom");
      }

      // Update pan offset state — coalesced to one write per frame; the ref
      // above always carries the freshest value for the RAF to flush.
      if (panRafRef.current === null) {
        panRafRef.current = requestAnimationFrame(() => {
          panRafRef.current = null;
          setPanOffset({ ...panOffsetRef.current });
        });
      }
    } else if (isCreatingTextBox && textBoxStart) {
      // User is dragging to create a text box - update preview
      const coords = getPDFCoordinates(e);
      if (coords) {
        setSelectionEnd(coords);
      }
    } else if (isSelecting && selectionStart) {
      const coords = getPDFCoordinates(e);
      if (coords) {
        // For highlight tool with shift, the tool handler will update selectionEnd with locked coordinates
        // So we should use the updated selectionEnd for path tracking, not raw coords
        if ((activeTool === "highlight" || activeTool === "strikethrough") && e.shiftKey) {
          // Let the tool handler update selectionEnd first, then we'll track it
          setSelectionEnd(coords);
        } else {
          setSelectionEnd(coords);
          
          // Track overlay path directly here for live preview - update immediately
          if ((activeTool === "highlight" || activeTool === "strikethrough")) {
            setOverlayHighlightPath(prev => {
              // Always add the new point for smooth continuous preview
              // Only skip if it's exactly the same (within very small tolerance)
              if (prev.length === 0 || 
                  Math.abs(prev[prev.length - 1].x - coords.x) > 0.01 || 
                  Math.abs(prev[prev.length - 1].y - coords.y) > 0.01) {
                return [...prev, coords];
              }
              return prev;
            });
          }
        }
      }
    }
    
    // For selectText or highlight tool, check if hovering over text for cursor changes
    if ((activeTool === "selectText" || (activeTool === "highlight" || activeTool === "strikethrough")) && !isSelecting && !selectionStart) {
      const coords = getPDFCoordinates(e);
      if (coords && allTextSpansRef.current.length > 0) {
        // Check if mouse is over any text span
        const isOverText = allTextSpansRef.current.some((span) => {
          const [spanX0, spanY0, spanX1, spanY1] = span.bbox;
          return (
            coords.x >= spanX0 &&
            coords.x <= spanX1 &&
            coords.y >= spanY0 &&
            coords.y <= spanY1
          );
        });
        setIsHoveringOverText(isOverText);
      } else {
        setIsHoveringOverText(false);
      }
    } else if (activeTool !== "selectText" && activeTool !== "highlight") {
      setIsHoveringOverText(false);
    }
    
    // For select tool, detect hover over annotations (text boxes and highlights)
    if (activeTool === "select" && !isDragging && !isSelecting && coords) {
      let foundHover = false;
      
      // Check if hovering over any annotation
      for (const annot of annotations) {
        if (annot.type === "text") {
          // Check if mouse is over text box
          const canvasPos = pdfToCanvas(annot.x, annot.y);
          // Canvas pixel = display coordinates (1:1 mapping)
          const displayX = canvasPos.x;
          const displayY = canvasPos.y;
          const width = annot.width || 200;
          const height = annot.height || 100;
          
          // Get mouse position in display coordinates
          const mouseCanvasPos = pdfToCanvas(coords.x, coords.y);
          const mouseDisplayX = mouseCanvasPos.x;
          const mouseDisplayY = mouseCanvasPos.y;
          
          if (
            mouseDisplayX >= displayX &&
            mouseDisplayX <= displayX + width &&
            mouseDisplayY >= displayY &&
            mouseDisplayY <= displayY + height
          ) {
            setHoveredAnnotationId(annot.id);
            foundHover = true;
            break;
          }
        } else if (annot.type === "highlight") {
          // Check if mouse is over highlight
          if (annot.highlightMode === "overlay" && annot.path && annot.path.length > 0) {
            // For overlay highlights, use bounding box approach for reliable hover detection
            const strokeWidth = annot.strokeWidth || 15;
            const padding = strokeWidth / 2 + 10; // Half stroke width plus padding for easier selection

            // Calculate bounding box from path points using a single loop (avoids creating temp arrays)
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (const p of annot.path) {
              if (p.x < minX) minX = p.x;
              if (p.x > maxX) maxX = p.x;
              if (p.y < minY) minY = p.y;
              if (p.y > maxY) maxY = p.y;
            }
            minX -= padding;
            maxX += padding;
            minY -= padding;
            maxY += padding;
            
            // Check if mouse is within the expanded bounding box
            if (
              coords.x >= minX &&
              coords.x <= maxX &&
              coords.y >= minY &&
              coords.y <= maxY
            ) {
              setHoveredAnnotationId(annot.id);
              foundHover = true;
              break;
            }
          } else if (annot.quads && annot.quads.length > 0) {
            // For text selection highlights, check if mouse is over any quad
            const isOverQuad = annot.quads.some((quad: number[]) => {
              if (!Array.isArray(quad) || quad.length < 8) return false;
              
              const minX = Math.min(quad[0], quad[2], quad[4], quad[6]);
              const minY = Math.min(quad[1], quad[3], quad[5], quad[7]);
              const maxX = Math.max(quad[0], quad[2], quad[4], quad[6]);
              const maxY = Math.max(quad[1], quad[3], quad[5], quad[7]);
              
              return (
                coords.x >= minX &&
                coords.x <= maxX &&
                coords.y >= minY &&
                coords.y <= maxY
              );
            });
            
            if (isOverQuad) {
              setHoveredAnnotationId(annot.id);
              foundHover = true;
              break;
            }
          }
        } else if (annot.type === "strikethrough") {
          // Reuse highlight quad hit-testing for strikethroughs
          if (annot.quads && annot.quads.length > 0) {
            const isOverQuad = annot.quads.some((quad: number[]) => {
              if (!Array.isArray(quad) || quad.length < 8) return false;
              const minX = Math.min(quad[0], quad[2], quad[4], quad[6]);
              const minY = Math.min(quad[1], quad[3], quad[5], quad[7]);
              const maxX = Math.max(quad[0], quad[2], quad[4], quad[6]);
              const maxY = Math.max(quad[1], quad[3], quad[5], quad[7]);
              return coords.x >= minX && coords.x <= maxX && coords.y >= minY && coords.y <= maxY;
            });
            if (isOverQuad) {
              setHoveredAnnotationId(annot.id);
              foundHover = true;
              break;
            }
          }
        }
      }

      if (!foundHover) {
        setHoveredAnnotationId(null);
      }
    } else if (activeTool !== "select") {
      setHoveredAnnotationId(null);
    }
    
    // For selectText tool, also handle mouseMove when selectionStart exists (even if isSelecting is false)
    // This allows the tool to detect drag and set isSelecting to true
    if (activeTool === "selectText" && selectionStart && !isSelecting) {
      const coords = getPDFCoordinates(e);
      if (coords && currentDocument) {
        const toolHandler = toolHandlers[activeTool];
        if (toolHandler && toolHandler.handleMouseMove) {
          toolHandler.handleMouseMove(e, baseToolContext);
        }
      }
    } else if (isSelecting && selectionStart && activeTool === "selectText") {
      // Update text selection preview for selectText tool when already selecting
      const coords = getPDFCoordinates(e);
      if (coords && currentDocument) {
        const toolHandler = toolHandlers[activeTool];
        if (toolHandler && toolHandler.handleMouseMove) {
          toolHandler.handleMouseMove(e, baseToolContext);
        }
      }
    }

    // Handle highlight tool mouse move for overlay path and shift+drag
    if ((activeTool === "highlight" || activeTool === "strikethrough") && isSelecting && selectionStart && currentDocument) {
      const toolHandler = toolHandlers[activeTool];
      if (toolHandler && toolHandler.handleMouseMove) {
        const highlightToolContext = {
          ...baseToolContext,
          setSelectionEnd: (coords: { x: number; y: number } | null) => {
            setSelectionEnd(coords);
            // Track overlay path using the updated selectionEnd (includes shift-locked coordinates)
            // Only add to overlay path if NOT in text mode (text mode shows text selection preview instead)
            if (coords && (activeTool === "highlight" || activeTool === "strikethrough") && !isHighlightTextMode) {
              setOverlayHighlightPath(prev => {
                // Always add the first point if path is empty
                if (prev.length === 0) {
                  return [coords];
                }

                // For subsequent points, add if coordinates changed significantly
                const lastPoint = prev[prev.length - 1];
                const dx = Math.abs(lastPoint.x - coords.x);
                const dy = Math.abs(lastPoint.y - coords.y);
                const distance = Math.sqrt(dx * dx + dy * dy);
                const shouldAdd = distance > 0.05;

                // Also check if this exact point (within tolerance) already exists in the path
                const pointExists = prev.some(p => {
                  const pDx = Math.abs(p.x - coords.x);
                  const pDy = Math.abs(p.y - coords.y);
                  return Math.sqrt(pDx * pDx + pDy * pDy) <= 0.05;
                });

                if (shouldAdd && !pointExists) {
                  return [...prev, coords];
                }
                return prev;
              });
            }
          },
          overlayHighlightPath,
          setOverlayHighlightPath,
        };

        toolHandler.handleMouseMove(e, highlightToolContext);
      }
    }

    // Handle generic tool mouse move for draw, shape, form, and signatureField tools
    if ((activeTool === "draw" || activeTool === "shape" || activeTool === "form" || activeTool === "signatureField") &&
        (isSelecting || selectionStart) && currentDocument) {
      const toolHandler = toolHandlers[activeTool];
      if (toolHandler && toolHandler.handleMouseMove) {
        toolHandler.handleMouseMove(e, baseToolContext);
      }
    }

    // Handle stamp tool mouse move for preview - always call when stamp tool is active
    if (activeTool === "stamp" && currentDocument) {
      const toolHandler = toolHandlers["stamp"];
      if (toolHandler && toolHandler.handleMouseMove) {
        toolHandler.handleMouseMove(e, baseToolContext);
      }
    }
  };

  // Handle drag and drop PDF files to insert pages
  // Use useEffect to attach native event listeners that fire before react-dropzone
  useEffect(() => {
    if (!containerRef.current || !currentDocument) {
      setIsDragOverPage(false);
      return;
    }

    const container = containerRef.current;
    let dragOverTimeout: NodeJS.Timeout | null = null;

    const handleDragOver = (e: DragEvent) => {
      // Check if dragging a PDF file or image file
      const hasPdf = Array.from(e.dataTransfer?.items || []).some(
        (item) => item.type === "application/pdf" || (item.type === "" && item.kind === "file")
      );
      
      const hasImage = Array.from(e.dataTransfer?.items || []).some(
        (item) => item.type.startsWith("image/") || 
                  (item.kind === "file" && (
                    item.type === "" || 
                    item.type === "image/jpeg" || 
                    item.type === "image/jpg" || 
                    item.type === "image/png"
                  ))
      );
      
      if (hasPdf || hasImage) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        
        // Clear any pending timeout
        if (dragOverTimeout) {
          clearTimeout(dragOverTimeout);
        }
        
        // Use requestAnimationFrame to ensure state update happens
        requestAnimationFrame(() => {
          setIsDragOverPage(true);
        });
      }
    };

    const handleDragLeave = (e: DragEvent) => {
      // Only hide if we're actually leaving the container
      const rect = container.getBoundingClientRect();
      const x = e.clientX;
      const y = e.clientY;
      
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        
        // Delay to prevent flickering when moving between child elements
        dragOverTimeout = setTimeout(() => {
          setIsDragOverPage(false);
        }, 50);
      }
    };

    const handleDrop = async (e: DragEvent) => {
      console.log("Drop event fired", e.dataTransfer?.files?.length, "files");
      
      // Check if drop is actually on this page canvas
      const target = e.target as HTMLElement;
      if (target && !container.contains(target) && target !== container) {
        console.log("Drop target is not in container, ignoring");
        return;
      }
      
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      
      if (dragOverTimeout) {
        clearTimeout(dragOverTimeout);
      }
      setIsDragOverPage(false);

      const files = Array.from(e.dataTransfer?.files || []);
      console.log("Files in drop:", files.map(f => ({ name: f.name, type: f.type })));
      
      // Check for PDF file first (existing behavior)
      const pdfFile = files.find(
        (file) => file.type === "application/pdf" || file.name.endsWith(".pdf")
      );

      if (pdfFile) {
        // Handle PDF file drop (existing behavior)
        const pdfStore = usePDFStore.getState();
        try {
          pdfStore.setLoading(true);
          pdfStore.clearError();
          
          // Load the dropped PDF as a new document/tab
          const arrayBuffer = await pdfFile.arrayBuffer();
          const data = new Uint8Array(arrayBuffer);
          const mupdfModule = await import("mupdf");
          
          // Use the store directly to create new document and tab
          const tabStore = (await import("@/shared/stores/tabStore")).useTabStore.getState();
          
          const documentId = `pdf_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          const document = new PDFDocumentClass(documentId, pdfFile.name, data.length);
          await document.loadFromData(data, mupdfModule.default);
          
          pdfStore.addDocument(document);
          pdfStore.setCurrentDocument(documentId);

          // Load existing annotations from PDF
          const tempEditor = new PDFEditor(mupdfModule.default);
          const pageCount = document.getPageCount();
          const allAnnotations: any[] = [];
          
          for (let i = 0; i < pageCount; i++) {
            const pageAnnotations = await tempEditor.loadAnnotationsFromPage(document, i);
            allAnnotations.push(...pageAnnotations);
          }
          
          // Add loaded annotations to store, checking for duplicates
          const existingAnnotations = pdfStore.getAnnotations(documentId);
          for (const annot of allAnnotations) {
            // Check for duplicates (same logic as usePDF.ts)
            let isDuplicate = false;
            for (const existing of existingAnnotations) {
              if (annot.pdfAnnotation && existing.pdfAnnotation === annot.pdfAnnotation) {
                isDuplicate = true;
                break;
              }
              // For arrows, match by position
              if (annot.type === "shape" && annot.shapeType === "arrow" && 
                  existing.type === "shape" && existing.shapeType === "arrow" &&
                  annot.pageNumber === existing.pageNumber &&
                  annot.points && existing.points && annot.points.length === 2 && existing.points.length === 2) {
                const tolerance = 10;
                const p1Match = Math.abs(annot.points[0].x - existing.points[0].x) < tolerance &&
                                Math.abs(annot.points[0].y - existing.points[0].y) < tolerance;
                const p2Match = Math.abs(annot.points[1].x - existing.points[1].x) < tolerance &&
                                Math.abs(annot.points[1].y - existing.points[1].y) < tolerance;
                const p1ReverseMatch = Math.abs(annot.points[0].x - existing.points[1].x) < tolerance &&
                                       Math.abs(annot.points[0].y - existing.points[1].y) < tolerance;
                const p2ReverseMatch = Math.abs(annot.points[1].x - existing.points[0].x) < tolerance &&
                                       Math.abs(annot.points[1].y - existing.points[0].y) < tolerance;
                if ((p1Match && p2Match) || (p1ReverseMatch && p2ReverseMatch)) {
                  isDuplicate = true;
                  pdfStore.updateAnnotation(documentId, existing.id, {
                    pdfAnnotation: annot.pdfAnnotation || existing.pdfAnnotation,
                    points: annot.points,
                    x: annot.x,
                    y: annot.y,
                    width: annot.width,
                    height: annot.height,
                    strokeColor: annot.strokeColor || existing.strokeColor,
                    strokeWidth: annot.strokeWidth || existing.strokeWidth,
                    arrowHeadSize: annot.arrowHeadSize || existing.arrowHeadSize,
                  });
                  break;
                }
              }
            }
            if (!isDuplicate) {
              pdfStore.addAnnotation(documentId, annot);
            }
          }

          // Create tab for this document
          const tabId = `tab_${documentId}`;
          tabStore.addTab({
            id: tabId,
            documentId,
            name: pdfFile.name,
            isModified: false,
            lastSaved: null, // New document, never saved
            order: tabStore.tabs.length,
          });
        } catch (error) {
          console.error("Error opening PDF as new tab:", error);
          pdfStore.setError(
            error instanceof Error ? error.message : "Failed to load PDF"
          );
        } finally {
          pdfStore.setLoading(false);
        }
        return;
      }

      // Check for image files (JPG, PNG)
      const imageFile = files.find(
        (file) => 
          file.type === "image/jpeg" || 
          file.type === "image/jpg" || 
          file.type === "image/png" ||
          file.name.toLowerCase().endsWith(".jpg") ||
          file.name.toLowerCase().endsWith(".jpeg") ||
          file.name.toLowerCase().endsWith(".png")
      );

      if (imageFile && currentDocument && (pageContentRef.current ?? canvasRef.current)) {
        console.log("Image file detected:", imageFile.name, imageFile.type);
        // Save the current page before async operations — something else
        // could reset currentPage during the await gap
        const savedPageNumber = pageNumber;
        try {
          // Convert image to base64 data URL
          // Use FileReader to avoid stack overflow with large images
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              if (typeof reader.result === 'string') {
                resolve(reader.result);
              } else {
                reject(new Error('Failed to read file as data URL'));
              }
            };
            reader.onerror = (err) => {
              console.error("FileReader error:", err);
              reject(new Error('FileReader failed'));
            };
            reader.readAsDataURL(imageFile);
          });

          console.log("Image converted to data URL, length:", dataUrl.length);

          // Load image to get dimensions
          const img = new Image();
          await new Promise((resolve, reject) => {
            img.onload = () => {
              console.log("Image loaded, dimensions:", img.width, "x", img.height);
              resolve(undefined);
            };
            img.onerror = (err) => {
              console.error("Image load error:", err);
              reject(new Error('Failed to load image'));
            };
            img.src = dataUrl;
          });

          const imageWidth = img.width;
          const imageHeight = img.height;

          // Get drop coordinates in PDF space
          const canvasElement = pageContentRef.current ?? canvasRef.current;
          const pageMetadata = currentDocument.getPageMetadata(pageNumber);

          if (!canvasElement || !pageMetadata) {
            console.warn("Cannot get page metadata for image drop");
            showNotification("Cannot get page metadata for image drop", "error");
            return;
          }

          // Get page-content position on screen
          const canvasRect = canvasElement.getBoundingClientRect();

          if (canvasRect.width === 0 || canvasRect.height === 0) {
            console.warn("Page has invalid display dimensions");
            showNotification("Page has invalid display dimensions", "error");
            return;
          }
          
          // Calculate drop position relative to canvas
          const canvasRelativeX = e.clientX - canvasRect.left;
          const canvasRelativeY = e.clientY - canvasRect.top;
          
          console.log("Drop position:", e.clientX, e.clientY, "Canvas relative:", canvasRelativeX, canvasRelativeY);
          
          // Convert directly from canvas display size (CSS pixels) to PDF coordinates
          // Use display dimensions for 1:1 mapping (match getPDFCoordinates)
          const mediaboxWidth = pageMetadata.width;
          const mediaboxHeight = pageMetadata.height;
          
          // Convert directly from display size ratio to PDF coordinates (1:1 mapping)
          const pdfX = (canvasRelativeX / canvasRect.width) * mediaboxWidth;
          const pdfY = mediaboxHeight - ((canvasRelativeY / canvasRect.height) * mediaboxHeight);

          // Calculate initial size (max 300x300 PDF points, maintain aspect ratio)
          const maxSize = 300;
          const aspectRatio = imageWidth / imageHeight;
          let initialWidth = maxSize;
          let initialHeight = maxSize / aspectRatio;
          
          if (initialHeight > maxSize) {
            initialHeight = maxSize;
            initialWidth = maxSize * aspectRatio;
          }

          // Position image at drop location (center the image on drop point)
          const imageX = pdfX - (initialWidth / 2);
          const imageY = pdfY - (initialHeight / 2);

          console.log("Creating image annotation at PDF coords:", imageX, imageY, "Size:", initialWidth, initialHeight);

          // Create image annotation
          const imageAnnotation: Annotation = {
            id: `image_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            type: "image",
            pageNumber,
            x: imageX,
            y: imageY,
            width: initialWidth,
            height: initialHeight,
            imageData: dataUrl,
            imageWidth,
            imageHeight,
            preserveAspectRatio: true,
          };

          // Add annotation to store with undo/redo support
          wrapAnnotationOperation(
            () => {
              addAnnotation(currentDocument.getId(), imageAnnotation);
            },
            "addAnnotation",
            currentDocument.getId(),
            imageAnnotation.id,
            imageAnnotation
          );
          console.log("Image annotation added to store:", imageAnnotation.id);

          // Select the new image annotation
          setEditingAnnotation(imageAnnotation);

          // Defensive: restore currentPage if it was changed during async ops
          const currentPageAfter = usePDFStore.getState().currentPage;
          if (currentPageAfter !== savedPageNumber) {
            usePDFStore.getState().setCurrentPage(savedPageNumber);
          }

          showNotification("Image added successfully!", "success");
        } catch (error) {
          console.error("Error adding image annotation:", error);
          const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
          showNotification(`Failed to add image: ${errorMessage}`, "error");
        }
        return;
      }

      // No supported file type found
      console.warn("No supported file found in drop (PDF or image)");
    };

    // Use capture phase to intercept before react-dropzone
    container.addEventListener('dragover', handleDragOver, true);
    container.addEventListener('dragleave', handleDragLeave, true);
    container.addEventListener('drop', handleDrop, true);

    return () => {
      if (dragOverTimeout) {
        clearTimeout(dragOverTimeout);
      }
      container.removeEventListener('dragover', handleDragOver, true);
      container.removeEventListener('dragleave', handleDragLeave, true);
      container.removeEventListener('drop', handleDrop, true);
    };
  }, [currentDocument, editor, pageNumber, getAnnotations, setCurrentPage]);


  const handleMouseUp = async (e: React.MouseEvent) => {
    // Clear middle mouse button tracking
    if (e.button === 1) {
      isMiddleMouseDownRef.current = false;
    }
    
    // Handle duplicate drag end
    if (duplicatingAnnotationRef.current && currentDocument) {
      const dupInfo = duplicatingAnnotationRef.current;
      const annotations = getAnnotations(currentDocument.getId());
      const duplicateAnnotation = annotations.find(a => a.id === dupInfo.duplicateId);
      
      if (duplicateAnnotation) {
        // Record undo for the duplicate position change
        const initialPos = { x: dupInfo.startX, y: dupInfo.startY };
        const finalPos = { x: duplicateAnnotation.x, y: duplicateAnnotation.y };
        
        // Only record undo if position actually changed
        if (initialPos.x !== finalPos.x || initialPos.y !== finalPos.y) {
          wrapAnnotationUpdate(
            currentDocument.getId(),
            dupInfo.duplicateId,
            finalPos
          );
        }
      }
      
      // Clear duplicate drag tracking
      duplicatingAnnotationRef.current = null;
      draggingAnnotationRef.current = null;
    } else if (isDragging) {
      setIsDragging(false);
    } else if (currentDocument && activeTool === "selectText" && selectionStart && selectionEnd) {
      // Handle text selection using mupdf's highlight method
      try {
        const isClick = Math.abs(selectionStart.x - selectionEnd.x) < 1 && Math.abs(selectionStart.y - selectionEnd.y) < 1;
        
        // Single clicks should not select anything - only drags should select text
        if (isClick) {
          // Clear any previous selection and reset state
          setSelectedTextSpans([]);
          selectedTextRef.current = "";
          useCtoTextSelectionStore.getState().clearSelection();
          setIsSelecting(false);
          setSelectionStart(null);
          setSelectionEnd(null);
          return;
        }
        
        // For drags, use the actual selection
        const result = await getSpansInSelectionFromPage(
          currentDocument,
          pageNumber,
          selectionStart,
          selectionEnd
        );
        
        // Store the final selection spans and text
        setSelectedTextSpans(result.spans);
        selectedTextRef.current = result.text;
        
        // When embedded in CTO, store the selection (0-based page per CTO contract) so the
        // floating selection toolbar can offer Ask AI / Highlight / Copy / Add to table.
        // Anchor the toolbar at the cursor-release point.
        if (result.text?.trim()) {
          const params = parseCiviltakeoffViewParams(typeof window !== "undefined" ? window.location.search : "");
          if (params.token) {
            const anchor = globalMousePositionRef.current
              ? { x: globalMousePositionRef.current.clientX, y: globalMousePositionRef.current.clientY }
              : null;
            useCtoTextSelectionStore.getState().setSelection(pageNumber, result.text.trim(), anchor);
          }
        }
        
        // Stop the selection process (set isSelecting=false) but keep the spans visible
        // The selectedTextSpans will remain visible until user clicks and drags again
        setIsSelecting(false);
        
        // Clear selectionStart/selectionEnd to stop handleMouseMove from continuing
        // The selectedTextSpans are already stored, so we don't need these anymore
        setSelectionStart(null);
        setSelectionEnd(null);
        
        if (!result.text) {
          console.warn("No text selected");
        }
      } catch (error) {
        console.error("Error extracting text selection:", error);
        setSelectedTextSpans([]);
        selectedTextRef.current = "";
        useCtoTextSelectionStore.getState().clearSelection();
        setIsSelecting(false);
        setSelectionStart(null);
        setSelectionEnd(null);
      }
    } else if (currentDocument && activeTool !== "select" && activeTool !== "pan" && activeTool !== "selectText") {
      // Use tool handlers for ALL tools that have mouse up logic (not just text tool)
      const toolHandler = toolHandlers[activeTool];
      if (toolHandler && toolHandler.handleMouseUp) {
        const toolContext = (activeTool === "highlight" || activeTool === "strikethrough")
          ? { ...baseToolContext, setActiveTool, overlayHighlightPath, setOverlayHighlightPath }
          : { ...baseToolContext, setActiveTool };

        // For highlight tool, ensure we have selectionEnd from the path if it's missing
        let finalSelectionEnd = selectionEnd;
        if ((activeTool === "highlight" || activeTool === "strikethrough")) {
          if (!finalSelectionEnd && selectionStart && overlayHighlightPath.length > 0) {
            // Use the last point in the path as selectionEnd
            finalSelectionEnd = overlayHighlightPath[overlayHighlightPath.length - 1];
          } else if (!finalSelectionEnd && selectionStart) {
            // Fallback: use selectionStart if no end point
            finalSelectionEnd = selectionStart;
          }
        }
        
        await toolHandler.handleMouseUp(e, toolContext, selectionStart, finalSelectionEnd || selectionStart, textBoxStart);
      }
    }
    
    // Clean up text box creation state
    if (isCreatingTextBox) {
      setIsCreatingTextBox(false);
      setTextBoxStart(null);
      setSelectionEnd(null);
    }
    
    // Clean up overlay highlight path - but only after highlight is committed
    // Don't clear if we're still in the process of creating it
    if ((activeTool === "highlight" || activeTool === "strikethrough") && !isSelecting) {
      // Use setTimeout to ensure cleanup happens after highlight is committed
      // Give it a longer delay to ensure the tool handler has finished
      setTimeout(() => {
        setOverlayHighlightPath([]);
        setIsHighlightTextMode(false);
        setMousePosition(null);
        setIsShiftPressed(false);
      }, 100);
    }
  };

  // Prevent context menu on middle click
  const handleContextMenu = (e: React.MouseEvent) => {
    // Always prevent the browser context menu on the canvas
    e.preventDefault();

    // Show annotation context menu when right-clicking on a hovered annotation
    if (activeTool === "select" && hoveredAnnotationId) {
      setContextMenu({ x: e.clientX, y: e.clientY, annotationId: hoveredAnnotationId });
    } else {
      setContextMenu(null);
    }
  };

  const contextMenuItems = useMemo((): ContextMenuItem[] => {
    if (!contextMenu || !currentDocument) return [];
    const docId = currentDocument.getId();
    const annot = annotations.find(a => a.id === contextMenu.annotationId);
    if (!annot) return [];

    return [
      {
        label: "Duplicate",
        onClick: () => {
          const newId = crypto.randomUUID();
          const duplicate = { ...annot, id: newId, x: annot.x + 10, y: annot.y - 10 };
          addAnnotation(docId, duplicate);
        },
      },
      {
        label: "Delete",
        onClick: () => {
          wrapAnnotationOperation(() => {
            removeAnnotation(docId, annot.id);
          }, "removeAnnotation", docId, annot.id, annot);
          setEditingAnnotation(null);
        },
      },
    ];
  }, [contextMenu, currentDocument, annotations, addAnnotation, removeAnnotation]);

  // Viewport culling: skip rendering annotations that are entirely off-screen.
  // Only applies in non-read mode (single-page view with pan/zoom) when there are many annotations.
  // In read mode, VirtualizedPageList handles page-level culling and CSS scaling handles the rest.
  const ANNOTATION_CULL_THRESHOLD = 30;
  const visibleAnnotations = useMemo(() => {
    if (readMode || annotations.length < ANNOTATION_CULL_THRESHOLD) return annotations;

    const containerEl = containerRef.current;
    if (!containerEl || !pageMetadata) return annotations;

    const containerWidth = containerEl.clientWidth;
    const containerHeight = containerEl.clientHeight;
    if (containerWidth <= 0 || containerHeight <= 0) return annotations;

    // Viewport bounds in PDF coordinate space
    const viewLeft = -panOffset.x / zoomLevel;
    const viewTop = -panOffset.y / zoomLevel;
    const viewRight = viewLeft + containerWidth / zoomLevel;
    const viewBottom = viewTop + containerHeight / zoomLevel;

    // Convert viewport to PDF coords (Y axis flip: PDF Y=0 at bottom)
    const pageH = pageMetadata.height;
    const pdfViewLeft = viewLeft;
    const pdfViewRight = viewRight;
    const pdfViewBottom = pageH - viewBottom;
    const pdfViewTop = pageH - viewTop;

    const padding = 200; // PDF points (~2.8in) to prevent pop-in

    return annotations.filter(annot => {
      // Path-based annotations (highlights, drawings) have complex bounds — skip culling
      if (annot.type === "highlight" || annot.type === "strikethrough" || annot.type === "draw") return true;

      const ax = annot.x ?? 0;
      const ay = annot.y ?? 0;
      const aw = annot.width || 200;
      const ah = annot.height || 100;

      // Check if annotation bbox overlaps visible viewport (with padding)
      return !(ax + aw < pdfViewLeft - padding ||
               ax > pdfViewRight + padding ||
               ay + ah < pdfViewBottom - padding ||
               ay > pdfViewTop + padding);
    });
  }, [readMode, annotations, panOffset, zoomLevel, pageMetadata]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-destructive">
        {error}
      </div>
    );
  }

  const canPan = isSpacePressed || activeTool === "pan";
  const cursor = isDragging
    ? "grabbing"
    : canPan
    ? "grab"
    : activeTool === "text"
    ? "text"
    : activeTool === "selectText"
    ? "text" // Always show text cursor so user sees the tool is active (e.g. in CTO split screen)
    : (activeTool === "highlight" || activeTool === "strikethrough")
    ? isSelecting 
      ? "text" // Show text cursor while selecting/dragging
      : isHoveringOverText
        ? "text" // Show text cursor when hovering over text
        : "crosshair"
    : activeTool === "callout"
    ? "crosshair"
    : activeTool === "redact"
    ? "crosshair"
    : activeTool === "signatureField"
    ? "crosshair"
    : "default";

  return (
    <div
      ref={containerRef}
      data-page-canvas={pageNumber}
      className={cn(
        "relative transition-all duration-200",
        readMode ? "" : "w-full",
        readMode ? "" : "h-full",
        readMode ? "" : "bg-muted", // Only show background in normal mode, not read mode
        // In read mode when zoomed, allow overflow so content isn't cut off
        readMode && fitMode === "custom" ? "overflow-visible" : "overflow-hidden",
        isDragOverPage && "ring-4 ring-primary ring-offset-4 bg-primary/10"
      )}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={(e) => {
        // If we're in the middle of a highlight drag, commit it before cleaning up
        if ((activeTool === "highlight" || activeTool === "strikethrough") && isSelecting && selectionStart && overlayHighlightPath.length > 0) {
          // Use the last point in the path as selectionEnd to ensure we commit the highlight
          const lastPoint = overlayHighlightPath[overlayHighlightPath.length - 1];
          if (lastPoint) {
            // Set selectionEnd first
            setSelectionEnd(lastPoint);
            
            // Create a synthetic mouse event to commit the highlight
            const syntheticEvent = {
              ...e,
              shiftKey: false, // Can't determine shift state when mouse leaves
            } as React.MouseEvent;
            
            // Small delay to ensure state is updated before calling handleMouseUp
            setTimeout(() => {
              handleMouseUp(syntheticEvent);
            }, 0);
          }
        } else {
          handleMouseUp(e);
        }
        setIsHoveringOverText(false);
        setMousePosition(null);
        setIsShiftPressed(false);
      }}
      onContextMenu={handleContextMenu}
      // Remove React handlers - using native handlers in useEffect instead
      style={{ 
        cursor, 
        margin: 0, // No margin in read mode - parent handles positioning
        padding: 0, 
        lineHeight: readMode ? 0 : undefined, 
        fontSize: readMode ? 0 : undefined,
        display: readMode ? 'block' : undefined, // Block display in read mode to remove inline spacing
        width: readMode ? '100%' : undefined, // Fill parent width in read mode
        height: readMode ? '100%' : undefined, // Fill parent height in read mode
        boxSizing: readMode ? 'border-box' : undefined, // Ensure no extra spacing
        overflow: readMode ? 'hidden' : undefined, // Prevent overflow gaps
      } as React.CSSProperties}
    >
      {/* Rulers - only in normal mode when enabled */}
      {!readMode && showRulers && containerRef.current && pageMetadata && (
        <>
          <HorizontalRuler
            width={pageMetadata.width}
            zoomLevel={zoomLevel}
            panOffset={panOffset}
            containerWidth={containerRef.current.clientWidth}
          />
          <VerticalRuler
            height={pageMetadata.height}
            zoomLevel={zoomLevel}
            panOffset={panOffset}
            containerHeight={containerRef.current.clientHeight}
          />
        </>
      )}
      
      {isDragOverPage && (
        <div className="absolute inset-0 flex items-center justify-center z-50 pointer-events-none">
          <div className="bg-primary/20 border-4 border-dashed border-primary rounded-lg p-8 backdrop-blur-sm">
            <div className="text-primary font-bold text-lg text-center">
              Drop PDF here to insert pages after page {pageNumber + 1}
            </div>
          </div>
        </div>
      )}
      <ReadModeScaleWrapper
        active={readMode && pageMetadata != null}
        pageWidth={pageMetadata?.width ?? 0}
        pageHeight={pageMetadata?.height ?? 0}
        displayWidth={displayWidthProp ?? pageMetadata?.width ?? 0}
        displayHeight={displayHeightProp ?? pageMetadata?.height ?? 0}
        scale={readModeAnnotationScale}
      >
        <div
          ref={transformDivRef}
          className={readMode ? "block relative" : "inline-block relative"}
          style={{
            transform: readMode
              ? undefined
              : `scale(${zoomLevel}) translate(${panOffset.x / zoomLevel}px, ${panOffset.y / zoomLevel}px)`,
            transformOrigin: "0 0",
            margin: 0,
            padding: 0,
            lineHeight: readMode ? 0 : undefined,
            fontSize: readMode ? 0 : undefined,
            width: readMode ? "100%" : undefined,
            height: readMode ? "100%" : undefined,
            display: readMode ? "block" : undefined,
            boxSizing: readMode ? "border-box" : undefined,
            overflow: readMode ? "hidden" : undefined,
            position: readMode ? "relative" : undefined,
          }}
        >
          {/* Loading placeholder — visible until the canvas is painted */}
          {readMode && !hasRendered && (
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={{
                zIndex: 0,
                backgroundColor: "var(--color-card, #ffffff)",
                border: "1px solid var(--color-border, #e5e7eb)",
                borderRadius: "2px",
              }}
            >
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <div
                  className="animate-spin rounded-full border-2 border-current border-t-transparent"
                  style={{ width: 24, height: 24 }}
                />
                <span className="text-xs select-none">Loading page {pageNumber + 1}</span>
              </div>
            </div>
          )}
          <div
            style={
              horizontalFlip
                ? { transform: "scaleX(-1)", transformOrigin: "0 0", display: "block" }
                : { display: "block" }
            }
          >
            {useTiledRenderer && tiledRenderer && pageMetadata ? (
              <TiledCanvas
                pageNumber={pageNumber}
                pageDims={{
                  widthPt: pageMetadata.width,
                  heightPt: pageMetadata.height,
                }}
                displayPxPerPoint={debouncedTiledInputs.displayPxPerPoint}
                viewportPdfRect={debouncedTiledInputs.viewportRect}
                renderer={tiledRenderer}
                rootRef={pageContentRef}
                className={cn("block", !readMode && "shadow-2xl")}
                style={{
                  position: "relative",
                  zIndex: 1,
                  verticalAlign: "top",
                  boxSizing: "border-box",
                  flexShrink: 0,
                }}
              />
            ) : (
              <canvas
                ref={(el) => {
                  // Populate both refs: canvasRef (legacy render path uses canvas-specific APIs)
                  // and pageContentRef (coord-calc paths use generic HTMLElement methods).
                  (canvasRef as React.MutableRefObject<HTMLCanvasElement | null>).current = el;
                  pageContentRef.current = el;
                }}
                className={cn("block", !readMode && "shadow-2xl")}
                style={{
                  position: "relative",
                  zIndex: 1,
                  margin: 0,
                  padding: 0,
                  display: "block",
                  verticalAlign: "top",
                  border: "none",
                  outline: "none",
                  backgroundColor: readMode && !hasRendered ? "transparent" : readMode ? undefined : "white",
                  width: readMode && pageMetadata ? pageMetadata.width : undefined,
                  height: readMode && pageMetadata ? pageMetadata.height : undefined,
                  boxSizing: "border-box",
                  flexShrink: 0,
                }}
              />
            )}
          </div>
          {/* Render text box creation preview */}
        {isCreatingTextBox && textBoxStart && selectionEnd && activeTool === "text" && (
          (() => {
            const startCanvas = pdfToCanvas(textBoxStart.x, textBoxStart.y);
            const endCanvas = pdfToCanvas(selectionEnd.x, selectionEnd.y);
            // Canvas pixel = display coordinates (1:1 mapping)
            const minX = Math.min(startCanvas.x, endCanvas.x);
            const minY = Math.min(startCanvas.y, endCanvas.y);
            const width = Math.abs(endCanvas.x - startCanvas.x);
            const height = Math.abs(endCanvas.y - startCanvas.y);
            const minPreviewPx = 8;
            return (
              <div
                className="absolute border-2 border-dashed border-primary bg-primary/10 pointer-events-none z-40"
                style={{
                  left: `${minX}px`,
                  top: `${minY}px`,
                  width: `${Math.max(minPreviewPx, width)}px`,
                  height: `${Math.max(minPreviewPx, height)}px`,
                  borderRadius: "4px",
                }}
              />
            );
          })()
        )}

        {/* Render overlay highlight preview - only show in overlay mode (not text mode) */}
        {/* Need at least 2 points for a polyline to be visible */}
        {(activeTool === "highlight" || activeTool === "strikethrough") && !isHighlightTextMode && overlayHighlightPath.length >= 2 && (isSelecting || selectionStart) && (() => {
          const { highlightColor, highlightStrokeWidth, highlightOpacity } = useUIStore.getState();
          
          // If shift is pressed and we have start and end, show straight line preview
          let pathToRender = overlayHighlightPath;
          if (isShiftPressed && selectionStart && selectionEnd) {
            // Use selectionStart and selectionEnd (which are locked) for straight line preview
            pathToRender = [selectionStart, selectionEnd];
          } else if (isShiftPressed && selectionStart && overlayHighlightPath.length >= 2) {
            // Fallback: use first and last point from path
            const start = overlayHighlightPath[0];
            const end = overlayHighlightPath[overlayHighlightPath.length - 1];
            pathToRender = [start, end];
          }
          
          // Ensure we have at least 2 points to render
          if (pathToRender.length < 2) {
            return null;
          }
          
          // Calculate bounding box for SVG positioning with padding for stroke width
          // Canvas pixel = display coordinates (1:1 mapping)
          const allCanvasX = pathToRender.map(p => pdfToCanvas(p.x, p.y).x);
          const allCanvasY = pathToRender.map(p => pdfToCanvas(p.x, p.y).y);
          
          const minCanvasX = Math.min(...allCanvasX);
          const minCanvasY = Math.min(...allCanvasY);
          const maxCanvasX = Math.max(...allCanvasX);
          const maxCanvasY = Math.max(...allCanvasY);
          
          // Add padding for stroke width to ensure full visibility
          const padding = highlightStrokeWidth / 2;
          // Ensure minimum size for single point or very small paths
          const rawWidth = maxCanvasX - minCanvasX;
          const rawHeight = maxCanvasY - minCanvasY;
          const minSize = highlightStrokeWidth;
          const boxX = minCanvasX - padding;
          const boxY = minCanvasY - padding;
          const boxWidth = Math.max(rawWidth, minSize) + (padding * 2);
          const boxHeight = Math.max(rawHeight, minSize) + (padding * 2);
          
          // Convert path points to relative coordinates within bounding box (with padding)
          // Canvas pixel = display coordinates (1:1 mapping)
          const relativePathPoints = pathToRender.map(p => {
            const canvasPos = pdfToCanvas(p.x, p.y);
            return `${canvasPos.x - boxX},${canvasPos.y - boxY}`;
          }).join(" ");
          
          return (
            <div
              className="absolute pointer-events-none z-50"
              style={{
                left: `${boxX}px`,
                top: `${boxY}px`,
                width: `${boxWidth}px`,
                height: `${boxHeight}px`,
              }}
            >
              <svg
                className="absolute"
                style={{
                  left: 0,
                  top: 0,
                  width: `${boxWidth}px`,
                  height: `${boxHeight}px`,
                  overflow: "visible",
                }}
                viewBox={`0 0 ${boxWidth} ${boxHeight}`}
              >
                <polyline
                  points={relativePathPoints}
                  fill="none"
                  stroke={highlightColor}
                  strokeWidth={highlightStrokeWidth}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={highlightOpacity}
                />
              </svg>
            </div>
          );
        })()}

        {/* Cursor preview circle for highlight tool */}
        {(activeTool === "highlight" || activeTool === "strikethrough") && !isSelecting && mousePosition && (() => {
          const { highlightColor, highlightStrokeWidth, highlightOpacity } = useUIStore.getState();
          
          return (
            <div
              className="absolute pointer-events-none z-50"
              style={{
                left: `${mousePosition.x}px`,
                top: `${mousePosition.y}px`,
                width: `${highlightStrokeWidth}px`,
                height: `${highlightStrokeWidth}px`,
                borderRadius: "50%",
                border: `2px solid ${highlightColor}`,
                backgroundColor: `${highlightColor}${Math.round(highlightOpacity * 255).toString(16).padStart(2, '0')}`,
                opacity: 0.6,
                transform: "translate(-50%, -50%)",
                pointerEvents: "none",
              }}
            />
          );
        })()}

        {/* Render shape preview while creating shapes */}
        {isSelecting && selectionStart && selectionEnd && activeTool === "shape" && (() => {
          const { currentShapeType, shapeStrokeColor, shapeStrokeWidth, shapeFillColor, shapeFillOpacity, arrowHeadSize } = useUIStore.getState();
          
          const startCanvas = pdfToCanvas(selectionStart.x, selectionStart.y);
          const endCanvas = pdfToCanvas(selectionEnd.x, selectionEnd.y);
          
          if (currentShapeType === "arrow") {
            // Render arrow preview
            const dx = endCanvas.x - startCanvas.x;
            const dy = endCanvas.y - startCanvas.y;
            const angle = Math.atan2(dy, dx);
            const headSize = arrowHeadSize || 10;
            
            // Calculate where the line should end (shortened by arrow head size)
            const lineEndX = endCanvas.x - (headSize * Math.cos(angle));
            const lineEndY = endCanvas.y - (headSize * Math.sin(angle));
            
            const arrowHead1X = endCanvas.x - headSize * Math.cos(angle - Math.PI / 6);
            const arrowHead1Y = endCanvas.y - headSize * Math.sin(angle - Math.PI / 6);
            const arrowHead2X = endCanvas.x - headSize * Math.cos(angle + Math.PI / 6);
            const arrowHead2Y = endCanvas.y - headSize * Math.sin(angle + Math.PI / 6);
            
            const minX = Math.min(startCanvas.x, endCanvas.x, arrowHead1X, arrowHead2X) - 10;
            const minY = Math.min(startCanvas.y, endCanvas.y, arrowHead1Y, arrowHead2Y) - 10;
            const maxX = Math.max(startCanvas.x, endCanvas.x, arrowHead1X, arrowHead2X) + 10;
            const maxY = Math.max(startCanvas.y, endCanvas.y, arrowHead1Y, arrowHead2Y) + 10;
            
            return (
              <div
                key="arrow-preview"
                className="absolute pointer-events-none z-50"
                style={{
                  left: `${minX}px`,
                  top: `${minY}px`,
                  width: `${maxX - minX}px`,
                  height: `${maxY - minY}px`,
                }}
              >
                <svg style={{ width: "100%", height: "100%" }}>
                  <line
                    x1={startCanvas.x - minX}
                    y1={startCanvas.y - minY}
                    x2={lineEndX - minX}
                    y2={lineEndY - minY}
                    stroke={shapeStrokeColor}
                    strokeWidth={shapeStrokeWidth}
                    strokeLinecap="round"
                  />
                  <polygon
                    points={`${endCanvas.x - minX},${endCanvas.y - minY} ${arrowHead1X - minX},${arrowHead1Y - minY} ${arrowHead2X - minX},${arrowHead2Y - minY}`}
                    fill={shapeStrokeColor}
                  />
                </svg>
              </div>
            );
          } else if (currentShapeType === "circle") {
            // Render circle preview - pin to initial click position (center)
            // The selectionStart/End now represent the bounding box calculated from center
            const minX = Math.min(selectionStart.x, selectionEnd.x);
            const minY = Math.min(selectionStart.y, selectionEnd.y);
            const maxX = Math.max(selectionStart.x, selectionEnd.x);
            const maxY = Math.max(selectionStart.y, selectionEnd.y);
            const width = maxX - minX;
            const height = maxY - minY;
            const size = Math.max(width, height);
            
            // Convert to canvas coordinates - use same logic as final rendering
            // In PDF: annotation.y is bottom edge, annotation.y + height is top edge
            // So top-left in PDF is (minX, minY + size)
            const topLeft = pdfToCanvas(minX, minY + size);
            
            return (
              <div
                key="circle-preview"
                className="absolute pointer-events-none z-50"
                style={{
                  left: `${topLeft.x}px`,
                  top: `${topLeft.y}px`,
                  width: `${size}px`,
                  height: `${size}px`,
                }}
              >
                <svg style={{ width: "100%", height: "100%" }}>
                  <ellipse
                    cx={size / 2}
                    cy={size / 2}
                    rx={(size - shapeStrokeWidth) / 2}
                    ry={(size - shapeStrokeWidth) / 2}
                    stroke={shapeStrokeColor}
                    strokeWidth={shapeStrokeWidth}
                    fill={shapeFillColor}
                    fillOpacity={shapeFillOpacity}
                  />
                </svg>
              </div>
            );
          } else if (currentShapeType === "rectangle") {
            // Render rectangle preview - use same coordinate system as final rendering
            // Calculate bounding box in PDF coordinates (like ShapeTool does)
            const minX = Math.min(selectionStart.x, selectionEnd.x);
            const minY = Math.min(selectionStart.y, selectionEnd.y);
            const maxX = Math.max(selectionStart.x, selectionEnd.x);
            const maxY = Math.max(selectionStart.y, selectionEnd.y);
            const width = maxX - minX;
            const height = maxY - minY;
            
            // Convert to canvas coordinates - use same logic as final rendering
            // In PDF: annotation.y is bottom edge, annotation.y + height is top edge
            // So top-left in PDF is (minX, minY + height)
            const topLeft = pdfToCanvas(minX, minY + height);
            
            return (
              <div
                key="rectangle-preview"
                className="absolute pointer-events-none z-50"
                style={{
                  left: `${topLeft.x}px`,
                  top: `${topLeft.y}px`,
                  width: `${width}px`,
                  height: `${height}px`,
                }}
              >
                <svg style={{ width: "100%", height: "100%" }}>
                  <rect
                    x={shapeStrokeWidth / 2}
                    y={shapeStrokeWidth / 2}
                    width={width - shapeStrokeWidth}
                    height={height - shapeStrokeWidth}
                    stroke={shapeStrokeColor}
                    strokeWidth={shapeStrokeWidth}
                    fill={shapeFillColor}
                    fillOpacity={shapeFillOpacity}
                  />
                </svg>
              </div>
            );
          }
          return null;
        })()}

        {/* Render selection rectangle - not for draw tool or shape tool (they have their own previews) */}
        {isSelecting && selectionStart && selectionEnd && activeTool !== "selectText" && activeTool !== "highlight" && activeTool !== "draw" && activeTool !== "shape" && (
          (() => {
            // Convert PDF coordinates to CANVAS coordinates (like text box does)
            const startCanvas = pdfToCanvas(selectionStart.x, selectionStart.y);
            const endCanvas = pdfToCanvas(selectionEnd.x, selectionEnd.y);
            
            // Canvas pixel = display coordinates (1:1 mapping)
            const minX = Math.min(startCanvas.x, endCanvas.x);
            const minY = Math.min(startCanvas.y, endCanvas.y);
            const width = Math.abs(endCanvas.x - startCanvas.x);
            const height = Math.abs(endCanvas.y - startCanvas.y);
            
            // Ensure minimum size for visibility
            const minWidth = Math.max(width, 2);
            const minHeight = Math.max(height, 2);
            
            return (
              <>
                <div
                  className={cn(
                    "absolute border-2 pointer-events-none z-50",
                    activeTool === "callout"
                      ? "border-blue-500 bg-blue-400/20"
                      : activeTool === "redact"
                      ? "border-red-500 bg-red-400/30"
                      : activeTool === "selectionBox"
                      ? "border-cyan-500 bg-cyan-400/20 border-dashed"
                      : "border-primary bg-primary/10"
                  )}
                  style={{
                    left: `${minX}px`,
                    top: `${minY}px`,
                    width: `${minWidth}px`,
                    height: `${minHeight}px`,
                  }}
                />
              </>
            );
          })()
        )}
        
        {/* Render drawing preview while drawing - drawingPathVersion triggers re-renders */}
        {activeTool === "draw" && isCurrentlyDrawing() && drawingPathVersion >= 0 && (() => {
          const path = getDrawingPath();
          if (!path || path.length < 2) return null;
          
          // Get drawing settings from UI store
          const { drawingColor, drawingStrokeWidth, drawingOpacity } = useUIStore.getState();
          
          // Always use pencil style
          const strokeWidth = drawingStrokeWidth || 5;
          const strokeOpacity = drawingOpacity !== undefined ? drawingOpacity : 1.0; // Default to 100% opacity
          const strokeLinecap: "round" | "butt" | "square" = "round";
          
          // Calculate bounding box for SVG positioning
          const allCanvasX = path.map(p => pdfToCanvas(p.x, p.y).x);
          const allCanvasY = path.map(p => pdfToCanvas(p.x, p.y).y);
          const minCanvasX = Math.min(...allCanvasX);
          const minCanvasY = Math.min(...allCanvasY);
          const maxCanvasX = Math.max(...allCanvasX);
          const maxCanvasY = Math.max(...allCanvasY);
          
          const padding = (strokeWidth || 5) / 2 + 2;
          const boxX = minCanvasX - padding;
          const boxY = minCanvasY - padding;
          const boxWidth = (maxCanvasX - minCanvasX) + (padding * 2);
          const boxHeight = (maxCanvasY - minCanvasY) + (padding * 2);
          
          const pathPoints = path.map(p => {
            const canvasPos = pdfToCanvas(p.x, p.y);
            return `${canvasPos.x - boxX},${canvasPos.y - boxY}`;
          }).join(" ");
          
          return (
            <div
              className="absolute pointer-events-none"
              style={{
                left: `${boxX}px`,
                top: `${boxY}px`,
                width: `${boxWidth}px`,
                height: `${boxHeight}px`,
                zIndex: 60,
              }}
            >
              <svg
                style={{
                  width: `${boxWidth}px`,
                  height: `${boxHeight}px`,
                }}
                viewBox={`0 0 ${boxWidth} ${boxHeight}`}
              >
                <polyline
                  points={pathPoints}
                  fill="none"
                  stroke={drawingColor || "#000000"}
                  strokeWidth={strokeWidth}
                  strokeOpacity={strokeOpacity}
                  strokeLinecap={strokeLinecap}
                  strokeLinejoin="round"
                />
              </svg>
            </div>
          );
        })()}

        {/* Render text selection highlights - show during drag and after release */}
        {(() => {
          // Show highlights if we have spans, whether we're dragging or not
          // Also show for highlight tool to give live preview of text being selected
          const shouldShowHighlights = (activeTool === "selectText" || (activeTool === "highlight" || activeTool === "strikethrough")) && selectedTextSpans.length > 0;
          
          if (!shouldShowHighlights) return null;
          
          // Get highlight color for preview when using highlight tool
          const { highlightColor, highlightOpacity } = useUIStore.getState();
          const tool = activeTool as string;
          const previewColor = tool === "strikethrough" ? "#EF4444" : (tool === "highlight" || tool === "strikethrough") ? highlightColor : null;
          const isHighlightPreview = (activeTool === "highlight" || activeTool === "strikethrough") && isSelecting;
          
          // Group spans by line (same Y coordinate, within tolerance)
          const lineGroups: { [key: string]: typeof selectedTextSpans } = {};
          const Y_TOLERANCE = 2; // Group spans within 2 points vertically
          
          selectedTextSpans.forEach((span) => {
            const [, spanY0, , spanY1] = span.bbox;
            // Use the center Y coordinate for grouping
            const centerY = (spanY0 + spanY1) / 2;
            // Round to nearest tolerance value to group nearby lines
            const lineKey = Math.round(centerY / Y_TOLERANCE) * Y_TOLERANCE;
            
            if (!lineGroups[lineKey]) {
              lineGroups[lineKey] = [];
            }
            lineGroups[lineKey].push(span);
          });
          
          // Render one continuous highlight per line
          return (
            <>
              {Object.entries(lineGroups).map(([lineKey, lineSpans], lineIdx) => {
                // Calculate bounding box for all spans in this line
                let minX = Infinity;
                let maxX = -Infinity;
                let minY = Infinity;
                let maxY = -Infinity;
                
                lineSpans.forEach((span) => {
                  const [spanX0, spanY0, spanX1, spanY1] = span.bbox;
                  minX = Math.min(minX, spanX0);
                  maxX = Math.max(maxX, spanX1);
                  minY = Math.min(minY, spanY0);
                  maxY = Math.max(maxY, spanY1);
                });
                
                // Convert PDF coordinates to canvas coordinates
                // In PDF space: minY = bottom, maxY = top
                // pdfToCanvas flips Y, so we need to use the correct corners for CSS positioning
                // CSS needs top-left corner: (minX, maxY) in PDF space
                const canvasTopLeft = pdfToCanvas(minX, maxY); // maxY is top in PDF
                const canvasBottomRight = pdfToCanvas(maxX, minY); // minY is bottom in PDF
                
                // After Y flip, canvasTopLeft.y < canvasBottomRight.y
                const width = canvasBottomRight.x - canvasTopLeft.x;
                const height = canvasBottomRight.y - canvasTopLeft.y;
                
                return (
                  <div
                    key={`text-selection-line-${lineKey}-${lineIdx}`}
                    className={cn(
                      "absolute pointer-events-none z-50",
                      isHighlightPreview && "animate-pulse"
                    )}
                    style={{
                      left: `${canvasTopLeft.x}px`,
                      top: `${canvasTopLeft.y}px`,
                      width: `${Math.abs(width)}px`,
                      height: `${Math.abs(height)}px`,
                      backgroundColor: previewColor ? previewColor : 'rgba(96, 165, 250, 0.4)',
                      opacity: previewColor ? highlightOpacity : 1,
                      // Add a dashed border for preview mode to indicate it's not committed yet
                      ...(isHighlightPreview && {
                        boxShadow: `0 0 0 1px ${previewColor || 'rgba(96, 165, 250, 0.6)'}`,
                      }),
                    }}
                  />
                );
              })}
            </>
          );
        })()}

        {/* No selection rectangle for selectText - only show text highlights */}

        {/* Render search result highlights - use same point/scale system as other markups (pdfToCanvas) */}
        {pageSearchMatches.length > 0 && (() => {
          const pageMetadata = document.getPageMetadata(pageNumber);
          const pageHeight = pageMetadata?.height ?? 0;
          return (
            <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 50 }}>
              {pageSearchMatches.flatMap((match) => {
                // match.quad can be a single quad (number[]) or array of quads (number[][]); mupdf search returns display coords (Y=0 at top)
                const quadsRaw = match.quad;
                const quads: number[][] = Array.isArray(quadsRaw) && quadsRaw.length > 0
                  ? (Array.isArray(quadsRaw[0]) ? (quadsRaw as number[][]) : [quadsRaw as unknown as number[]])
                  : [];
                const isCurrentMatch = currentSearchMatch?.matchIndex === match.matchIndex;

                return quads.map((singleQuad: number[], quadIdx: number) => {
                  if (!Array.isArray(singleQuad) || singleQuad.length < 8) return null;
                  // mupdf search quads are in display coordinates (Y=0 at top); convert to PDF (Y=0 at bottom) then use pdfToCanvas like other overlays
                  const displayMinX = Math.min(singleQuad[0], singleQuad[2], singleQuad[4], singleQuad[6]);
                  const displayMinY = Math.min(singleQuad[1], singleQuad[3], singleQuad[5], singleQuad[7]);
                  const displayMaxX = Math.max(singleQuad[0], singleQuad[2], singleQuad[4], singleQuad[6]);
                  const displayMaxY = Math.max(singleQuad[1], singleQuad[3], singleQuad[5], singleQuad[7]);
                  const pdfMinY = pageHeight - displayMaxY;
                  const pdfMaxY = pageHeight - displayMinY;
                  const topLeft = pdfToCanvas(displayMinX, pdfMaxY);
                  const bottomRight = pdfToCanvas(displayMaxX, pdfMinY);
                  const canvasX = Math.min(topLeft.x, bottomRight.x);
                  const canvasY = Math.min(topLeft.y, bottomRight.y);
                  const width = Math.abs(bottomRight.x - topLeft.x);
                  const height = Math.abs(bottomRight.y - topLeft.y);

                  return (
                    <div
                      key={`search_${match.matchIndex}_${quadIdx}`}
                      className="absolute pointer-events-none"
                      style={{
                        left: `${canvasX}px`,
                        top: `${canvasY}px`,
                        width: `${Math.max(width, 5)}px`,
                        height: `${Math.max(height, 5)}px`,
                        backgroundColor: isCurrentMatch ? 'rgba(251, 146, 60, 0.6)' : 'rgba(250, 204, 21, 0.5)',
                        border: isCurrentMatch ? '2px solid #f97316' : '1px solid #eab308',
                        boxShadow: isCurrentMatch ? '0 0 8px rgba(249, 115, 22, 0.6)' : 'none',
                      }}
                    />
                  );
                });
              })}
            </div>
          );
        })()}

        {/* Render spec extraction highlights */}
        {(() => {
          const { getSpecHighlights, selectedSpecId, selectedSpecDocumentId } = useSpecExtractionStore.getState();
          if (!currentDocument) return null;
          const documentId = currentDocument.getId();
          const specHighlights = getSpecHighlights(documentId);
          const pageSpecHighlights = specHighlights.filter((h: { page: number }) => h.page === pageNumber);
          
          const hasPageHighlights = pageSpecHighlights.length > 0;
          const hasTemporaryHighlight = temporaryHighlight && temporaryHighlight.page === pageNumber;
          
          if (!hasPageHighlights && !hasTemporaryHighlight) return null;
          
          const isSelected = selectedSpecDocumentId === documentId;
          
          return (
            <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 45 }}>
              {/* Regular spec highlights */}
              {pageSpecHighlights.map((highlight: { bbox: [number, number, number, number]; specId: string; color?: string }, idx: number) => {
                const [x0, y0, x1, y1] = highlight.bbox;
                // Convert PDF bbox (Y=0 at bottom) to canvas coordinates via pdfToCanvas so read-mode scale is correct
                const topLeft = pdfToCanvas(x0, y1);
                const bottomRight = pdfToCanvas(x1, y0);
                const canvasX0 = topLeft.x;
                const canvasY0 = topLeft.y;
                const width = Math.abs(bottomRight.x - topLeft.x);
                const height = Math.abs(bottomRight.y - topLeft.y);
                
                const isHighlightSelected = isSelected && highlight.specId === selectedSpecId;
                const baseColor = highlight.color || '#fbbf24';
                
                // Convert hex color to rgba for proper opacity
                const hexToRgba = (hex: string, alpha: number): string => {
                  const r = parseInt(hex.slice(1, 3), 16);
                  const g = parseInt(hex.slice(3, 5), 16);
                  const b = parseInt(hex.slice(5, 7), 16);
                  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
                };
                
                return (
                  <div
                    key={`spec_${highlight.specId}_${idx}`}
                    className="absolute pointer-events-none"
                    style={{
                      left: `${canvasX0}px`,
                      top: `${canvasY0}px`,
                      width: `${Math.max(width, 5)}px`,
                      height: `${Math.max(height, 5)}px`,
                      backgroundColor: isHighlightSelected 
                        ? hexToRgba(baseColor, 0.5) // 50% opacity when selected
                        : hexToRgba(baseColor, 0.3), // 30% opacity for normal (more transparent)
                      border: isHighlightSelected
                        ? `3px solid ${baseColor}` // Thicker border when selected
                        : `1px solid ${baseColor}`,
                      boxShadow: isHighlightSelected
                        ? `0 0 8px ${hexToRgba(baseColor, 0.4)}` // Glow effect when selected
                        : 'none',
                      transition: 'all 0.2s ease-in-out',
                    }}
                  />
                );
              })}
              
              {/* Temporary text highlight (exact text quads) — natural highlighter style */}
              {hasTemporaryHighlight && temporaryHighlight && (
                // Group opacity so overlapping quads (multi-line quotes) composite as ONE
                // translucent layer instead of stacking into an unreadable dark band.
                <div className="absolute inset-0" style={{ opacity: 0.5 }}>
                  {temporaryHighlight.quads.map((quad, idx) => {
                    if (!Array.isArray(quad) || quad.length < 8) return null;
                    
                    // Quad is [x0, y0, x1, y1, x2, y2, x3, y3] in PDF coordinates
                    const quadMinX = Math.min(quad[0], quad[2], quad[4], quad[6]);
                    const quadMinY = Math.min(quad[1], quad[3], quad[5], quad[7]);
                    const quadMaxX = Math.max(quad[0], quad[2], quad[4], quad[6]);
                    const quadMaxY = Math.max(quad[1], quad[3], quad[5], quad[7]);
                    
                    // Convert PDF coordinates to canvas coordinates
                    const quadMinCanvas = pdfToCanvas(quadMinX, quadMinY);
                    const quadMaxCanvas = pdfToCanvas(quadMaxX, quadMaxY);
                    
                    // For CSS positioning, we need top-left corner and positive dimensions
                    const quadX = Math.min(quadMinCanvas.x, quadMaxCanvas.x);
                    const quadY = Math.min(quadMinCanvas.y, quadMaxCanvas.y);
                    const quadWidth = Math.abs(quadMaxCanvas.x - quadMinCanvas.x);
                    const quadHeight = Math.abs(quadMaxCanvas.y - quadMinCanvas.y);
                    
                    // Convert quad points to canvas coordinates
                    const quadPoints = [
                      pdfToCanvas(quad[0], quad[1]),
                      pdfToCanvas(quad[2], quad[3]),
                      pdfToCanvas(quad[4], quad[5]),
                      pdfToCanvas(quad[6], quad[7]),
                    ];
                    // Sort by angle from centroid so the path is a proper quadrilateral (no X/bow-tie)
                    const cx = (quadPoints[0].x + quadPoints[1].x + quadPoints[2].x + quadPoints[3].x) / 4;
                    const cy = (quadPoints[0].y + quadPoints[1].y + quadPoints[2].y + quadPoints[3].y) / 4;
                    const sorted = [...quadPoints].sort(
                      (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
                    );
                    const pathData = sorted
                      .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x - quadX} ${p.y - quadY}`)
                      .join(" ") + " Z";
                    
                    // Use highlight color from store (e.g. geotechnical amber); default highlighter yellow. Make location obvious with fill + stroke.
                    const hex = (temporaryHighlight.color || "#fbbf24").replace(/^#/, "");
                    const r = parseInt(hex.slice(0, 2), 16);
                    const g = parseInt(hex.slice(2, 4), 16);
                    const b = parseInt(hex.slice(4, 6), 16);
                    // Opaque fill/stroke; the parent group applies the 50% transparency once
                    // so overlapping quads don't stack into a darker band.
                    const fillColor = `rgba(${r}, ${g}, ${b}, 1)`;
                    const strokeColor = `rgba(${r}, ${g}, ${b}, 1)`;
                    
                    return (
                      <div
                        key={`temp_quad_${idx}`}
                        // Marker on the first quad so the viewer can center it via scrollIntoView.
                        id={idx === 0 ? "nanodoc-temp-highlight" : undefined}
                        className="absolute pointer-events-none"
                        style={{
                          left: `${quadX}px`,
                          top: `${quadY}px`,
                          width: `${quadWidth}px`,
                          height: `${quadHeight}px`,
                        }}
                      >
                        <svg
                          width={quadWidth}
                          height={quadHeight}
                          className="absolute inset-0"
                          style={{ overflow: "visible" }}
                        >
                          <path
                            d={pathData}
                            fill={fillColor}
                            stroke={strokeColor}
                            strokeWidth={1.5}
                          />
                        </svg>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}

        {/* Render annotations (viewport-culled in non-read mode when count >= threshold) */}
        {visibleAnnotations.length > 0 && (
          <div className="absolute inset-0" style={{ zIndex: 20, pointerEvents: (activeTool === "select" || activeTool === "selectText") ? "auto" : "none" }}>
            {visibleAnnotations.map((annot) => {
              // Don't render text annotations if they're selected (RichTextEditor will show it instead)
              // This prevents double rendering. Highlights should always render even when selected.
              if (editingAnnotation?.id === annot.id && annot.type === "text") {
                return null;
              }
              
              // Only render if annotation is for current page
              if (annot.pageNumber !== pageNumber) {
                return null;
              }
              
              // Get current zoom for rendering
              const currentZoom = zoomLevelRef.current;
          
          if (annot.type === "highlight") {
            const highlightColor = annot.color || "#FFFF00";
            const opacity = annot.opacity !== undefined ? annot.opacity : 0.5;
            const strokeWidth = annot.strokeWidth || 15;
            
            // Convert hex color to rgba for proper opacity blending
            const hexToRgba = (hex: string, alpha: number): string => {
              const hexClean = hex.replace("#", "");
              const r = parseInt(hexClean.substring(0, 2), 16);
              const g = parseInt(hexClean.substring(2, 4), 16);
              const b = parseInt(hexClean.substring(4, 6), 16);
              return `rgba(${r}, ${g}, ${b}, ${alpha})`;
            };
            
            // Render overlay highlights (freehand path)
            // Always render overlay highlights if they have a path or quads
            if (annot.highlightMode === "overlay") {
              // Prefer path if available, otherwise use quads
              const pathToRender = annot.path && annot.path.length > 0 
                ? annot.path 
                : (annot.quads && annot.quads.length > 0
                  ? annot.quads.map((quad: number[]) => {
                      // Convert quad to path points (use corners of quad)
                      return [
                        { x: quad[0], y: quad[1] },
                        { x: quad[2], y: quad[3] },
                        { x: quad[4], y: quad[5] },
                        { x: quad[6], y: quad[7] }
                      ];
                    }).flat()
                  : null);
              
              if (!pathToRender || pathToRender.length === 0) {
                console.warn("Overlay highlight has no path or quads:", annot);
                return null;
              }
              
              // Calculate bounding box for SVG positioning
              // Canvas pixel = display coordinates (1:1 mapping)
              const allCanvasX = pathToRender.map((p: { x: number; y: number }) => pdfToCanvas(p.x, p.y).x);
              const allCanvasY = pathToRender.map((p: { x: number; y: number }) => pdfToCanvas(p.x, p.y).y);
              const minCanvasX = Math.min(...allCanvasX);
              const minCanvasY = Math.min(...allCanvasY);
              const maxCanvasX = Math.max(...allCanvasX);
              const maxCanvasY = Math.max(...allCanvasY);
              
              // Add padding for stroke width
              const padding = strokeWidth / 2;
              const boxX = minCanvasX - padding;
              const boxY = minCanvasY - padding;
              const boxWidth = (maxCanvasX - minCanvasX) + (padding * 2);
              const boxHeight = (maxCanvasY - minCanvasY) + (padding * 2);
              
              // Adjust path points to be relative to bounding box
              // Canvas pixel = display coordinates (1:1 mapping)
              const relativePathPoints = pathToRender.map((p: { x: number; y: number }) => {
                const canvasPos = pdfToCanvas(p.x, p.y);
                return `${canvasPos.x - boxX},${canvasPos.y - boxY}`;
              }).join(" ");
              
              const isHovered = hoveredAnnotationId === annot.id && activeTool === "select";
              const isSelected = editingAnnotation?.id === annot.id;
              
              return (
                <div 
                  key={annot.id} 
                  data-annotation-id={annot.id}
                  data-highlight-selected={isSelected ? "true" : "false"}
                  className={cn(
                    "absolute",
                    activeTool === "select" ? "cursor-pointer" : ""
                  )}
                  style={{ 
                    pointerEvents: activeTool === "select" ? "auto" : "none", 
                    zIndex: 30,
                    left: `${boxX}px`,
                    top: `${boxY}px`,
                    width: `${boxWidth}px`,
                    height: `${boxHeight}px`,
                  }}
                  onClick={(e) => {
                    if (activeTool === "select") {
                      e.stopPropagation();
                      setEditingAnnotation(annot);
                      setAnnotationText(annot.content || "");
                      // Keep hover state when selected
                      setHoveredAnnotationId(annot.id);
                    }
                  }}
                  onMouseEnter={() => {
                    if (activeTool === "select") {
                      setHoveredAnnotationId(annot.id);
                    }
                  }}
                  onMouseLeave={() => {
                    if (activeTool === "select" && !isSelected) {
                      setHoveredAnnotationId(null);
                    }
                  }}
                >
                  {/* Hover/Selection border overlay */}
                  {(isHovered || isSelected) && (
                    <div
                      className="absolute border-2 border-primary pointer-events-none"
                      style={{
                        left: `-4px`,
                        top: `-4px`,
                        width: `${boxWidth + 8}px`,
                        height: `${boxHeight + 8}px`,
                        borderRadius: "4px",
                        zIndex: 31,
                        boxShadow: "0 0 0 2px rgba(59, 130, 246, 0.3)",
                      }}
                    />
                  )}
                  <svg
                    className="absolute"
                    style={{
                      left: 0,
                      top: 0,
                      width: `${boxWidth}px`,
                      height: `${boxHeight}px`,
                      overflow: "visible",
                    }}
                    viewBox={`0 0 ${boxWidth} ${boxHeight}`}
                  >
                    <polyline
                      points={relativePathPoints}
                      fill="none"
                      stroke={highlightColor}
                      strokeWidth={strokeWidth}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={opacity}
                    />
                  </svg>
                </div>
              );
            }
            
            // Render text selection highlights (quads)
            if (annot.quads && annot.quads.length > 0) {
              const isHovered = hoveredAnnotationId === annot.id && activeTool === "select";
              const isSelected = editingAnnotation?.id === annot.id;
              
              // Calculate bounding box for all quads for hover border
              let minQuadX = Infinity, minQuadY = Infinity, maxQuadX = -Infinity, maxQuadY = -Infinity;
              annot.quads.forEach((quad: number[]) => {
                if (Array.isArray(quad) && quad.length >= 8) {
                  const minX = Math.min(quad[0], quad[2], quad[4], quad[6]);
                  const minY = Math.min(quad[1], quad[3], quad[5], quad[7]);
                  const maxX = Math.max(quad[0], quad[2], quad[4], quad[6]);
                  const maxY = Math.max(quad[1], quad[3], quad[5], quad[7]);
                  minQuadX = Math.min(minQuadX, minX);
                  minQuadY = Math.min(minQuadY, minY);
                  maxQuadX = Math.max(maxQuadX, maxX);
                  maxQuadY = Math.max(maxQuadY, maxY);
                }
              });
              
              // Convert PDF coordinates to canvas coordinates
              // Note: pdfToCanvas flips Y, so after conversion:
              // - minCanvas.y is the BOTTOM in canvas space (larger value)
              // - maxCanvas.y is the TOP in canvas space (smaller value)
              const minCanvas = pdfToCanvas(minQuadX, minQuadY);
              const maxCanvas = pdfToCanvas(maxQuadX, maxQuadY);
              
              // For CSS positioning, we need top-left corner and positive dimensions
              const hoverBoxX = Math.min(minCanvas.x, maxCanvas.x);
              const hoverBoxY = Math.min(minCanvas.y, maxCanvas.y); // Use the smaller Y (top in canvas)
              const hoverBoxWidth = Math.abs(maxCanvas.x - minCanvas.x);
              const hoverBoxHeight = Math.abs(maxCanvas.y - minCanvas.y);
              
              return (
                <div 
                  key={annot.id} 
                  data-annotation-id={annot.id}
                  data-highlight-selected={isSelected ? "true" : "false"}
                  className={cn(
                    "absolute",
                    activeTool === "select" ? "cursor-pointer" : ""
                  )}
                  style={{
                    pointerEvents: activeTool === "select" ? "auto" : "none",
                    zIndex: isSelected ? 50 : 30,
                    overflow: "visible",
                    // Position the clickable area at the bounding box
                    left: `${hoverBoxX}px`,
                    top: `${hoverBoxY}px`,
                    width: `${hoverBoxWidth}px`,
                    height: `${hoverBoxHeight}px`,
                  }}
                  onClick={(e) => {
                    if (activeTool === "select") {
                      e.stopPropagation();
                      setEditingAnnotation(annot);
                      setAnnotationText(annot.content || "");
                      // Keep hover state when selected
                      setHoveredAnnotationId(annot.id);
                    }
                  }}
                  onMouseEnter={() => {
                    if (activeTool === "select") {
                      setHoveredAnnotationId(annot.id);
                    }
                  }}
                  onMouseLeave={() => {
                    if (activeTool === "select" && !isSelected) {
                      setHoveredAnnotationId(null);
                    }
                  }}
                >
                  {/* Hover/Selection border overlay */}
                  {(isHovered || isSelected) && (
                    <div
                      className="absolute border-2 border-primary pointer-events-none"
                      style={{
                        left: `-4px`,
                        top: `-4px`,
                        width: `${hoverBoxWidth + 8}px`,
                        height: `${hoverBoxHeight + 8}px`,
                        borderRadius: "4px",
                        zIndex: 31,
                        boxShadow: "0 0 0 2px rgba(59, 130, 246, 0.3)",
                      }}
                    />
                  )}
                  {annot.quads.map((quad, idx) => {
                    // Quad is [x0, y0, x1, y1, x2, y2, x3, y3] in PDF coordinates
                    if (!Array.isArray(quad) || quad.length < 8) return null;
                    
                    const quadMinX = Math.min(quad[0], quad[2], quad[4], quad[6]);
                    const quadMinY = Math.min(quad[1], quad[3], quad[5], quad[7]);
                    const quadMaxX = Math.max(quad[0], quad[2], quad[4], quad[6]);
                    const quadMaxY = Math.max(quad[1], quad[3], quad[5], quad[7]);
                    
                    // Convert PDF coordinates to canvas coordinates (for rendering)
                    // Note: pdfToCanvas flips Y
                    const quadMinCanvas = pdfToCanvas(quadMinX, quadMinY);
                    const quadMaxCanvas = pdfToCanvas(quadMaxX, quadMaxY);
                    
                    // Get the actual top-left in canvas space (smallest X and Y)
                    const quadCanvasX = Math.min(quadMinCanvas.x, quadMaxCanvas.x);
                    const quadCanvasY = Math.min(quadMinCanvas.y, quadMaxCanvas.y);
                    const quadCanvasWidth = Math.abs(quadMaxCanvas.x - quadMinCanvas.x);
                    const quadCanvasHeight = Math.abs(quadMaxCanvas.y - quadMinCanvas.y);
                    
                    // Position relative to parent container (which is at hoverBoxX, hoverBoxY)
                    const relativeLeft = quadCanvasX - hoverBoxX;
                    const relativeTop = quadCanvasY - hoverBoxY;
                    
                    return (
                      <div
                        key={idx}
                        className="absolute"
                        style={{
                          left: `${relativeLeft}px`,
                          top: `${relativeTop}px`,
                          width: `${quadCanvasWidth}px`,
                          height: `${quadCanvasHeight}px`,
                          backgroundColor: hexToRgba(highlightColor, opacity),
                        }}
                      />
                    );
                  })}
                  {/* Comment indicator icon — shown when highlight has a comment */}
                  {(annot.commentContent || annot.redlineSuggestion) && (
                    <div
                      className="absolute"
                      style={{
                        right: "-24px",
                        top: "-4px",
                        width: "20px",
                        height: "20px",
                        pointerEvents: "auto",
                        cursor: "pointer",
                        zIndex: 32,
                      }}
                      title="Click to view comment"
                    >
                      <svg viewBox="0 0 20 20" fill={highlightColor} className="w-5 h-5 drop-shadow-sm">
                        <path fillRule="evenodd" d="M2 5a2 2 0 012-2h12a2 2 0 012 2v6a2 2 0 01-2 2H8l-4 3V13H4a2 2 0 01-2-2V5z" clipRule="evenodd" />
                      </svg>
                    </div>
                  )}
                  {/* Comment popup — always shown when selected so user can add/edit comments */}
                  {isSelected && (
                    <RedlinePopupPortal
                      annotation={annot}
                      anchorRef={annot.id}
                      onClose={() => {
                        setEditingAnnotation(null);
                        setHoveredAnnotationId(null);
                      }}
                    />
                  )}
                </div>
              );
            }
          } else if (annot.type === "strikethrough") {
            // Render strikethrough annotations — red line through text quads
            if (annot.quads && annot.quads.length > 0) {
              const strikeColor = annot.color || "#EF4444";
              const isHovered = hoveredAnnotationId === annot.id && activeTool === "select";
              const isSelected = editingAnnotation?.id === annot.id;

              // Calculate bounding box for all quads
              let minQuadX = Infinity, minQuadY = Infinity, maxQuadX = -Infinity, maxQuadY = -Infinity;
              annot.quads.forEach((quad: number[]) => {
                if (Array.isArray(quad) && quad.length >= 8) {
                  minQuadX = Math.min(minQuadX, quad[0], quad[2], quad[4], quad[6]);
                  minQuadY = Math.min(minQuadY, quad[1], quad[3], quad[5], quad[7]);
                  maxQuadX = Math.max(maxQuadX, quad[0], quad[2], quad[4], quad[6]);
                  maxQuadY = Math.max(maxQuadY, quad[1], quad[3], quad[5], quad[7]);
                }
              });

              const minCanvas = pdfToCanvas(minQuadX, minQuadY);
              const maxCanvas = pdfToCanvas(maxQuadX, maxQuadY);
              const hoverBoxX = Math.min(minCanvas.x, maxCanvas.x);
              const hoverBoxY = Math.min(minCanvas.y, maxCanvas.y);
              const hoverBoxWidth = Math.abs(maxCanvas.x - minCanvas.x);
              const hoverBoxHeight = Math.abs(maxCanvas.y - minCanvas.y);

              return (
                <div
                  key={annot.id}
                  data-annotation-id={annot.id}
                  className={cn("absolute", activeTool === "select" ? "cursor-pointer" : "")}
                  style={{
                    pointerEvents: activeTool === "select" ? "auto" : "none",
                    zIndex: isSelected ? 50 : 30,
                    left: `${hoverBoxX}px`,
                    top: `${hoverBoxY}px`,
                    width: `${hoverBoxWidth}px`,
                    height: `${hoverBoxHeight}px`,
                    overflow: "visible",
                  }}
                  onClick={(e) => {
                    if (activeTool === "select") {
                      e.stopPropagation();
                      setEditingAnnotation(annot);
                      setAnnotationText(annot.content || "");
                      setHoveredAnnotationId(annot.id);
                    }
                  }}
                  onMouseEnter={() => { if (activeTool === "select") setHoveredAnnotationId(annot.id); }}
                  onMouseLeave={() => { if (activeTool === "select" && !isSelected) setHoveredAnnotationId(null); }}
                >
                  {(isHovered || isSelected) && (
                    <div
                      className="absolute border-2 border-primary pointer-events-none"
                      style={{
                        left: `-4px`, top: `-4px`,
                        width: `${hoverBoxWidth + 8}px`, height: `${hoverBoxHeight + 8}px`,
                        borderRadius: "4px", zIndex: 31,
                        boxShadow: "0 0 0 2px rgba(59, 130, 246, 0.3)",
                      }}
                    />
                  )}
                  {annot.quads.map((quad, idx) => {
                    if (!Array.isArray(quad) || quad.length < 8) return null;
                    const quadMinX = Math.min(quad[0], quad[2], quad[4], quad[6]);
                    const quadMinY = Math.min(quad[1], quad[3], quad[5], quad[7]);
                    const quadMaxX = Math.max(quad[0], quad[2], quad[4], quad[6]);
                    const quadMaxY = Math.max(quad[1], quad[3], quad[5], quad[7]);
                    const quadMinCanvas = pdfToCanvas(quadMinX, quadMinY);
                    const quadMaxCanvas = pdfToCanvas(quadMaxX, quadMaxY);
                    const quadCanvasX = Math.min(quadMinCanvas.x, quadMaxCanvas.x);
                    const quadCanvasY = Math.min(quadMinCanvas.y, quadMaxCanvas.y);
                    const quadCanvasWidth = Math.abs(quadMaxCanvas.x - quadMinCanvas.x);
                    const quadCanvasHeight = Math.abs(quadMaxCanvas.y - quadMinCanvas.y);
                    const relativeLeft = quadCanvasX - hoverBoxX;
                    const relativeTop = quadCanvasY - hoverBoxY;

                    return (
                      <div key={idx} className="absolute" style={{ left: `${relativeLeft}px`, top: `${relativeTop}px`, width: `${quadCanvasWidth}px`, height: `${quadCanvasHeight}px` }}>
                        {/* Strikethrough line through the middle */}
                        <div className="absolute" style={{
                          left: 0, right: 0,
                          top: '50%', transform: 'translateY(-50%)',
                          height: '2px',
                          backgroundColor: strikeColor,
                          opacity: 0.8,
                        }} />
                      </div>
                    );
                  })}
                  {/* Comment indicator icon — always visible on strikethroughs with comments */}
                  {(annot.commentContent || annot.redlineSuggestion) && (
                    <div
                      className="absolute"
                      style={{
                        right: "-24px",
                        top: "-4px",
                        width: "20px",
                        height: "20px",
                        pointerEvents: "auto",
                        cursor: "pointer",
                        zIndex: 32,
                      }}
                      title="Click to view comment"
                    >
                      <svg viewBox="0 0 20 20" fill={strikeColor} className="w-5 h-5 drop-shadow-sm">
                        <path fillRule="evenodd" d="M2 5a2 2 0 012-2h12a2 2 0 012 2v6a2 2 0 01-2 2H8l-4 3V13H4a2 2 0 01-2-2V5z" clipRule="evenodd" />
                      </svg>
                    </div>
                  )}
                  {/* Expandable comment popup — shown when annotation is selected, portaled to body */}
                  {isSelected && (
                    <RedlinePopupPortal
                      annotation={annot}
                      anchorRef={annot.id}
                      onClose={() => {
                        setEditingAnnotation(null);
                        setHoveredAnnotationId(null);
                      }}
                    />
                  )}
                </div>
              );
            }
          } else if (annot.type === "comment") {
            // Comment annotations render as a small colored marker at the position
            if (!annot.commentContent && !annot.redlineSuggestion) return null;
            const commentPos = pdfToCanvas(annot.x, annot.y);
            const severityColors: Record<string, string> = {
              critical: '#EF4444', high: '#F97316', medium: '#F59E0B', low: '#3B82F6', info: '#9CA3AF',
            };
            const markerColor = severityColors[annot.redlineSeverity || 'info'] || '#9CA3AF';
            return (
              <div
                key={annot.id}
                data-annotation-id={annot.id}
                className="absolute cursor-pointer"
                style={{
                  left: `${commentPos.x - 8}px`,
                  top: `${commentPos.y - 8}px`,
                  width: '16px',
                  height: '16px',
                  zIndex: 30,
                  pointerEvents: 'auto',
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingAnnotation(annot);
                }}
                title={annot.commentContent || annot.redlineSuggestion || ''}
              >
                <div style={{
                  width: '16px', height: '16px',
                  borderRadius: '50%',
                  backgroundColor: markerColor,
                  border: '2px solid white',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                }} />
              </div>
            );
          } else if (annot.type === "callout") {
            // Callout annotations are rendered using CalloutAnnotation component below
            return null;
          } else if (annot.type === "redact") {
            // Don't render redactions as overlays - the content is actually deleted from the PDF
            // The PDF canvas will show the white background where content was removed
            // We only show a subtle outline when in select mode
            if (activeTool === "select") {
              const redactWidth = annot.width || 100;
              const redactHeight = annot.height || 50;
              
              // Convert PDF coordinates to canvas display coordinates (same as text annotations)
              // annot.y is the BOTTOM edge in PDF coordinates (Y=0 at bottom, Y increases upward)
              // For CSS positioning, we need the TOP edge (top-left corner)
              // pdfToCanvas expects PDF coordinates and flips Y internally
              // So we pass the top edge: annot.y + redactHeight
              const pdfTopY = annot.y + redactHeight;
              const canvasPos = pdfToCanvas(annot.x, pdfTopY);
              // Canvas pixel = display coordinates (1:1 mapping)
              const redactContainer = { 
                x: canvasPos.x, 
                y: canvasPos.y 
              };
              const redactContainerWidth = redactWidth * currentZoom;
              const redactContainerHeight = redactHeight * currentZoom;
              
              return (
                <div 
                  key={annot.id} 
                  className="absolute border-2 border-dashed border-red-400 cursor-pointer"
                  style={{ 
                    pointerEvents: "auto", 
                    zIndex: 25,
                    left: `${redactContainer.x}px`,
                    top: `${redactContainer.y}px`,
                    width: `${redactContainerWidth}px`,
                    height: `${redactContainerHeight}px`,
                  }}
                  onClick={() => {
                    setEditingAnnotation(annot);
                  }}
                />
              );
            }
            return null; // Don't render anything when not in select mode
          } else if (annot.type === "text") {
            // Text annotations are now always rendered using RichTextEditor
            // This is handled below in the RichTextEditor section
            return null;
          } else if (annot.type === "image") {
            // Image annotations are rendered using ImageAnnotation component
            // This is handled below in the ImageAnnotation section
            return null;
          } else if (annot.type === "draw") {
            // Render drawing annotation
            if (!annot.path || annot.path.length < 2) return null;
            
            const drawColor = annot.color || "#000000";
            const strokeWidth = annot.strokeWidth || 3;
            
            // Always use pencil style
            const strokeOpacity = annot.strokeOpacity !== undefined ? annot.strokeOpacity : 1.0; // Default to 100% opacity
            const strokeLinecap: "round" | "butt" | "square" = "round";
            
            // Calculate bounding box
            const allCanvasX = annot.path.map(p => pdfToCanvas(p.x, p.y).x);
            const allCanvasY = annot.path.map(p => pdfToCanvas(p.x, p.y).y);
            const minCanvasX = Math.min(...allCanvasX);
            const minCanvasY = Math.min(...allCanvasY);
            const maxCanvasX = Math.max(...allCanvasX);
            const maxCanvasY = Math.max(...allCanvasY);
            
            const padding = strokeWidth / 2;
            const boxX = minCanvasX - padding;
            const boxY = minCanvasY - padding;
            const boxWidth = (maxCanvasX - minCanvasX) + (padding * 2);
            const boxHeight = (maxCanvasY - minCanvasY) + (padding * 2);
            
            const relativePathPoints = annot.path.map(p => {
              const canvasPos = pdfToCanvas(p.x, p.y);
              return `${canvasPos.x - boxX},${canvasPos.y - boxY}`;
            }).join(" ");
            
            const isHovered = hoveredAnnotationId === annot.id && activeTool === "select";
            const isSelected = editingAnnotation?.id === annot.id;
            
            return (
              <div 
                key={annot.id}
                data-annotation-id={annot.id}
                className={cn("absolute", activeTool === "select" ? "cursor-pointer" : "")}
                style={{ 
                  pointerEvents: activeTool === "select" ? "auto" : "none",
                  zIndex: 30,
                  left: `${boxX}px`,
                  top: `${boxY}px`,
                  width: `${boxWidth}px`,
                  height: `${boxHeight}px`,
                }}
                onClick={(e) => {
                  if (activeTool === "select") {
                    e.stopPropagation();
                    setEditingAnnotation(annot);
                    setHoveredAnnotationId(annot.id);
                  }
                }}
                onMouseEnter={() => {
                  if (activeTool === "select") setHoveredAnnotationId(annot.id);
                }}
                onMouseLeave={() => {
                  if (activeTool === "select" && !isSelected) setHoveredAnnotationId(null);
                }}
              >
                {(isHovered || isSelected) && (
                  <div
                    className="absolute border-2 border-primary pointer-events-none"
                    style={{
                      left: `-4px`,
                      top: `-4px`,
                      width: `${boxWidth + 8}px`,
                      height: `${boxHeight + 8}px`,
                      borderRadius: "4px",
                      zIndex: 31,
                    }}
                  />
                )}
                <svg
                  style={{
                    width: `${boxWidth}px`,
                    height: `${boxHeight}px`,
                  }}
                  viewBox={`0 0 ${boxWidth} ${boxHeight}`}
                >
                  <polyline
                    points={relativePathPoints}
                    fill="none"
                    stroke={drawColor}
                    strokeWidth={strokeWidth}
                    strokeOpacity={strokeOpacity}
                    strokeLinecap={strokeLinecap}
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            );
          } else if (annot.type === "shape") {
            // Render shape annotation
            const strokeColor = annot.strokeColor || "#000000";
            const strokeWidth = annot.strokeWidth || 2;
            const fillColor = annot.fillColor || "transparent";
            // If fillColor is set but fillOpacity is not, default to 1 (fully opaque)
            // Otherwise use the specified opacity, or 0 if no fill color
            const fillOpacity = annot.fillColor 
              ? (annot.fillOpacity !== undefined ? annot.fillOpacity : 1)
              : 0;
            
            if (annot.shapeType === "arrow" && annot.points && annot.points.length >= 2) {
              // Check if this annotation is selected (needed for debug log and rendering)
              const isSelected = editingAnnotation?.id === annot.id;
              
              // Validate points - reject if invalid (0,0, NaN, undefined, or out of bounds)
              const p0 = annot.points[0];
              const p1 = annot.points[1];
              
              
              if (!p0 || !p1 || 
                  typeof p0.x !== 'number' || typeof p0.y !== 'number' ||
                  typeof p1.x !== 'number' || typeof p1.y !== 'number' ||
                  isNaN(p0.x) || isNaN(p0.y) || isNaN(p1.x) || isNaN(p1.y) ||
                  (p0.x === 0 && p0.y === 0 && p1.x === 0 && p1.y === 0) || // Both points at origin
                  Math.abs(p0.x) > 100000 || Math.abs(p0.y) > 100000 ||
                  Math.abs(p1.x) > 100000 || Math.abs(p1.y) > 100000) {
                console.warn("🔴 [ARROW RENDER] Invalid arrow points, skipping render:", annot.points);
                return null;
              }
              
              console.log("🔴 [ARROW RENDER] Rendering arrow with PDF points:", annot.points, "for annotation", annot.id);
              const start = pdfToCanvas(annot.points[0].x, annot.points[0].y);
              const end = pdfToCanvas(annot.points[1].x, annot.points[1].y);
              console.log("🔴 [ARROW RENDER] Converted to canvas:", { start, end });
              // Convert arrow head size from PDF points to canvas pixels
              // Use 1:1 mapping - coordinate system is independent of RENDER_SCALE
              const arrowHeadSizePdf = annot.arrowHeadSize || 10;
              const arrowHeadSize = arrowHeadSizePdf;  // 1:1 mapping with PDF points
              
              const dx = end.x - start.x;
              const dy = end.y - start.y;
              const angle = Math.atan2(dy, dx);
              
              // Calculate where the line should end (shortened by arrow head size)
              // The line should stop before the arrow head begins
              const lineEndX = end.x - (arrowHeadSize * Math.cos(angle));
              const lineEndY = end.y - (arrowHeadSize * Math.sin(angle));
              
              // Calculate arrow head points (extending from line end to actual end point)
              const arrowHead1X = end.x - arrowHeadSize * Math.cos(angle - Math.PI / 6);
              const arrowHead1Y = end.y - arrowHeadSize * Math.sin(angle - Math.PI / 6);
              const arrowHead2X = end.x - arrowHeadSize * Math.cos(angle + Math.PI / 6);
              const arrowHead2Y = end.y - arrowHeadSize * Math.sin(angle + Math.PI / 6);
              
              const minX = Math.min(start.x, end.x, arrowHead1X, arrowHead2X) - 10;
              const minY = Math.min(start.y, end.y, arrowHead1Y, arrowHead2Y) - 10;
              const maxX = Math.max(start.x, end.x, arrowHead1X, arrowHead2X) + 10;
              const maxY = Math.max(start.y, end.y, arrowHead1Y, arrowHead2Y) + 10;
              
              console.log("🔴 [ARROW RENDER] Calculated bounds:", { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY });
              
              // Validate canvas coordinates are reasonable
              if (Math.abs(start.x) > 100000 || Math.abs(start.y) > 100000 || 
                  Math.abs(end.x) > 100000 || Math.abs(end.y) > 100000) {
                console.error("🔴 [ARROW RENDER] Canvas coordinates out of bounds:", { start, end });
                return null;
              }
              
              const isDraggingThis = draggingShapeId === annot.id;
              
              return (
                <div key={annot.id}>
                  <div 
                    data-annotation-id={annot.id}
                    className={cn("absolute", activeTool === "select" && isSelected ? "cursor-move" : activeTool === "select" ? "cursor-pointer" : "")}
                    style={{
                      pointerEvents: activeTool === "select" ? "auto" : "none",
                      zIndex: 30,
                      left: `${minX}px`,
                      top: `${minY}px`,
                      width: `${maxX - minX}px`,
                      height: `${maxY - minY}px`,
                    }}
                    onMouseDown={(e) => {
                      if (activeTool === "select") {
                        // Don't start drag if clicking on a handle
                        const target = e.target as HTMLElement;
                        if (target.closest('[data-shape-handle]')) {
                          return;
                        }
                        
                        // Start dragging (works even if not selected yet)
                        e.preventDefault();
                        e.stopPropagation();
                        
                        // Select the arrow if not already selected
                        if (!isSelected) {
                          setEditingAnnotation(annot);
                        }
                        
                        setDraggingShapeId(annot.id);
                        shapeDragStartRef.current = {
                          x: e.clientX,
                          y: e.clientY,
                          annotX: annot.x,
                          annotY: annot.y,
                          points: annot.points ? [...annot.points] : undefined,
                        };
                      }
                    }}
                    onClick={(e) => {
                      if (activeTool === "select") {
                        // Don't select if clicking on a handle or if we just dragged
                        const target = e.target as HTMLElement;
                        if (target.closest('[data-shape-handle]')) {
                          return;
                        }
                        // If we dragged, don't trigger selection (already selected in onMouseDown)
                        if (isDraggingThis && shapeDragStartRef.current) {
                          const dx = e.clientX - shapeDragStartRef.current.x;
                          const dy = e.clientY - shapeDragStartRef.current.y;
                          const moveDistance = Math.sqrt(dx * dx + dy * dy);
                          if (moveDistance > 3) {
                            return; // We dragged, don't select again
                          }
                        }
                        e.stopPropagation();
                        setEditingAnnotation(annot);
                      }
                    }}
                  >
                    <svg style={{ width: "100%", height: "100%", pointerEvents: "none" }}>
                      <line
                        x1={start.x - minX}
                        y1={start.y - minY}
                        x2={lineEndX - minX}
                        y2={lineEndY - minY}
                        stroke={strokeColor}
                        strokeWidth={strokeWidth}
                        strokeLinecap="round"
                        pointerEvents="stroke"
                      />
                      <polygon
                        points={`${end.x - minX},${end.y - minY} ${arrowHead1X - minX},${arrowHead1Y - minY} ${arrowHead2X - minX},${arrowHead2Y - minY}`}
                        fill={strokeColor}
                        pointerEvents="all"
                      />
                    </svg>
                  </div>
                  {isSelected && activeTool === "select" && (
                    <ShapeHandles
                      annotation={annot}
                      pdfToCanvas={pdfToCanvas}
                      onUpdate={(updates) => {
                        if (!currentDocument) return;
                        updateAnnotation(
                          currentDocument.getId(),
                          annot.id,
                          updates
                        );
                        // Update editingAnnotation if it's the one being edited
                        if (editingAnnotation?.id === annot.id) {
                          setEditingAnnotation({
                            ...editingAnnotation,
                            ...updates,
                          });
                        }
                      }}
                      zoomLevel={currentZoom}
                    />
                  )}
                </div>
              );
            } else if (annot.shapeType === "rectangle" || annot.shapeType === "circle") {
              const topLeft = pdfToCanvas(annot.x, annot.y + (annot.height || 0));
              const width = annot.width || 0;
              const height = annot.height || 0;
              const rotation = annot.rotation || 0;
              const isSelected = editingAnnotation?.id === annot.id;
              const isDraggingThis = draggingShapeId === annot.id;
              
              return (
                <div key={annot.id}>
                  <div 
                    data-annotation-id={annot.id}
                    className={cn("absolute", activeTool === "select" && isSelected ? "cursor-move" : activeTool === "select" ? "cursor-pointer" : "")}
                    style={{
                      pointerEvents: activeTool === "select" ? "auto" : "none",
                      zIndex: 30,
                      left: `${topLeft.x}px`,
                      top: `${topLeft.y}px`,
                      width: `${width}px`,
                      height: `${height}px`,
                      transform: rotation !== 0 ? `rotate(${rotation * (180 / Math.PI)}deg)` : undefined,
                      transformOrigin: "center center",
                    }}
                    onMouseDown={(e) => {
                      if (activeTool === "select" && isSelected) {
                        // Don't start drag if clicking on a handle
                        const target = e.target as HTMLElement;
                        if (target.closest('[data-shape-handle]')) {
                          return;
                        }
                        
                        // Start dragging
                        e.preventDefault();
                        e.stopPropagation();
                        setDraggingShapeId(annot.id);
                        shapeDragStartRef.current = {
                          x: e.clientX,
                          y: e.clientY,
                          annotX: annot.x,
                          annotY: annot.y,
                          points: annot.points ? [...annot.points] : undefined,
                        };
                      }
                    }}
                    onClick={(e) => {
                      if (activeTool === "select") {
                        // Don't select if clicking on a handle or if we just dragged
                        const target = e.target as HTMLElement;
                        if (target.closest('[data-shape-handle]')) {
                          return;
                        }
                        // If we dragged, don't trigger selection
                        if (isDraggingThis && shapeDragStartRef.current) {
                          const dx = e.clientX - shapeDragStartRef.current.x;
                          const dy = e.clientY - shapeDragStartRef.current.y;
                          const moveDistance = Math.sqrt(dx * dx + dy * dy);
                          if (moveDistance > 3) {
                            return; // We dragged, don't select
                          }
                        }
                        e.stopPropagation();
                        setEditingAnnotation(annot);
                      }
                    }}
                  >
                    <svg style={{ width: "100%", height: "100%" }}>
                      {annot.shapeType === "rectangle" ? (
                        <rect
                          x={strokeWidth / 2}
                          y={strokeWidth / 2}
                          width={width - strokeWidth}
                          height={height - strokeWidth}
                          stroke={strokeColor}
                          strokeWidth={strokeWidth}
                          fill={fillColor}
                          fillOpacity={fillOpacity}
                        />
                      ) : (
                        <ellipse
                          cx={width / 2}
                          cy={height / 2}
                          rx={(width - strokeWidth) / 2}
                          ry={(height - strokeWidth) / 2}
                          stroke={strokeColor}
                          strokeWidth={strokeWidth}
                          fill={fillColor}
                          fillOpacity={fillOpacity}
                        />
                      )}
                    </svg>
                  </div>
                  {isSelected && activeTool === "select" && (
                    <ShapeHandles
                      annotation={annot}
                      pdfToCanvas={pdfToCanvas}
                      onUpdate={(updates) => {
                        if (!currentDocument) return;
                        updateAnnotation(
                          currentDocument.getId(),
                          annot.id,
                          updates
                        );
                      }}
                      zoomLevel={currentZoom}
                    />
                  )}
                </div>
              );
            }
          } else if (annot.type === "formField") {
            // Form fields are rendered using FormField component below
            return null;
          } else if (annot.type === "stamp") {
            // Stamp annotations are rendered using StampAnnotation component below
            return null;
          } else if (annot.type === "signatureField") {
            // Signature fields are rendered using SignatureFieldAnnotation component below
            return null;
          }

          return null;
            })}
          </div>
        )}

        {/* Rich text editor for all text annotations - always visible */}
        {(() => {
          // Get all text annotations, including temp ones that haven't been added yet
          const allTextAnnotations = [...annotations.filter(annot => annot.type === "text")];
          
          // If there's an editing annotation that's a temp (not in annotations yet), include it
          if (editingAnnotation && editingAnnotation.type === "text" && editingAnnotation.id.startsWith("temp_")) {
            const tempExists = allTextAnnotations.some(a => a.id === editingAnnotation.id);
            if (!tempExists) {
              allTextAnnotations.push(editingAnnotation);
            }
          }
          
          const filteredAnnotations = allTextAnnotations.filter(annot => annot.pageNumber === pageNumber);
          return filteredAnnotations
            .filter(annot => annot.x != null && annot.y != null) // Filter out annotations with null coordinates
            .map((annot) => {
            // Always show all text annotations - they're always visible
            // Check if this is the currently editing annotation for edit mode
            const isCurrentlyEditing = editingAnnotation?.id === annot.id;
            const isHovered = hoveredAnnotationId === annot.id && activeTool === "select" && !isCurrentlyEditing;
          
          return (() => {
            // Get current viewport transform values
            // Use zoomLevel from state to ensure re-renders when zoom changes
            const currentZoom = zoomLevel;
            
            // Ensure zoom is valid
            if (currentZoom <= 0) return null;
            
            // Read mode: 1:1 overlay space (wrapper scale handles zoom)
            const annotationScale = readMode ? 1.0 : 1.0;
            
            // Since RichTextEditor is inside the transformed div, use canvas display coordinates
            // Ensure coordinates are valid numbers
            if (annot.x == null || annot.y == null || isNaN(annot.x) || isNaN(annot.y)) {
              return null;
            }
            // Canvas pixel = display coordinates (1:1 mapping)
            const canvasPos = pdfToCanvas(annot.x, annot.y);
            
            
            // Determine if this annotation is being edited
            const isEditing = isCurrentlyEditing && isEditingMode;
            // Use annotationText if this is the currently editing annotation (has latest changes including font-size),
            // otherwise fall back to annot.content
            // This ensures font-size changes are preserved even when transitioning out of edit mode
            const content = (isCurrentlyEditing && annotationText) ? annotationText : (annot.content || "");
          
            return (
              <RichTextEditor
                key={annot.id}
                annotation={annot}
                pageRotation={pageRotation}
                content={content}
                isEditing={isEditing}
                isSelected={isCurrentlyEditing || (editingAnnotation?.id === annot.id)}
                isHovered={isHovered}
                activeTool={activeTool}
                isSpacePressed={isSpacePressed}
                onEditModeChange={(editing) => {
                  if (editing) {
                    // When entering edit mode, ensure only this annotation is in edit mode
                    // Exit edit mode for any previously editing annotation
                    if (editingAnnotation && editingAnnotation.id !== annot.id) {
                      setIsEditingMode(false);
                    }
                    // Update state immediately for instant visual feedback
                    setEditingAnnotation(annot);
                    setAnnotationText(annot.content || "");
                    setIsEditingMode(true);
                  } else {
                    // Only exit edit mode if this is the currently editing annotation
                    if (editingAnnotation?.id === annot.id) {
                      setIsEditingMode(false);
                    }
                  }
                }}
                onChange={async (html) => {
                  if (isCurrentlyEditing) {
                    setAnnotationText(html);
                  }
                  
                  // If this is a new annotation (temp ID), create it when user starts typing
                  if (currentDocument && annot.id.startsWith("temp_") && html.trim().length > 0) {
                    // Create the actual annotation
                    const newAnnotation: Annotation = {
                      ...annot,
                      id: `annot_${Date.now()}`,
                      content: html,
                    };
                    
                    // Add to app state with undo/redo support
                    wrapAnnotationOperation(
                      () => {
                        addAnnotation(currentDocument.getId(), newAnnotation);
                      },
                      "addAnnotation",
                      currentDocument.getId(),
                      newAnnotation.id,
                      newAnnotation
                    );
                    
                    // Update editing annotation to use real ID
                    setEditingAnnotation(newAnnotation);
                    
                    // Don't write to PDF immediately - this causes duplication when page re-renders
                    // Text annotations will be written to PDF on save/export
                  } else if (currentDocument && !annot.id.startsWith("temp_")) {
                    // Update existing annotation as user types
                    // Note: We don't wrap every keystroke with undo/redo to avoid history bloat
                    // Only the final state on blur will be undoable
                    updateAnnotation(
                      currentDocument.getId(),
                      annot.id,
                      { content: html }
                    );
                    
                    // Don't update in PDF immediately - this causes duplication when page re-renders
                    // Updates will be written to PDF on save/export
                  }
                }}
                onBlur={async () => {
                  if (!isCurrentlyEditing) return;
                  
                  // Check if blur was caused by clicking on toolbar or popover
                  // Use setTimeout to check activeElement after blur event completes
                  setTimeout(async () => {
                    const activeElement = window.document.activeElement as HTMLElement;
                    if (activeElement) {
                      // Don't exit edit mode if clicking on toolbar elements or popover
                      if (
                        activeElement.closest('[data-formatting-toolbar]') ||
                        activeElement.closest('[role="dialog"]') ||
                        activeElement.closest('[data-radix-portal]') ||
                        activeElement.closest('button') ||
                        activeElement.closest('select') ||
                        activeElement.closest('input[type="color"]') ||
                        activeElement.tagName === 'BUTTON' ||
                        activeElement.tagName === 'SELECT'
                      ) {
                        // Keep edit mode active, just refocus the editor
                        const editorElement = window.document.querySelector(`[data-rich-text-editor="true"][data-annotation-id="${annot.id}"]`) as HTMLElement;
                        if (editorElement) {
                          editorElement.focus();
                        }
                        return;
                      }
                    }
                    
                    // Get the editor element directly from DOM to read the latest HTML (including font-size changes)
                    const editorElement = window.document.querySelector(`[data-rich-text-editor="true"][data-annotation-id="${annot.id}"]`) as HTMLElement;
                    const htmlFromEditor = editorElement?.innerHTML || "";
                    
                    // Don't close on blur if ESC was pressed (that's handled separately)
                    // Only close if clicking outside
                    if (isEditingMode) {
                      // Exit edit mode but keep annotation selected
                      setIsEditingMode(false);
                      return;
                    }
                    
                    if (currentDocument && annot) {
                      // If it's a temp annotation with no text, just discard it
                      if (annot.id.startsWith("temp_") && (!htmlFromEditor || htmlFromEditor.trim().length === 0)) {
                        setEditingAnnotation(null);
                        setAnnotationText("");
                        setIsEditingMode(false);
                        return;
                      }
                      
                      // If it's a temp annotation with text, it should already be created in onChange
                      // Just finalize it
                      if (annot.id.startsWith("temp_") && htmlFromEditor && htmlFromEditor.trim().length > 0) {
                        // Should have been created in onChange, but handle edge case
                        const finalAnnotation: Annotation = {
                          ...annot,
                          id: `annot_${Date.now()}`,
                          content: htmlFromEditor,
                        };
                        
                        wrapAnnotationOperation(
                          () => {
                            addAnnotation(currentDocument.getId(), finalAnnotation);
                          },
                          "addAnnotation",
                          currentDocument.getId(),
                          finalAnnotation.id,
                          finalAnnotation
                        );
                        
                        // Don't write to PDF immediately - this causes duplication when page re-renders
                        // Text annotations will be written to PDF on save/export
                      } else if (!annot.id.startsWith("temp_")) {
                        // Update existing annotation - wrap with undo/redo
                        // Read HTML directly from editor DOM to get the latest content including font-size changes
                        // This is more reliable than annotationText state which might not be updated
                        const contentToSave = htmlFromEditor || annotationText || annot.content || "";
                        wrapAnnotationUpdate(
                          currentDocument.getId(),
                          annot.id,
                          { content: contentToSave }
                        );
                        
                        // Don't update in PDF immediately - this causes duplication when page re-renders
                        // Updates will be written to PDF on save/export
                      }
                    }
                    setEditingAnnotation(null);
                    setAnnotationText("");
                    setIsEditingMode(false);
                  }, 100); // Small delay to allow focus to settle
                }}
                style={{
                  position: "absolute",
                  left: `${canvasPos.x}px`,
                  top: `${canvasPos.y}px`,
                  zIndex: 50, // Higher than annotations and canvas
                  // Reset line-height so text box content isn't affected by read-mode container (lineHeight: 0)
                  ...(readMode ? { lineHeight: "normal" } : {}),
                }}
                scale={annotationScale}
                onResize={(width, height) => {
                  if (currentDocument) {
                    // If this is the start of a resize, capture initial size
                    if (!resizingAnnotationRef.current || resizingAnnotationRef.current.id !== annot.id) {
                      resizingAnnotationRef.current = {
                        id: annot.id,
                        initialWidth: annot.width || 100,
                        initialHeight: annot.height || 50,
                      };
                    }
                    
                    // Update size directly without undo during resize
                    updateAnnotation(
                      currentDocument.getId(),
                      annot.id,
                      { width, height }
                    );
                    if (isCurrentlyEditing) {
                      setEditingAnnotation({
                        ...annot,
                        width,
                        height,
                      });
                    }
                  }
                }}
                onResizeEnd={(initialWidth, initialHeight, finalWidth, finalHeight) => {
                  // When resize ends, record undo/redo with initial and final sizes
                  if (currentDocument) {
                    // Only record undo if size actually changed
                    if (initialWidth !== finalWidth || initialHeight !== finalHeight) {
                      wrapAnnotationUpdate(
                        currentDocument.getId(),
                        annot.id,
                        { width: finalWidth, height: finalHeight }
                      );
                    }
                    
                    // Clear resize tracking
                    resizingAnnotationRef.current = null;
                  }
                }}
                onRotate={(angle) => {
                  if (currentDocument) {
                    // If this is the start of a rotation, capture initial rotation
                    if (!rotatingAnnotationRef.current || rotatingAnnotationRef.current.id !== annot.id) {
                      rotatingAnnotationRef.current = {
                        id: annot.id,
                        initialRotation: annot.rotation || 0,
                      };
                    }
                    
                    // Update rotation directly without undo during rotation
                    updateAnnotation(
                      currentDocument.getId(),
                      annot.id,
                      { rotation: angle }
                    );
                    if (isCurrentlyEditing) {
                      setEditingAnnotation({
                        ...annot,
                        rotation: angle,
                      });
                    }
                  }
                }}
                onRotateEnd={() => {
                  // When rotation ends, record undo/redo with initial and final rotation
                  if (currentDocument && rotatingAnnotationRef.current && rotatingAnnotationRef.current.id === annot.id) {
                    const initialRotation = rotatingAnnotationRef.current;
                    const finalRotation = annot.rotation || 0;
                    
                    // Only record undo if rotation actually changed
                    if (initialRotation.initialRotation !== finalRotation) {
                      wrapAnnotationUpdate(
                        currentDocument.getId(),
                        annot.id,
                        { rotation: finalRotation }
                      );
                    }
                    
                    // Clear rotation tracking
                    rotatingAnnotationRef.current = null;
                  }
                }}
                onMove={(deltaX, deltaY) => {
                  if (currentDocument) {
                    const newX = annot.x + deltaX;
                    const newY = annot.y + deltaY;
                    
                    // If this is the start of a drag, capture initial position
                    if (!draggingAnnotationRef.current || draggingAnnotationRef.current.id !== annot.id) {
                      draggingAnnotationRef.current = {
                        id: annot.id,
                        initialX: annot.x,
                        initialY: annot.y,
                      };
                    }
                    
                    // Update position directly without undo during drag
                    updateAnnotation(
                      currentDocument.getId(),
                      annot.id,
                      { x: newX, y: newY }
                    );
                    
                    if (isCurrentlyEditing) {
                      setEditingAnnotation({
                        ...annot,
                        x: newX,
                        y: newY,
                      });
                    }
                  }
                }}
                onDragEnd={() => {
                  // When drag ends, record undo/redo with initial and final positions
                  if (currentDocument && draggingAnnotationRef.current && draggingAnnotationRef.current.id === annot.id) {
                    const initialPos = draggingAnnotationRef.current;
                    const finalPos = { x: annot.x, y: annot.y };
                    
                    // Only record undo if position actually changed
                    if (initialPos.initialX !== finalPos.x || initialPos.initialY !== finalPos.y) {
                      wrapAnnotationUpdate(
                        currentDocument.getId(),
                        annot.id,
                        finalPos
                      );
                    }
                    
                    // Clear drag tracking
                    draggingAnnotationRef.current = null;
                  }
                }}
                onDuplicate={(e: React.MouseEvent) => {
                  // Create a duplicate of the annotation when CTRL+drag is detected
                  if (currentDocument) {
                    // Create duplicate with new ID at the same position (will be moved by drag)
                    const duplicateAnnotation: Annotation = {
                      ...annot,
                      id: `text_annot_${Date.now()}`,
                      x: annot.x,
                      y: annot.y,
                    };
                    
                    // Add the duplicate to the document
                    addAnnotation(currentDocument.getId(), duplicateAnnotation);
                    
                    // Set the duplicate as the editing annotation so it can be dragged
                    setEditingAnnotation(duplicateAnnotation);
                    setAnnotationText(duplicateAnnotation.content || "");
                    
                    // Initialize drag tracking for the duplicate
                    draggingAnnotationRef.current = {
                      id: duplicateAnnotation.id,
                      initialX: duplicateAnnotation.x,
                      initialY: duplicateAnnotation.y,
                    };
                    
                    // Store duplicate info for drag handling
                    duplicatingAnnotationRef.current = {
                      duplicateId: duplicateAnnotation.id,
                      startX: duplicateAnnotation.x,
                      startY: duplicateAnnotation.y,
                      mouseStartX: e.clientX,
                      mouseStartY: e.clientY,
                    };
                    
                    // Show notification
                    showNotification("Text box duplicated - drag to position", "success");
                  }
                }}
              />
            );
          })();
        })})()}

        {/* Image annotations - always visible (inside transformed div like text annotations) */}
        {(() => {
          const allImageAnnotations = annotations.filter(annot => annot.type === "image");
          const filteredAnnotations = allImageAnnotations.filter(annot => annot.pageNumber === pageNumber);
          return filteredAnnotations
            .filter(annot => annot.x != null && annot.y != null && annot.imageData)
            .map((annot) => {
              const isSelected = editingAnnotation?.id === annot.id;
              const isHovered = hoveredAnnotationId === annot.id && activeTool === "select" && !isSelected;
              
              // Get current viewport transform values
              // Use zoomLevel from state to ensure re-renders when zoom changes
              const currentZoom = zoomLevel;
              if (currentZoom <= 0) return null;
              
              const annotationScale = readMode ? 1.0 : 1.0;
              
              // Convert PDF coordinates to canvas display coordinates (same as text annotations)
              // annot.y is the BOTTOM edge in PDF coordinates
              // For CSS positioning, we need the TOP edge
              const pdfTopY = annot.y + (annot.height || 0);
              // Canvas pixel = display coordinates (1:1 mapping)
              const canvasPos = pdfToCanvas(annot.x, pdfTopY);
              
              return (
                <ImageAnnotation
                  key={annot.id}
                  annotation={annot}
                  scale={annotationScale}
                  style={{
                    position: "absolute",
                    left: `${canvasPos.x}px`,
                    top: `${canvasPos.y}px`,
                    zIndex: 25,
                  }}
                  onMove={(deltaX, deltaY) => {
                    if (!currentDocument) return;
                    const newX = annot.x + deltaX;
                    const newY = annot.y + deltaY;
                    
                    // If this is the start of a drag, capture initial position
                    if (!draggingAnnotationRef.current || draggingAnnotationRef.current.id !== annot.id) {
                      draggingAnnotationRef.current = {
                        id: annot.id,
                        initialX: annot.x,
                        initialY: annot.y,
                      };
                    }
                    
                    // Update position directly without undo during drag
                    updateAnnotation(
                      currentDocument.getId(),
                      annot.id,
                      { x: newX, y: newY }
                    );
                  }}
                  onResize={(width, height) => {
                    if (!currentDocument) return;
                    if (!resizingAnnotationRef.current || resizingAnnotationRef.current.id !== annot.id) {
                      resizingAnnotationRef.current = {
                        id: annot.id,
                        initialWidth: annot.width || 200,
                        initialHeight: annot.height || 200,
                      };
                    }
                    updateAnnotation(
                      currentDocument.getId(),
                      annot.id,
                      { width, height }
                    );
                  }}
                  onResizeWithPosition={(x, y, width, height) => {
                    if (!currentDocument) return;
                    if (!resizingAnnotationRef.current || resizingAnnotationRef.current.id !== annot.id) {
                      resizingAnnotationRef.current = {
                        id: annot.id,
                        initialWidth: annot.width || 200,
                        initialHeight: annot.height || 200,
                      };
                    }
                    updateAnnotation(
                      currentDocument.getId(),
                      annot.id,
                      { x, y, width, height }
                    );
                  }}
                  onResizeEnd={() => {
                    if (currentDocument && resizingAnnotationRef.current && resizingAnnotationRef.current.id === annot.id) {
                      const initialSize = resizingAnnotationRef.current;
                      const finalSize = { width: annot.width || 200, height: annot.height || 200 };

                      if (initialSize.initialWidth !== finalSize.width || initialSize.initialHeight !== finalSize.height) {
                        wrapAnnotationUpdate(
                          currentDocument.getId(),
                          annot.id,
                          finalSize
                        );
                      }

                      resizingAnnotationRef.current = null;
                    }
                  }}
                  onRotate={(angle) => {
                    if (!currentDocument) return;
                    // If this is the start of a rotation, capture initial rotation
                    if (!rotatingAnnotationRef.current || rotatingAnnotationRef.current.id !== annot.id) {
                      rotatingAnnotationRef.current = {
                        id: annot.id,
                        initialRotation: annot.rotation || 0,
                      };
                    }
                    
                    // Update rotation directly without undo during rotation
                    updateAnnotation(
                      currentDocument.getId(),
                      annot.id,
                      { rotation: angle }
                    );
                  }}
                  onRotateEnd={() => {
                    // When rotation ends, record undo/redo with initial and final rotation
                    if (currentDocument && rotatingAnnotationRef.current && rotatingAnnotationRef.current.id === annot.id) {
                      const initialRotation = rotatingAnnotationRef.current;
                      const finalRotation = annot.rotation || 0;
                      
                      // Only record undo if rotation actually changed
                      if (initialRotation.initialRotation !== finalRotation) {
                        wrapAnnotationUpdate(
                          currentDocument.getId(),
                          annot.id,
                          { rotation: finalRotation }
                        );
                      }
                      
                      // Clear rotation tracking
                      rotatingAnnotationRef.current = null;
                    }
                  }}
                  onDragEnd={() => {
                    // When drag ends, record undo/redo with initial and final positions
                    if (currentDocument && draggingAnnotationRef.current && draggingAnnotationRef.current.id === annot.id) {
                      const initialPos = draggingAnnotationRef.current;
                      const finalPos = { x: annot.x, y: annot.y };
                      
                      // Only record undo if position actually changed
                      if (initialPos.initialX !== finalPos.x || initialPos.initialY !== finalPos.y) {
                        wrapAnnotationUpdate(
                          currentDocument.getId(),
                          annot.id,
                          finalPos
                        );
                      }
                      
                      // Clear drag tracking
                      draggingAnnotationRef.current = null;
                    }
                  }}
                  onDuplicate={(e) => {
                    if (!currentDocument) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const duplicateAnnotation: Annotation = {
                      ...annot,
                      id: `image_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                      x: annot.x + 20,
                      y: annot.y + 20,
                    };
                    addAnnotation(currentDocument.getId(), duplicateAnnotation);
                    setEditingAnnotation(duplicateAnnotation);
                    showNotification("Image duplicated - drag to position", "success");
                  }}
                  isSelected={isSelected}
                  isHovered={isHovered}
                  pageRotation={pageRotation}
                  activeTool={activeTool}
                  isSpacePressed={isSpacePressed}
                  onClick={() => {
                    if (activeTool === "select") {
                      setEditingAnnotation(annot);
                      setHoveredAnnotationId(annot.id);
                    }
                  }}
                  onMouseEnter={() => {
                    if (activeTool === "select") {
                      setHoveredAnnotationId(annot.id);
                    }
                  }}
                  onMouseLeave={() => {
                    if (activeTool === "select" && !isSelected) {
                      setHoveredAnnotationId(null);
                    }
                  }}
                />
              );
            });
        })()}

        {/* Form fields - always visible */}
        {(() => {
          const allFormFields = annotations.filter(annot => annot.type === "formField");
          const filteredFields = allFormFields.filter(annot => annot.pageNumber === pageNumber);
          return filteredFields
            .filter(annot => annot.x != null && annot.y != null)
            .map((annot) => {
              const isSelected = editingAnnotation?.id === annot.id;
              
              return (
                <div key={annot.id}>
                  <FormField
                    annotation={annot}
                    pdfToCanvas={pdfToCanvas}
                    zoomLevel={readMode ? readModeAnnotationScale : zoomLevel}
                    onValueChange={(value) => {
                      if (!currentDocument) return;
                      updateAnnotation(
                        currentDocument.getId(),
                        annot.id,
                        { fieldValue: value }
                      );
                    }}
                    onOptionsChange={(options) => {
                      if (!currentDocument) return;
                      updateAnnotation(
                        currentDocument.getId(),
                        annot.id,
                        { options }
                      );
                    }}
                    onMove={(deltaX, deltaY) => {
                      if (!currentDocument) return;
                      const newX = annot.x + deltaX;
                      const newY = annot.y + deltaY;
                      updateAnnotation(
                        currentDocument.getId(),
                        annot.id,
                        { x: newX, y: newY }
                      );
                    }}
                    isEditable={true}
                    isSelected={isSelected}
                    activeTool={activeTool}
                    onClick={() => {
                      if (activeTool === "select" || activeTool === "selectText") {
                        setEditingAnnotation(annot);
                      }
                    }}
                  />
                  {isSelected && activeTool === "select" && (
                    <FormFieldHandles
                      annotation={annot}
                      pdfToCanvas={pdfToCanvas}
                      onUpdate={(updates) => {
                        if (!currentDocument) return;
                        updateAnnotation(
                          currentDocument.getId(),
                          annot.id,
                          updates
                        );
                      }}
                      zoomLevel={readMode ? readModeAnnotationScale : zoomLevel}
                    />
                  )}
                </div>
              );
            });
        })()}

        {/* Callout annotations - always visible */}
        {(() => {
          const allCallouts = annotations.filter(annot => annot.type === "callout");
          const filteredCallouts = allCallouts.filter(annot => annot.pageNumber === pageNumber);
          return filteredCallouts.map((annot) => {
            const currentZoom = zoomLevelRef.current;
            if (currentZoom <= 0) return null;
            
            const isSelected = editingAnnotation?.id === annot.id;
            
            return (
              <CalloutAnnotation
                key={annot.id}
                annotation={annot}
                pdfToContainer={pdfToContainer}
                onEdit={() => {
                  setEditingAnnotation(annot);
                  setAnnotationText(annot.content || "");
                  setIsEditingMode(true);
                }}
                onDelete={async () => {
                  if (!currentDocument) return;
                  
                  try {
                    const mupdfModule = await import("mupdf");
                    const { PDFEditor } = await import("@/core/pdf/PDFEditor");
                    const editor = new PDFEditor(mupdfModule.default);
                    
                    await editor.deleteAnnotation(currentDocument, annot);
                    
                    const { wrapAnnotationOperation } = await import("@/shared/stores/undoHelpers");
                    wrapAnnotationOperation(
                      () => {
                        usePDFStore.getState().removeAnnotation(
                          currentDocument.getId(),
                          annot.id
                        );
                      },
                      "removeAnnotation",
                      currentDocument.getId(),
                      annot.id,
                      undefined,
                      annot
                    );
                  } catch (error) {
                    console.error("Error deleting callout:", error);
                  }
                }}
                isSelected={isSelected}
                zoomLevel={currentZoom}
              />
            );
          });
        })()}

        {/* Stamp annotations - always visible */}
        {(() => {
          const allStamps = annotations.filter(annot => annot.type === "stamp");
          const filteredStamps = allStamps.filter(annot => annot.pageNumber === pageNumber);
          return filteredStamps
            .filter(annot => annot.x != null && annot.y != null)
            .map((annot) => {
              const isSelected = editingAnnotation?.id === annot.id;
              const isHovered = hoveredAnnotationId === annot.id && activeTool === "select" && !isSelected;
              
              // Use zoomLevel from state to ensure re-renders when zoom changes
              const currentZoom = zoomLevel;
              if (currentZoom <= 0) return null;
              
              const annotationScale = readMode ? 1 : (actualScale > 0 ? actualScale : currentZoom);
              
              const pdfTopY = annot.y + (annot.height || 0);
              const canvasPos = pdfToCanvas(annot.x, pdfTopY);
              
              return (
                <StampAnnotation
                  key={annot.id}
                  annotation={annot}
                  scale={annotationScale}
                  style={{
                    position: "absolute",
                    left: `${canvasPos.x}px`,
                    top: `${canvasPos.y}px`,
                    zIndex: 25,
                  }}
                  onMove={(deltaX, deltaY) => {
                    if (!currentDocument) return;
                    // deltaX and deltaY are already in PDF coordinates (converted in StampAnnotation)
                    const newX = annot.x + deltaX;
                    const newY = annot.y + deltaY;
                    
                    if (!draggingAnnotationRef.current || draggingAnnotationRef.current.id !== annot.id) {
                      draggingAnnotationRef.current = {
                        id: annot.id,
                        initialX: annot.x,
                        initialY: annot.y,
                      };
                    }
                    
                    updateAnnotation(
                      currentDocument.getId(),
                      annot.id,
                      { x: newX, y: newY }
                    );
                  }}
                  onResize={(width, height) => {
                    if (!currentDocument) return;
                    if (!resizingAnnotationRef.current || resizingAnnotationRef.current.id !== annot.id) {
                      resizingAnnotationRef.current = {
                        id: annot.id,
                        initialWidth: annot.width || 100,
                        initialHeight: annot.height || 60,
                      };
                    }
                    
                    updateAnnotation(
                      currentDocument.getId(),
                      annot.id,
                      { width, height }
                    );
                  }}
                  onResizeWithPosition={(x, y, width, height) => {
                    if (!currentDocument) return;
                    if (!resizingAnnotationRef.current || resizingAnnotationRef.current.id !== annot.id) {
                      resizingAnnotationRef.current = {
                        id: annot.id,
                        initialWidth: annot.width || 100,
                        initialHeight: annot.height || 60,
                      };
                    }
                    
                    updateAnnotation(
                      currentDocument.getId(),
                      annot.id,
                      { x, y, width, height }
                    );
                  }}
                  onResizeEnd={() => {
                    if (currentDocument && resizingAnnotationRef.current && resizingAnnotationRef.current.id === annot.id) {
                      const initialSize = resizingAnnotationRef.current;
                      const finalSize = { width: annot.width || 100, height: annot.height || 60 };
                      
                      if (initialSize.initialWidth !== finalSize.width || initialSize.initialHeight !== finalSize.height) {
                        wrapAnnotationUpdate(
                          currentDocument.getId(),
                          annot.id,
                          finalSize
                        );
                      }
                      
                      resizingAnnotationRef.current = null;
                    }
                  }}
                  onRotate={(angle) => {
                    if (!currentDocument) return;
                    if (!rotatingAnnotationRef.current || rotatingAnnotationRef.current.id !== annot.id) {
                      rotatingAnnotationRef.current = {
                        id: annot.id,
                        initialRotation: annot.rotation || 0,
                      };
                    }
                    
                    updateAnnotation(
                      currentDocument.getId(),
                      annot.id,
                      { rotation: angle }
                    );
                  }}
                  onRotateEnd={() => {
                    if (currentDocument && rotatingAnnotationRef.current && rotatingAnnotationRef.current.id === annot.id) {
                      const initialRotation = rotatingAnnotationRef.current;
                      const finalRotation = annot.rotation || 0;
                      
                      if (initialRotation.initialRotation !== finalRotation) {
                        wrapAnnotationUpdate(
                          currentDocument.getId(),
                          annot.id,
                          { rotation: finalRotation }
                        );
                      }
                      
                      rotatingAnnotationRef.current = null;
                    }
                  }}
                  onDragEnd={() => {
                    if (currentDocument && draggingAnnotationRef.current && draggingAnnotationRef.current.id === annot.id) {
                      const initialPos = draggingAnnotationRef.current;
                      const finalPos = { x: annot.x, y: annot.y };
                      
                      if (initialPos.initialX !== finalPos.x || initialPos.initialY !== finalPos.y) {
                        wrapAnnotationUpdate(
                          currentDocument.getId(),
                          annot.id,
                          finalPos
                        );
                      }
                      
                      draggingAnnotationRef.current = null;
                    }
                  }}
                  isSelected={isSelected}
                  isHovered={isHovered}
                  activeTool={activeTool}
                  isSpacePressed={isSpacePressed}
                  onClick={() => {
                    if (activeTool === "select") {
                      setEditingAnnotation(annot);
                      setHoveredAnnotationId(annot.id);
                    }
                  }}
                  onDoubleClick={() => {
                    // Open editor for text stamps on double-click
                    if (annot.stampData?.type === "text" && activeTool === "select") {
                      setEditingStampAnnotation(annot);
                    }
                  }}
                  onMouseEnter={() => {
                    if (activeTool === "select") {
                      setHoveredAnnotationId(annot.id);
                    }
                  }}
                  onMouseLeave={() => {
                    if (activeTool === "select" && !isSelected) {
                      setHoveredAnnotationId(null);
                    }
                  }}
                />
              );
            });
        })()}

        {/* Signature field annotations - e-sign prepare/sign mode */}
        {(() => {
          const sigFields = annotations.filter(a => a.type === "signatureField" && a.pageNumber === pageNumber);
          if (sigFields.length === 0) return null;
          if (zoomLevel <= 0) return null;

          return sigFields
            .filter(a => a.x != null && a.y != null)
            .map((annot) => {
              const isSelected = editingAnnotation?.id === annot.id;
              return (
                <div key={annot.id}>
                  <SignatureFieldAnnotation
                    annotation={annot}
                    pdfToCanvas={pdfToCanvas}
                    isSelected={isSelected}
                    onSelect={() => {
                      setEditingAnnotation(annot);
                      window.dispatchEvent(new CustomEvent("annotationSelected", { detail: { annotationId: annot.id } }));
                    }}
                  />
                  {isSelected && activeTool === "select" && (
                    <FormFieldHandles
                      annotation={annot}
                      pdfToCanvas={pdfToCanvas}
                      onUpdate={(updates) => {
                        if (!currentDocument) return;
                        updateAnnotation(
                          currentDocument.getId(),
                          annot.id,
                          updates
                        );
                      }}
                      zoomLevel={readMode ? readModeAnnotationScale : zoomLevel}
                    />
                  )}
                </div>
              );
            });
        })()}

        {/* Stamp Preview - shows when stamp tool is active */}
        {activeTool === "stamp" && stampPreviewPosition && (() => {
          const selectedStampId = getSelectedStamp();
          if (!selectedStampId) return null;
          
          const stamp = getStamp(selectedStampId);
          if (!stamp) return null;
          
          // Use shared dimensions so preview matches placement size exactly (no jump when image loads)
          const { width: previewWidth, height: previewHeight } = getStampPlacementDimensions(stamp, stampSizeMultiplier);
          
          // Position preview: stampPreviewPosition is the bottom-left corner in PDF coordinates
          // Convert to canvas coordinates for top-left positioning (same as StampAnnotation)
          const pdfTopY = stampPreviewPosition.y + previewHeight;
          const canvasPos = pdfToCanvas(stampPreviewPosition.x, pdfTopY);
          
          // Use same coordinate system as stamp overlays: 1:1 with PDF points (container scale applies to both)
          return (
            <div
              key="stamp-preview"
              className="absolute pointer-events-none opacity-70"
              style={{
                left: `${canvasPos.x}px`,
                top: `${canvasPos.y}px`,
                width: `${previewWidth}px`,
                height: `${previewHeight}px`,
                zIndex: 50,
              }}
            >
              <div className="w-full h-full border-2 border-dashed border-blue-500 bg-white/50 flex items-center justify-center rounded shadow-md">
                {stamp.thumbnail ? (
                  <img
                    src={stamp.thumbnail}
                    alt={stamp.name || "Stamp"}
                    className="max-w-full max-h-full w-auto h-auto"
                    style={{ 
                      imageRendering: "auto",
                      objectFit: "contain",
                    }}
                  />
                ) : stamp.type === "text" && stamp.text ? (
                  <div
                    className="text-center"
                    style={{
                      color: stamp.textColor || "#000000",
                      backgroundColor: stamp.backgroundEnabled && stamp.backgroundColor
                        ? (() => {
                            const r = parseInt(stamp.backgroundColor.slice(1, 3), 16);
                            const g = parseInt(stamp.backgroundColor.slice(3, 5), 16);
                            const b = parseInt(stamp.backgroundColor.slice(5, 7), 16);
                            const opacity = stamp.backgroundOpacity !== undefined ? stamp.backgroundOpacity / 100 : 1;
                            return `rgba(${r}, ${g}, ${b}, ${opacity})`;
                          })()
                        : "transparent",
                      fontFamily: stamp.font || "Arial",
                      fontSize: "14px",
                      padding: stamp.borderOffset !== undefined ? `${8 + stamp.borderOffset}px` : "8px",
                      borderRadius: stamp.borderStyle === "rounded" ? "8px" : "0px",
                      border: stamp.borderEnabled 
                        ? `${stamp.borderThickness || 2}px solid ${stamp.borderColor || "#000000"}` 
                        : "none",
                      whiteSpace: "pre-line",
                    }}
                  >
                    {stamp.text}
                  </div>
                ) : (
                  <div className="text-sm text-gray-400">
                    {stamp.name || "Stamp"}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* Stamp Editor Dialog */}
        <StampEditor
          open={editingStampAnnotation !== null}
          onClose={() => setEditingStampAnnotation(null)}
          stampData={editingStampAnnotation?.stampData || null}
          onSave={async (updatedStampData) => {
            if (!currentDocument || !editingStampAnnotation) return;

            // Use shared dimensions so size matches preview and placement
            const { width: newWidth, height: newHeight } = getStampPlacementDimensions(
              updatedStampData,
              stampSizeMultiplier
            );

            // Update annotation with new stamp data and size
            wrapAnnotationUpdate(
              currentDocument.getId(),
              editingStampAnnotation.id,
              {
                stampData: updatedStampData,
                width: newWidth,
                height: newHeight,
              }
            );

            setEditingStampAnnotation(null);
          }}
        />
        {/* Annotation Context Menu */}
        {contextMenu && (
          <AnnotationContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
            items={contextMenuItems}
          />
        )}
        </div>
      </ReadModeScaleWrapper>
    </div>
  );
});
