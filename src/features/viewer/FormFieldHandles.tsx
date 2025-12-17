/**
 * Form Field Handles Component
 * 
 * Provides resize and move handles for form field annotations
 */

import { useState, useCallback, useEffect } from "react";
import type { Annotation } from "@/core/pdf/PDFEditor";

interface FormFieldHandlesProps {
  annotation: Annotation;
  pdfToCanvas: (pdfX: number, pdfY: number) => { x: number; y: number };
  onUpdate: (updates: Partial<Annotation>) => void;
}

export function FormFieldHandles({
  annotation,
  pdfToCanvas,
  onUpdate,
}: FormFieldHandlesProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [dragType, setDragType] = useState<"move" | "se" | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number; annotX: number; annotY: number; annotW: number; annotH: number } | null>(null);

  if (!annotation.width || !annotation.height) return null;

  // Convert annotation bounds to canvas coordinates
  const topLeft = pdfToCanvas(annotation.x, annotation.y + annotation.height);
  const bottomRight = pdfToCanvas(annotation.x + annotation.width, annotation.y);

  const handleSize = 8;
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
      annotW: annotation.width,
      annotH: annotation.height,
    });
  };

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging || !dragStart || !dragType) return;

      // Calculate pixel delta
      const screenDx = e.clientX - dragStart.x;
      const screenDy = e.clientY - dragStart.y;
      
      // Convert screen delta to PDF delta (assuming 1:1 scale at base)
      const pdfDx = screenDx;
      const pdfDy = -screenDy; // Flip Y axis for PDF coordinates

      if (dragType === "move") {
        // Move entire field
        onUpdate({
          x: dragStart.annotX + pdfDx,
          y: dragStart.annotY + pdfDy,
        });
      } else if (dragType === "se") {
        // Resize from bottom-right corner
        const newWidth = dragStart.annotW + pdfDx;
        const newHeight = dragStart.annotH - pdfDy; // Subtract because Y is flipped
        
        // Constrain to minimum size
        if (newWidth > 20 && newHeight > 20) {
          onUpdate({
            width: newWidth,
            height: newHeight,
          });
        }
      }
    },
    [isDragging, dragStart, dragType, onUpdate]
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

  const centerX = (topLeft.x + bottomRight.x) / 2;
  const centerY = (topLeft.y + bottomRight.y) / 2;

  return (
    <>
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

      {/* Resize handle (bottom-right corner) */}
      <div
        style={{
          ...handleStyle,
          left: `${bottomRight.x - handleSize / 2}px`,
          top: `${bottomRight.y - handleSize / 2}px`,
          cursor: "se-resize",
        }}
        onMouseDown={(e) => handleMouseDown(e, "se")}
      />
    </>
  );
}

