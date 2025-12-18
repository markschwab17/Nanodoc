/**
 * PageCanvas Component
 * 
 * Renders a single PDF page with enhanced zoom and pan support.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { flushSync } from "react-dom";
import { useUIStore } from "@/shared/stores/uiStore";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useDocumentSettingsStore } from "@/shared/stores/documentSettingsStore";
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
import { FormFieldHandles } from "./FormFieldHandles";
import { ShapeHandles } from "./ShapeHandles";
import { HorizontalRuler } from "./HorizontalRuler";
import { VerticalRuler } from "./VerticalRuler";
import { wrapAnnotationUpdate, wrapAnnotationOperation } from "@/shared/stores/undoHelpers";
import { PDFDocument as PDFDocumentClass } from "@/core/pdf/PDFDocument";
import { toolHandlers } from "@/features/tools";
import { getSelectedStamp, getStampPreviewPosition, setPreviewUpdateCallback } from "@/features/tools/StampTool";
import { getDrawingPath, isCurrentlyDrawing, setDrawPreviewCallback } from "@/features/tools/DrawTool";
import { useStampStore } from "@/shared/stores/stampStore";
import { StampEditor } from "@/features/stamps/StampEditor";
import { getSpansInSelectionFromPage, getStructuredTextForPage, type TextSpan } from "@/core/pdf/PDFTextExtractor";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { useTextAnnotationClipboardStore } from "@/shared/stores/textAnnotationClipboardStore";
import { useTabStore } from "@/shared/stores/tabStore";

interface PageCanvasProps {
  document: PDFDocument;
  pageNumber: number;
  renderer: PDFRenderer;
  onPageClick?: (x: number, y: number) => void;
  readMode?: boolean;
}

export function PageCanvas({
  document,
  pageNumber,
  renderer,
  onPageClick,
  readMode = false,
}: PageCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actualScale, setActualScale] = useState<number>(1.0); // Store the actual scale used for rendering
  const BASE_SCALE = 1.0; // Fixed base scale for PDF rendering (1:1 mapping - canvas size = PDF size)
  const [editor, setEditor] = useState<PDFEditor | null>(null);
  
  const { zoomLevel, fitMode, activeTool, setZoomLevel, setFitMode, setZoomToCenterCallback } = useUIStore();
  const { 
    getCurrentDocument, 
    getAnnotations, 
    addAnnotation, 
    removeAnnotation, 
    updateAnnotation, 
    setCurrentPage, 
    currentPage
  } = usePDFStore();
  
  // Use separate selector for search state to ensure reactivity
  const currentSearchResult = usePDFStore(state => state.currentSearchResult);
  const searchResultsMap = usePDFStore(state => state.searchResults);
  
  const { showRulers } = useDocumentSettingsStore();
  const { showNotification } = useNotificationStore();
  const { copyTextAnnotation, pasteTextAnnotation, hasTextAnnotation, clear: clearTextAnnotationClipboard } = useTextAnnotationClipboardStore();
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
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent("clearEditingAnnotation"));
      });
    }
  }, [editingAnnotation?.id]);
  
  // Listen for clearEditingAnnotation event (from delete handler)
  useEffect(() => {
    const handleClearEditingAnnotation = (e: CustomEvent) => {
      if (editingAnnotation && editingAnnotation.id === e.detail.annotationId) {
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
      if (activeTool === "highlight" && isSelecting && selectionStart && overlayHighlightPath.length > 0 && !selectionEnd) {
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
            if (!currentMouseCoords && globalMousePositionRef.current && canvasRef.current) {
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
              
              // If container method failed, try using canvas element directly
              if (!fallbackCoords && canvasRef.current) {
                const canvasRect = canvasRef.current.getBoundingClientRect();
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

  // Handle keyboard for space+drag pan
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
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        setIsSpacePressed(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  // Use native event listener for wheel to properly prevent default (React synthetic events are passive)
  // In read mode, wheel zoom is handled at the container level, not per-page
  useEffect(() => {
    const container = containerRef.current;
    if (!container || readMode) return; // Don't handle wheel zoom in read mode at page level

    const handleWheelNative = (e: WheelEvent) => {
      // Get current values from refs
      const currentZoomLevel = zoomLevelRef.current;
      const currentFitMode = fitModeRef.current;
      const currentPanOffset = panOffsetRef.current;
      
      // Handle zoom if ctrl/meta is pressed
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();

        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const currentScale = currentZoomLevel;
        const newZoom = Math.max(0.25, Math.min(5, currentScale * delta));

        if (Math.abs(newZoom - currentScale) > 0.001) {
          // Get canvas bounds - use the actual canvas element position
          const canvas = canvasRef.current;
          if (!canvas) return;
          
          const canvasRect = canvas.getBoundingClientRect();
          
          // Mouse position relative to the visible canvas
          const mouseRelativeToCanvasX = e.clientX - canvasRect.left;
          const mouseRelativeToCanvasY = e.clientY - canvasRect.top;
          
          // The canvas is scaled by zoomLevel, so divide to get unscaled canvas coordinates
          const canvasX = mouseRelativeToCanvasX / currentScale;
          const canvasY = mouseRelativeToCanvasY / currentScale;
          
          // Get container bounds for calculating new pan offset
          const containerRect = container.getBoundingClientRect();
          const mouseX = e.clientX - containerRect.left;
          const mouseY = e.clientY - containerRect.top;

          // Calculate new pan offset to place that canvas point at the mouse position
          const newCanvasRelativeX = canvasX * newZoom;
          const newCanvasRelativeY = canvasY * newZoom;
          const newPanX = mouseX - newCanvasRelativeX;
          const newPanY = mouseY - newCanvasRelativeY;

          // Update refs immediately for smooth operation
          panOffsetRef.current = { x: newPanX, y: newPanY };
          zoomLevelRef.current = newZoom;
          fitModeRef.current = "custom";

          // Use flushSync to force all state updates in a single synchronous render
          // This prevents the "adjustment" where some values update before others
          flushSync(() => {
            setFitMode("custom");
            setZoomLevel(newZoom);
            setPanOffset({ x: newPanX, y: newPanY });
          });
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
    };
  }, [setZoomLevel, setFitMode, readMode]);

  useEffect(() => {
    const renderPage = async () => {
      if (!canvasRef.current || !document.isDocumentLoaded()) return;

      setIsRendering(true);
      setError(null);

      try {
        const mupdfDoc = document.getMupdfDocument();
        const pageMetadata = document.getPageMetadata(pageNumber);
        
        if (!pageMetadata) {
          throw new Error(`Page ${pageNumber} not found`);
        }

        // Render PDF at high-DPI resolution for crisp text
        // The coordinate system (BASE_SCALE) stays constant for tool positioning
        // Only the render resolution is multiplied by devicePixelRatio
        const dpr = window.devicePixelRatio || 1;
        const renderScale = BASE_SCALE * dpr;
        
        // Calculate initial viewport scale for fit modes
        let viewportScale = zoomLevel;
        
        // In read mode, PageCanvas just renders at base scale
        // Layout and zoom are handled by VirtualizedPageList and parent container
        if (!readMode) {
          if (fitMode === "width" && containerRef.current) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            const containerWidth = containerRef.current.clientWidth;
            if (containerWidth > 0) {
              viewportScale = containerWidth / pageMetadata.width;
              if (Math.abs(viewportScale - zoomLevel) > 0.01) {
                setZoomLevel(viewportScale);
              }
            }
          } else if (fitMode === "page" && containerRef.current) {
            let containerWidth = containerRef.current.clientWidth;
            let containerHeight = containerRef.current.clientHeight;
            const scaleX = containerWidth / pageMetadata.width;
            const scaleY = containerHeight / pageMetadata.height;
            viewportScale = Math.min(scaleX, scaleY);
            setZoomLevel(viewportScale);
          }
          
          // Center canvas in container when fitting (normal mode only)
          if ((fitMode === "page" || fitMode === "width") && containerRef.current) {
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
          }
        }

        // Note: We do NOT pass rotation to the renderer because mupdf already applies
        // the PDF's Rotate field when loading the page. The page.getBounds() and
        // page.toPixmap() already account for the rotation specified in the PDF.
        // If we apply rotation again, we'd be double-rotating the page.
        
        // Render PDF at fixed base scale (rotation is already applied by mupdf)
        const rendered = await renderer.renderPage(mupdfDoc, pageNumber, {
          scale: renderScale,
          rotation: 0, // Don't apply additional rotation - PDF Rotate is already applied
        });

        const canvas = canvasRef.current;
        
        // High-DPI rendering: canvas backing buffer is DPR times larger than display size
        // This gives crisp text on Retina/HiDPI displays
        const pdfDisplayWidth = pageMetadata.width;
        const pdfDisplayHeight = pageMetadata.height;
        
        // Canvas backing size = rendered size (high-res, e.g., 2x on Retina)
        canvas.width = rendered.width;
        canvas.height = rendered.height;
        
        // Canvas display size = PDF dimensions (browser downscales crisply)
        canvas.style.width = `${pdfDisplayWidth}px`;
        canvas.style.height = `${pdfDisplayHeight}px`;

        const ctx = canvas.getContext("2d", {
          willReadFrequently: false,
          colorSpace: "srgb"
        });
        
        if (ctx && rendered.imageData instanceof ImageData) {
          // Enable smoothing for crisp downscaling on high-DPI displays
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          
          // Draw the rendered image data
          ctx.putImageData(rendered.imageData, 0, 0);
        }
        
        
        // Store the base scale (PDF is always rendered at this scale)
        // The viewport zoom is handled via CSS transforms
        setActualScale(BASE_SCALE);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to render page");
        console.error("Error rendering page:", err);
      } finally {
        setIsRendering(false);
      }
    };

    renderPage();
  }, [document, pageNumber, renderer, zoomLevel, fitMode, setZoomLevel, readMode]);
  
  // Effect to ensure centering when fitMode changes to "page" or "width"
  useEffect(() => {
    if (readMode || !containerRef.current || !document.isDocumentLoaded()) return;
    
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
  }, [fitMode, readMode, document, pageNumber, zoomLevel]);
  
  // Get page metadata to watch for rotation and dimension changes
  const pageMetadata = document?.getPageMetadata(pageNumber);
  const pageRotation = pageMetadata?.rotation ?? 0;
  const pageWidth = pageMetadata?.width ?? 0;
  const pageHeight = pageMetadata?.height ?? 0;
  
  // State to track metadata changes and force re-render
  const [metadataVersion, setMetadataVersion] = useState(0);
  
  // Ref to track previous metadata values for change detection
  const previousMetadataRef = useRef({ rotation: pageRotation, width: pageWidth, height: pageHeight });
  
  // Effect to watch for metadata changes and update state
  useEffect(() => {
    const checkMetadata = () => {
      const currentMetadata = document?.getPageMetadata(pageNumber);
      const currentRotation = currentMetadata?.rotation ?? 0;
      const currentWidth = currentMetadata?.width ?? 0;
      const currentHeight = currentMetadata?.height ?? 0;
      
      const prevRotation = previousMetadataRef.current.rotation;
      const prevWidth = previousMetadataRef.current.width;
      const prevHeight = previousMetadataRef.current.height;
      
      
      // If rotation or dimensions changed, update state to force re-render
      if (currentRotation !== prevRotation || currentWidth !== prevWidth || currentHeight !== prevHeight) {
        previousMetadataRef.current = { rotation: currentRotation, width: currentWidth, height: currentHeight };
        setMetadataVersion(prev => prev + 1);
      }
    };
    
    // Check immediately
    checkMetadata();
    
    // Check periodically to catch metadata changes
    const intervalId = setInterval(checkMetadata, 100);
    
    return () => clearInterval(intervalId);
  }, [document, pageNumber]);
  
  // CRITICAL: Clear renderer cache and canvas when document changes to prevent artifacts
  // This ensures that when switching PDFs, the previous PDF's rendered content doesn't appear
  useEffect(() => {
    if (renderer && document) {
      renderer.clearCache();
    }
    
    // Clear the canvas to remove any rendered content from previous document
    if (canvasRef.current) {
      const ctx = canvasRef.current.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }
    }
    
    // Clear editing state when document changes
    setEditingAnnotation(null);
    setAnnotationText("");
    setIsEditingMode(false);
  }, [document?.getId(), renderer]);
  
  // Effect to force re-render when rotation or dimensions change
  // This ensures the page re-renders with updated dimensions after rotation
  useEffect(() => {
    
    if (!document.isDocumentLoaded() || !renderer || !canvasRef.current) return;
    
    // Clear cache when rotation or dimensions change
    renderer.clearCache();
    
    // Force a re-render by re-running the render logic
    const forceReRender = async () => {
      try {
        const mupdfDoc = document.getMupdfDocument();
        const metadata = document.getPageMetadata(pageNumber);
        if (!metadata) return;
        
        // High-DPI rendering for crisp text
        const dpr = window.devicePixelRatio || 1;
        const renderScale = BASE_SCALE * dpr;
        
        // Render without additional rotation (PDF Rotate is already applied by mupdf)
        const rendered = await renderer.renderPage(mupdfDoc, pageNumber, {
          scale: renderScale,
          rotation: 0,
        });
        
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
  }, [document, pageNumber, renderer, pageRotation, pageWidth, pageHeight, metadataVersion]);

  // Helper function to convert mouse coordinates to PDF coordinates
  // PDF uses bottom-up Y coordinate system, canvas uses top-down
  const getPDFCoordinates = (e: React.MouseEvent): { x: number; y: number } | null => {
    if (!canvasRef.current) return null;
    
    const canvasElement = canvasRef.current;
    const pageMetadata = document.getPageMetadata(pageNumber);
    
    if (!pageMetadata) return null;
    
    // Step 1: Get canvas position on screen (accounts for ALL CSS transforms automatically)
    const canvasRect = canvasElement.getBoundingClientRect();
    
    // Check if canvas has valid dimensions
    if (canvasRect.width === 0 || canvasRect.height === 0 || canvasElement.width === 0 || canvasElement.height === 0) {
      return null;
    }
    
    // Step 2: Calculate mouse position relative to canvas element
    const canvasRelativeX = e.clientX - canvasRect.left;
    const canvasRelativeY = e.clientY - canvasRect.top;
    
    // Step 3: Convert from canvas screen size to canvas pixel coordinates
    // Use ratio conversion: (screen position / screen size) * actual pixel size
    const canvasPixelX = (canvasRelativeX / canvasRect.width) * canvasElement.width;
    const canvasPixelY = (canvasRelativeY / canvasRect.height) * canvasElement.height;
    
    // Step 4: Convert canvas pixels to PDF coordinates
    // PDF Y=0 is at bottom, canvas Y=0 is at top - we need to flip Y-axis
    // IMPORTANT: Use original mediabox dimensions (not swapped display dimensions) for coordinate conversion
    // because annotations are stored in mediabox coordinate space
    let mediaboxHeight: number;
    if (pageMetadata.rotation === 90 || pageMetadata.rotation === 270) {
      // Display dimensions are swapped, so mediaboxHeight = displayWidth
      mediaboxHeight = pageMetadata.width;
    } else {
      // Display dimensions match mediabox dimensions
      mediaboxHeight = pageMetadata.height;
    }
    
    // High-DPI: canvas backing buffer is DPR times larger than display size
    // So we divide by (BASE_SCALE * dpr) to convert from canvas pixels to PDF points
    const dpr = window.devicePixelRatio || 1;
    const pdfX = canvasPixelX / (BASE_SCALE * dpr);
    const pdfY = mediaboxHeight - (canvasPixelY / (BASE_SCALE * dpr));  // Flip Y: PDF Y=0 is at bottom
    
    return { x: pdfX, y: pdfY };
  };

  // Helper function to convert PDF coordinates to canvas coordinates for rendering overlays
  // Must match getPDFCoordinates - both flip Y-axis since PDF Y=0 is at bottom, canvas Y=0 is at top
  // getPDFCoordinates: pageHeight - (canvasPixelY / BASE_SCALE) → pdfY (flipped)
  // pdfToCanvas: (pageHeight - pdfY) * BASE_SCALE → canvasY (flipped, to match)
  // IMPORTANT: Use original mediabox dimensions (not swapped display dimensions) for coordinate conversion
  // because annotations are stored in mediabox coordinate space
  const pdfToCanvas = (pdfX: number, pdfY: number, _useRefs: boolean = false): { x: number; y: number } => {
    const pageMetadata = document.getPageMetadata(pageNumber);
    
    if (!pageMetadata) {
      return { x: pdfX * BASE_SCALE, y: pdfY * BASE_SCALE };
    }
    
    // Get original mediabox dimensions for Y-axis flipping
    // CRITICAL: After rotation, annotation coordinates are transformed to the rotated coordinate system.
    // The rotated coordinate system has:
    // - X range: 0 to originalHeight (1735) when rotated 90/270
    // - Y range: 0 to originalWidth (2592) when rotated 90/270
    // For Y-axis flipping, we need to use the Y-axis range of the rotated coordinate system,
    // which is originalWidth (2592) when rotated 90/270, or originalHeight (1735) when rotated 0/180.
    const currentRotation = pageRotation !== undefined ? pageRotation : (pageMetadata.rotation ?? 0);
    let mediaboxHeight: number;
    
    // If the annotation's Y coordinate is greater than the original height, it's likely in the rotated coordinate system
    // This handles the case where pageMetadata.rotation hasn't updated yet but annotations have been transformed
    // After 90° rotation, Y range becomes 0 to originalWidth (2592), so pdfY > originalHeight (1735) indicates rotated coords
    const isLikelyRotated = pdfY > pageMetadata.height && pageMetadata.width > pageMetadata.height;
    
    if (currentRotation === 90 || currentRotation === 270 || isLikelyRotated) {
      // After 90° rotation, the rotated coordinate system's Y-axis is the original width
      // So we use pageMetadata.width (which is the original width = 2592) for Y-axis flipping
      mediaboxHeight = pageMetadata.width;
    } else {
      // Display dimensions match mediabox dimensions
      // Y-axis range is the original height
      mediaboxHeight = pageMetadata.height;
    }
    
    // PDF Y=0 is at bottom, canvas Y=0 is at top - flip Y-axis using mediabox height
    const flippedY = mediaboxHeight - pdfY;
    
    const result = {
      x: pdfX * BASE_SCALE,
      y: flippedY * BASE_SCALE,  // Flip Y to match getPDFCoordinates
    };
    
    // Debug logging for arrow points specifically
    if (Math.abs(pdfX) < 10000 && Math.abs(pdfY) < 10000) { // Only log reasonable values to avoid spam
      console.log("🔴 [pdfToCanvas] Converting:", { pdfX, pdfY, mediaboxHeight, flippedY, result });
    }
    
    return result;
  };

  // Helper function to convert PDF coordinates to container-relative (screen) coordinates
  // This is the REVERSE of getPDFCoordinates
  const pdfToContainer = (pdfX: number, pdfY: number, _useRefs: boolean = false): { x: number; y: number } => {
    if (!canvasRef.current) {
      return { x: 0, y: 0 };
    }
    
    const pageMetadata = document.getPageMetadata(pageNumber);
    
    if (!pageMetadata) {
      return { x: 0, y: 0 };
    }
    
    // Convert PDF coordinates to canvas display coordinates (in display pixels)
    // PDF Y=0 is at bottom, canvas Y=0 is at top
    const canvasDisplayX = pdfX * BASE_SCALE;
    const canvasDisplayY = (pageMetadata.height - pdfY) * BASE_SCALE;
    
    // Canvas display coordinates are already in the correct coordinate system
    // (rendered image is at BASE_SCALE resolution, canvas display size matches)
    const screenRelativeX = canvasDisplayX;
    const screenRelativeY = canvasDisplayY;
    
    // Add canvas position to get absolute screen coordinates
    // const screenX = canvasRect.left + screenRelativeX;
    // const screenY = canvasRect.top + screenRelativeY;
    
    // But we want container-relative, so just use the relative values
    // Actually, for rendering purposes we want canvas-relative which is screen-relative
    return {
      x: screenRelativeX,
      y: screenRelativeY,
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

  const handleMouseDown = async (e: React.MouseEvent) => {
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
    if (e.button === 1 || (e.button === 0 && (isSpacePressed || activeTool === "pan"))) {
      e.preventDefault();
      e.stopPropagation();
      if (e.nativeEvent && 'stopImmediatePropagation' in e.nativeEvent) {
        e.nativeEvent.stopImmediatePropagation();
      }
      setIsDragging(true);
      // Use ref value in custom mode to avoid stale state
      const currentPanForDrag = fitMode === "custom" ? panOffsetRef.current : panOffset;
      setDragStart({ x: e.clientX - currentPanForDrag.x, y: e.clientY - currentPanForDrag.y });
      return;
    }

    // Initialize overlay path for highlight tool - start immediately
    if (activeTool === "highlight") {
      const coords = getPDFCoordinates(e);
      if (coords) {
        // Initialize path immediately so preview shows right away
        setOverlayHighlightPath([coords]);
        // Hide cursor preview when starting to draw
        setMousePosition(null);
      }
    }

    // Use tool handlers for tool-specific interactions
    if (currentDocument && activeTool !== "select" && activeTool !== "pan") {
      const toolHandler = toolHandlers[activeTool];
      if (toolHandler) {
        const toolContext = {
          document,
          pageNumber,
          currentDocument,
          annotations,
          activeTool,
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
        };
        
        const result = await toolHandler.handleMouseDown(e, toolContext);
        if (result === true) {
          // Handler indicates it fully handled the event
          return;
        }
      }
    }

    // Handle selectText tool - clear previous selection only if clicking outside current selection
    if (activeTool === "selectText" && currentDocument) {
      const coords = getPDFCoordinates(e);
      let shouldClearSelection = true;
      
      // Check if click is within current selection bounds
      if (coords && selectedTextSpans.length > 0 && selectionStart && selectionEnd) {
        const minX = Math.min(selectionStart.x, selectionEnd.x);
        const maxX = Math.max(selectionStart.x, selectionEnd.x);
        const minY = Math.min(selectionStart.y, selectionEnd.y);
        const maxY = Math.max(selectionStart.y, selectionEnd.y);
        
        // Check if click is within selection rectangle
        if (coords.x >= minX && coords.x <= maxX && coords.y >= minY && coords.y <= maxY) {
          shouldClearSelection = false;
        }
      }
      
      // Only clear if clicking outside selection or if no selection exists
      if (shouldClearSelection) {
        setSelectedTextSpans([]);
        selectedTextRef.current = "";
        setIsSelecting(false);
        setSelectionStart(null);
        setSelectionEnd(null);
      }
      
      const toolHandler = toolHandlers[activeTool];
      if (toolHandler) {
        const toolContext = {
          document,
          pageNumber,
          currentDocument,
          annotations,
          activeTool,
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
        };
        
        await toolHandler.handleMouseDown(e, toolContext);
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
    if (activeTool === "highlight" && !isDragging && !isSelecting) {
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
        
        // Update duplicate position
        const newX = dupInfo.startX + pdfDeltaX;
        const newY = dupInfo.startY + pdfDeltaY;
        
        updateAnnotation(
          currentDocument.getId(),
          dupInfo.duplicateId,
          { x: newX, y: newY }
        );
        
        // Update editing annotation if it's the duplicate
        if (editingAnnotation && editingAnnotation.id === dupInfo.duplicateId) {
          setEditingAnnotation({
            ...editingAnnotation,
            x: newX,
            y: newY,
          });
        }
      }
    } else if (isDragging) {
      setPanOffset({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
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
        if (activeTool === "highlight" && e.shiftKey) {
          // Let the tool handler update selectionEnd first, then we'll track it
          setSelectionEnd(coords);
        } else {
          setSelectionEnd(coords);
          
          // Track overlay path directly here for live preview - update immediately
          if (activeTool === "highlight") {
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
    if ((activeTool === "selectText" || activeTool === "highlight") && !isSelecting && !selectionStart) {
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
            
            // Calculate bounding box from path points
            const allX = annot.path.map((p: { x: number; y: number }) => p.x);
            const allY = annot.path.map((p: { x: number; y: number }) => p.y);
            const minX = Math.min(...allX) - padding;
            const maxX = Math.max(...allX) + padding;
            const minY = Math.min(...allY) - padding;
            const maxY = Math.max(...allY) + padding;
            
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
          const toolContext = {
            document,
            pageNumber,
            currentDocument,
            annotations,
            activeTool,
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
          };
          
          toolHandler.handleMouseMove(e, toolContext);
        }
      }
    } else if (isSelecting && selectionStart && activeTool === "selectText") {
      // Update text selection preview for selectText tool when already selecting
      const coords = getPDFCoordinates(e);
      if (coords && currentDocument) {
        const toolHandler = toolHandlers[activeTool];
        if (toolHandler && toolHandler.handleMouseMove) {
          const toolContext = {
            document,
            pageNumber,
            currentDocument,
            annotations,
            activeTool,
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
          };
          
          toolHandler.handleMouseMove(e, toolContext);
        }
      }
    }
    
    // Handle highlight tool mouse move for overlay path and shift+drag
    if (activeTool === "highlight" && isSelecting && selectionStart && currentDocument) {
      const toolHandler = toolHandlers[activeTool];
      if (toolHandler && toolHandler.handleMouseMove) {
        const toolContext = {
          document,
          pageNumber,
          currentDocument,
          annotations,
          activeTool,
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
          setSelectionEnd: (coords: { x: number; y: number } | null) => {
            setSelectionEnd(coords);
            // Track overlay path using the updated selectionEnd (includes shift-locked coordinates)
            if (coords && activeTool === "highlight") {
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
          },
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
        };
        
        toolHandler.handleMouseMove(e, toolContext);
      }
    }
    
    // Handle generic tool mouse move for draw, shape, and form tools
    if ((activeTool === "draw" || activeTool === "shape" || activeTool === "form") && 
        (isSelecting || selectionStart) && currentDocument) {
      const toolHandler = toolHandlers[activeTool];
      if (toolHandler && toolHandler.handleMouseMove) {
        const toolContext = {
          document,
          pageNumber,
          currentDocument,
          annotations,
          activeTool,
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
        };
        
        toolHandler.handleMouseMove(e, toolContext);
      }
    }
    
    // Handle stamp tool mouse move for preview - always call when stamp tool is active
    if (activeTool === "stamp" && currentDocument) {
      const toolHandler = toolHandlers["stamp"];
      if (toolHandler && toolHandler.handleMouseMove) {
        const toolContext = {
          document,
          pageNumber,
          currentDocument,
          annotations,
          activeTool,
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
        };
        
        toolHandler.handleMouseMove(e, toolContext);
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

      if (imageFile && currentDocument && canvasRef.current) {
        console.log("Image file detected:", imageFile.name, imageFile.type);
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
          const canvasElement = canvasRef.current;
          const pageMetadata = currentDocument.getPageMetadata(pageNumber);
          
          if (!pageMetadata) {
            console.warn("Cannot get page metadata for image drop");
            showNotification("Cannot get page metadata for image drop", "error");
            return;
          }

          // Get canvas position on screen
          const canvasRect = canvasElement.getBoundingClientRect();
          
          if (canvasRect.width === 0 || canvasRect.height === 0 || canvasElement.width === 0 || canvasElement.height === 0) {
            console.warn("Canvas has invalid dimensions");
            showNotification("Canvas has invalid dimensions", "error");
            return;
          }
          
          // Calculate drop position relative to canvas
          const canvasRelativeX = e.clientX - canvasRect.left;
          const canvasRelativeY = e.clientY - canvasRect.top;
          
          console.log("Drop position:", e.clientX, e.clientY, "Canvas relative:", canvasRelativeX, canvasRelativeY);
          
          // Convert to canvas pixel coordinates
          const canvasPixelX = (canvasRelativeX / canvasRect.width) * canvasElement.width;
          const canvasPixelY = (canvasRelativeY / canvasRect.height) * canvasElement.height;
          
          // Convert to PDF coordinates (1:1 mapping with BASE_SCALE = 1.0)
          let mediaboxHeight: number;
          if (pageMetadata.rotation === 90 || pageMetadata.rotation === 270) {
            mediaboxHeight = pageMetadata.width;
          } else {
            mediaboxHeight = pageMetadata.height;
          }
          
          const pdfX = canvasPixelX;
          const pdfY = mediaboxHeight - canvasPixelY;

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

          // Mark tab as modified
          const tab = useTabStore.getState().getTabByDocumentId(currentDocument.getId());
          if (tab) {
            useTabStore.getState().setTabModified(tab.id, true);
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
        
        let result: { spans: TextSpan[]; text: string };
        
        if (isClick) {
          // For clicks, expand to a small area around the point to find text
          const expandSize = 10; // 10 points in each direction
          const expandedStart = { x: selectionStart.x - expandSize, y: selectionStart.y - expandSize };
          const expandedEnd = { x: selectionStart.x + expandSize, y: selectionStart.y + expandSize };
          result = await getSpansInSelectionFromPage(
            currentDocument,
            pageNumber,
            expandedStart,
            expandedEnd
          );
        } else {
          // For drags, use the actual selection
          result = await getSpansInSelectionFromPage(
            currentDocument,
            pageNumber,
            selectionStart,
            selectionEnd
          );
        }
        
        setSelectedTextSpans(result.spans);
        selectedTextRef.current = result.text;
        
        // Always clear isSelecting after mouseUp, regardless of result
        setIsSelecting(false);
        
        // For drags (not clicks), clear selectionStart/selectionEnd to stop handleMouseMove from continuing
        // The selectedTextSpans are already stored, so we don't need these anymore
        if (!isClick) {
          setSelectionStart(null);
          setSelectionEnd(null);
        }
        
        if (!result.text) {
          console.warn("No text selected");
          // Clear selection state if no text found (for clicks)
          setSelectionStart(null);
          setSelectionEnd(null);
        }
      } catch (error) {
        console.error("Error extracting text selection:", error);
        setSelectedTextSpans([]);
        selectedTextRef.current = "";
        setIsSelecting(false);
        setSelectionStart(null);
        setSelectionEnd(null);
      }
    } else if (currentDocument && activeTool !== "select" && activeTool !== "pan" && activeTool !== "selectText") {
      // Use tool handlers for ALL tools that have mouse up logic (not just text tool)
      const toolHandler = toolHandlers[activeTool];
      if (toolHandler && toolHandler.handleMouseUp) {
        const toolContext = {
          document,
          pageNumber,
          currentDocument,
          annotations,
          activeTool,
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
          overlayHighlightPath: activeTool === "highlight" ? overlayHighlightPath : undefined,
        };
        
        // For highlight tool, ensure we have selectionEnd from the path if it's missing
        let finalSelectionEnd = selectionEnd;
        if (activeTool === "highlight") {
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
    if (activeTool === "highlight" && !isSelecting) {
      // Use setTimeout to ensure cleanup happens after highlight is committed
      // Give it a longer delay to ensure the tool handler has finished
      setTimeout(() => {
        setOverlayHighlightPath([]);
        setMousePosition(null);
        setIsShiftPressed(false);
      }, 100);
    }
  };

  // Prevent context menu on middle click
  const handleContextMenu = (e: React.MouseEvent) => {
    if (e.button === 1) {
      e.preventDefault();
    }
  };

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
    ? isHoveringOverText
      ? "text"
      : "default"
    : activeTool === "highlight"
    ? isSelecting 
      ? "text" // Show text cursor while selecting/dragging
      : isHoveringOverText
        ? "text" // Show text cursor when hovering over text
        : "crosshair"
    : activeTool === "callout"
    ? "crosshair"
    : activeTool === "redact"
    ? "crosshair"
    : "default";

  return (
    <div
      ref={containerRef}
      data-page-canvas={pageNumber}
      className={cn(
        "relative bg-muted transition-all duration-200",
        readMode ? "" : "w-full",
        readMode ? "" : "h-full",
        // In read mode when zoomed, allow overflow so content isn't cut off
        readMode && fitMode === "custom" ? "overflow-visible" : "overflow-hidden",
        isDragOverPage && "ring-4 ring-primary ring-offset-4 bg-primary/10"
      )}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={(e) => {
        // If we're in the middle of a highlight drag, commit it before cleaning up
        if (activeTool === "highlight" && isSelecting && selectionStart && overlayHighlightPath.length > 0) {
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
        margin: readMode ? '0 auto' : 0, // Center the container in read mode
        padding: 0, 
        lineHeight: readMode ? 0 : undefined, 
        fontSize: readMode ? 0 : undefined,
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
      
      {isRendering && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-10">
          <div className="text-muted-foreground">Rendering...</div>
        </div>
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
      <div
        className={readMode ? "block relative" : "inline-block relative"}
        style={{
          // In read mode, no transform - zoom is handled at the pages container level
          // In normal mode, apply viewport transform: scale then translate
          // Always use panOffset state (not ref) for consistency - refs are for internal calculations
          transform: readMode 
            ? undefined
            : `scale(${zoomLevel}) translate(${panOffset.x / zoomLevel}px, ${panOffset.y / zoomLevel}px)`,
          transformOrigin: "0 0",
          margin: readMode ? '0 auto' : 0,
          padding: 0,
          lineHeight: readMode ? 0 : undefined,
          fontSize: readMode ? 0 : undefined,
          // In read mode, let parent container handle sizing
          width: readMode ? "100%" : undefined,
          height: readMode ? "100%" : undefined,
        }}
      >
        <canvas 
          ref={canvasRef} 
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
            // In read mode, canvas fills its container (sized by VirtualizedPageList)
            width: readMode ? "100%" : undefined,
            height: readMode ? "100%" : undefined,
          }} 
        />
        
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
            
            return (
              <div
                className="absolute border-2 border-dashed border-primary bg-primary/10 pointer-events-none z-40"
                style={{
                  left: `${minX}px`,
                  top: `${minY}px`,
                  width: `${Math.max(50, width)}px`,
                  height: `${Math.max(30, height)}px`,
                  borderRadius: "4px",
                }}
              />
            );
          })()
        )}

        {/* Render overlay highlight preview - always show while drawing for visual feedback */}
        {activeTool === "highlight" && overlayHighlightPath.length > 0 && (isSelecting || selectionStart) && (() => {
          const { highlightColor, highlightStrokeWidth, highlightOpacity } = useUIStore.getState();
          
          // If shift is pressed and we have start and end, show straight line preview
          let pathToRender = overlayHighlightPath;
          if (isShiftPressed && selectionStart && selectionEnd) {
            // Use selectionStart and selectionEnd (which are locked) for straight line preview
            pathToRender = [selectionStart, selectionEnd];
          } else if (isShiftPressed && selectionStart && overlayHighlightPath.length > 0) {
            // Fallback: use first and last point from path
            const start = overlayHighlightPath[0];
            const end = overlayHighlightPath[overlayHighlightPath.length - 1];
            pathToRender = [start, end];
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
        {activeTool === "highlight" && !isSelecting && mousePosition && (() => {
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
          const shouldShowHighlights = (activeTool === "selectText" || activeTool === "highlight") && selectedTextSpans.length > 0;
          
          if (!shouldShowHighlights) return null;
          
          // Get highlight color for preview when using highlight tool
          const { highlightColor, highlightOpacity } = useUIStore.getState();
          const previewColor = activeTool === "highlight" ? highlightColor : null;
          const isHighlightPreview = activeTool === "highlight" && isSelecting;
          
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

        {/* Render search result highlights */}
        {pageSearchMatches.length > 0 && (
          <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 50 }}>
            {pageSearchMatches.map((match) => {
                // match.quad is an array of quads (for multi-line matches)
                // Each quad is [x0, y0, x1, y1, x2, y2, x3, y3] in PDF coordinates
                // Get the first quad for this match
                const quads = match.quad;
                const isCurrentMatch = currentSearchMatch?.matchIndex === match.matchIndex;
                
                // Render each quad in this match (usually just one, but can be multiple for multi-line text)
                return quads.map((singleQuad: number[], quadIdx: number) => {
                  const minX = Math.min(singleQuad[0], singleQuad[2], singleQuad[4], singleQuad[6]);
                  const minY = Math.min(singleQuad[1], singleQuad[3], singleQuad[5], singleQuad[7]);
                  const maxX = Math.max(singleQuad[0], singleQuad[2], singleQuad[4], singleQuad[6]);
                  const maxY = Math.max(singleQuad[1], singleQuad[3], singleQuad[5], singleQuad[7]);
                  
                  // mupdf search quads use Y=0 at top (screen-like coordinates)
                  // NOT Y=0 at bottom like standard PDF coordinates
                  // So we don't need to flip Y - just scale directly with BASE_SCALE
                  const canvasX = minX * BASE_SCALE;
                  const canvasY = minY * BASE_SCALE;
                  const width = (maxX - minX) * BASE_SCALE;
                  const height = (maxY - minY) * BASE_SCALE;
                  
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
        )}

        {/* Render annotations */}
        {annotations.length > 0 && (
          <div className="absolute inset-0" style={{ zIndex: 20, pointerEvents: (activeTool === "select" || activeTool === "selectText") ? "auto" : "none" }}>
            {annotations.map((annot) => {
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
                    zIndex: 30,
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
                          backgroundColor: highlightColor,
                          opacity: opacity,
                        }}
                      />
                    );
                  })}
                </div>
              );
            }
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
              const arrowHeadSizePdf = annot.arrowHeadSize || 10;
              const arrowHeadSize = arrowHeadSizePdf * BASE_SCALE;
              
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
            // Get current viewport transform values (use refs for real-time updates during zoom)
            const currentZoom = zoomLevelRef.current;
            
            // Ensure zoom is valid
            if (currentZoom <= 0) return null;
            
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
                }}
                scale={1.0}
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
              const currentZoom = zoomLevelRef.current;
              if (currentZoom <= 0) return null;
              
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
                  scale={1.0}
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
                    // If this is the start of a resize, capture initial size
                    if (!resizingAnnotationRef.current || resizingAnnotationRef.current.id !== annot.id) {
                      resizingAnnotationRef.current = {
                        id: annot.id,
                        initialWidth: annot.width || 200,
                        initialHeight: annot.height || 200,
                      };
                    }
                    
                    // Update size directly without undo during resize
                    updateAnnotation(
                      currentDocument.getId(),
                      annot.id,
                      { width, height }
                    );
                  }}
                  onResizeEnd={() => {
                    // When resize ends, record undo/redo with initial and final sizes
                    if (currentDocument && resizingAnnotationRef.current && resizingAnnotationRef.current.id === annot.id) {
                      const initialSize = resizingAnnotationRef.current;
                      const finalSize = { width: annot.width || 200, height: annot.height || 200 };
                      
                      // Only record undo if size actually changed
                      if (initialSize.initialWidth !== finalSize.width || initialSize.initialHeight !== finalSize.height) {
                        wrapAnnotationUpdate(
                          currentDocument.getId(),
                          annot.id,
                          finalSize
                        );
                      }
                      
                      // Clear resize tracking
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
                    onLockChange={(locked) => {
                      if (!currentDocument) return;
                      updateAnnotation(
                        currentDocument.getId(),
                        annot.id,
                        { locked }
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
                    zoomLevel={zoomLevel}
                    activeTool={activeTool}
                    onClick={() => {
                      if (activeTool === "select") {
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
                      zoomLevel={zoomLevel}
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
              
              const currentZoom = zoomLevelRef.current;
              if (currentZoom <= 0) return null;
              
              // Use actualScale for coordinate conversion (accounts for fit modes)
              const currentScale = actualScaleRef.current > 0 ? actualScaleRef.current : currentZoom;
              
              const pdfTopY = annot.y + (annot.height || 0);
              const canvasPos = pdfToCanvas(annot.x, pdfTopY);
              
              return (
                <StampAnnotation
                  key={annot.id}
                  annotation={annot}
                  scale={currentScale}
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

        {/* Stamp Preview - shows when stamp tool is active */}
        {activeTool === "stamp" && stampPreviewPosition && (() => {
          const selectedStampId = getSelectedStamp();
          if (!selectedStampId) return null;
          
          const stamp = getStamp(selectedStampId);
          if (!stamp) return null;
          
          // Calculate preview dimensions the same way as actual stamp
          let previewWidth = 100;
          let previewHeight = 60;
          
          if (stamp.thumbnail) {
            // Calculate from thumbnail dimensions (same logic as StampTool)
            const img = new Image();
            img.src = stamp.thumbnail;
            if (img.complete && img.width && img.height) {
              // Thumbnail is generated at scale 6, so convert to PDF points
              const scale = 6; // Thumbnail generation scale
              const thumbnailWidthInPoints = img.width / scale;
              const thumbnailHeightInPoints = img.height / scale;
              
              // Use the actual thumbnail dimensions (scaled down) to match exactly what's rendered
              previewWidth = thumbnailWidthInPoints;
              previewHeight = thumbnailHeightInPoints;
              
              // Apply size multiplier
              previewWidth *= stampSizeMultiplier;
              previewHeight *= stampSizeMultiplier;
              
              if (previewWidth < 50) previewWidth = 50;
              if (previewHeight < 30) previewHeight = 30;
            }
          } else if (stamp.type === "text" && stamp.text) {
            // Calculate from text content (same logic as StampTool)
            const lines = stamp.text.split('\n');
            const fontSize = 12;
            const lineHeight = fontSize * 1.2;
            const borderOffset = stamp.borderOffset || 8;
            const borderThickness = stamp.borderEnabled ? (stamp.borderThickness || 2) : 0;
            const contentPadding = borderOffset;
            
            const canvas = window.document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            if (ctx) {
              ctx.font = `${fontSize}px ${stamp.font || "Arial"}`;
              let maxTextWidth = 0;
              lines.forEach((line) => {
                const metrics = ctx.measureText(line);
                if (metrics.width > maxTextWidth) {
                  maxTextWidth = metrics.width;
                }
              });
              
              // Calculate content dimensions (text + padding)
              const textBlockHeight = lines.length * lineHeight;
              const contentWidth = maxTextWidth + contentPadding * 2;
              const contentHeight = textBlockHeight + contentPadding * 2;
              
              // Total dimensions include border thickness
              previewWidth = contentWidth + borderThickness;
              previewHeight = contentHeight + borderThickness;
              
              // Apply size multiplier
              previewWidth *= stampSizeMultiplier;
              previewHeight *= stampSizeMultiplier;
              
              if (previewWidth < 50) previewWidth = 50;
              if (previewHeight < 30) previewHeight = 30;
            }
          }
          
          // Calculate scale the same way as stamp annotations
          const currentZoom = zoomLevelRef.current;
          const currentScale = actualScaleRef.current > 0 ? actualScaleRef.current : currentZoom;
          
          // Position preview: stampPreviewPosition is the bottom-left corner in PDF coordinates
          // Convert to canvas coordinates for top-left positioning
          const pdfTopY = stampPreviewPosition.y + previewHeight;
          const canvasPos = pdfToCanvas(stampPreviewPosition.x, pdfTopY);
          
          return (
            <div
              key="stamp-preview"
              className="absolute pointer-events-none opacity-70"
              style={{
                left: `${canvasPos.x}px`,
                top: `${canvasPos.y}px`,
                width: `${previewWidth * currentScale}px`,
                height: `${previewHeight * currentScale}px`,
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

            // Recalculate stamp size based on updated data
            let newWidth = editingStampAnnotation.width || 100;
            let newHeight = editingStampAnnotation.height || 60;

            if (updatedStampData.type === "text" && updatedStampData.text) {
              const lines = updatedStampData.text.split('\n');
              const fontSize = 12;
              const lineHeight = fontSize * 1.2;
              const borderOffset = updatedStampData.borderOffset || 8;
              const borderThickness = updatedStampData.borderEnabled ? (updatedStampData.borderThickness || 2) : 0;
              const contentPadding = borderOffset;
              
              const canvas = window.document.createElement("canvas");
              const ctx = canvas.getContext("2d");
              if (ctx) {
                ctx.font = `${fontSize}px ${updatedStampData.font || "Arial"}`;
                let maxTextWidth = 0;
                lines.forEach((line) => {
                  const metrics = ctx.measureText(line);
                  if (metrics.width > maxTextWidth) {
                    maxTextWidth = metrics.width;
                  }
                });
                
                const textBlockHeight = lines.length * lineHeight;
                const contentWidth = maxTextWidth + contentPadding * 2;
                const contentHeight = textBlockHeight + contentPadding * 2;
                
                const totalWidth = contentWidth + borderThickness;
                const totalHeight = contentHeight + borderThickness;
                
                newWidth = totalWidth * stampSizeMultiplier;
                newHeight = totalHeight * stampSizeMultiplier;
                
                if (newWidth < 50) newWidth = 50;
                if (newHeight < 30) newHeight = 30;
              }
            } else if (updatedStampData.thumbnail) {
              const img = new Image();
              img.src = updatedStampData.thumbnail;
              await new Promise<void>((resolve) => {
                if (img.complete) {
                  resolve();
                } else {
                  img.onload = () => resolve();
                  img.onerror = () => resolve();
                }
              });
              
              if (img.width && img.height) {
                const scale = 6;
                const thumbnailWidthInPoints = img.width / scale;
                const thumbnailHeightInPoints = img.height / scale;
                
                newWidth = thumbnailWidthInPoints * stampSizeMultiplier;
                newHeight = thumbnailHeightInPoints * stampSizeMultiplier;
                
                if (newWidth < 50) newWidth = 50;
                if (newHeight < 30) newHeight = 30;
              }
            }

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
      </div>
    </div>
  );
}
