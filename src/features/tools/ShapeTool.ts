/**
 * Shape Tool Handler
 * 
 * Handles shape annotation tool interactions (arrows, rectangles, circles)
 */

import type { ToolHandler, ToolContext } from "./types";
import type { Annotation } from "@/core/pdf/PDFEditor";
import { useUIStore } from "@/shared/stores/uiStore";

let isDrawingShape = false;
let shapeStart: { x: number; y: number } | null = null;
let circleCenter: { x: number; y: number } | null = null; // Pinned center for circles
let circleSize: number = 0; // Current size when Shift is pressed
let isRepositioning: boolean = false; // Whether we're in reposition mode (Shift pressed)

export const ShapeTool: ToolHandler = {
  handleMouseDown: (e: React.MouseEvent, context: ToolContext) => {
    const coords = context.getPDFCoordinates(e);
    if (!coords) {
      console.warn("🟣 [ARROW CREATE] getPDFCoordinates returned null");
      return;
    }
    
    console.log("🟣 [ARROW CREATE] Mouse down, getPDFCoordinates returned:", coords);
    
    const { currentShapeType } = useUIStore.getState();
    
    isDrawingShape = true;
    shapeStart = coords;
    
    // For circles, pin the center to the initial click position
    if (currentShapeType === "circle") {
      circleCenter = coords;
      circleSize = 0;
      isRepositioning = false;
    }
    
    context.setIsSelecting(true);
    context.setSelectionStart(coords);
    context.setSelectionEnd(coords);
    
    e.preventDefault();
    e.stopPropagation();
  },

  handleMouseMove: (e: React.MouseEvent, context: ToolContext) => {
    if (!isDrawingShape || !shapeStart) return;
    
    const coords = context.getPDFCoordinates(e);
    if (!coords) return;
    
    const { currentShapeType } = useUIStore.getState();
    
    // Handle Shift key for circles: pause resizing and allow repositioning
    if (currentShapeType === "circle" && circleCenter) {
      if (e.shiftKey && !isRepositioning) {
        // Shift just pressed - enter reposition mode
        // Calculate current size before pausing
        const dx = coords.x - circleCenter.x;
        const dy = coords.y - circleCenter.y;
        circleSize = Math.max(Math.abs(dx), Math.abs(dy)) * 2; // Diameter
        isRepositioning = true;
      } else if (!e.shiftKey && isRepositioning) {
        // Shift released - exit reposition mode, pin to top-left and resume resizing
        // Update the center to the current mouse position (new pinned position)
        circleCenter = coords;
        circleSize = 0; // Reset size, will be recalculated from new center
        isRepositioning = false;
      }
      
      if (isRepositioning) {
        // In reposition mode: update the center but keep the size
        circleCenter = coords;
        // Calculate bounding box from new center with stored size
        const radius = circleSize / 2;
        const minX = circleCenter.x - radius;
        const minY = circleCenter.y - radius;
        const maxX = circleCenter.x + radius;
        const maxY = circleCenter.y + radius;
        
        // Update selection to show the bounding box at new position
        context.setSelectionStart({ x: minX, y: minY });
        context.setSelectionEnd({ x: maxX, y: maxY });
      } else {
        // Normal resize mode: calculate size from center
        const dx = coords.x - circleCenter.x;
        const dy = coords.y - circleCenter.y;
        const radius = Math.max(Math.abs(dx), Math.abs(dy));
        
        // Calculate bounding box from center
        const minX = circleCenter.x - radius;
        const minY = circleCenter.y - radius;
        const maxX = circleCenter.x + radius;
        const maxY = circleCenter.y + radius;
        
        // Update selection to show the bounding box
        context.setSelectionStart({ x: minX, y: minY });
        context.setSelectionEnd({ x: maxX, y: maxY });
      }
    } else {
      // For non-circles, use normal behavior
      context.setSelectionEnd(coords);
    }
  },

  handleMouseUp: async (e: React.MouseEvent, context: ToolContext, selectionStart, selectionEnd) => {
    if (!isDrawingShape || !shapeStart) {
      isDrawingShape = false;
      shapeStart = null;
      circleCenter = null;
      circleSize = 0;
      isRepositioning = false;
      context.setIsSelecting(false);
      context.setSelectionStart(null);
      context.setSelectionEnd(null);
      return;
    }
    
    const { pageNumber, currentDocument, addAnnotation } = context;
    
    if (!currentDocument) {
      isDrawingShape = false;
      shapeStart = null;
      circleCenter = null;
      circleSize = 0;
      isRepositioning = false;
      return;
    }
    
    // Get shape settings from UI store
    const {
      currentShapeType,
      shapeStrokeColor,
      shapeStrokeWidth,
      shapeFillColor,
      shapeFillOpacity,
      arrowHeadSize,
    } = useUIStore.getState();
    
    let x: number, y: number, w: number, h: number;
    
    if (currentShapeType === "circle" && circleCenter) {
      // For circles, calculate from pinned center
      if (isRepositioning && circleSize > 0) {
        // If we're in reposition mode, use the stored size
        const radius = circleSize / 2;
        x = circleCenter.x - radius;
        y = circleCenter.y - radius;
        w = circleSize;
        h = circleSize;
      } else if (selectionStart && selectionEnd) {
        // Calculate from current selection (which is already based on center)
        x = Math.min(selectionStart.x, selectionEnd.x);
        y = Math.min(selectionStart.y, selectionEnd.y);
        w = Math.abs(selectionEnd.x - selectionStart.x);
        h = Math.abs(selectionEnd.y - selectionStart.y);
      } else {
        // Fallback: calculate from center to current mouse
        const coords = context.getPDFCoordinates(e);
        if (!coords) {
          isDrawingShape = false;
          shapeStart = null;
          circleCenter = null;
          circleSize = 0;
          isRepositioning = false;
          return;
        }
        const dx = coords.x - circleCenter.x;
        const dy = coords.y - circleCenter.y;
        const radius = Math.max(Math.abs(dx), Math.abs(dy));
        x = circleCenter.x - radius;
        y = circleCenter.y - radius;
        w = radius * 2;
        h = radius * 2;
      }
    } else {
      // For non-circles, use normal bounding box calculation
      if (!selectionEnd) {
        isDrawingShape = false;
        shapeStart = null;
        circleCenter = null;
        circleSize = 0;
        isRepositioning = false;
        context.setIsSelecting(false);
        context.setSelectionStart(null);
        context.setSelectionEnd(null);
        return;
      }
      
      // Check for minimum size (avoid accidental tiny shapes)
      const width = Math.abs(selectionEnd.x - shapeStart.x);
      const height = Math.abs(selectionEnd.y - shapeStart.y);
      
      if (width < 10 && height < 10) {
        isDrawingShape = false;
        shapeStart = null;
        circleCenter = null;
        circleSize = 0;
        isRepositioning = false;
        context.setIsSelecting(false);
        context.setSelectionStart(null);
        context.setSelectionEnd(null);
        return;
      }
      
      // Check if Shift key is pressed for constrained proportions
      const constrained = e.shiftKey;
      
      let finalEnd = selectionEnd;
      if (constrained) {
        if (currentShapeType === "rectangle") {
          // Make it a square
          const size = Math.max(width, height);
          finalEnd = {
            x: shapeStart.x + (selectionEnd.x > shapeStart.x ? size : -size),
            y: shapeStart.y + (selectionEnd.y > shapeStart.y ? size : -size),
          };
        } else if (currentShapeType === "arrow") {
          // Constrain to 45-degree angles
          const dx = selectionEnd.x - shapeStart.x;
          const dy = selectionEnd.y - shapeStart.y;
          const angle = Math.atan2(dy, dx);
          const constrainedAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
          const length = Math.sqrt(dx * dx + dy * dy);
          finalEnd = {
            x: shapeStart.x + length * Math.cos(constrainedAngle),
            y: shapeStart.y + length * Math.sin(constrainedAngle),
          };
        }
      }
      
      // Calculate bounding box
      x = Math.min(shapeStart.x, finalEnd.x);
      y = Math.min(shapeStart.y, finalEnd.y);
      w = Math.abs(finalEnd.x - shapeStart.x);
      h = Math.abs(finalEnd.y - shapeStart.y);
    }
    
    // Check minimum size for circles too
    if (w < 10 && h < 10) {
      isDrawingShape = false;
      shapeStart = null;
      circleCenter = null;
      circleSize = 0;
      isRepositioning = false;
      context.setIsSelecting(false);
      context.setSelectionStart(null);
      context.setSelectionEnd(null);
      return;
    }
    
    // Create shape annotation
    const annotation: Annotation = {
      id: `shape_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: "shape",
      pageNumber,
      x,
      y,
      width: w,
      height: h,
      shapeType: currentShapeType,
      strokeColor: shapeStrokeColor,
      strokeWidth: shapeStrokeWidth,
      fillColor: shapeFillColor,
      fillOpacity: shapeFillOpacity,
      arrowHeadSize: currentShapeType === "arrow" ? arrowHeadSize : undefined,
      points: currentShapeType === "arrow" ? (() => {
        // Ensure points are valid numbers
        const start = shapeStart;
        const end = selectionEnd || shapeStart;
        console.log("🟣 [ARROW CREATE] Creating arrow with points:", { start, end, shapeStart, selectionEnd });
        if (!start || !end || 
            typeof start.x !== 'number' || typeof start.y !== 'number' ||
            typeof end.x !== 'number' || typeof end.y !== 'number' ||
            isNaN(start.x) || isNaN(start.y) || isNaN(end.x) || isNaN(end.y)) {
          console.error("🟠 [ARROW CREATE] Invalid arrow points:", { start, end, shapeStart, selectionEnd });
          return undefined;
        }
        console.log("🟣 [ARROW CREATE] Valid points, returning:", [start, end]);
        return [start, end];
      })() : undefined,
    };
    
    addAnnotation(currentDocument.getId(), annotation);
    
    // Switch to select tool and select the newly created annotation
    useUIStore.getState().setActiveTool("select");
    context.setEditingAnnotation(annotation);
    
    // Dispatch event to notify that annotation was selected
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent("annotationSelected", { 
        detail: { annotationId: annotation.id } 
      }));
    });
    
    // Reset state
    isDrawingShape = false;
    shapeStart = null;
    circleCenter = null;
    circleSize = 0;
    isRepositioning = false;
    context.setIsSelecting(false);
    context.setSelectionStart(null);
    context.setSelectionEnd(null);
  },
};

