/**
 * Stamp Annotation Component
 * 
 * Renders stamp annotations with move, resize, and rotate capabilities
 * Similar to ImageAnnotation but for stamps
 */

import { useRef, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { Annotation } from "@/core/pdf/PDFEditor";

interface StampAnnotationProps {
  annotation: Annotation;
  style?: React.CSSProperties;
  scale: number;
  onResize?: (width: number, height: number) => void;
  onResizeEnd?: () => void;
  onRotate?: (angle: number) => void;
  onRotateEnd?: () => void;
  onMove?: (x: number, y: number) => void;
  onDragEnd?: () => void;
  onClick?: () => void;
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
  scale,
  onResize,
  onResizeEnd,
  onRotate,
  onRotateEnd,
  onMove,
  onDragEnd,
  onClick,
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
      } else if (isResizing && resizeCorner && onResize) {
        const deltaX = e.clientX - dragStartRef.current.x;
        const deltaY = e.clientY - dragStartRef.current.y;

        // Calculate uniform resize based on the dominant axis
        let newWidth = width;
        let newHeight = height;

        // Use the larger delta to determine scale, maintaining aspect ratio
        let scaleFactor = 1;
        if (resizeCorner === "se") {
          // Bottom-right: increase when moving down-right
          const avgDelta = (deltaX + deltaY) / 2;
          scaleFactor = 1 + avgDelta / Math.max(width, height);
        } else if (resizeCorner === "nw") {
          // Top-left: increase when moving up-left
          const avgDelta = (-deltaX - deltaY) / 2;
          scaleFactor = 1 + avgDelta / Math.max(width, height);
        } else if (resizeCorner === "ne") {
          // Top-right: increase when moving up-right
          const avgDelta = (deltaX - deltaY) / 2;
          scaleFactor = 1 + avgDelta / Math.max(width, height);
        } else if (resizeCorner === "sw") {
          // Bottom-left: increase when moving down-left
          const avgDelta = (-deltaX + deltaY) / 2;
          scaleFactor = 1 + avgDelta / Math.max(width, height);
        }

        newWidth = width * scaleFactor;
        newHeight = height * scaleFactor;

        newWidth = Math.max(20, newWidth);
        newHeight = Math.max(20, newHeight);

        onResize(newWidth, newHeight);
        dragStartRef.current = { x: e.clientX, y: e.clientY };
      } else if (isDragging && onMove) {
        const deltaX = e.clientX - dragStartRef.current.x;
        const deltaY = e.clientY - dragStartRef.current.y;

        onMove(deltaX, -deltaY); // Flip Y for PDF coordinates
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
  }, [isResizing, isRotating, isDragging, onResize, onRotate, onMove, onResizeEnd, onRotateEnd, onDragEnd, resizeCorner, rotationStart, width, height]);

  const handleSize = 8;
  const rotationHandleDistance = 40;

  return (
    <div
      ref={containerRef}
      className={cn(
        "absolute select-none",
        isDragging && "cursor-move",
        isResizing && "cursor-nwse-resize",
        activeTool === "select" && !isResizing && !isRotating && !isDragging && "cursor-move"
      )}
      style={{
        ...style,
        width: `${width}px`,
        height: `${height}px`,
        transform: `rotate(${rotation}deg)`,
        transformOrigin: "center",
      }}
      onMouseDown={handleDragMouseDown}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* Stamp content */}
      <div 
        className="w-full h-full flex items-center justify-center overflow-hidden"
        style={{
          backgroundColor: annotation.stampData?.backgroundEnabled 
            ? annotation.stampData.backgroundColor || "#FFFFFF" 
            : "transparent",
        }}
      >
        {annotation.stampData?.thumbnail ? (
          <img
            src={annotation.stampData.thumbnail}
            alt={annotation.stampData.name || "Stamp"}
            className="w-full h-full object-contain"
            style={{ imageRendering: "crisp-edges" }}
          />
        ) : annotation.stampData?.type === "text" && annotation.stampData.text ? (
          <div
            className="p-2 text-center w-full h-full flex items-center justify-center"
            style={{
              color: annotation.stampData.textColor || "#000000",
              fontFamily: annotation.stampData.font || "Arial",
              fontSize: `${Math.min(width, height) * 0.4}px`,
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

