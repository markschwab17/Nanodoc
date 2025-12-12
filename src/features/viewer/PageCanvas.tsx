/**
 * PageCanvas Component
 * 
 * Renders a single PDF page with enhanced zoom and pan support.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useUIStore } from "@/shared/stores/uiStore";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { cn } from "@/lib/utils";
import { PDFEditor } from "@/core/pdf/PDFEditor";
import type { PDFRenderer } from "@/core/pdf/PDFRenderer";
import type { PDFDocument } from "@/core/pdf/PDFDocument";
import type { Annotation } from "@/core/pdf/PDFEditor";
import { RichTextEditor } from "./RichTextEditor";
import { wrapAnnotationUpdate } from "@/shared/stores/undoHelpers";
import { PDFDocument as PDFDocumentClass } from "@/core/pdf/PDFDocument";

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
  const BASE_SCALE = 1.0; // Fixed base scale for PDF rendering (1 point = 1 pixel)
  const [editor, setEditor] = useState<PDFEditor | null>(null);
  const [containerHeight, setContainerHeight] = useState<number | undefined>(undefined);
  const [containerWidth, setContainerWidth] = useState<number | undefined>(undefined);
  
  const { zoomLevel, fitMode, activeTool, setZoomLevel, setFitMode, setZoomToCenterCallback } = useUIStore();
  const { getCurrentDocument, getAnnotations, addAnnotation, getSearchResults, updateAnnotation, setCurrentPage } = usePDFStore();
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
        
        // In read mode, always calculate fit-to-width for container sizing (even if fitMode is custom)
        // The fitMode only controls where zoom is applied, not the base container size
        // In normal mode, use fit-to-width when fitMode is "width"
        if (readMode || (!readMode && fitMode === "width")) {
          // Use requestAnimationFrame to ensure DOM is laid out
          await new Promise(resolve => requestAnimationFrame(resolve));
          await new Promise(resolve => setTimeout(resolve, 150)); // Wait longer for layout
          
          let containerWidth = 800; // Default fallback
          
          if (readMode) {
            // In read mode, get width from the max-w-4xl parent container
            // Try multiple times to get the correct width
            let attempts = 0;
            while (attempts < 3 && containerWidth < 500) {
              const parentContainer = containerRef.current?.closest('.max-w-4xl') as HTMLElement;
              if (parentContainer) {
                containerWidth = parentContainer.clientWidth || parentContainer.offsetWidth || 0;
                if (containerWidth > 100) break;
              }
              
              // Also try getting from the scroll container
              const scrollContainer = containerRef.current?.closest('[class*="overflow-y-auto"]') as HTMLElement;
              if (scrollContainer && scrollContainer.clientWidth > 100) {
                containerWidth = scrollContainer.clientWidth;
                break;
              }
              
              // Fallback to viewport calculation
              if (containerWidth < 100) {
                containerWidth = Math.min(896, window.innerWidth - 320);
              }
              
              if (containerWidth < 500) {
                await new Promise(resolve => setTimeout(resolve, 50));
                attempts++;
              }
            }
            
            // Final fallback
            if (containerWidth < 500) {
              containerWidth = 800;
            }
          } else if (containerRef.current) {
            containerWidth = containerRef.current.clientWidth;
          }
          
          // Ensure we have a valid width
          if (containerWidth < 100) {
            containerWidth = 800; // Safe fallback
          }
          
          viewportScale = containerWidth / pageMetadata.width;
          
          // Update zoom level to match fit
          // In read mode, only update if fitMode is NOT "custom" (user hasn't manually zoomed)
          // When fitMode is "custom", the user has manually zoomed, so don't override their zoom
          // IMPORTANT: Only update if the difference is significant AND fitMode is not custom
          if (readMode && fitMode === "custom") {
            // User has manually zoomed - don't override, but ensure viewportScale is still calculated for reference
            // The container will use zoomLevel for sizing, not viewportScale
          } else if (Math.abs(viewportScale - zoomLevel) > 0.01) {
            if (readMode) {
              // Only update zoom if user hasn't manually zoomed (fitMode is not "custom")
              // In read mode, set zoomLevel and keep fitMode as "width"
              // setZoomLevel automatically sets fitMode to "custom", so we need to override it
              useUIStore.setState({ 
                zoomLevel: Math.max(0.25, Math.min(5.0, viewportScale)), 
                fitMode: "width" 
              });
            } else {
              setZoomLevel(viewportScale);
            }
          }
        } else if (fitMode === "page" && containerRef.current) {
          // In read mode, treat "page" mode as "width" mode to prevent tiny pages
          if (readMode) {
            // Use the same width calculation as fit-to-width
            await new Promise(resolve => requestAnimationFrame(resolve));
            await new Promise(resolve => setTimeout(resolve, 100));
            
            let containerWidth = 800;
            const parentContainer = containerRef.current?.closest('.max-w-4xl') as HTMLElement;
            if (parentContainer) {
              containerWidth = parentContainer.clientWidth || parentContainer.offsetWidth || 800;
              if (containerWidth < 100) {
                containerWidth = Math.min(896, window.innerWidth - 320);
              }
            } else {
              containerWidth = Math.min(896, window.innerWidth - 320);
            }
            if (containerWidth < 100) {
              containerWidth = 800;
            }
            viewportScale = containerWidth / pageMetadata.width;
            
            // Update zoom level to match fit (in read mode with page fitMode, always update)
            if (Math.abs(viewportScale - zoomLevel) > 0.01) {
              // Set zoomLevel directly via state to avoid the "custom" override
              useUIStore.setState({ 
                zoomLevel: Math.max(0.25, Math.min(5.0, viewportScale)), 
                fitMode: "width" 
              });
            }
          } else {
            let containerWidth = containerRef.current.clientWidth;
            let containerHeight = containerRef.current.clientHeight;
            const scaleX = containerWidth / pageMetadata.width;
            const scaleY = containerHeight / pageMetadata.height;
            viewportScale = Math.min(scaleX, scaleY);
            setZoomLevel(viewportScale);
          }
        }
        
        // Center canvas in container when fitting
        // IMPORTANT: In custom mode, don't modify panOffset - it's controlled by zoom/pan operations
        // Only center when in fit modes (page/width)
        // In read mode, don't center vertically - stack from top
        if ((fitMode === "page" || fitMode === "width") && containerRef.current) {
          const containerWidth = containerRef.current.clientWidth;
          const containerHeight = containerRef.current.clientHeight;
          const scaledWidth = pageMetadata.width * viewportScale;
          const scaledHeight = pageMetadata.height * viewportScale;
          
          // Center the canvas horizontally, but only center vertically if not in read mode
          const centerX = (containerWidth - scaledWidth) / 2;
          const centerY = readMode ? 0 : (containerHeight - scaledHeight) / 2;
          
          // In read mode, always set pan offset Y to 0 to stack pages
          const finalPanY = readMode ? 0 : centerY;
          
          // Only update pan offset if it's significantly different (avoid render loops)
          if (Math.abs(panOffset.x - centerX) > 1 || Math.abs(panOffset.y - finalPanY) > 1) {
            setTimeout(() => {
              setPanOffset({ x: centerX, y: finalPanY });
            }, 0);
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
        canvas.width = rendered.width;
        canvas.height = rendered.height;

        const ctx = canvas.getContext("2d");
        if (ctx && rendered.imageData instanceof ImageData) {
          ctx.putImageData(rendered.imageData, 0, 0);
        }
        
        // In read mode, set container dimensions to match fit-to-width size
        // Zoom is applied via CSS transform on the parent container, not by resizing containers
        // This prevents layout shifts and makes zoom feel like zooming into a static image
        if (readMode && containerRef.current) {
          // Use pageMetadata dimensions (PDF logical size) not rendered dimensions (canvas pixel size)
          // Always use viewportScale (fit-to-width) for container sizing
          // Zoom is handled via transform scale on the pages container, not container resizing
          const scaledWidth = pageMetadata.width * viewportScale;
          const scaledHeight = pageMetadata.height * viewportScale;
          
          setContainerWidth(scaledWidth);
          setContainerHeight(scaledHeight);
        } else {
          setContainerWidth(undefined);
          setContainerHeight(undefined);
        }
        
        // Force a re-render to update the width/height styles in read mode
        if (readMode) {
          // Trigger a state update to ensure styles are applied
          setTimeout(() => {
            // This will cause a re-render with updated dimensions
          }, 0);
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
          canvas.width = rendered.width;
          canvas.height = rendered.height;
          const ctx = canvas.getContext("2d");
          if (ctx && rendered.imageData instanceof ImageData) {
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
  }, [document, pageNumber, renderer, pageRotation, pageWidth, pageHeight]);

  // Helper function to convert mouse coordinates to PDF coordinates
  // PDF uses bottom-up Y coordinate system, canvas uses top-down
  const getPDFCoordinates = (e: React.MouseEvent): { x: number; y: number } | null => {
    if (!containerRef.current || !canvasRef.current) return null;
    
    const containerRect = containerRef.current.getBoundingClientRect();
    const pageMetadata = document.getPageMetadata(pageNumber);
    
    if (!pageMetadata) return null;
    
    // Mouse position relative to container viewport
    const mouseX = e.clientX - containerRect.left;
    const mouseY = e.clientY - containerRect.top;
    
    // The canvas container has: transform: scale(zoom) translate(panX/zoom, panY/zoom)
    // To reverse this transformation:
    // 1. Remove pan offset: (mouseX - panX, mouseY - panY)
    // 2. Divide by zoom: (mouseX - panX) / zoom, (mouseY - panY) / zoom
    // 3. This gives us canvas coordinates (PDF rendered at BASE_SCALE)
    // 4. Convert canvas coordinates to PDF coordinates
    
    const currentZoom = zoomLevelRef.current;
    const currentPan = fitMode === "custom" ? panOffsetRef.current : panOffset;
    
    // Remove pan offset to get canvas-relative coordinates
    const canvasRelativeX = mouseX - currentPan.x;
    const canvasRelativeY = mouseY - currentPan.y;
    
    // Divide by zoom to get actual canvas coordinates (PDF rendered at BASE_SCALE)
    const canvasCoordX = canvasRelativeX / currentZoom;
    const canvasCoordY = canvasRelativeY / currentZoom;
    
    // Convert canvas coordinates to PDF coordinates
    // Canvas Y=0 is at top, PDF Y=0 is at bottom
    // PDF is rendered at BASE_SCALE, so canvas coordinates map directly
    const pdfX = canvasCoordX / BASE_SCALE;
    const pdfY = pageMetadata.height - (canvasCoordY / BASE_SCALE);
    
    return { x: pdfX, y: pdfY };
  };

  // Helper function to convert PDF coordinates to canvas coordinates
  // PDF uses bottom-up Y coordinate system, canvas uses top-down
  // PDF is rendered at BASE_SCALE, so coordinates are 1:1 with canvas pixels
  const pdfToCanvas = (pdfX: number, pdfY: number, _useRefs: boolean = false): { x: number; y: number } => {
    const pageMetadata = document.getPageMetadata(pageNumber);
    
    if (!pageMetadata) {
      return { x: pdfX * BASE_SCALE, y: pdfY * BASE_SCALE };
    }
    
    // PDF Y=0 is at bottom, canvas Y=0 is at top
    // Flip Y coordinate: canvasY = (pageHeight - pdfY) * BASE_SCALE
    // PDF is rendered at BASE_SCALE, so coordinates map directly
    const flippedY = pageMetadata.height - pdfY;
    
    return {
      x: pdfX * BASE_SCALE,
      y: flippedY * BASE_SCALE,
    };
  };

  // Helper function to convert PDF coordinates to container-relative coordinates
  // Accounts for viewport transform (zoom and pan)
  // PDF coordinates are fixed, viewport transforms via CSS
  const pdfToContainer = (pdfX: number, pdfY: number, useRefs: boolean = false): { x: number; y: number } => {
    const canvasPos = pdfToCanvas(pdfX, pdfY, useRefs);
    
    // Get current viewport transform values
    const currentZoom = useRefs ? zoomLevelRef.current : zoomLevel;
    const currentPan = useRefs 
      ? (fitModeRef.current === "custom" ? panOffsetRef.current : panOffset)
      : (fitMode === "custom" ? panOffsetRef.current : panOffset);
    
    // Apply viewport transform: scale then translate
    // The canvas container has: transform: scale(zoom) translate(panX/zoom, panY/zoom)
    // So screen position = (canvasPos * zoom) + pan
    return {
      x: canvasPos.x * currentZoom + currentPan.x,
      y: canvasPos.y * currentZoom + currentPan.y,
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
    
    // Get current scale (use actualScale if available, otherwise zoomLevel)
    const currentScale = fitMode === "custom" ? zoomLevel : actualScale;
    
    // Convert center to document coordinates
    const canvasX = centerX - panOffset.x;
    const canvasY = centerY - panOffset.y;
    const documentX = canvasX / currentScale;
    const documentY = canvasY / currentScale;
    
    // Apply new zoom
    const newCanvasX = documentX * newZoom;
    const newCanvasY = documentY * newZoom;
    
    // Adjust pan to keep center fixed
    const newPanX = centerX - newCanvasX;
    const newPanY = centerY - newCanvasY;
    
    setZoomLevel(newZoom);
    setPanOffset({ x: newPanX, y: newPanY });
    setFitMode("custom");
  }, [zoomLevel, panOffset, actualScale, fitMode, setZoomLevel, setFitMode, readMode]);

  // Expose zoomToCenter via UI store
  useEffect(() => {
    setZoomToCenterCallback(zoomToCenter);
    return () => {
      setZoomToCenterCallback(null);
    };
  }, [zoomToCenter, setZoomToCenterCallback]);

  // Note: Focus is now handled by RichTextEditor component

  const handleMouseDown = async (e: React.MouseEvent) => {
    // Middle mouse button or space+drag for pan
    if (e.button === 1 || (e.button === 0 && (isSpacePressed || activeTool === "pan"))) {
      e.preventDefault();
      setIsDragging(true);
      // Use ref value in custom mode to avoid stale state
      const currentPanForDrag = fitMode === "custom" ? panOffsetRef.current : panOffset;
      setDragStart({ x: e.clientX - currentPanForDrag.x, y: e.clientY - currentPanForDrag.y });
    } else if (activeTool === "highlight" && currentDocument) {
      // Start text selection for highlighting
      const coords = getPDFCoordinates(e);
      if (coords) {
        setIsSelecting(true);
        setSelectionStart(coords);
        setSelectionEnd(coords);
      }
    } else if (activeTool === "callout" && currentDocument) {
      // Start drawing callout box
      const coords = getPDFCoordinates(e);
      if (coords) {
        setIsSelecting(true);
        setSelectionStart(coords);
        setSelectionEnd(coords);
      }
    } else if (activeTool === "text" && currentDocument) {
      // Check if clicking on an existing annotation first
      // Check each text annotation to see if click is within bounds
        // Since annotations are inside the transformed div, we need to account for the transform
        const clickedAnnotation = annotations.find((annot) => {
          if (annot.type !== "text") return false;
          
          // Get the transformed div element
          const transformedDiv = containerRef.current?.querySelector('div[style*="transform"]') as HTMLElement;
          if (!transformedDiv) return false;
          
          const transformedRect = transformedDiv.getBoundingClientRect();
          
          // Convert mouse position to coordinates relative to the transformed div
          const transformedX = e.clientX - transformedRect.left;
          const transformedY = e.clientY - transformedRect.top;
          
          // Get canvas position (in canvas coordinates, before transform)
          const canvasPos = pdfToCanvas(annot.x, annot.y);
          
          // Account for the transform: the div has scale(zoom) translate(panX/zoom, panY/zoom)
          // The transform is: scale(zoom) translate(panX/zoom, panY/zoom)
          // So screen position = (canvasPos * zoom) + pan
          // To reverse: canvasPos = (screenPos - pan) / zoom
          const currentZoom = zoomLevelRef.current;
          const currentPan = fitMode === "custom" ? panOffsetRef.current : panOffset;
          
          // Reverse the transform to get canvas coordinates
          // Note: the translate is applied AFTER scale, so we need to account for that
          // transform: scale(zoom) translate(panX/zoom, panY/zoom)
          // This means: screenPos = canvasPos * zoom + pan
          const canvasX = (transformedX - currentPan.x) / currentZoom;
          const canvasY = (transformedY - currentPan.y) / currentZoom;
          
          // Check if click is within annotation bounds (in canvas coordinates)
          const width = annot.width || 200;
          const height = annot.height || 100;
          
          return (
            canvasX >= canvasPos.x &&
            canvasX <= canvasPos.x + width &&
            canvasY >= canvasPos.y &&
            canvasY <= canvasPos.y + height
          );
        });
        
        if (clickedAnnotation) {
          // Single click: select annotation (shows handles, ready to drag/resize)
          // Double click will enter edit mode (handled in RichTextEditor)
          e.preventDefault();
          e.stopPropagation();
          setEditingAnnotation(clickedAnnotation);
          setAnnotationText(clickedAnnotation.content || "");
          setIsEditingMode(false); // Start in selection mode, not edit mode
          return;
        }
      
      // Start creating text box - track if it's a click or drag
      const coords = getPDFCoordinates(e);
      if (coords) {
        setIsCreatingTextBox(true);
        setTextBoxStart(coords);
        setSelectionStart(coords);
        setSelectionEnd(coords); // Initialize selectionEnd so preview shows immediately
      }
    } else if (onPageClick) {
      const coords = getPDFCoordinates(e);
      if (coords) {
        onPageClick(coords.x, coords.y);
      }
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
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
        setSelectionEnd(coords);
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
    console.log("PageCanvas: Attaching drag and drop listeners", { pageNumber, hasContainer: !!container, hasDocument: !!currentDocument });
    let dragOverTimeout: NodeJS.Timeout | null = null;

    const handleDragOver = (e: DragEvent) => {
      console.log("PageCanvas: dragover event", { pageNumber, hasDataTransfer: !!e.dataTransfer });
      // Check if dragging a PDF file
      const hasPdf = Array.from(e.dataTransfer?.items || []).some(
        (item) => item.type === "application/pdf" || (item.type === "" && item.kind === "file")
      );
      
      console.log("PageCanvas: hasPdf", hasPdf);
      
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
          console.log("PageCanvas: Setting isDragOverPage to true");
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
      console.log("PageCanvas: drop event fired - opening as new tab!", { 
        pageNumber, 
        hasFiles: !!e.dataTransfer?.files,
        target: e.target,
        currentTarget: e.currentTarget,
        container: container
      });
      
      // Check if drop is actually on this page canvas
      const target = e.target as HTMLElement;
      if (target && !container.contains(target) && target !== container) {
        console.log("PageCanvas: Drop not on this canvas, ignoring");
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

      console.log("PageCanvas: Opening dropped PDF as new tab");

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
          order: tabStore.tabs.length,
        });
        
        console.log("PageCanvas: PDF opened as new tab successfully");
      } catch (error) {
        console.error("Error opening PDF as new tab:", error);
      }
    };

    // Use capture phase to intercept before react-dropzone
    container.addEventListener('dragover', handleDragOver, true);
    container.addEventListener('dragleave', handleDragLeave, true);
    container.addEventListener('drop', handleDrop, true);

    console.log("PageCanvas: Event listeners attached", { 
      pageNumber, 
      container: container,
      hasContainer: !!container,
      containerId: container.id || 'no-id',
      containerClasses: container.className
    });

    return () => {
      if (dragOverTimeout) {
        clearTimeout(dragOverTimeout);
      }
      container.removeEventListener('dragover', handleDragOver, true);
      container.removeEventListener('dragleave', handleDragLeave, true);
      container.removeEventListener('drop', handleDrop, true);
    };
  }, [currentDocument, editor, pageNumber, getAnnotations, setCurrentPage]);


  const handleMouseUp = async () => {
    if (isDragging) {
      setIsDragging(false);
    } else if (isCreatingTextBox && textBoxStart && selectionEnd && currentDocument) {
      // Determine if it was a click (no drag) or drag
      const dragDistance = Math.sqrt(
        Math.pow(selectionEnd.x - textBoxStart.x, 2) + 
        Math.pow(selectionEnd.y - textBoxStart.y, 2)
      );
      const isClick = dragDistance < 5; // Less than 5 points = click
      
      const defaultFontSize = 12;
      let width: number;
      let height: number;
      let autoFit = false;
      let boxX = textBoxStart.x;
      let boxY = textBoxStart.y;
      
      if (isClick) {
        // Click: auto-fit mode (typewriter style)
        autoFit = true;
        width = defaultFontSize * 9; // Initial width, will auto-fit
        height = defaultFontSize * 1.5; // Initial height, will auto-fit
      } else {
        // Drag: fixed box size - use top-left corner of drag
        // Note: PDF coordinates have Y=0 at bottom, so larger Y = higher up
        // For top-left corner in PDF: use minX and maxY (maxY is the top)
        const minX = Math.min(textBoxStart.x, selectionEnd.x);
        const maxX = Math.max(textBoxStart.x, selectionEnd.x);
        const minY = Math.min(textBoxStart.y, selectionEnd.y); // Smaller Y = lower (closer to bottom)
        const maxY = Math.max(textBoxStart.y, selectionEnd.y); // Larger Y = higher (closer to top)
        boxX = minX;
        boxY = maxY; // Use maxY for top position in PDF coordinates
        width = Math.max(50, maxX - minX);
        height = Math.max(30, maxY - minY); // Height is positive (top - bottom)
      }
      
      const tempAnnotation: Annotation = {
        id: `temp_annot_${Date.now()}`,
        type: "text",
        pageNumber,
        x: boxX,
        y: boxY,
        content: "",
        fontSize: defaultFontSize,
        fontFamily: "Arial",
        color: "#000000",
        width,
        height,
        autoFit, // Flag to indicate auto-fit mode
      };
      
      setEditingAnnotation(tempAnnotation);
      setAnnotationText("");
      setIsEditingMode(true);
      setIsCreatingTextBox(false);
      setTextBoxStart(null);
      setSelectionStart(null);
      setSelectionEnd(null);
    } else if (isSelecting && selectionStart && selectionEnd && currentDocument) {
      if (activeTool === "highlight") {
        // Create highlight from selection
        try {
          const mupdfDoc = currentDocument.getMupdfDocument();
          const page = mupdfDoc.loadPage(pageNumber);
          
          // Convert selection coordinates to mupdf points
          const p = [selectionStart.x, selectionStart.y];
          const q = [selectionEnd.x, selectionEnd.y];
          
          // Get highlighted quads from StructuredText (not page)
          // highlight() returns Quad[] where each Quad is [x0, y0, x1, y1, x2, y2, x3, y3]
          const structuredText = page.toStructuredText();
          const quads = structuredText.highlight(p, q);
          
          if (quads && quads.length > 0) {
            // Get selected text using structured text
            let selectedText = "";
            try {
              // TODO: Extract text from quads region using structured text
              // For now, store empty string - can be enhanced later
              selectedText = "";
            } catch (error) {
              console.error("Error extracting text:", error);
            }
            
            // Convert quads to the format we need (array of arrays)
            const quadArray = quads.map((quad: any) => {
              if (Array.isArray(quad) && quad.length >= 8) {
                return quad;
              }
              // If quad is an object, extract coordinates
              return [quad.x0 || 0, quad.y0 || 0, quad.x1 || 0, quad.y1 || 0, 
                      quad.x2 || 0, quad.y2 || 0, quad.x3 || 0, quad.y3 || 0];
            });
            
            const annotation: Annotation = {
              id: `highlight_${Date.now()}`,
              type: "highlight",
              pageNumber,
              x: Math.min(selectionStart.x, selectionEnd.x),
              y: Math.min(selectionStart.y, selectionEnd.y),
              width: Math.abs(selectionEnd.x - selectionStart.x),
              height: Math.abs(selectionEnd.y - selectionStart.y),
              quads: quadArray,
              selectedText: selectedText,
              color: "#FFFF00",
            };
            
            // Add to app state first (so it renders immediately)
            addAnnotation(currentDocument.getId(), annotation);
            
            // Write to PDF document
            if (!editor) {
              console.warn("PDF editor not initialized, annotation not saved to PDF");
            } else {
              try {
                await editor.addHighlightAnnotation(currentDocument, annotation);
                console.log("Highlight annotation saved to PDF");
              } catch (err) {
                console.error("Error writing highlight to PDF:", err);
              }
            }
          }
        } catch (error) {
          console.error("Error creating highlight:", error);
        }
      } else if (activeTool === "callout") {
        // Create callout from selection box
        const minX = Math.min(selectionStart.x, selectionEnd.x);
        const minY = Math.min(selectionStart.y, selectionEnd.y);
        const maxX = Math.max(selectionStart.x, selectionEnd.x);
        const maxY = Math.max(selectionStart.y, selectionEnd.y);
        const width = maxX - minX;
        const height = maxY - minY;
        
        // Only create if box is large enough
        if (width > 20 && height > 20) {
          const annotation: Annotation = {
            id: `callout_${Date.now()}`,
            type: "callout",
            pageNumber,
            x: minX,
            y: minY,
            width: width,
            height: height,
            arrowPoint: { x: minX + width / 2, y: minY + height / 2 },
            boxPosition: { x: minX + width + 20, y: minY },
            content: "",
            color: "#FFFF00",
          };
          
          // Add to app state first (so it renders immediately)
          addAnnotation(currentDocument.getId(), annotation);
          
          // Set as editing so user can type immediately
          setEditingAnnotation(annotation);
          setAnnotationText("");
          
          // Write to PDF document
          if (!editor) {
            console.warn("PDF editor not initialized, callout annotation not saved to PDF");
          } else {
            try {
              await editor.addCalloutAnnotation(currentDocument, annotation);
              console.log("Callout annotation saved to PDF");
            } catch (err) {
              console.error("Error writing callout to PDF:", err);
            }
          }
        }
      }
      
      setIsSelecting(false);
      setSelectionStart(null);
      setSelectionEnd(null);
    }
    
    // Clean up text box creation state
    if (isCreatingTextBox) {
      setIsCreatingTextBox(false);
      setTextBoxStart(null);
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
    : activeTool === "highlight"
    ? "crosshair"
    : activeTool === "callout"
    ? "crosshair"
    : "default";

  return (
    <div
      ref={containerRef}
      data-page-canvas="true"
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
      onMouseLeave={handleMouseUp}
      onContextMenu={handleContextMenu}
      // Remove React handlers - using native handlers in useEffect instead
      style={{ 
        cursor, 
        margin: 0, 
        padding: 0, 
        lineHeight: readMode ? 0 : undefined, 
        fontSize: readMode ? 0 : undefined,
        ...(readMode && containerWidth !== undefined ? { width: `${containerWidth}px` } : {}),
        ...(readMode && containerHeight !== undefined ? { height: `${containerHeight}px` } : {}),
      } as React.CSSProperties}
    >
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
          // In read mode with fit-to-width, scale the canvas container to fit
          // In read mode with custom zoom, no transform here (handled at parent level)
          // In normal mode, apply viewport transform: scale then translate
          transform: readMode 
            ? (fitMode === "custom" 
                ? undefined 
                : `scale(${zoomLevel})`)
            : `scale(${zoomLevel}) translate(${(fitMode === "custom" ? panOffsetRef.current.x : panOffset.x) / zoomLevel}px, ${(fitMode === "custom" ? panOffsetRef.current.y : panOffset.y) / zoomLevel}px)`,
          transformOrigin: "0 0",
          margin: readMode ? '0 auto' : 0,
          padding: 0,
          lineHeight: readMode ? 0 : undefined,
          fontSize: readMode ? 0 : undefined,
          // In read mode, ensure proper width for the scaled content
          // When fitMode is "custom", the outer container is already sized to zoomLevel, so inner div should match
          // When fitMode is "width", use raw PDF dimensions and scale via transform
          width: readMode && pageMetadata 
            ? (fitMode === "custom" 
                ? `${pageMetadata.width * zoomLevel}px` 
                : `${pageMetadata.width}px`)
            : undefined,
          height: readMode && pageMetadata 
            ? (fitMode === "custom" 
                ? `${pageMetadata.height * zoomLevel}px` 
                : `${pageMetadata.height}px`)
            : undefined,
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
            // In read mode when zoomed, canvas should fill its container
            width: readMode && fitMode === "custom" ? "100%" : undefined,
            height: readMode && fitMode === "custom" ? "100%" : undefined,
          }} 
        />
        
        {/* Render text box creation preview */}
        {isCreatingTextBox && textBoxStart && selectionEnd && activeTool === "text" && (
          (() => {
            const startCanvas = pdfToCanvas(textBoxStart.x, textBoxStart.y);
            const endCanvas = pdfToCanvas(selectionEnd.x, selectionEnd.y);
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

        {/* Render selection rectangle */}
        {isSelecting && selectionStart && selectionEnd && (
          (() => {
            // Convert PDF coordinates to container coordinates (accounts for viewport transform)
            const startContainer = pdfToContainer(selectionStart.x, selectionStart.y);
            const endContainer = pdfToContainer(selectionEnd.x, selectionEnd.y);
            const minX = Math.min(startContainer.x, endContainer.x);
            const minY = Math.min(startContainer.y, endContainer.y);
            const width = Math.abs(endContainer.x - startContainer.x);
            const height = Math.abs(endContainer.y - startContainer.y);
            
            return (
              <div
                className={cn(
                  "absolute border-2 pointer-events-none",
                  activeTool === "highlight" 
                    ? "border-yellow-500 bg-yellow-400/20" 
                    : activeTool === "callout"
                    ? "border-blue-500 bg-blue-400/20"
                    : "border-primary bg-primary/10"
                )}
                style={{
                  left: `${minX}px`,
                  top: `${minY}px`,
                  width: `${width}px`,
                  height: `${height}px`,
                }}
              />
            );
          })()
        )}

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
              // Don't render if it's selected (RichTextEditor will show it instead)
              // This prevents double rendering
              if (editingAnnotation?.id === annot.id) {
                return null;
              }
              
              // Only render if annotation is for current page
              if (annot.pageNumber !== pageNumber) {
                return null;
              }
              
              // Get current zoom for rendering
              const currentZoom = zoomLevelRef.current;
          
          if (annot.type === "highlight" && annot.quads && annot.quads.length > 0) {
            // Render highlight quads
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
                {annot.quads.map((quad, idx) => {
                  // Quad is [x0, y0, x1, y1, x2, y2, x3, y3] in PDF coordinates
                  if (!Array.isArray(quad) || quad.length < 8) return null;
                  
                  const minX = Math.min(quad[0], quad[2], quad[4], quad[6]);
                  const minY = Math.min(quad[1], quad[3], quad[5], quad[7]);
                  const maxX = Math.max(quad[0], quad[2], quad[4], quad[6]);
                  const maxY = Math.max(quad[1], quad[3], quad[5], quad[7]);
                  
                  // Convert PDF coordinates to container coordinates (accounts for viewport transform)
                  const minContainer = pdfToContainer(minX, minY);
                  const maxContainer = pdfToContainer(maxX, maxY);
                  
                  return (
                    <div
                      key={idx}
                      className="absolute bg-yellow-400/50"
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
            );
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
          
          return allTextAnnotations.map((annot) => {
            // Always show all text annotations - they're always visible
            // Check if this is the currently editing annotation for edit mode
            const isCurrentlyEditing = editingAnnotation?.id === annot.id;
          
          return (() => {
            // Get current viewport transform values (use refs for real-time updates during zoom)
            const currentZoom = zoomLevelRef.current;
            
            // Ensure zoom is valid
            if (currentZoom <= 0) return null;
            
            // Since RichTextEditor is inside the transformed div, use canvas coordinates
            const canvasPos = pdfToCanvas(annot.x, annot.y);
            
            // Determine if this annotation is being edited
            const isEditing = isCurrentlyEditing && isEditingMode;
            const content = isCurrentlyEditing ? annotationText : (annot.content || "");
          
            return (
              <RichTextEditor
                key={annot.id}
                annotation={annot}
                content={content}
                isEditing={isEditing}
                onEditModeChange={(editing) => {
                  if (editing) {
                    setEditingAnnotation(annot);
                    setAnnotationText(annot.content || "");
                    setIsEditingMode(true);
                  } else {
                    setIsEditingMode(false);
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
                        console.log("Text annotation saved to PDF");
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
                  
                  // Don't close on blur if ESC was pressed (that's handled separately)
                  // Only close if clicking outside
                  if (isEditingMode) {
                    // Exit edit mode but keep annotation selected
                    setIsEditingMode(false);
                    return;
                  }
                  
                  if (currentDocument && annot) {
                    // If it's a temp annotation with no text, just discard it
                    if (annot.id.startsWith("temp_") && (!annot.content || annot.content.trim().length === 0)) {
                      setEditingAnnotation(null);
                      setAnnotationText("");
                      setIsEditingMode(false);
                      return;
                    }
                    
                    // If it's a temp annotation with text, it should already be created in onChange
                    // Just finalize it
                    if (annot.id.startsWith("temp_") && annot.content && annot.content.trim().length > 0) {
                      // Should have been created in onChange, but handle edge case
                      const finalAnnotation: Annotation = {
                        ...annot,
                        id: `annot_${Date.now()}`,
                        content: annot.content,
                      };
                      
                      addAnnotation(currentDocument.getId(), finalAnnotation);
                      
                      if (editor) {
                        try {
                          await editor.addTextAnnotation(currentDocument, finalAnnotation);
                          console.log("Text annotation saved to PDF");
                        } catch (err) {
                          console.error("Error creating text annotation in PDF:", err);
                        }
                      } else {
                        console.warn("PDF editor not initialized, text annotation not saved to PDF");
                      }
                    } else if (!annot.id.startsWith("temp_")) {
                      // Update existing annotation - wrap with undo/redo
                      wrapAnnotationUpdate(
                        currentDocument.getId(),
                        annot.id,
                        { content: annot.content || "" }
                      );
                      
                      // Update in PDF document
                      if (editor && annot.pdfAnnotation) {
                        try {
                          await editor.updateAnnotationInPdf(
                            currentDocument,
                            annot.pdfAnnotation,
                            { content: annot.content || "" }
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
              />
            );
          })();
        })})()}
      </div>
    </div>
  );
}
