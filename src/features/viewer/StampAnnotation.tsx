/**
 * Stamp Annotation Component
 * 
 * Renders stamp annotations with move, resize, and rotate capabilities
 * Similar to ImageAnnotation but for stamps
 */

import { useRef, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { Annotation } from "@/core/pdf/PDFEditor";
import { useUIStore } from "@/shared/stores/uiStore";

interface StampAnnotationProps {
  annotation: Annotation;
  style?: React.CSSProperties;
  scale: number;
  onResize?: (width: number, height: number) => void;
  onResizeWithPosition?: (x: number, y: number, width: number, height: number) => void;
  onResizeEnd?: () => void;
  onRotate?: (angle: number) => void;
  onRotateEnd?: () => void;
  onMove?: (x: number, y: number) => void;
  onDragEnd?: () => void;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  isSelected?: boolean;
  isHovered?: boolean;
  activeTool?: string;
  isSpacePressed?: boolean;
}

export function StampAnnotation({
  annotation,
  style,
  scale: _scale,
  onResize,
  onResizeWithPosition,
  onResizeEnd,
  onRotate,
  onRotateEnd,
  onMove,
  onDragEnd,
  onClick,
  onDoubleClick,
  onMouseEnter,
  onMouseLeave,
  isSelected = false,
  isHovered = false,
  activeTool,
  isSpacePressed = false,
}: StampAnnotationProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [resizeCorner, setResizeCorner] = useState<string | null>(null);
  const [rotationStart, setRotationStart] = useState({ x: 0, y: 0, angle: 0, centerX: 0, centerY: 0, startAngle: 0 });
  const dragStartRef = useRef({ x: 0, y: 0 });
  const resizeStartRef = useRef({ 
    x: 0, 
    y: 0, 
    width: 0, 
    height: 0 
  });
  const { zoomLevel } = useUIStore();

  const width = annotation.width || 100;
  const height = annotation.height || 60;
  const rotation = annotation.rotation || 0;

  // Rotation handle
  const handleRotationMouseDown = (e: React.MouseEvent) => {
    if (activeTool !== "select" || isSpacePressed) return;
    e.preventDefault();
    e.stopPropagation();

    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // Calculate the starting angle from mouse position
    const startAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX) * (180 / Math.PI);

    setIsRotating(true);
    setRotationStart({
      x: e.clientX,
      y: e.clientY,
      angle: rotation, // Current rotation of the stamp
      centerX,
      centerY,
      startAngle, // Angle when drag started
    });
  };

  // Resize handles
  const handleResizeMouseDown = (e: React.MouseEvent, corner: string) => {
    if (activeTool !== "select" || isSpacePressed) return;
    e.preventDefault();
    e.stopPropagation();

    setIsResizing(true);
    setResizeCorner(corner);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    // Store initial position and size for corner pinning
    // Use annotation values directly to ensure we have the current state
    resizeStartRef.current = {
      x: annotation.x,
      y: annotation.y,
      width: annotation.width || 100,
      height: annotation.height || 60,
    };
  };

  // Drag to move
  const handleDragMouseDown = (e: React.MouseEvent) => {
    if (activeTool !== "select" || isSpacePressed) return;
    if (isResizing || isRotating) return;

    e.preventDefault();
    e.stopPropagation();

    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
  };

  // Global mouse move handler
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isRotating && onRotate) {
        // Calculate current angle from center to mouse
        const currentAngle = Math.atan2(
          e.clientY - rotationStart.centerY,
          e.clientX - rotationStart.centerX
        ) * (180 / Math.PI);
        
        // Delta from start angle - the handle follows the cursor
        const deltaAngle = currentAngle - rotationStart.startAngle;
        
        // Add delta to original rotation
        let newRotation = rotationStart.angle + deltaAngle;
        
        // Normalize to 0-360
        while (newRotation < 0) newRotation += 360;
        while (newRotation >= 360) newRotation -= 360;
        
        onRotate(newRotation);
      } else if (isResizing && resizeCorner && (onResize || onResizeWithPosition)) {
        const screenDeltaX = e.clientX - dragStartRef.current.x;
        const screenDeltaY = e.clientY - dragStartRef.current.y;
        
        // Convert screen pixel deltas to PDF coordinate deltas
        const pdfDx = screenDeltaX / zoomLevel;
        const pdfDyForResize = screenDeltaY / zoomLevel; // Don't flip Y for resize (same as ShapeHandles)
        
        // Calculate new position and size based on which corner is dragged
        // Each corner pins the opposite corner (same as rectangle resize)
        // In PDF coordinates: annotation.y is bottom edge, annotation.y + height is top edge
        let newX = resizeStartRef.current.x;
        let newY = resizeStartRef.current.y;
        let newWidth = resizeStartRef.current.width;
        let newHeight = resizeStartRef.current.height;
        
        if (resizeCorner === "nw") {
          // Top-left corner - pin bottom-right corner
          // Bottom-right in PDF: (x + width, y)
          const pinnedBottomRightX = resizeStartRef.current.x + resizeStartRef.current.width;
          const pinnedBottomRightY = resizeStartRef.current.y;
          
          // Top-left corner in PDF is at (x, y + height)
          // When dragging, the new top-left position is:
          const newTopLeftX = resizeStartRef.current.x + pdfDx;
          const newTopLeftY = resizeStartRef.current.y + resizeStartRef.current.height - pdfDyForResize; // Dragging down decreases top Y
          
          // Calculate new position and dimensions from pinned corner
          newX = newTopLeftX;
          newY = pinnedBottomRightY;
          newWidth = pinnedBottomRightX - newTopLeftX;
          newHeight = newTopLeftY - pinnedBottomRightY;
        } else if (resizeCorner === "ne") {
          // Top-right corner - pin bottom-left corner
          const pinnedBottomLeftX = resizeStartRef.current.x;
          const pinnedBottomLeftY = resizeStartRef.current.y;
          
          // Top-right corner in PDF is at (x + width, y + height)
          const newTopRightX = resizeStartRef.current.x + resizeStartRef.current.width + pdfDx;
          const newTopRightY = resizeStartRef.current.y + resizeStartRef.current.height - pdfDyForResize; // Dragging down decreases top Y
          
          newX = pinnedBottomLeftX;
          newY = pinnedBottomLeftY;
          newWidth = newTopRightX - pinnedBottomLeftX;
          newHeight = newTopRightY - pinnedBottomLeftY;
        } else if (resizeCorner === "sw") {
          // Bottom-left corner - pin top-right corner
          const pinnedTopRightX = resizeStartRef.current.x + resizeStartRef.current.width;
          const pinnedTopRightY = resizeStartRef.current.y + resizeStartRef.current.height;
          
          // Bottom-left corner in PDF is at (x, y)
          // Dragging down decreases bottom Y in PDF
          const newBottomLeftX = resizeStartRef.current.x + pdfDx;
          const newBottomLeftY = resizeStartRef.current.y - pdfDyForResize; // Dragging down decreases bottom Y in PDF
          
          newX = newBottomLeftX;
          newY = newBottomLeftY;
          newWidth = pinnedTopRightX - newBottomLeftX;
          newHeight = pinnedTopRightY - newBottomLeftY;
        } else if (resizeCorner === "se") {
          // Bottom-right corner - pin top-left corner
          const pinnedTopLeftX = resizeStartRef.current.x;
          const pinnedTopLeftY = resizeStartRef.current.y + resizeStartRef.current.height;
          
          // Bottom-right corner in PDF is at (x + width, y)
          // Dragging down decreases bottom Y in PDF
          const newBottomRightX = resizeStartRef.current.x + resizeStartRef.current.width + pdfDx;
          const newBottomRightY = resizeStartRef.current.y - pdfDyForResize; // Dragging down decreases bottom Y in PDF
          
          newX = pinnedTopLeftX;
          newY = newBottomRightY;
          newWidth = newBottomRightX - pinnedTopLeftX;
          newHeight = pinnedTopLeftY - newBottomRightY;
        }
        
        // Ensure width and height are positive, adjusting position if needed
        if (newWidth < 0) {
          newX += newWidth;
          newWidth = -newWidth;
        }
        if (newHeight < 0) {
          newY += newHeight;
          newHeight = -newHeight;
        }
        
        // Allow any positive size - no minimum or maximum constraints
        // Use onResizeWithPosition if available (for corner pinning), otherwise fall back to onResize
        if (onResizeWithPosition) {
          onResizeWithPosition(newX, newY, newWidth, newHeight);
        } else if (onResize) {
          // Fallback: only update size (old behavior)
          onResize(newWidth, newHeight);
        }
        
        // Don't update dragStartRef during resize - always calculate from initial position
        // This prevents "wiggling" by keeping a fixed reference point
      } else if (isDragging && onMove) {
        const screenDeltaX = e.clientX - dragStartRef.current.x;
        const screenDeltaY = e.clientY - dragStartRef.current.y;
        
        // Convert screen pixel deltas to PDF coordinate deltas
        // pdfDelta = screenDelta / zoomLevel (same as ImageAnnotation)
        const pdfDeltaX = screenDeltaX / zoomLevel;
        const pdfDeltaY = -screenDeltaY / zoomLevel; // Flip Y for PDF coordinates

        onMove(pdfDeltaX, pdfDeltaY);
        dragStartRef.current = { x: e.clientX, y: e.clientY };
      }
    };

    const handleMouseUp = () => {
      if (isRotating) {
        setIsRotating(false);
        if (onRotateEnd) onRotateEnd();
      } else if (isResizing) {
        setIsResizing(false);
        setResizeCorner(null);
        if (onResizeEnd) onResizeEnd();
      } else if (isDragging) {
        setIsDragging(false);
        if (onDragEnd) onDragEnd();
      }
    };

    if (isResizing || isRotating || isDragging) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      return () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
    }
  }, [isResizing, isRotating, isDragging, onResize, onResizeWithPosition, onRotate, onMove, onResizeEnd, onRotateEnd, onDragEnd, resizeCorner, rotationStart, width, height, zoomLevel]);

  const handleSize = 8;
  const rotationHandleDistance = 40;

  return (
    <div
      ref={containerRef}
      data-annotation-id={annotation.id}
      className={cn(
        "absolute select-none",
        isDragging && "cursor-move",
        isResizing && "cursor-nwse-resize",
        activeTool === "select" && !isResizing && !isRotating && !isDragging && "cursor-move"
      )}
      style={{
        ...style,
        pointerEvents: (activeTool === "select" || activeTool === "selectText") ? "auto" : "none", // Disable interaction when non-select tools are active
        width: `${width}px`,
        height: `${height}px`,
        transform: `rotate(${rotation}deg)`,
        transformOrigin: "center",
      }}
      onMouseDown={handleDragMouseDown}
      onClick={onClick}
      onDoubleClick={(e) => {
        // Allow double-click editing for text stamps
        if (annotation.stampData?.type === "text" && onDoubleClick) {
          e.preventDefault();
          e.stopPropagation();
          onDoubleClick();
        }
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Stamp content */}
      <div 
        className="w-full h-full flex items-center justify-center overflow-hidden"
        style={{
          position: "relative",
        }}
      >
        {annotation.stampData?.thumbnail ? (
          <img
            src={annotation.stampData.thumbnail}
            alt={annotation.stampData.name || "Stamp"}
            style={{ 
              width: "100%",
              height: "100%",
              imageRendering: "auto",
              objectFit: "contain",
            }}
          />
        ) : annotation.stampData?.type === "text" && annotation.stampData.text ? (
          <div
            className="text-center flex items-center justify-center"
            style={{
              color: annotation.stampData.textColor || "#000000",
              fontFamily: annotation.stampData.font || "Arial",
              fontSize: `${Math.min(width, height) * 0.4}px`,
              padding: annotation.stampData.borderOffset !== undefined ? `${8 + annotation.stampData.borderOffset}px` : "8px",
              borderRadius: annotation.stampData.borderStyle === "rounded" ? "8px" : "0px",
              border: annotation.stampData.borderEnabled 
                ? `${annotation.stampData.borderThickness || 2}px solid ${annotation.stampData.borderColor || "#000000"}` 
                : "none",
              backgroundColor: annotation.stampData.backgroundEnabled && annotation.stampData.backgroundColor
                ? (() => {
                    const r = parseInt(annotation.stampData.backgroundColor.slice(1, 3), 16);
                    const g = parseInt(annotation.stampData.backgroundColor.slice(3, 5), 16);
                    const b = parseInt(annotation.stampData.backgroundColor.slice(5, 7), 16);
                    const opacity = annotation.stampData.backgroundOpacity !== undefined ? annotation.stampData.backgroundOpacity / 100 : 1;
                    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
                  })()
                : "transparent",
              whiteSpace: "pre-line",
            }}
          >
            {annotation.stampData.text}
          </div>
        ) : (
          <div className="text-sm text-gray-400">
            {annotation.stampData?.name || "Stamp"}
          </div>
        )}
      </div>

      {/* Resize and rotation handles - only when selected */}
      {isSelected && activeTool === "select" && !isSpacePressed && (
        <>
          {/* Corner resize handles */}
          <div
            className="absolute bg-white border-2 border-blue-500 rounded-full cursor-nw-resize"
            style={{
              width: `${handleSize}px`,
              height: `${handleSize}px`,
              left: `-${handleSize / 2}px`,
              top: `-${handleSize / 2}px`,
            }}
            onMouseDown={(e) => handleResizeMouseDown(e, "nw")}
          />
          <div
            className="absolute bg-white border-2 border-blue-500 rounded-full cursor-ne-resize"
            style={{
              width: `${handleSize}px`,
              height: `${handleSize}px`,
              right: `-${handleSize / 2}px`,
              top: `-${handleSize / 2}px`,
            }}
            onMouseDown={(e) => handleResizeMouseDown(e, "ne")}
          />
          <div
            className="absolute bg-white border-2 border-blue-500 rounded-full cursor-sw-resize"
            style={{
              width: `${handleSize}px`,
              height: `${handleSize}px`,
              left: `-${handleSize / 2}px`,
              bottom: `-${handleSize / 2}px`,
            }}
            onMouseDown={(e) => handleResizeMouseDown(e, "sw")}
          />
          <div
            className="absolute bg-white border-2 border-blue-500 rounded-full cursor-se-resize"
            style={{
              width: `${handleSize}px`,
              height: `${handleSize}px`,
              right: `-${handleSize / 2}px`,
              bottom: `-${handleSize / 2}px`,
            }}
            onMouseDown={(e) => handleResizeMouseDown(e, "se")}
          />

          {/* Rotation handle */}
          <div
            className="absolute cursor-grab active:cursor-grabbing"
            style={{
              left: "50%",
              top: `-${rotationHandleDistance}px`,
              transform: "translateX(-50%)",
              width: `${handleSize}px`,
              height: `${handleSize}px`,
            }}
            onMouseDown={handleRotationMouseDown}
          >
            <div className="w-full h-full bg-blue-500 border-2 border-blue-600 rounded-full" />
            <div
              className="absolute border-l-2 border-dashed border-blue-400"
              style={{
                left: "50%",
                top: `${handleSize}px`,
                height: `${rotationHandleDistance - handleSize}px`,
                transform: "translateX(-50%)",
              }}
            />
          </div>

          {/* Selection border */}
          <div
            className="absolute inset-0 border-2 border-blue-500 pointer-events-none rounded"
            style={{ boxShadow: "0 0 0 1px rgba(59, 130, 246, 0.3)" }}
          />
        </>
      )}

      {/* Hover border */}
      {isHovered && !isSelected && activeTool === "select" && (
        <div className="absolute inset-0 border-2 border-blue-300 pointer-events-none rounded" />
      )}
    </div>
  );
}

