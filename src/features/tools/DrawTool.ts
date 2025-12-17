/**
 * Draw Tool Handler
 * 
 * Handles freeform drawing tool interactions with path smoothing
 */

import type { ToolHandler, ToolContext } from "./types";
import type { Annotation } from "@/core/pdf/PDFEditor";
import { useUIStore } from "@/shared/stores/uiStore";

// Catmull-Rom spline smoothing for path points
function smoothPath(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  if (points.length < 3) return points;
  
  const smoothed: Array<{ x: number; y: number }> = [];
  
  // Add first point
  smoothed.push(points[0]);
  
  // Smooth intermediate points using Catmull-Rom spline
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    
    // Generate intermediate points using Catmull-Rom spline
    // Standard Catmull-Rom formula: q(t) = 0.5 * (2*p1 + (-p0 + p2)*t + (2*p0 - 5*p1 + 4*p2 - p3)*t² + (-p0 + 3*p1 - 3*p2 + p3)*t³)
    const segments = 10;
    for (let t = 1; t <= segments; t++) {
      const t_norm = t / segments;
      const t2 = t_norm * t_norm;
      const t3 = t2 * t_norm;
      
      const x = 0.5 * (
        (2 * p1.x) +
        (-p0.x + p2.x) * t_norm +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
      );
      
      const y = 0.5 * (
        (2 * p1.y) +
        (-p0.y + p2.y) * t_norm +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
      );
      
      smoothed.push({ x, y });
    }
  }
  
  // Add last point
  smoothed.push(points[points.length - 1]);
  
  return smoothed;
}

// Simplify path using Douglas-Peucker algorithm
function simplifyPath(points: Array<{ x: number; y: number }>, tolerance: number = 2): Array<{ x: number; y: number }> {
  if (points.length <= 2) return points;
  
  // Find point with maximum distance from line
  let maxDistance = 0;
  let maxIndex = 0;
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  
  for (let i = 1; i < points.length - 1; i++) {
    const distance = perpendicularDistance(points[i], firstPoint, lastPoint);
    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = i;
    }
  }
  
  // If max distance is greater than tolerance, recursively simplify
  if (maxDistance > tolerance) {
    const left = simplifyPath(points.slice(0, maxIndex + 1), tolerance);
    const right = simplifyPath(points.slice(maxIndex), tolerance);
    return [...left.slice(0, -1), ...right];
  } else {
    return [firstPoint, lastPoint];
  }
}

function perpendicularDistance(
  point: { x: number; y: number },
  lineStart: { x: number; y: number },
  lineEnd: { x: number; y: number }
): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const norm = Math.sqrt(dx * dx + dy * dy);
  
  if (norm === 0) {
    const dx2 = point.x - lineStart.x;
    const dy2 = point.y - lineStart.y;
    return Math.sqrt(dx2 * dx2 + dy2 * dy2);
  }
  
  const u = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / (norm * norm);
  
  let closestX: number;
  let closestY: number;
  
  if (u < 0) {
    closestX = lineStart.x;
    closestY = lineStart.y;
  } else if (u > 1) {
    closestX = lineEnd.x;
    closestY = lineEnd.y;
  } else {
    closestX = lineStart.x + u * dx;
    closestY = lineStart.y + u * dy;
  }
  
  const dx3 = point.x - closestX;
  const dy3 = point.y - closestY;
  return Math.sqrt(dx3 * dx3 + dy3 * dy3);
}

let isDrawing = false;
let currentPath: Array<{ x: number; y: number }> = [];
let lastAddTime = 0;
let drawPreviewCallback: (() => void) | null = null;

export const getDrawingPath = () => currentPath;
export const isCurrentlyDrawing = () => isDrawing;
export const setDrawPreviewCallback = (callback: (() => void) | null) => {
  drawPreviewCallback = callback;
};

export const DrawTool: ToolHandler = {
  handleMouseDown: (e: React.MouseEvent, context: ToolContext) => {
    const coords = context.getPDFCoordinates(e);
    if (!coords) return;
    
    isDrawing = true;
    currentPath = [coords];
    lastAddTime = Date.now();
    
    // Set selection state to trigger mouse move events
    context.setIsSelecting(true);
    context.setSelectionStart(coords);
    context.setSelectionEnd(coords);
    
    e.preventDefault();
    e.stopPropagation();
  },

  handleMouseMove: (e: React.MouseEvent, context: ToolContext) => {
    if (!isDrawing) return;
    
    // Throttle point addition to improve performance
    const now = Date.now();
    if (now - lastAddTime < 5) return; // Add point every 5ms
    
    const coords = context.getPDFCoordinates(e);
    if (!coords) return;
    
    currentPath.push(coords);
    lastAddTime = now;
    
    // Trigger re-render to show drawing preview
    if (drawPreviewCallback) {
      drawPreviewCallback();
    }
  },

  handleMouseUp: async (_e: React.MouseEvent, context: ToolContext) => {
    if (!isDrawing || currentPath.length < 2) {
      isDrawing = false;
      currentPath = [];
      context.setIsSelecting(false);
      context.setSelectionStart(null);
      context.setSelectionEnd(null);
      return;
    }
    
    const { pageNumber, currentDocument, addAnnotation } = context;
    
    if (!currentDocument) {
      isDrawing = false;
      currentPath = [];
      return;
    }
    
    // Simplify path if too many points
    let finalPath = currentPath;
    if (finalPath.length > 100) {
      finalPath = simplifyPath(finalPath, 2);
    }
    
    // Apply smoothing
    finalPath = smoothPath(finalPath);
    
    // Get drawing settings from UI store
    const { drawingColor, drawingStrokeWidth, drawingOpacity } = useUIStore.getState();
    
    // Create drawing annotation (always use pencil style)
    const annotation: Annotation = {
      id: `draw_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: "draw",
      pageNumber,
      x: Math.min(...finalPath.map(p => p.x)),
      y: Math.min(...finalPath.map(p => p.y)),
      width: Math.max(...finalPath.map(p => p.x)) - Math.min(...finalPath.map(p => p.x)),
      height: Math.max(...finalPath.map(p => p.y)) - Math.min(...finalPath.map(p => p.y)),
      path: finalPath,
      drawingStyle: "pencil",
      color: drawingColor,
      strokeWidth: drawingStrokeWidth,
      strokeOpacity: drawingOpacity,
      smoothed: true,
    };
    
    addAnnotation(currentDocument.getId(), annotation);
    
    // Reset state (stay in draw mode)
    isDrawing = false;
    currentPath = [];
    context.setIsSelecting(false);
    context.setSelectionStart(null);
    context.setSelectionEnd(null);
  },
};

