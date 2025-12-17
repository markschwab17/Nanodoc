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

export const ShapeTool: ToolHandler = {
  handleMouseDown: (e: React.MouseEvent, context: ToolContext) => {
    const coords = context.getPDFCoordinates(e);
    if (!coords) return;
    
    isDrawingShape = true;
    shapeStart = coords;
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
    
    context.setSelectionEnd(coords);
  },

  handleMouseUp: async (e: React.MouseEvent, context: ToolContext, selectionStart, selectionEnd) => {
    if (!isDrawingShape || !shapeStart || !selectionEnd) {
      isDrawingShape = false;
      shapeStart = null;
      context.setIsSelecting(false);
      context.setSelectionStart(null);
      context.setSelectionEnd(null);
      return;
    }
    
    const { pageNumber, currentDocument, addAnnotation } = context;
    
    if (!currentDocument) {
      isDrawingShape = false;
      shapeStart = null;
      return;
    }
    
    // Check for minimum size (avoid accidental tiny shapes)
    const width = Math.abs(selectionEnd.x - shapeStart.x);
    const height = Math.abs(selectionEnd.y - shapeStart.y);
    
    if (width < 10 && height < 10) {
      isDrawingShape = false;
      shapeStart = null;
      context.setIsSelecting(false);
      context.setSelectionStart(null);
      context.setSelectionEnd(null);
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
      } else if (currentShapeType === "circle") {
        // Already constrained to circle
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
    const x = Math.min(shapeStart.x, finalEnd.x);
    const y = Math.min(shapeStart.y, finalEnd.y);
    const w = Math.abs(finalEnd.x - shapeStart.x);
    const h = Math.abs(finalEnd.y - shapeStart.y);
    
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
      points: currentShapeType === "arrow" ? [shapeStart, finalEnd] : undefined,
    };
    
    addAnnotation(currentDocument.getId(), annotation);
    
    // Reset state
    isDrawingShape = false;
    shapeStart = null;
    context.setIsSelecting(false);
    context.setSelectionStart(null);
    context.setSelectionEnd(null);
  },
};

