/**
 * Shape Handles Component
 * 
 * Provides resize and move handles for shape annotations
 */

import { useState, useCallback, useEffect } from "react";
import type { Annotation } from "@/core/pdf/PDFEditor";

interface ShapeHandlesProps {
  annotation: Annotation;
  pdfToCanvas: (pdfX: number, pdfY: number) => { x: number; y: number };
  onUpdate: (updates: Partial<Annotation>) => void;
  zoomLevel: number;
}

export function ShapeHandles({
  annotation,
  pdfToCanvas,
  onUpdate,
  zoomLevel,
}: ShapeHandlesProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [dragType, setDragType] = useState<"move" | "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w" | "start" | "end" | "rotate" | null>(null);
  const [dragStart, setDragStart] = useState<{ 
    x: number; 
    y: number; 
    annotX: number; 
    annotY: number; 
    annotW: number; 
    annotH: number;
    rotation?: number;
    centerX?: number;
    centerY?: number;
    points?: Array<{ x: number; y: number }>;
  } | null>(null);

  const handleSize = 8 / zoomLevel; // Scale handle size with zoom
  const handleStyle = {
    width: `${handleSize}px`,
    height: `${handleSize}px`,
    background: "white",
    border: "2px solid #3b82f6",
    borderRadius: "50%",
    position: "absolute" as const,
    cursor: "pointer",
    zIndex: 1001,
    pointerEvents: "auto" as const,
  };
  
  // For arrows, we handle them specially (they use points, not width/height)
  if (annotation.shapeType === "arrow" && annotation.points) {
    // Arrow endpoint handles - handle this case first
    const start = pdfToCanvas(annotation.points[0].x, annotation.points[0].y);
    const end = pdfToCanvas(annotation.points[1].x, annotation.points[1].y);
    
    // Calculate bounding box for relative positioning
    const minX = Math.min(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxX = Math.max(start.x, end.x);
    const maxY = Math.max(start.y, end.y);
    
    // Position handles relative to the bounding box
    const startX = start.x - minX;
    const startY = start.y - minY;
    const endX = end.x - minX;
    const endY = end.y - minY;

    return (
      <div
        style={{
          position: "absolute",
          left: `${minX}px`,
          top: `${minY}px`,
          width: `${maxX - minX}px`,
          height: `${maxY - minY}px`,
          pointerEvents: "none",
          zIndex: 1000,
        }}
      >
        <div
          data-shape-handle="start"
          style={{
            ...handleStyle,
            left: `${startX - handleSize / 2}px`,
            top: `${startY - handleSize / 2}px`,
            cursor: "move",
            pointerEvents: "auto",
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
            handleMouseDown(e, "start");
          }}
        />
        <div
          data-shape-handle="end"
          style={{
            ...handleStyle,
            left: `${endX - handleSize / 2}px`,
            top: `${endY - handleSize / 2}px`,
            cursor: "move",
            pointerEvents: "auto",
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
            handleMouseDown(e, "end");
          }}
        />
      </div>
    );
  }
  
  // For rectangles and circles, require width/height
  if (!annotation.width || !annotation.height) return null;

  // Convert annotation bounds to canvas coordinates
  const topLeft = pdfToCanvas(annotation.x, annotation.y + annotation.height);
  const bottomRight = pdfToCanvas(annotation.x + annotation.width, annotation.y);

  const handleMouseDown = (e: React.MouseEvent, type: typeof dragType) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
    setDragType(type);
    const centerX = annotation.x + (annotation.width || 0) / 2;
    const centerY = annotation.y + (annotation.height || 0) / 2;
    setDragStart({ 
      x: e.clientX, 
      y: e.clientY,
      annotX: annotation.x,
      annotY: annotation.y,
      annotW: annotation.width || 0,
      annotH: annotation.height || 0,
      rotation: annotation.rotation || 0,
      centerX,
      centerY,
      points: annotation.points ? [...annotation.points] : undefined,
    });
  };

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging || !dragStart || !dragType) return;

      const screenDx = e.clientX - dragStart.x;
      const screenDy = e.clientY - dragStart.y;
      
      // Convert screen delta to PDF delta, accounting for zoom
      const pdfDx = screenDx / zoomLevel;
      // For resize operations, we want intuitive behavior:
      // - Dragging right (positive screenDx) increases width
      // - Dragging down (positive screenDy) increases height
      // So we don't flip Y for resize operations
      const pdfDyForResize = screenDy / zoomLevel;
      // For move operations, we need to flip Y because PDF Y increases upward
      const pdfDyForMove = -screenDy / zoomLevel;

      if (dragType === "rotate" && dragStart.centerX !== undefined && dragStart.centerY !== undefined && dragStart.rotation !== undefined) {
        // Rotation for rectangles
        const centerCanvas = pdfToCanvas(dragStart.centerX, dragStart.centerY);
        const currentAngle = Math.atan2(e.clientY - centerCanvas.y, e.clientX - centerCanvas.x);
        const startAngle = Math.atan2(dragStart.y - centerCanvas.y, dragStart.x - centerCanvas.x);
        // Calculate delta angle - positive when moving clockwise
        const deltaAngle = currentAngle - startAngle;
        const newRotation = (dragStart.rotation + deltaAngle) % (2 * Math.PI);
        
        onUpdate({
          rotation: newRotation,
        });
      } else if (dragType === "move") {
        // Move entire shape
        if (annotation.shapeType === "arrow" && dragStart.points) {
          // Move arrow points
          const newPoints = dragStart.points.map(p => ({
            x: p.x + pdfDx,
            y: p.y + pdfDyForMove,
          }));
          
          // Update bounding box
          const minX = Math.min(newPoints[0].x, newPoints[1].x);
          const maxX = Math.max(newPoints[0].x, newPoints[1].x);
          const minY = Math.min(newPoints[0].y, newPoints[1].y);
          const maxY = Math.max(newPoints[0].y, newPoints[1].y);
          
          onUpdate({
            points: newPoints,
            x: minX,
            y: minY,
            width: maxX - minX,
            height: maxY - minY,
          });
        } else {
          // Move rectangle/circle
          onUpdate({
            x: dragStart.annotX + pdfDx,
            y: dragStart.annotY + pdfDyForMove,
          });
        }
      } else if (annotation.shapeType === "arrow" && dragStart.points && (dragType === "start" || dragType === "end")) {
        // Move arrow endpoints
        const points = [...dragStart.points];
        if (dragType === "start") {
          points[0] = {
            x: dragStart.points[0].x + pdfDx,
            y: dragStart.points[0].y + pdfDyForMove,
          };
        } else if (dragType === "end") {
          points[1] = {
            x: dragStart.points[1].x + pdfDx,
            y: dragStart.points[1].y + pdfDyForMove,
          };
        }
        
        // Update bounding box
        const minX = Math.min(points[0].x, points[1].x);
        const maxX = Math.max(points[0].x, points[1].x);
        const minY = Math.min(points[0].y, points[1].y);
        const maxY = Math.max(points[0].y, points[1].y);
        
        onUpdate({
          points,
          x: minX,
          y: minY,
          width: maxX - minX,
          height: maxY - minY,
        });
      } else {
        // Resize handles for rectangles and circles
        // In PDF coordinates: annotation.y is bottom edge, annotation.y + height is top edge
        // Each corner handle pins the opposite corner
        let newX = dragStart.annotX;
        let newY = dragStart.annotY;
        let newWidth = dragStart.annotW;
        let newHeight = dragStart.annotH;

        // Handle corner drags - each corner pins the opposite corner
        // In PDF coordinates: y is bottom edge, y + height is top edge
        if (dragType === "nw") {
          // Top-left corner - pin bottom-right corner
          // Bottom-right in PDF: (x + width, y)
          const pinnedBottomRightX = dragStart.annotX + dragStart.annotW;
          const pinnedBottomRightY = dragStart.annotY;
          
          // Top-left corner in PDF is at (x, y + height)
          // When dragging, the new top-left position is:
          const newTopLeftX = dragStart.annotX + pdfDx;
          const newTopLeftY = dragStart.annotY + dragStart.annotH - pdfDyForResize; // Dragging down decreases top Y
          
          // Calculate new bottom-left position and dimensions from pinned corner
          newX = newTopLeftX;
          newY = pinnedBottomRightY;
          newWidth = pinnedBottomRightX - newTopLeftX;
          newHeight = newTopLeftY - pinnedBottomRightY;
        } else if (dragType === "ne") {
          // Top-right corner - pin bottom-left corner
          // Bottom-left in PDF: (x, y)
          const pinnedBottomLeftX = dragStart.annotX;
          const pinnedBottomLeftY = dragStart.annotY;
          
          // Top-right corner in PDF is at (x + width, y + height)
          // When dragging, the new top-right position is:
          const newTopRightX = dragStart.annotX + dragStart.annotW + pdfDx;
          const newTopRightY = dragStart.annotY + dragStart.annotH - pdfDyForResize; // Dragging down decreases top Y
          
          // Calculate new position and dimensions from pinned corner
          newX = pinnedBottomLeftX;
          newY = pinnedBottomLeftY;
          newWidth = newTopRightX - pinnedBottomLeftX;
          newHeight = newTopRightY - pinnedBottomLeftY;
        } else if (dragType === "sw") {
          // Bottom-left corner - pin top-right corner
          // Top-right in PDF: (x + width, y + height)
          const pinnedTopRightX = dragStart.annotX + dragStart.annotW;
          const pinnedTopRightY = dragStart.annotY + dragStart.annotH;
          
          // Bottom-left corner in PDF is at (x, y)
          // When dragging down on screen (positive screenDy), we move toward smaller Y in PDF
          // So we need to flip: dragging down = decreasing Y in PDF
          // But pdfDyForResize is positive when dragging down, so we subtract it
          const newBottomLeftX = dragStart.annotX + pdfDx;
          const newBottomLeftY = dragStart.annotY - pdfDyForResize; // Dragging down decreases bottom Y in PDF
          
          // Calculate new position and dimensions from pinned corner
          // Width: distance from new left to pinned right
          newWidth = pinnedTopRightX - newBottomLeftX;
          // Height: distance from new bottom to pinned top (top Y - bottom Y)
          newHeight = pinnedTopRightY - newBottomLeftY;
          // Position: new bottom-left corner
          newX = newBottomLeftX;
          newY = newBottomLeftY;
        } else if (dragType === "se") {
          // Bottom-right corner - pin top-left corner
          // Top-left in PDF: (x, y + height)
          const pinnedTopLeftX = dragStart.annotX;
          const pinnedTopLeftY = dragStart.annotY + dragStart.annotH;
          
          // Bottom-right corner in PDF is at (x + width, y)
          // When dragging down on screen (positive screenDy), we move toward smaller Y in PDF
          // So we need to flip: dragging down = decreasing Y in PDF
          const newBottomRightX = dragStart.annotX + dragStart.annotW + pdfDx;
          const newBottomRightY = dragStart.annotY - pdfDyForResize; // Dragging down decreases bottom Y in PDF
          
          // Calculate new position and dimensions from pinned corner
          // Position: keep top-left pinned, so bottom-left is at (pinnedX, newBottomY)
          newX = pinnedTopLeftX;
          newY = newBottomRightY;
          // Width: distance from pinned left to new right
          newWidth = newBottomRightX - pinnedTopLeftX;
          // Height: distance from new bottom to pinned top (top Y - bottom Y)
          newHeight = pinnedTopLeftY - newBottomRightY;
        } else {
          // Handle edge drags - pin the opposite edge
          if (dragType === "e") {
            // Right edge - pin left edge
            newX = dragStart.annotX;
            newY = dragStart.annotY;
            newWidth = dragStart.annotW + pdfDx;
            newHeight = dragStart.annotH;
          } else if (dragType === "w") {
            // Left edge - pin right edge
            const pinnedRightX = dragStart.annotX + dragStart.annotW;
            newX = dragStart.annotX + pdfDx;
            newY = dragStart.annotY;
            newWidth = pinnedRightX - newX;
            newHeight = dragStart.annotH;
          } else if (dragType === "s") {
            // Bottom edge - pin top edge
            const pinnedTopY = dragStart.annotY + dragStart.annotH;
            newX = dragStart.annotX;
            newY = dragStart.annotY + pdfDyForResize;
            newWidth = dragStart.annotW;
            newHeight = pinnedTopY - newY;
          } else if (dragType === "n") {
            // Top edge - pin bottom edge
            newX = dragStart.annotX;
            newY = dragStart.annotY;
            newWidth = dragStart.annotW;
            newHeight = dragStart.annotH - pdfDyForResize;
          }
        }

        // For circles, maintain aspect ratio
        if (annotation.shapeType === "circle") {
          const size = Math.max(Math.abs(newWidth), Math.abs(newHeight));
          newWidth = size;
          newHeight = size;
          
          // Recalculate position based on which handle was dragged
          if (dragType === "nw") {
            // Top-left dragged - pin bottom-right
            newX = (dragStart.annotX + dragStart.annotW) - newWidth;
            newY = dragStart.annotY;
          } else if (dragType === "ne") {
            // Top-right dragged - pin bottom-left
            newX = dragStart.annotX;
            newY = dragStart.annotY;
          } else if (dragType === "sw") {
            // Bottom-left dragged - pin top-right
            newX = (dragStart.annotX + dragStart.annotW) - newWidth;
            newY = (dragStart.annotY + dragStart.annotH) - newHeight;
          } else if (dragType === "se") {
            // Bottom-right dragged - pin top-left
            newX = dragStart.annotX;
            newY = (dragStart.annotY + dragStart.annotH) - newHeight;
          } else if (dragType === "e" || dragType === "w") {
            // Horizontal edge - maintain center Y, adjust X based on width change
            const centerX = dragStart.annotX + dragStart.annotW / 2;
            newX = centerX - newWidth / 2;
            // Y stays the same for horizontal edges
          } else if (dragType === "n" || dragType === "s") {
            // Vertical edge - maintain center X, adjust Y based on height change
            const centerY = dragStart.annotY + dragStart.annotH / 2;
            newY = centerY - newHeight / 2;
            // X stays the same for vertical edges
          }
        }

        // Constrain to minimum size
        const minSize = annotation.shapeType === "circle" ? 10 : 10;
        if (Math.abs(newWidth) > minSize && Math.abs(newHeight) > minSize) {
          onUpdate({
            x: newX,
            y: newY,
            width: Math.abs(newWidth),
            height: Math.abs(newHeight),
          });
        }
      }
    },
    [isDragging, dragStart, dragType, annotation, onUpdate, zoomLevel, pdfToCanvas]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    setDragType(null);
    setDragStart(null);
  }, []);

  // Attach global mouse listeners when dragging
  useEffect(() => {
    if (isDragging) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      return () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);


  // Rectangle and circle resize handles
  const centerX = (topLeft.x + bottomRight.x) / 2;
  const centerY = (topLeft.y + bottomRight.y) / 2;
  const rotation = annotation.rotation || 0;

  // Calculate handle positions relative to center for rotation
  const halfWidth = (bottomRight.x - topLeft.x) / 2;
  const halfHeight = (bottomRight.y - topLeft.y) / 2;

  // Rotate handle positions around center
  const rotatePoint = (x: number, y: number, centerX: number, centerY: number, angle: number) => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = x - centerX;
    const dy = y - centerY;
    return {
      x: centerX + dx * cos - dy * sin,
      y: centerY + dx * sin + dy * cos,
    };
  };

  // Corner positions (relative to center, before rotation)
  const corners = {
    nw: { x: centerX - halfWidth, y: centerY - halfHeight },
    ne: { x: centerX + halfWidth, y: centerY - halfHeight },
    sw: { x: centerX - halfWidth, y: centerY + halfHeight },
    se: { x: centerX + halfWidth, y: centerY + halfHeight },
  };

  // Edge positions (relative to center, before rotation)
  const edges = {
    n: { x: centerX, y: centerY - halfHeight },
    s: { x: centerX, y: centerY + halfHeight },
    w: { x: centerX - halfWidth, y: centerY },
    e: { x: centerX + halfWidth, y: centerY },
  };

  // Rotation handle position (above top edge)
  const rotHandle = { x: centerX, y: centerY - halfHeight - 20 };

  // Apply rotation to all handle positions
  const rotatedCorners = {
    nw: rotatePoint(corners.nw.x, corners.nw.y, centerX, centerY, rotation),
    ne: rotatePoint(corners.ne.x, corners.ne.y, centerX, centerY, rotation),
    sw: rotatePoint(corners.sw.x, corners.sw.y, centerX, centerY, rotation),
    se: rotatePoint(corners.se.x, corners.se.y, centerX, centerY, rotation),
  };

  const rotatedEdges = {
    n: rotatePoint(edges.n.x, edges.n.y, centerX, centerY, rotation),
    s: rotatePoint(edges.s.x, edges.s.y, centerX, centerY, rotation),
    w: rotatePoint(edges.w.x, edges.w.y, centerX, centerY, rotation),
    e: rotatePoint(edges.e.x, edges.e.y, centerX, centerY, rotation),
  };

  const rotatedRotHandle = rotatePoint(rotHandle.x, rotHandle.y, centerX, centerY, rotation);

  return (
    <>
      {/* Corner handles */}
      <div
        data-shape-handle="true"
        style={{ ...handleStyle, left: `${rotatedCorners.nw.x - handleSize / 2}px`, top: `${rotatedCorners.nw.y - handleSize / 2}px`, cursor: "nw-resize" }}
        onMouseDown={(e) => {
          e.stopPropagation();
          handleMouseDown(e, "nw");
        }}
      />
      <div
        data-shape-handle="true"
        style={{ ...handleStyle, left: `${rotatedCorners.ne.x - handleSize / 2}px`, top: `${rotatedCorners.ne.y - handleSize / 2}px`, cursor: "ne-resize" }}
        onMouseDown={(e) => {
          e.stopPropagation();
          handleMouseDown(e, "ne");
        }}
      />
      <div
        data-shape-handle="true"
        style={{ ...handleStyle, left: `${rotatedCorners.sw.x - handleSize / 2}px`, top: `${rotatedCorners.sw.y - handleSize / 2}px`, cursor: "sw-resize" }}
        onMouseDown={(e) => {
          e.stopPropagation();
          handleMouseDown(e, "sw");
        }}
      />
      <div
        data-shape-handle="true"
        style={{ ...handleStyle, left: `${rotatedCorners.se.x - handleSize / 2}px`, top: `${rotatedCorners.se.y - handleSize / 2}px`, cursor: "se-resize" }}
        onMouseDown={(e) => {
          e.stopPropagation();
          handleMouseDown(e, "se");
        }}
      />

      {/* Edge handles */}
      <div
        data-shape-handle="true"
        style={{ ...handleStyle, left: `${rotatedEdges.n.x - handleSize / 2}px`, top: `${rotatedEdges.n.y - handleSize / 2}px`, cursor: "n-resize" }}
        onMouseDown={(e) => {
          e.stopPropagation();
          handleMouseDown(e, "n");
        }}
      />
      <div
        data-shape-handle="true"
        style={{ ...handleStyle, left: `${rotatedEdges.s.x - handleSize / 2}px`, top: `${rotatedEdges.s.y - handleSize / 2}px`, cursor: "s-resize" }}
        onMouseDown={(e) => {
          e.stopPropagation();
          handleMouseDown(e, "s");
        }}
      />
      <div
        data-shape-handle="true"
        style={{ ...handleStyle, left: `${rotatedEdges.w.x - handleSize / 2}px`, top: `${rotatedEdges.w.y - handleSize / 2}px`, cursor: "w-resize" }}
        onMouseDown={(e) => {
          e.stopPropagation();
          handleMouseDown(e, "w");
        }}
      />
      <div
        data-shape-handle="true"
        style={{ ...handleStyle, left: `${rotatedEdges.e.x - handleSize / 2}px`, top: `${rotatedEdges.e.y - handleSize / 2}px`, cursor: "e-resize" }}
        onMouseDown={(e) => {
          e.stopPropagation();
          handleMouseDown(e, "e");
        }}
      />

      {/* Rotation handle (only for rectangles) */}
      {annotation.shapeType === "rectangle" && (
        <div
          data-shape-handle="true"
          style={{
            ...handleStyle,
            left: `${rotatedRotHandle.x - handleSize / 2}px`,
            top: `${rotatedRotHandle.y - handleSize / 2}px`,
            cursor: "grab",
            background: "#10b981",
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
            handleMouseDown(e, "rotate");
          }}
        />
      )}

      {/* Move handle (center) */}
      <div
        data-shape-handle="true"
        style={{
          ...handleStyle,
          left: `${centerX - handleSize / 2}px`,
          top: `${centerY - handleSize / 2}px`,
          cursor: "move",
          background: "#3b82f6",
          zIndex: 1002, // Ensure move handle is on top
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
          handleMouseDown(e, "move");
        }}
      />
    </>
  );
}

