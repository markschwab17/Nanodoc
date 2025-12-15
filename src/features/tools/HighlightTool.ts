/**
 * Highlight Tool Handler
 * 
 * Handles highlight tool interactions: text selection highlighting and overlay highlighting
 */

import type { ToolHandler, ToolContext } from "./types";
import type { Annotation } from "@/core/pdf/PDFEditor";
import { useUIStore } from "@/shared/stores/uiStore";

// Store overlay path during drag
let overlayPath: Array<{ x: number; y: number }> = [];
let isOverlayMode = false;
let dragStartCoords: { x: number; y: number } | null = null;
let isShiftPressed = false;
let lockedDirection: "horizontal" | "vertical" | "diagonal" | null = null;
let lockedEndPoint: { x: number; y: number } | null = null; // Store locked end point

// Helper to convert path to quads for storage
function pathToQuads(path: Array<{ x: number; y: number }>, strokeWidth: number): number[][] {
  if (path.length < 2) {
    // If we only have one point, create a small circular quad
    if (path.length === 1) {
      const p = path[0];
      const halfWidth = strokeWidth / 2;
      return [[
        p.x - halfWidth, p.y - halfWidth,
        p.x + halfWidth, p.y - halfWidth,
        p.x + halfWidth, p.y + halfWidth,
        p.x - halfWidth, p.y + halfWidth
      ]];
    }
    return [];
  }
  
  const quads: number[][] = [];
  const halfWidth = strokeWidth / 2;
  
  for (let i = 0; i < path.length - 1; i++) {
    const p1 = path[i];
    const p2 = path[i + 1];
    
    // Calculate perpendicular vector for stroke width
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    
    if (len === 0) {
      // If points are the same, create a small circular quad
      quads.push([
        p1.x - halfWidth, p1.y - halfWidth,
        p1.x + halfWidth, p1.y - halfWidth,
        p1.x + halfWidth, p1.y + halfWidth,
        p1.x - halfWidth, p1.y + halfWidth
      ]);
      continue;
    }
    
    // Perpendicular vector (normalized)
    const perpX = -dy / len;
    const perpY = dx / len;
    
    // Create quad for this segment
    const x0 = p1.x + perpX * halfWidth;
    const y0 = p1.y + perpY * halfWidth;
    const x1 = p1.x - perpX * halfWidth;
    const y1 = p1.y - perpY * halfWidth;
    const x2 = p2.x - perpX * halfWidth;
    const y2 = p2.y - perpY * halfWidth;
    const x3 = p2.x + perpX * halfWidth;
    const y3 = p2.y + perpY * halfWidth;
    
    quads.push([x0, y0, x1, y1, x2, y2, x3, y3]);
  }
  
  return quads;
}

// Helper to determine locked direction for perfect lines
function determineLockedDirection(start: { x: number; y: number }, end: { x: number; y: number }): "horizontal" | "vertical" | "diagonal" {
  const dx = Math.abs(end.x - start.x);
  const dy = Math.abs(end.y - start.y);
  
  // Prefer horizontal/vertical over diagonal
  // Use a smaller threshold to make horizontal/vertical easier to achieve
  // Only use diagonal if the movement is truly close to 45 degrees
  const threshold = 1.1; // Lower threshold makes horizontal/vertical easier
  
  // Calculate angle to determine if it's close to 45 degrees
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  const angleFrom45 = Math.abs(angle - 45);
  const angleFrom135 = Math.abs(angle - 135);
  const isCloseTo45 = angleFrom45 < 10 || angleFrom135 < 10;
  
  // If close to 45 degrees, use diagonal
  if (isCloseTo45) {
    return "diagonal";
  }
  
  // Otherwise, prefer horizontal/vertical based on dominant axis
  if (dx > dy * threshold) {
    return "horizontal";
  } else if (dy > dx * threshold) {
    return "vertical";
  } else {
    // If neither is clearly dominant, choose based on which is larger
    return dx > dy ? "horizontal" : "vertical";
  }
}

// Helper to calculate locked end point
function calculateLockedEndPoint(
  start: { x: number; y: number },
  current: { x: number; y: number },
  direction: "horizontal" | "vertical" | "diagonal"
): { x: number; y: number } {
  switch (direction) {
    case "horizontal":
      return { x: current.x, y: start.y };
    case "vertical":
      return { x: start.x, y: current.y };
    case "diagonal": {
      // Lock to 45-degree diagonal
      const dx = current.x - start.x;
      const dy = current.y - start.y;
      const avgDelta = (dx + dy) / 2;
      return { x: start.x + avgDelta, y: start.y + avgDelta };
    }
  }
}

