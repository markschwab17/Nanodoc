/**
 * PageCanvas Component
 * 
 * Renders a single PDF page with enhanced zoom and pan support.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useUIStore } from "@/shared/stores/uiStore";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useDocumentSettingsStore } from "@/shared/stores/documentSettingsStore";
import { cn } from "@/lib/utils";
import { PDFEditor } from "@/core/pdf/PDFEditor";
import type { PDFRenderer } from "@/core/pdf/PDFRenderer";
import type { PDFDocument } from "@/core/pdf/PDFDocument";
import type { Annotation } from "@/core/pdf/PDFEditor";
import { RichTextEditor } from "./RichTextEditor";
import { HorizontalRuler } from "./HorizontalRuler";
import { VerticalRuler } from "./VerticalRuler";
import { wrapAnnotationUpdate } from "@/shared/stores/undoHelpers";
import { PDFDocument as PDFDocumentClass } from "@/core/pdf/PDFDocument";
import { toolHandlers } from "@/features/tools";
import { getSpansInSelectionFromPage, getStructuredTextForPage, type TextSpan } from "@/core/pdf/PDFTextExtractor";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { useTextAnnotationClipboardStore } from "@/shared/stores/textAnnotationClipboardStore";

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
  const [actualScale, setActualScale] = useState<number>(2.0); // Store the actual scale used for rendering
  const BASE_SCALE = 2.0; // Fixed base scale for PDF rendering (2x resolution for crisp text and vectors)
  const [editor, setEditor] = useState<PDFEditor | null>(null);
  
  const { zoomLevel, fitMode, activeTool, setZoomLevel, setFitMode, setZoomToCenterCallback } = useUIStore();
  const { getCurrentDocument, getAnnotations, addAnnotation, getSearchResults, updateAnnotation, setCurrentPage, currentPage } = usePDFStore();
  const { showRulers } = useDocumentSettingsStore();
  const { showNotification } = useNotificationStore();
  const { copyTextAnnotation, pasteTextAnnotation, hasTextAnnotation, clear: clearTextAnnotationClipboard } = useTextAnnotationClipboardStore();
  const currentDocument = getCurrentDocument();
  
  const searchResults = currentDocument
    ? getSearchResults(currentDocument.getId()).filter(
        (r) => r.pageNumber === pageNumber
      )
    : [];
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  
  // Use refs for smooth wheel zoom to avoid jitter
  const panOffsetRef = useRef(panOffset);
  const actualScaleRef = useRef(actualScale);
  const zoomLevelRef = useRef(zoomLevel);
  const fitModeRef = useRef(fitMode);
  
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
  const [editingAnnotation, setEditingAnnotation] = useState<Annotation | null>(null);
  const [annotationText, setAnnotationText] = useState("");
  const [isEditingMode, setIsEditingMode] = useState(false);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<{ x: number; y: number } | null>(null);
  const [isCreatingTextBox, setIsCreatingTextBox] = useState(false);
  const [textBoxStart, setTextBoxStart] = useState<{ x: number; y: number } | null>(null);
  const [isDragOverPage, setIsDragOverPage] = useState(false);
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
    if (activeTool !== "selectText") {
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

  // Reset pan when page changes
  useEffect(() => {
    setPanOffset({ x: 0, y: 0 });
  }, [pageNumber]);

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
      // Don't prevent space if user is typing in a text editor
      const domDocument = window.document;
      const activeElement = domDocument.activeElement as HTMLElement;
      if (activeElement && activeElement.hasAttribute("contenteditable") && activeElement.getAttribute("data-rich-text-editor") === "true") {
        return; // Allow spacebar to work in text editor
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
      // Only handle zoom if ctrl/meta is pressed
      if (!(e.ctrlKey || e.metaKey)) {
        return; // Allow normal scroll
      }

      // Prevent default to stop page scrolling
      e.preventDefault();
      e.stopPropagation();

      // Get current values from refs for smooth operation
      const currentPanOffset = panOffsetRef.current;
      const currentActualScale = actualScaleRef.current;
      const currentZoomLevel = zoomLevelRef.current;
      const currentFitMode = fitModeRef.current;

      // When zooming, switch to custom mode (not fit mode)
      if (currentFitMode !== "custom") {
        setFitMode("custom");
      }

      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      // Use zoomLevel as the current scale when in custom mode, otherwise use actualScale
      // This ensures we're using the scale that matches the current zoom state
      const currentScale = currentFitMode === "custom" 
        ? currentZoomLevel 
        : (currentActualScale > 0 ? currentActualScale : currentZoomLevel);
      const newZoom = Math.max(0.25, Math.min(5, currentScale * delta));

      if (Math.abs(newZoom - currentScale) > 0.001) {
        // Get container bounds
        const containerRect = container.getBoundingClientRect();

        // Mouse position relative to container (where the user is pointing)
        const mouseX = e.clientX - containerRect.left;
        const mouseY = e.clientY - containerRect.top;

        // Calculate what point on the PDF (in PDF coordinates) is under the mouse
        // 1. Remove pan offset to get canvas-relative coordinates
        // 2. Divide by current zoom to get canvas coordinates (PDF at BASE_SCALE)
        // 3. Convert to PDF coordinates
        const canvasRelativeX = mouseX - currentPanOffset.x;
        const canvasRelativeY = mouseY - currentPanOffset.y;
        
        // Divide by zoom to get canvas coordinates (PDF rendered at BASE_SCALE)
        const canvasX = canvasRelativeX / currentScale;
        const canvasY = canvasRelativeY / currentScale;
        
        // Convert canvas coordinates to PDF coordinates
        const documentX = canvasX / BASE_SCALE;
        const documentY = canvasY / BASE_SCALE;

        // After zoom, we want the same PDF point to be at the mouse position
        // New canvas coordinates for that PDF point = PDF coordinates * BASE_SCALE
        // Then apply new zoom: newCanvasRelative = canvasCoord * newZoom
        const newCanvasCoordX = documentX * BASE_SCALE;
        const newCanvasCoordY = documentY * BASE_SCALE;
        const newCanvasRelativeX = newCanvasCoordX * newZoom;
        const newCanvasRelativeY = newCanvasCoordY * newZoom;

        // Calculate new pan offset to place that point at the mouse position
        // panOffset = mouse position - (canvas coordinate * zoom)
        const newPanX = mouseX - newCanvasRelativeX;
        const newPanY = mouseY - newCanvasRelativeY;

        // Update refs immediately to avoid stale values in render effect
        panOffsetRef.current = { x: newPanX, y: newPanY };
        zoomLevelRef.current = newZoom;
        fitModeRef.current = "custom";

        // Use requestAnimationFrame to batch state updates in the same frame
        // This ensures zoomLevel and panOffset update together, preventing render effect from running with stale values
        requestAnimationFrame(() => {
          setFitMode("custom");
          setZoomLevel(newZoom);
          setPanOffset({ x: newPanX, y: newPanY });
          
          // Force update editing annotation position if one is active
          // This ensures the text box position updates immediately during zoom
          if (editingAnnotation && editingAnnotation.type === "text") {
            // The position will be recalculated on next render using the updated scale and pan
            // The key prop on RichTextEditor will force a re-render with correct position
          }
        });
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

        // Render PDF at fixed base scale - PDF coordinates stay constant
        // Zoom and pan are handled via CSS transforms on the viewport
        const renderScale = BASE_SCALE;
        
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
        
        // Account for device pixel ratio for crisp rendering on high-DPI displays
        const devicePixelRatio = window.devicePixelRatio || 1;
        const displayWidth = rendered.width;
        const displayHeight = rendered.height;
        
        // Set canvas internal resolution (actual pixels)
        canvas.width = displayWidth * devicePixelRatio;
        canvas.height = displayHeight * devicePixelRatio;
        
        // Set canvas display size (CSS pixels)
        canvas.style.width = `${displayWidth}px`;
        canvas.style.height = `${displayHeight}px`;

        const ctx = canvas.getContext("2d", {
          willReadFrequently: false,
          colorSpace: "srgb"
        });
        
        if (ctx && rendered.imageData instanceof ImageData) {
          // Scale context to account for device pixel ratio
          ctx.scale(devicePixelRatio, devicePixelRatio);
          
          // Disable image smoothing for crisp pixel-perfect rendering
          ctx.imageSmoothingEnabled = false;
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
        
        const renderScale = BASE_SCALE;
        
        // Render without additional rotation (PDF Rotate is already applied by mupdf)
        const rendered = await renderer.renderPage(mupdfDoc, pageNumber, {
          scale: renderScale,
          rotation: 0,
        });
        
        const canvas = canvasRef.current;
        if (canvas) {
          // Account for device pixel ratio for crisp rendering on high-DPI displays
          const devicePixelRatio = window.devicePixelRatio || 1;
          const displayWidth = rendered.width;
          const displayHeight = rendered.height;
          
          // Set canvas internal resolution (actual pixels)
          canvas.width = displayWidth * devicePixelRatio;
          canvas.height = displayHeight * devicePixelRatio;
          
          // Set canvas display size (CSS pixels)
          canvas.style.width = `${displayWidth}px`;
          canvas.style.height = `${displayHeight}px`;
          
          const ctx = canvas.getContext("2d", {
            willReadFrequently: false,
            colorSpace: "srgb"
          });
          
          if (ctx && rendered.imageData instanceof ImageData) {
            // Scale context to account for device pixel ratio
            ctx.scale(devicePixelRatio, devicePixelRatio);
            
            // Disable image smoothing for crisp pixel-perfect rendering
            ctx.imageSmoothingEnabled = false;
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
    
    const pdfX = canvasPixelX / BASE_SCALE;
    const pdfY = mediaboxHeight - (canvasPixelY / BASE_SCALE);  // Flip Y: PDF Y=0 is at bottom
    
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
    
    
    return {
      x: pdfX * BASE_SCALE,
      y: flippedY * BASE_SCALE,  // Flip Y to match getPDFCoordinates
    };
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
                                 target.closest('[data-rotation-handle]');
      
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
        // Convert to display coordinates for positioning
        const devicePixelRatio = window.devicePixelRatio || 1;
        const displayPos = { 
          x: canvasPos.x / devicePixelRatio, 
          y: canvasPos.y / devicePixelRatio 
        };
        setMousePosition(displayPos);
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
        
        // Convert screen pixels to PDF coordinates (same logic as RichTextEditor)
        const devicePixelRatio = window.devicePixelRatio || 1;
        const BASE_SCALE = 2.0;
        const currentZoomLevel = zoomLevelRef.current;
        
        const pdfDeltaX = (screenDeltaX * devicePixelRatio) / (BASE_SCALE * currentZoomLevel);
        const pdfDeltaY = -(screenDeltaY * devicePixelRatio) / (BASE_SCALE * currentZoomLevel); // Negate Y
        
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
    
    // For selectText tool, check if hovering over text for cursor changes
    if (activeTool === "selectText" && !isSelecting && !selectionStart) {
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
    } else if (activeTool !== "selectText") {
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
          const devicePixelRatio = window.devicePixelRatio || 1;
          const displayX = canvasPos.x / devicePixelRatio;
          const displayY = canvasPos.y / devicePixelRatio;
          const width = annot.width || 200;
          const height = annot.height || 100;
          
          // Get mouse position in display coordinates
          const mouseCanvasPos = pdfToCanvas(coords.x, coords.y);
          const mouseDisplayX = mouseCanvasPos.x / devicePixelRatio;
          const mouseDisplayY = mouseCanvasPos.y / devicePixelRatio;
          
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
      // Check if dragging a PDF file
      const hasPdf = Array.from(e.dataTransfer?.items || []).some(
        (item) => item.type === "application/pdf" || (item.type === "" && item.kind === "file")
      );
      
      if (hasPdf) {
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
      // Check if drop is actually on this page canvas
      const target = e.target as HTMLElement;
      if (target && !container.contains(target) && target !== container) {
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
      const pdfFile = files.find(
        (file) => file.type === "application/pdf" || file.name.endsWith(".pdf")
      );

      if (!pdfFile) {
        console.warn("No PDF file found in drop");
        return;
      }

      try {
        // Load the dropped PDF as a new document/tab
        const arrayBuffer = await pdfFile.arrayBuffer();
        const data = new Uint8Array(arrayBuffer);
        const mupdfModule = await import("mupdf");
        
        // Use the store directly to create new document and tab
        const pdfStore = usePDFStore.getState();
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
        
        // Add loaded annotations to store
        for (const annot of allAnnotations) {
          pdfStore.addAnnotation(documentId, annot);
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
      }
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
    ? "crosshair"
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
          transform: readMode 
            ? undefined
            : `scale(${zoomLevel}) translate(${(fitMode === "custom" ? panOffsetRef.current.x : panOffset.x) / zoomLevel}px, ${(fitMode === "custom" ? panOffsetRef.current.y : panOffset.y) / zoomLevel}px)`,
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
            // Convert to display coordinates for positioning
            const devicePixelRatio = window.devicePixelRatio || 1;
            const startDisplayX = startCanvas.x / devicePixelRatio;
            const startDisplayY = startCanvas.y / devicePixelRatio;
            const endDisplayX = endCanvas.x / devicePixelRatio;
            const endDisplayY = endCanvas.y / devicePixelRatio;
            const minX = Math.min(startDisplayX, endDisplayX);
            const minY = Math.min(startDisplayY, endDisplayY);
            const width = Math.abs(endDisplayX - startDisplayX);
            const height = Math.abs(endDisplayY - startDisplayY);
            
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

        {/* Render overlay highlight preview */}
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
          // CRITICAL: Convert from canvas pixel coordinates to canvas display coordinates
          // The canvas has both pixel size (internal) and display size (CSS)
          // Preview must use display coordinates to align with the canvas element
          const devicePixelRatio = window.devicePixelRatio || 1;
          const allCanvasPixelX = pathToRender.map(p => pdfToCanvas(p.x, p.y).x);
          const allCanvasPixelY = pathToRender.map(p => pdfToCanvas(p.x, p.y).y);
          const allCanvasDisplayX = allCanvasPixelX.map(x => x / devicePixelRatio);
          const allCanvasDisplayY = allCanvasPixelY.map(y => y / devicePixelRatio);
          
          const minCanvasX = Math.min(...allCanvasDisplayX);
          const minCanvasY = Math.min(...allCanvasDisplayY);
          const maxCanvasX = Math.max(...allCanvasDisplayX);
          const maxCanvasY = Math.max(...allCanvasDisplayY);
          
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
          // Use display coordinates for positioning
          const relativePathPoints = pathToRender.map(p => {
            const canvasPixel = pdfToCanvas(p.x, p.y);
            const canvasDisplay = { x: canvasPixel.x / devicePixelRatio, y: canvasPixel.y / devicePixelRatio };
            return `${canvasDisplay.x - boxX},${canvasDisplay.y - boxY}`;
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

        {/* Render selection rectangle */}
        {isSelecting && selectionStart && selectionEnd && activeTool !== "selectText" && activeTool !== "highlight" && (
          (() => {
            // Convert PDF coordinates to CANVAS coordinates (like text box does)
            const startCanvas = pdfToCanvas(selectionStart.x, selectionStart.y);
            const endCanvas = pdfToCanvas(selectionEnd.x, selectionEnd.y);
            
            // CRITICAL: Convert from canvas pixel coordinates to canvas display coordinates
            // The canvas has both pixel size (internal) and display size (CSS)
            // Preview box must use display coordinates to align with the canvas element
            const devicePixelRatio = window.devicePixelRatio || 1;
            const startDisplayX = startCanvas.x / devicePixelRatio;
            const startDisplayY = startCanvas.y / devicePixelRatio;
            const endDisplayX = endCanvas.x / devicePixelRatio;
            const endDisplayY = endCanvas.y / devicePixelRatio;
            
            const minX = Math.min(startDisplayX, endDisplayX);
            const minY = Math.min(startDisplayY, endDisplayY);
            const width = Math.abs(endDisplayX - startDisplayX);
            const height = Math.abs(endDisplayY - startDisplayY);
            
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

        {/* Render text selection highlights - show during drag and after release */}
        {(() => {
          // Show highlights if we have spans, whether we're dragging or not
          const shouldShowHighlights = activeTool === "selectText" && selectedTextSpans.length > 0;
          
          if (!shouldShowHighlights) return null;
          
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
                const bottomLeft = pdfToCanvas(minX, minY);
                const topRight = pdfToCanvas(maxX, maxY);
                
                const width = topRight.x - bottomLeft.x;
                const height = topRight.y - bottomLeft.y;
                
                return (
                  <div
                    key={`text-selection-line-${lineKey}-${lineIdx}`}
                    className="absolute bg-blue-400/40 pointer-events-none z-50"
                    style={{
                      left: `${bottomLeft.x}px`,
                      top: `${bottomLeft.y}px`,
                      width: `${Math.abs(width)}px`,
                      height: `${Math.abs(height)}px`,
                    }}
                  />
                );
              })}
            </>
          );
        })()}

        {/* No selection rectangle for selectText - only show text highlights */}

        {/* Render search result highlights */}
        {searchResults.map((result, resultIdx) => (
          <div key={`search_${resultIdx}`} className="absolute pointer-events-none">
            {result.quads.map((quad: number[], quadIdx: number) => {
              // Quad is [x0, y0, x1, y1, x2, y2, x3, y3] in PDF coordinates
              const minX = Math.min(quad[0], quad[2], quad[4], quad[6]);
              const minY = Math.min(quad[1], quad[3], quad[5], quad[7]);
              const maxX = Math.max(quad[0], quad[2], quad[4], quad[6]);
              const maxY = Math.max(quad[1], quad[3], quad[5], quad[7]);
              
              // Convert PDF coordinates to container coordinates
              const minContainer = pdfToContainer(minX, minY);
              const maxContainer = pdfToContainer(maxX, maxY);
              
              return (
                <div
                  key={quadIdx}
                  className="absolute bg-blue-400/30 border border-blue-500"
                  style={{
                    left: `${minContainer.x}px`,
                    top: `${minContainer.y}px`,
                    width: `${maxContainer.x - minContainer.x}px`,
                    height: `${maxContainer.y - minContainer.y}px`,
                  }}
                />
              );
            })}
          </div>
        ))}

        {/* Render annotations */}
        {annotations.length > 0 && (
          <div className="absolute inset-0" style={{ zIndex: 20, pointerEvents: "auto" }}>
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
              // CRITICAL: Convert from canvas pixel coordinates to canvas display coordinates
              const devicePixelRatio = window.devicePixelRatio || 1;
              const allCanvasPixelX = pathToRender.map((p: { x: number; y: number }) => pdfToCanvas(p.x, p.y).x);
              const allCanvasPixelY = pathToRender.map((p: { x: number; y: number }) => pdfToCanvas(p.x, p.y).y);
              const allCanvasDisplayX = allCanvasPixelX.map(x => x / devicePixelRatio);
              const allCanvasDisplayY = allCanvasPixelY.map(y => y / devicePixelRatio);
              const minCanvasX = Math.min(...allCanvasDisplayX);
              const minCanvasY = Math.min(...allCanvasDisplayY);
              const maxCanvasX = Math.max(...allCanvasDisplayX);
              const maxCanvasY = Math.max(...allCanvasDisplayY);
              
              // Add padding for stroke width
              const padding = strokeWidth / 2;
              const boxX = minCanvasX - padding;
              const boxY = minCanvasY - padding;
              const boxWidth = (maxCanvasX - minCanvasX) + (padding * 2);
              const boxHeight = (maxCanvasY - minCanvasY) + (padding * 2);
              
              // Adjust path points to be relative to bounding box (use display coordinates)
              const relativePathPoints = pathToRender.map((p: { x: number; y: number }) => {
                const canvasPixel = pdfToCanvas(p.x, p.y);
                const canvasDisplay = { x: canvasPixel.x / devicePixelRatio, y: canvasPixel.y / devicePixelRatio };
                return `${canvasDisplay.x - boxX},${canvasDisplay.y - boxY}`;
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
              
              const minCanvas = pdfToCanvas(minQuadX, minQuadY);
              const maxCanvas = pdfToCanvas(maxQuadX, maxQuadY);
              const devicePixelRatio = window.devicePixelRatio || 1;
              const hoverBoxX = minCanvas.x / devicePixelRatio;
              const hoverBoxY = minCanvas.y / devicePixelRatio;
              const hoverBoxWidth = (maxCanvas.x - minCanvas.x) / devicePixelRatio;
              const hoverBoxHeight = (maxCanvas.y - minCanvas.y) / devicePixelRatio;
              
              return (
                <div 
                  key={annot.id} 
                  data-annotation-id={annot.id}
                  data-highlight-selected={isSelected ? "true" : "false"}
                  className={cn(
                    "absolute",
                    activeTool === "select" ? "cursor-pointer" : ""
                  )}
                  style={{ pointerEvents: activeTool === "select" ? "auto" : "none", zIndex: 30 }}
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
                        left: `${hoverBoxX - 4}px`,
                        top: `${hoverBoxY - 4}px`,
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
                    
                    const minX = Math.min(quad[0], quad[2], quad[4], quad[6]);
                    const minY = Math.min(quad[1], quad[3], quad[5], quad[7]);
                    const maxX = Math.max(quad[0], quad[2], quad[4], quad[6]);
                    const maxY = Math.max(quad[1], quad[3], quad[5], quad[7]);
                    
                    // Convert PDF coordinates to canvas coordinates (for rendering)
                    const minCanvas = pdfToCanvas(minX, minY);
                    const maxCanvas = pdfToCanvas(maxX, maxY);
                    
                    return (
                      <div
                        key={idx}
                        className="absolute"
                        style={{
                          left: `${minCanvas.x}px`,
                          top: `${minCanvas.y}px`,
                          width: `${maxCanvas.x - minCanvas.x}px`,
                          height: `${maxCanvas.y - minCanvas.y}px`,
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
            // Render callout with arrow
            const arrowPoint = annot.arrowPoint || { x: annot.x + (annot.width || 0) / 2, y: annot.y + (annot.height || 0) / 2 };
            const boxPos = annot.boxPosition || { x: annot.x + (annot.width || 150) + 20, y: annot.y };
            const boxWidth = annot.width || 150;
            const boxHeight = annot.height || 80;
            
            // Convert PDF coordinates to container coordinates (accounts for viewport transform)
            const arrowContainer = pdfToContainer(arrowPoint.x, arrowPoint.y);
            const boxContainer = pdfToContainer(boxPos.x, boxPos.y);
            const boxContainerWidth = boxWidth * currentZoom;
            const boxContainerHeight = boxHeight * currentZoom;
            
            return (
              <div 
                key={annot.id} 
                className={cn(
                  "absolute",
                  activeTool === "select" ? "cursor-pointer" : ""
                )}
                style={{ pointerEvents: activeTool === "select" ? "auto" : "none", zIndex: 30 }}
                onClick={() => {
                  if (activeTool === "select") {
                    setEditingAnnotation(annot);
                    setAnnotationText(annot.content || "");
                  }
                }}
              >
                {/* Arrow line */}
                <svg
                  className="absolute"
                  style={{
                    left: `${Math.min(arrowContainer.x, boxContainer.x)}px`,
                    top: `${Math.min(arrowContainer.y, boxContainer.y)}px`,
                    width: `${Math.abs(boxContainer.x - arrowContainer.x)}px`,
                    height: `${Math.abs(boxContainer.y - arrowContainer.y)}px`,
                  }}
                >
                  <line
                    x1={arrowContainer.x < boxContainer.x ? 0 : Math.abs(boxContainer.x - arrowContainer.x)}
                    y1={arrowContainer.y < boxContainer.y ? 0 : Math.abs(boxContainer.y - arrowContainer.y)}
                    x2={arrowContainer.x < boxContainer.x ? Math.abs(boxContainer.x - arrowContainer.x) : 0}
                    y2={arrowContainer.y < boxContainer.y ? Math.abs(boxContainer.y - arrowContainer.y) : 0}
                    stroke={annot.color || "#000000"}
                    strokeWidth={2 * currentZoom}
                  />
                </svg>
                {/* Callout box */}
                <div
                  className="absolute border-2 bg-yellow-100 p-2 rounded shadow-lg"
                  style={{
                    left: `${boxContainer.x}px`,
                    top: `${boxContainer.y}px`,
                    width: `${boxContainerWidth}px`,
                    minHeight: `${boxContainerHeight}px`,
                    borderColor: annot.color || "#000000",
                    fontSize: `${12 * currentZoom}px`,
                  }}
                >
                  {annot.content || "Note"}
                </div>
              </div>
            );
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
              const canvasPixel = pdfToCanvas(annot.x, pdfTopY);
              const devicePixelRatio = window.devicePixelRatio || 1;
              const redactContainer = { 
                x: canvasPixel.x / devicePixelRatio, 
                y: canvasPixel.y / devicePixelRatio 
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
            const canvasPixel = pdfToCanvas(annot.x, annot.y);
            const devicePixelRatio = window.devicePixelRatio || 1;
            const canvasPos = { x: canvasPixel.x / devicePixelRatio, y: canvasPixel.y / devicePixelRatio };
            
            
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
                isSelected={isCurrentlyEditing}
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
                    
                    // Add to app state first (so it renders immediately)
                    addAnnotation(currentDocument.getId(), newAnnotation);
                    
                    // Update editing annotation to use real ID
                    setEditingAnnotation(newAnnotation);
                    
                    // Write to PDF document (async, don't block UI)
                    if (editor) {
                      try {
                        await editor.addTextAnnotation(currentDocument, newAnnotation);
                      } catch (err) {
                        console.error("Error creating text annotation in PDF:", err);
                      }
                    } else {
                      console.warn("PDF editor not initialized, text annotation not saved to PDF");
                    }
                  } else if (currentDocument && !annot.id.startsWith("temp_")) {
                    // Update existing annotation as user types
                    // Note: We don't wrap every keystroke with undo/redo to avoid history bloat
                    // Only the final state on blur will be undoable
                    updateAnnotation(
                      currentDocument.getId(),
                      annot.id,
                      { content: html }
                    );
                    
                    // Update in PDF document
                    if (editor && annot.pdfAnnotation) {
                      try {
                        await editor.updateAnnotationInPdf(
                          currentDocument,
                          annot.pdfAnnotation,
                          { content: html }
                        );
                      } catch (err) {
                        console.error("Error updating annotation in PDF:", err);
                      }
                    }
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
                        
                        addAnnotation(currentDocument.getId(), finalAnnotation);
                        
                        if (editor) {
                          try {
                            await editor.addTextAnnotation(currentDocument, finalAnnotation);
                          } catch (err) {
                            console.error("Error creating text annotation in PDF:", err);
                          }
                        } else {
                          console.warn("PDF editor not initialized, text annotation not saved to PDF");
                        }
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
                        
                        // Update in PDF document
                        if (editor && annot.pdfAnnotation) {
                          try {
                            await editor.updateAnnotationInPdf(
                              currentDocument,
                              annot.pdfAnnotation,
                              { content: contentToSave }
                            );
                          } catch (err) {
                            console.error("Error updating annotation in PDF:", err);
                          }
                        }
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
                onResizeEnd={() => {
                  // When resize ends, record undo/redo with initial and final sizes
                  if (currentDocument && resizingAnnotationRef.current && resizingAnnotationRef.current.id === annot.id) {
                    const initialSize = resizingAnnotationRef.current;
                    const finalSize = { width: annot.width || 100, height: annot.height || 50 };
                    
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
      </div>
    </div>
  );
}
