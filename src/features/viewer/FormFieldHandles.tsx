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
  zoomLevel: number;
}

export function FormFieldHandles({
  annotation,
  pdfToCanvas,
  onUpdate,
  zoomLevel,
}: FormFieldHandlesProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [dragType, setDragType] = useState<"move" | "nw" | "ne" | "sw" | "se" | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number; annotX: number; annotY: number; annotW: number; annotH: number } | null>(null);

  // Don't show handles if field is locked or missing dimensions
  const isLocked = (annotation as any).locked === true;
  const shouldShowHandles = !isLocked && annotation.width && annotation.height;

  // Convert annotation bounds to canvas coordinates
  const annotationHeight = annotation.height ?? 0;
  const annotationWidth = annotation.width ?? 0;
  const topLeft = pdfToCanvas(annotation.x, annotation.y + annotationHeight);
  const bottomRight = pdfToCanvas(annotation.x + annotationWidth, annotation.y);

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
      annotW: annotationWidth,
      annotH: annotationHeight,
    });
  };

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging || !dragStart || !dragType) return;

      // Calculate screen pixel delta
      const screenDx = e.clientX - dragStart.x;
      const screenDy = e.clientY - dragStart.y;
      
      // Convert screen delta to PDF delta using zoom level (same as RichTextEditor)
      // Divide by zoomLevel to convert screen pixels to PDF units
      const pdfDx = screenDx / zoomLevel;
      const pdfDy = -screenDy / zoomLevel; // Flip Y axis for PDF coordinates

      if (dragType === "move") {
        // Move entire field - 1:1 with mouse movement
        onUpdate({
          x: dragStart.annotX + pdfDx,
          y: dragStart.annotY + pdfDy,
        });
      } else {
        // Resize from corner - handle all 4 corners
        // Note: In PDF coordinates, Y=0 at bottom, Y increases upward
        // When dragging down on screen (positive screenDy), pdfDy is negative (moving down in PDF)
        // Height is measured from top (higher Y) to bottom (lower Y)
        let newX = dragStart.annotX;
        let newY = dragStart.annotY;
        let newWidth = dragStart.annotW;
        let newHeight = dragStart.annotH;

        switch (dragType) {
          case "nw": // Top-left - dragging right/down increases size
            newX = dragStart.annotX + pdfDx;
            newY = dragStart.annotY - pdfDy; // Move top edge up (increase Y) when dragging up
            newWidth = dragStart.annotW - pdfDx;
            newHeight = dragStart.annotH + pdfDy; // Increase height when dragging down
            break;
          case "ne": // Top-right - dragging right/down increases size
            newY = dragStart.annotY - pdfDy; // Move top edge up (increase Y) when dragging up
            newWidth = dragStart.annotW + pdfDx;
            newHeight = dragStart.annotH + pdfDy; // Increase height when dragging down
            break;
          case "sw": // Bottom-left - dragging right/up increases size
            newX = dragStart.annotX + pdfDx;
            newWidth = dragStart.annotW - pdfDx;
            newHeight = dragStart.annotH - pdfDy; // Increase height when dragging up
            break;
          case "se": // Bottom-right - dragging right/up increases size
            newWidth = dragStart.annotW + pdfDx;
            newHeight = dragStart.annotH - pdfDy; // Increase height when dragging up
            break;
        }
        
        // Constrain to minimum size
        // For checkboxes and radio buttons, allow very small sizes (2px minimum)
        // For other fields, minimum 4px to allow size 2 font
        const isCheckboxOrRadio = annotation.fieldType === "checkbox" || annotation.fieldType === "radio";
        const minSize = isCheckboxOrRadio ? 2 : 4;
        if (newWidth >= minSize && newHeight >= minSize) {
          onUpdate({
            x: newX,
            y: newY,
            width: newWidth,
            height: newHeight,
          });
        }
      }
    },
    [isDragging, dragStart, dragType, onUpdate, zoomLevel]
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
  const topMiddleX = centerX;
  const topMiddleY = topLeft.y;

  // Position move handle at top-middle for all form fields (above the field)
  const moveHandleX = topMiddleX;
  const moveHandleY = topMiddleY - handleSize / 2 - 5; // Position above the field

  if (!shouldShowHandles) return null;

  return (
    <>
      {/* Move handle (center for most fields, top-middle for checkbox/radio) */}
      <div
        style={{
          ...handleStyle,
          left: `${moveHandleX - handleSize / 2}px`,
          top: `${moveHandleY}px`,
          cursor: "move",
          background: "#3b82f6",
        }}
        onMouseDown={(e) => handleMouseDown(e, "move")}
      />

      {/* Resize handles (all 4 corners) */}
      <div
        style={{
          ...handleStyle,
          left: `${topLeft.x - handleSize / 2}px`,
          top: `${topLeft.y - handleSize / 2}px`,
          cursor: "nw-resize",
        }}
        onMouseDown={(e) => handleMouseDown(e, "nw")}
      />
      <div
        style={{
          ...handleStyle,
          left: `${bottomRight.x - handleSize / 2}px`,
          top: `${topLeft.y - handleSize / 2}px`,
          cursor: "ne-resize",
        }}
        onMouseDown={(e) => handleMouseDown(e, "ne")}
      />
      <div
        style={{
          ...handleStyle,
          left: `${topLeft.x - handleSize / 2}px`,
          top: `${bottomRight.y - handleSize / 2}px`,
          cursor: "sw-resize",
        }}
        onMouseDown={(e) => handleMouseDown(e, "sw")}
      />
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