export const HighlightTool: ToolHandler = {
  handleMouseDown: (e: React.MouseEvent, context: ToolContext) => {
    const coords = context.getPDFCoordinates(e);
    if (!coords) return;
    
    // Check if shift is pressed
    isShiftPressed = e.shiftKey;
    lockedDirection = null;
    lockedEndPoint = null;
    
    // Check if we have selected text spans (text selection mode)
    // We'll detect mode on mouseUp based on whether we can extract text quads
    isOverlayMode = false; // Will be determined on mouseUp
    overlayPath = [coords];
    dragStartCoords = coords;
    
    context.setIsSelecting(true);
    context.setSelectionStart(coords);
    context.setSelectionEnd(coords);
  },

  handleMouseMove: (e: React.MouseEvent, context: ToolContext) => {
    if (!context.isSelecting || !context.selectionStart) return;
    
    const coords = context.getPDFCoordinates(e);
    if (!coords) return;
    
    // Update shift key state
    isShiftPressed = e.shiftKey;
    
    // Determine locked direction if shift is pressed and we haven't locked yet
    if (isShiftPressed && dragStartCoords && !lockedDirection) {
      lockedDirection = determineLockedDirection(dragStartCoords, coords);
    }
    
    // Calculate end point (locked if shift is pressed)
    let endPoint = coords;
    if (isShiftPressed && dragStartCoords) {
      // If we don't have a locked direction yet, determine it
      if (!lockedDirection) {
        lockedDirection = determineLockedDirection(dragStartCoords, coords);
      }
      // Calculate locked end point
      if (lockedDirection) {
        endPoint = calculateLockedEndPoint(dragStartCoords, coords, lockedDirection);
        lockedEndPoint = endPoint; // Store locked end point (persists even if shift is released)
      }
    } else if (lockedEndPoint && dragStartCoords && lockedDirection) {
      // If shift was released but we had a locked direction, keep using the locked end point
      // Recalculate based on current mouse position but maintain the locked direction
      endPoint = calculateLockedEndPoint(dragStartCoords, coords, lockedDirection);
      lockedEndPoint = endPoint; // Update locked end point
    }
    
    // Update selection end (always use the calculated end point, which may be locked)
    context.setSelectionEnd(endPoint);
    
    // Add to overlay path (use the end point, which may be locked)
    overlayPath.push(endPoint);
    
    // Limit path length for performance
    if (overlayPath.length > 100) {
      overlayPath = overlayPath.slice(-100);
    }
  },

  handleMouseUp: async (e: React.MouseEvent, context: ToolContext, selectionStart, selectionEnd) => {
    // Ensure we have valid start point - always commit something if we started
    if (!selectionStart) {
      context.setIsSelecting(false);
      context.setSelectionStart(null);
      context.setSelectionEnd(null);
      overlayPath = [];
      isOverlayMode = false;
      dragStartCoords = null;
      lockedDirection = null;
      lockedEndPoint = null;
      return;
    }
    
    // Determine final selection end point
    // Priority: lockedEndPoint > selectionEnd from context > last point in path > selectionStart
    let finalSelectionEnd: { x: number; y: number };
    
    if (lockedEndPoint) {
      // Use locked end point if available (from shift+drag) - this is the most reliable
      console.log("Using lockedEndPoint for finalSelectionEnd", lockedEndPoint);
      finalSelectionEnd = lockedEndPoint;
    } else if (selectionEnd) {
      // Use selectionEnd from context
      console.log("Using selectionEnd from context", selectionEnd);
      finalSelectionEnd = selectionEnd;
    } else if (context.overlayHighlightPath && context.overlayHighlightPath.length > 0) {
      // Use last point from path
      console.log("Using last point from overlayHighlightPath", context.overlayHighlightPath[context.overlayHighlightPath.length - 1]);
      finalSelectionEnd = context.overlayHighlightPath[context.overlayHighlightPath.length - 1];
    } else if (overlayPath.length > 0) {
      // Use last point from internal path
      console.log("Using last point from overlayPath", overlayPath[overlayPath.length - 1]);
      finalSelectionEnd = overlayPath[overlayPath.length - 1];
    } else {
      // Fallback to selectionStart (will create a small highlight)
      console.warn("No valid end point found, using selectionStart as fallback");
      finalSelectionEnd = selectionStart;
    }
    
    // Check if this was just a click (no drag) - if so, don't create highlight
    // But if we have a locked end point or a path, it's definitely a drag, not a click
    const hasLockedPoint = !!lockedEndPoint;
    const hasPath = (context.overlayHighlightPath && context.overlayHighlightPath.length > 1) || overlayPath.length > 1;
    const distance = Math.sqrt(
      Math.pow(finalSelectionEnd.x - selectionStart.x, 2) + 
      Math.pow(finalSelectionEnd.y - selectionStart.y, 2)
    );
    const isClick = !hasLockedPoint && !hasPath && distance < 2;
    
    if (isClick) {
      console.log("Detected click, not creating highlight");
      context.setIsSelecting(false);
      context.setSelectionStart(null);
      context.setSelectionEnd(null);
      overlayPath = [];
      isOverlayMode = false;
      dragStartCoords = null;
      lockedDirection = null;
      lockedEndPoint = null;
      return;
    }
    
    console.log("Not a click, proceeding with highlight creation", {
      hasLockedPoint,
      hasPath,
      distance,
      pathLength: context.overlayHighlightPath?.length || overlayPath.length
    });
    
    console.log("HighlightTool handleMouseUp:", {
      selectionStart,
      selectionEnd,
      finalSelectionEnd,
      lockedEndPoint,
      dragStartCoords,
      lockedDirection,
      pathLength: context.overlayHighlightPath?.length || overlayPath.length,
      isClick,
      overlayPathLength: overlayPath.length
    });

    const { document, pageNumber, addAnnotation, editor } = context;
    const currentDocument = document;
    
    // Get highlight settings from store
    const { highlightColor, highlightStrokeWidth, highlightOpacity } = useUIStore.getState();

    try {
      const mupdfDoc = currentDocument.getMupdfDocument();
      const page = mupdfDoc.loadPage(pageNumber);

      // Try text selection mode first: attempt to get text quads
      // This should work like the old highlight tool - automatically highlight text if detected
      let quads: any[] | null = null;
      let selectedText = "";
      
      try {
        const BASE_SCALE = 2.0;
        // Normalize coordinates (min/max to handle drag direction)
        const minX = Math.min(selectionStart.x, finalSelectionEnd.x);
        const minY = Math.min(selectionStart.y, finalSelectionEnd.y);
        const maxX = Math.max(selectionStart.x, finalSelectionEnd.x);
        const maxY = Math.max(selectionStart.y, finalSelectionEnd.y);
        
        const p = [minX, minY];
        const q = [maxX, maxY];
        const structuredText = page.toStructuredText("preserve-whitespace");
        
        // Try PDF coordinates first (normalized)
        quads = structuredText.highlight(p, q);
        
        // If no quads, try canvas coordinates (multiply by BASE_SCALE)
        // highlight() might expect canvas coordinates in some cases
        if (!quads || quads.length === 0) {
          const pCanvas = [minX * BASE_SCALE, minY * BASE_SCALE];
          const qCanvas = [maxX * BASE_SCALE, maxY * BASE_SCALE];
          quads = structuredText.highlight(pCanvas, qCanvas);
        }
        
        // Try with original coordinates (in case direction matters)
        if (!quads || quads.length === 0) {
          quads = structuredText.highlight([selectionStart.x, selectionStart.y], [finalSelectionEnd.x, finalSelectionEnd.y]);
        }
        
        // Try with slightly expanded area to catch text near edges (like PDFTextExtractor does)
        if (!quads || quads.length === 0) {
          const expandedP = [minX - 2, minY - 2];
          const expandedQ = [maxX + 2, maxY + 2];
          quads = structuredText.highlight(expandedP, expandedQ);
        }
        
        // Try canvas coordinates with expanded area
        if (!quads || quads.length === 0) {
          const expandedPCanvas = [(minX - 2) * BASE_SCALE, (minY - 2) * BASE_SCALE];
          const expandedQCanvas = [(maxX + 2) * BASE_SCALE, (maxY + 2) * BASE_SCALE];
          quads = structuredText.highlight(expandedPCanvas, expandedQCanvas);
        }
        
        if (quads && quads.length > 0) {
          isOverlayMode = false;
          console.log("Text detected in highlight selection, using text mode", { quadsCount: quads.length });
          // Try to extract text from the quads
          try {
            selectedText = structuredText.asText();
          } catch (error) {
            // Ignore text extraction error
          }
        } else {
          isOverlayMode = true;
          console.log("No text detected in highlight selection, using overlay mode");
        }
      } catch (error) {
        console.warn("Error detecting text in highlight selection:", error);
        // If text extraction fails, use overlay mode
        isOverlayMode = true;
      }

      let annotation: Annotation;

      if (!isOverlayMode && quads && quads.length > 0) {
        // Text selection mode: use text quads
        const quadArray = quads.map((quad: any) => {
          if (Array.isArray(quad) && quad.length >= 8) {
            return quad;
          }
          return [quad.x0 || 0, quad.y0 || 0, quad.x1 || 0, quad.y1 || 0,
                  quad.x2 || 0, quad.y2 || 0, quad.x3 || 0, quad.y3 || 0];
        });

        annotation = {
          id: `highlight_${Date.now()}`,
          type: "highlight",
          pageNumber,
          x: Math.min(selectionStart.x, finalSelectionEnd.x),
          y: Math.min(selectionStart.y, finalSelectionEnd.y),
          width: Math.abs(finalSelectionEnd.x - selectionStart.x),
          height: Math.abs(finalSelectionEnd.y - selectionStart.y),
          quads: quadArray,
          selectedText: selectedText,
          color: highlightColor,
          opacity: highlightOpacity,
          highlightMode: "text",
        };
      } else {
        // Overlay mode: use path
        // Prefer path from context (PageCanvas) if available, otherwise use internal path
        const pathToUse = context.overlayHighlightPath && context.overlayHighlightPath.length > 0 
          ? context.overlayHighlightPath 
          : overlayPath;
        
        // Determine final path to use
        let finalPath: Array<{ x: number; y: number }>;
        
        // Priority: lockedEndPoint > shift-locked > tracked path > start/end fallback
        if (lockedEndPoint && dragStartCoords) {
          // We have a locked end point (from shift+drag) - use it even if shift is now released
          console.log("Using locked end point for overlay highlight", { dragStartCoords, lockedEndPoint, lockedDirection });
          finalPath = [dragStartCoords, lockedEndPoint];
        } else if (isShiftPressed && dragStartCoords && lockedDirection) {
          // Shift is still pressed, create straight line from start to end (locked coordinates)
          const lockedPoint = calculateLockedEndPoint(dragStartCoords, finalSelectionEnd, lockedDirection);
          console.log("Using shift-locked coordinates for overlay highlight", { dragStartCoords, lockedPoint, lockedDirection });
          finalPath = [dragStartCoords, lockedPoint];
        } else if (pathToUse.length > 1) {
          // Use the tracked path (only if we have multiple points)
          console.log("Using tracked path for overlay highlight", { pathLength: pathToUse.length });
          finalPath = pathToUse;
        } else {
          // Fallback: if no path or only one point, use start and end points to create a simple line
          console.log("Using start/end points for overlay highlight", { selectionStart, finalSelectionEnd });
          finalPath = [selectionStart, finalSelectionEnd];
        }
        
        // Ensure we have at least 2 points for a valid path
        if (finalPath.length < 2) {
          console.warn("Path has less than 2 points, using start/end fallback");
          finalPath = [selectionStart, finalSelectionEnd];
        }
        
        // Ensure path has valid points
        if (finalPath.some(p => !p || p.x === undefined || p.y === undefined)) {
          console.warn("Path has invalid points, using start/end fallback");
          finalPath = [selectionStart, finalSelectionEnd];
        }
        
        console.log("Final path for overlay highlight:", finalPath);
        
        // Convert path to quads
        const pathQuads = pathToQuads(finalPath, highlightStrokeWidth);
        console.log("Generated quads from path:", { pathLength: finalPath.length, quadsCount: pathQuads.length });
        
        // Ensure we have quads (pathToQuads should always return something for a valid path)
        if (pathQuads.length === 0 && finalPath.length >= 2) {
          console.warn("No quads generated from path, creating fallback quads");
          // Create a simple rectangular quad from the path bounds
          const allX = finalPath.map(p => p.x);
          const allY = finalPath.map(p => p.y);
          const minX = Math.min(...allX);
          const maxX = Math.max(...allX);
          const minY = Math.min(...allY);
          const maxY = Math.max(...allY);
          pathQuads.push([minX, minY, maxX, minY, maxX, maxY, minX, maxY]);
        }
        
        // Calculate bounding box
        const allX = finalPath.map(p => p.x);
        const allY = finalPath.map(p => p.y);
        const minX = Math.min(...allX);
        const maxX = Math.max(...allX);
        const minY = Math.min(...allY);
        const maxY = Math.max(...allY);
        
        // Ensure we have valid dimensions
        const width = Math.max(1, maxX - minX);
        const height = Math.max(1, maxY - minY);

        annotation = {
          id: `highlight_${Date.now()}`,
          type: "highlight",
          pageNumber,
          x: minX,
          y: minY,
          width: width,
          height: height,
          quads: pathQuads.length > 0 ? pathQuads : undefined, // Only include quads if we have them
          path: finalPath,
          color: highlightColor,
          strokeWidth: highlightStrokeWidth,
          opacity: highlightOpacity,
          highlightMode: "overlay",
        };
        
        console.log("Created overlay highlight annotation:", {
          id: annotation.id,
          pathLength: finalPath.length,
          quadsCount: pathQuads.length,
          bounds: { x: minX, y: minY, width, height }
        });
      }

      // Always commit the highlight (don't cancel) - even if there was an error
      console.log("Committing highlight annotation:", {
        id: annotation.id,
        type: annotation.type,
        highlightMode: annotation.highlightMode,
        hasQuads: !!annotation.quads && annotation.quads.length > 0,
        quadsCount: annotation.quads?.length || 0,
        hasPath: !!annotation.path && annotation.path.length > 0,
        pathLength: annotation.path?.length || 0,
        documentId: currentDocument.getId(),
        pageNumber: annotation.pageNumber
      });
      
      // Add to app state first (so it renders immediately)
      try {
        console.log("Adding annotation to store...");
        addAnnotation(currentDocument.getId(), annotation);
        console.log("Highlight annotation added to store successfully");
        
        // Verify it was added
        const addedAnnotations = context.annotations.filter(a => a.id === annotation.id);
        console.log("Verification - annotation in context:", addedAnnotations.length > 0);

        // Write to PDF document
        if (!editor) {
          console.warn("PDF editor not initialized, annotation not saved to PDF");
        } else {
          try {
            await editor.addHighlightAnnotation(currentDocument, annotation);
            console.log("Highlight annotation saved to PDF successfully");
          } catch (err) {
            console.error("Error writing highlight to PDF:", err);
            // Still keep the annotation in the UI even if PDF save fails
          }
        }
      } catch (annotationError) {
        console.error("Error adding annotation to store:", annotationError);
        // Try to create a minimal overlay highlight as fallback
        try {
          const fallbackAnnotation: Annotation = {
            id: `highlight_${Date.now()}`,
            type: "highlight",
            pageNumber,
            x: Math.min(selectionStart.x, finalSelectionEnd.x),
            y: Math.min(selectionStart.y, finalSelectionEnd.y),
            width: Math.abs(finalSelectionEnd.x - selectionStart.x) || 10,
            height: Math.abs(finalSelectionEnd.y - selectionStart.y) || 10,
            quads: [],
            path: [selectionStart, finalSelectionEnd],
            color: highlightColor,
            strokeWidth: highlightStrokeWidth,
            opacity: highlightOpacity,
            highlightMode: "overlay",
          };
          addAnnotation(currentDocument.getId(), fallbackAnnotation);
          console.log("Fallback highlight annotation created");
        } catch (fallbackError) {
          console.error("Error creating fallback highlight:", fallbackError);
        }
      }
    } catch (error) {
      console.error("Error creating highlight:", error);
      // Even on error, try to create a basic highlight
      try {
        const errorAnnotation: Annotation = {
          id: `highlight_${Date.now()}`,
          type: "highlight",
          pageNumber,
          x: Math.min(selectionStart.x, finalSelectionEnd.x),
          y: Math.min(selectionStart.y, finalSelectionEnd.y),
          width: Math.abs(finalSelectionEnd.x - selectionStart.x) || 10,
          height: Math.abs(finalSelectionEnd.y - selectionStart.y) || 10,
          quads: [],
          path: [selectionStart, finalSelectionEnd],
          color: highlightColor,
          strokeWidth: highlightStrokeWidth,
          opacity: highlightOpacity,
          highlightMode: "overlay",
        };
        addAnnotation(currentDocument.getId(), errorAnnotation);
      } catch (fallbackError) {
        console.error("Error creating error fallback highlight:", fallbackError);
      }
    }

    // Always clean up state after committing
    context.setIsSelecting(false);
    context.setSelectionStart(null);
    context.setSelectionEnd(null);
    overlayPath = [];
    isOverlayMode = false;
    dragStartCoords = null;
    lockedDirection = null;
    lockedEndPoint = null;
  },
};

