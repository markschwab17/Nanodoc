/**
 * Shape Handles Component
 * 
 * Provides resize and move handles for shape annotations
 */

import { useState, useCallback } from "react";
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
  const [dragType, setDragType] = useState<"move" | "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w" | "start" | "end" | null>(null);
  const [dragStart, setDragStart] = useState<{ 
    x: number; 
    y: number; 
    annotX: number; 
    annotY: number; 
    annotW: number; 
    annotH: number;
    points?: Array<{ x: number; y: number }>;
  } | null>(null);

  if (!annotation.width || !annotation.height) return null;

  // Convert annotation bounds to canvas coordinates
  const topLeft = pdfToCanvas(annotation.x, annotation.y + annotation.height);
  const bottomRight = pdfToCanvas(annotation.x + annotation.width, annotation.y);

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
  };

  const handleMouseDown = (e: React.MouseEvent, type: typeof dragType) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
    setDragType(type);
    setDragStart({ 
      x: e.clientX, 
      y: e.clientY,
      annotX: annotation.x,
      annotY: annotation.y,
      annotW: annotation.width || 0,
      annotH: annotation.height || 0,
      points: annotation.points ? [...annotation.points] : undefined,
    });
  };

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging || !dragStart || !dragType) return;

      const screenDx = e.clientX - dragStart.x;
      const screenDy = e.clientY - dragStart.y;
      
      // Convert screen delta to PDF delta
      const pdfDx = screenDx;
      const pdfDy = -screenDy; // Flip Y axis for PDF coordinates

      if (dragType === "move") {
        // Move entire shape
        onUpdate({
          x: dragStart.annotX + pdfDx,
          y: dragStart.annotY + pdfDy,
        });
        
        // Also move arrow points if it's an arrow
        if (annotation.shapeType === "arrow" && dragStart.points) {
          onUpdate({
            x: dragStart.annotX + pdfDx,
            y: dragStart.annotY + pdfDy,
            points: dragStart.points.map(p => ({
              x: p.x + pdfDx,
              y: p.y + pdfDy,
            })),
          });
        }
      } else if (annotation.shapeType === "arrow" && dragStart.points && (dragType === "start" || dragType === "end")) {
        // Move arrow endpoints
        const points = [...dragStart.points];
        if (dragType === "start") {
          points[0] = {
            x: dragStart.points[0].x + pdfDx,
            y: dragStart.points[0].y + pdfDy,
          };
        } else if (dragType === "end") {
          points[1] = {
            x: dragStart.points[1].x + pdfDx,
            y: dragStart.points[1].y + pdfDy,
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
        let newX = dragStart.annotX;
        let newY = dragStart.annotY;
        let newWidth = dragStart.annotW;
        let newHeight = dragStart.annotH;

        if (dragType?.includes("w")) {
          newX += pdfDx;
          newWidth -= pdfDx;
        }
        if (dragType?.includes("e")) {
          newWidth += pdfDx;
        }
        if (dragType?.includes("n")) {
          newY += pdfDy;
          newHeight -= pdfDy;
        }
        if (dragType?.includes("s")) {
          newHeight -= pdfDy;
        }

        // Constrain to minimum size
        if (newWidth > 10 && newHeight > 10) {
          onUpdate({
            x: newX,
            y: newY,
            width: newWidth,
            height: newHeight,
          });
        }
      }
    },
    [isDragging, dragStart, dragType, annotation, onUpdate]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    setDragType(null);
    setDragStart(null);
  }, []);

  // Attach global mouse listeners when dragging
  useState(() => {
    if (isDragging) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      return () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
    }
  });

  if (annotation.shapeType === "arrow" && annotation.points) {
    // Arrow endpoint handles
    const start = pdfToCanvas(annotation.points[0].x, annotation.points[0].y);
    const end = pdfToCanvas(annotation.points[1].x, annotation.points[1].y);

    return (
      <>
        <div
          style={{
            ...handleStyle,
            left: `${start.x - handleSize / 2}px`,
            top: `${start.y - handleSize / 2}px`,
            cursor: "move",
          }}
          onMouseDown={(e) => handleMouseDown(e, "start")}
        />
        <div
          style={{
            ...handleStyle,
            left: `${end.x - handleSize / 2}px`,
            top: `${end.y - handleSize / 2}px`,
            cursor: "move",
          }}
          onMouseDown={(e) => handleMouseDown(e, "end")}
        />
      </>
    );
  }

  // Rectangle and circle resize handles
  const centerX = (topLeft.x + bottomRight.x) / 2;
  const centerY = (topLeft.y + bottomRight.y) / 2;

  return (
    <>
      {/* Corner handles */}
      <div
        style={{ ...handleStyle, left: `${topLeft.x - handleSize / 2}px`, top: `${topLeft.y - handleSize / 2}px`, cursor: "nw-resize" }}
        onMouseDown={(e) => handleMouseDown(e, "nw")}
      />
      <div
        style={{ ...handleStyle, left: `${bottomRight.x - handleSize / 2}px`, top: `${topLeft.y - handleSize / 2}px`, cursor: "ne-resize" }}
        onMouseDown={(e) => handleMouseDown(e, "ne")}
      />
      <div
        style={{ ...handleStyle, left: `${topLeft.x - handleSize / 2}px`, top: `${bottomRight.y - handleSize / 2}px`, cursor: "sw-resize" }}
        onMouseDown={(e) => handleMouseDown(e, "sw")}
      />
      <div
        style={{ ...handleStyle, left: `${bottomRight.x - handleSize / 2}px`, top: `${bottomRight.y - handleSize / 2}px`, cursor: "se-resize" }}
        onMouseDown={(e) => handleMouseDown(e, "se")}
      />

      {/* Edge handles */}
      <div
        style={{ ...handleStyle, left: `${centerX - handleSize / 2}px`, top: `${topLeft.y - handleSize / 2}px`, cursor: "n-resize" }}
        onMouseDown={(e) => handleMouseDown(e, "n")}
      />
      <div
        style={{ ...handleStyle, left: `${centerX - handleSize / 2}px`, top: `${bottomRight.y - handleSize / 2}px`, cursor: "s-resize" }}
        onMouseDown={(e) => handleMouseDown(e, "s")}
      />
      <div
        style={{ ...handleStyle, left: `${topLeft.x - handleSize / 2}px`, top: `${centerY - handleSize / 2}px`, cursor: "w-resize" }}
        onMouseDown={(e) => handleMouseDown(e, "w")}
      />
      <div
        style={{ ...handleStyle, left: `${bottomRight.x - handleSize / 2}px`, top: `${centerY - handleSize / 2}px`, cursor: "e-resize" }}
        onMouseDown={(e) => handleMouseDown(e, "e")}
      />

      {/* Move handle (center) */}
      <div
        style={{
          ...handleStyle,
          left: `${centerX - handleSize / 2}px`,
          top: `${centerY - handleSize / 2}px`,
          cursor: "move",
          background: "#3b82f6",
        }}
        onMouseDown={(e) => handleMouseDown(e, "move")}
      />
    </>
  );
}

