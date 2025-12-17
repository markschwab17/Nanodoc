/**
 * Image Annotation Component
 * 
 * A component for rendering and interacting with image annotations on the PDF canvas.
 * Supports move, resize, and rotate operations similar to text boxes.
 */

import { useRef, useEffect, useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import type { Annotation } from "@/core/pdf/PDFEditor";
import { useUIStore } from "@/shared/stores/uiStore";

// Circular rotation handle component
const RotationHandle = ({ 
  size, 
  className,
  isHovered,
  isActive
}: { 
  size: number; 
  className?: string;
  isHovered?: boolean;
  isActive?: boolean;
}) => (
  <div
    className={cn(
      "rounded-full border-2 transition-all pointer-events-none",
      isActive 
        ? "bg-blue-500 border-blue-600" 
        : isHovered 
        ? "bg-blue-400 border-blue-500" 
        : "bg-white border-blue-400",
      className
    )}
    style={{
      width: `${size}px`,
      height: `${size}px`,
      boxShadow: isHovered || isActive ? "0 2px 8px rgba(0,0,0,0.2)" : "0 1px 4px rgba(0,0,0,0.1)",
    }}
  />
);

interface ImageAnnotationProps {
  annotation: Annotation;
  style?: React.CSSProperties;
  className?: string;
  scale: number;
  onResize?: (width: number, height: number) => void;
  onResizeEnd?: () => void;
  onRotate?: (angle: number) => void;
  onRotateEnd?: () => void;
  onMove?: (x: number, y: number) => void;
  onDragEnd?: () => void;
  onDuplicate?: (e: React.MouseEvent) => void;
  onClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  isSelected?: boolean;
  isHovered?: boolean;
  pageRotation?: number;
  activeTool?: string;
  isSpacePressed?: boolean;
}

export function ImageAnnotation({
  annotation,
  style,
  className,
  scale,
  onResize,
  onResizeEnd,
  onRotate,
  onRotateEnd,
  onMove,
  onDragEnd,
  onDuplicate,
  onClick,
  onMouseEnter,
  onMouseLeave,
  isSelected = false,
  isHovered = false,
  pageRotation = 0,
  activeTool,
  isSpacePressed = false,
}: ImageAnnotationProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [resizeCorner, setResizeCorner] = useState<string | null>(null);
  const [rotationStart, setRotationStart] = useState({ x: 0, y: 0, angle: 0, centerX: 0, centerY: 0 });
  const dragStartRef = useRef({ x: 0, y: 0 });
  const [isRotationHandleHovered, setIsRotationHandleHovered] = useState(false);
  const { zoomLevel } = useUIStore();
  
  // Get image dimensions from annotation
  const imageWidth = annotation.imageWidth || annotation.width || 200;
  const imageHeight = annotation.imageHeight || annotation.height || 200;
  const preserveAspectRatio = annotation.preserveAspectRatio !== false; // Default to true
  
  // Calculate aspect ratio
  const aspectRatio = imageWidth / imageHeight;
  
  const [size, setSize] = useState({
    width: annotation.width || imageWidth,
    height: annotation.height || imageHeight,
  });
  const [rotation, setRotation] = useState(annotation.rotation || 0);
  
  const sizeRef = useRef(size);
  const resizeStartRef = useRef({ x: 0, y: 0 });
  const initialResizeSizeRef = useRef({ width: 0, height: 0 });
  const initialResizeCenterRef = useRef({ x: 0, y: 0 });

  // Keep sizeRef in sync with size state
  useEffect(() => {
    sizeRef.current = size;
  }, [size]);

  // Sync size with annotation
  useEffect(() => {
    if (annotation.width && annotation.width !== size.width) {
      setSize(prev => ({ ...prev, width: annotation.width || imageWidth }));
    }
    if (annotation.height && annotation.height !== size.height) {
      setSize(prev => ({ ...prev, height: annotation.height || imageHeight }));
    }
  }, [annotation.width, annotation.height, imageWidth, imageHeight, size.width, size.height]);

  // Handle drag to move
  const handleDragMouseDown = useCallback((e: React.MouseEvent) => {
    if (activeTool === "pan" || isSpacePressed) {
      e.stopPropagation();
      return;
    }
    
    const target = e.target as HTMLElement;
    
    // Don't start drag if clicking on handles
    if (
      target.closest('[data-corner-handle]') ||
      target.closest('[data-rotation-handle]') ||
      target.closest('button')
    ) {
      return;
    }
    
    // Check for CTRL key for duplication
    if (e.ctrlKey || e.metaKey) {
      if (onDuplicate) {
        onDuplicate(e);
      }
      return;
    }
    
    setIsDragging(true);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
  }, [onDuplicate, activeTool, isSpacePressed]);

  // Handle drag to move
  useEffect(() => {
    if (!isDragging || activeTool === "pan" || isSpacePressed) return;

    const handleMouseMove = (e: MouseEvent) => {
      const screenDeltaX = e.clientX - dragStartRef.current.x;
      const screenDeltaY = e.clientY - dragStartRef.current.y;
      
      const moveDistance = Math.sqrt(
        Math.pow(screenDeltaX, 2) + Math.pow(screenDeltaY, 2)
      );
      
      if (moveDistance > 3) {
        e.preventDefault();
        
        // Overlay positioning uses CSS space, which is independent of canvas backing buffer
        // (high-DPI rendering only affects canvas backing, not CSS positioning)
        // pdfDelta = screenDelta / zoomLevel
        const pdfDeltaX = screenDeltaX / zoomLevel;
        const pdfDeltaY = -screenDeltaY / zoomLevel; // Negate Y because PDF Y-axis is flipped
        
        if (onMove) {
          onMove(pdfDeltaX, pdfDeltaY);
        }
        
        dragStartRef.current = { x: e.clientX, y: e.clientY };
      }
    };

    const handleMouseUp = () => {
      const wasDragging = isDragging;
      setIsDragging(false);
      if (wasDragging && onDragEnd) {
        onDragEnd();
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, scale, onMove, onDragEnd, activeTool, isSpacePressed, zoomLevel]);

  // Handle corner resize
  const handleCornerMouseDown = useCallback((e: React.MouseEvent, corner: string) => {
    if (activeTool === "pan" || isSpacePressed) {
      e.stopPropagation();
      return;
    }
    
    e.preventDefault();
    e.stopPropagation();
    if (e.nativeEvent && 'stopImmediatePropagation' in e.nativeEvent) {
      e.nativeEvent.stopImmediatePropagation();
    }
    
    if (!containerRef.current) return;
    
    const rect = containerRef.current.getBoundingClientRect();
    initialResizeCenterRef.current = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
    initialResizeSizeRef.current = { width: sizeRef.current.width, height: sizeRef.current.height };
    resizeStartRef.current = { x: e.clientX, y: e.clientY };
    setIsResizing(true);
    setResizeCorner(corner);
  }, [activeTool, isSpacePressed]);
  
  // Handle resize
  useEffect(() => {
    if (!isResizing || !resizeCorner || !containerRef.current || activeTool === "pan" || isSpacePressed) return;

    let rafId: number;
    let pendingUpdate: { width: number; height: number } | null = null;

    const handleMouseMove = (e: MouseEvent) => {
      const centerX = initialResizeCenterRef.current.x;
      const centerY = initialResizeCenterRef.current.y;

      // Transform to local coordinate system
      const rad = -rotation * (Math.PI / 180);
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      
      const currentRelX = e.clientX - centerX;
      const currentRelY = e.clientY - centerY;
      const currentLocalX = currentRelX * cos - currentRelY * sin;
      const currentLocalY = currentRelX * sin + currentRelY * cos;
      
      const initialRelX = resizeStartRef.current.x - centerX;
      const initialRelY = resizeStartRef.current.y - centerY;
      const initialLocalX = initialRelX * cos - initialRelY * sin;
      const initialLocalY = initialRelX * sin + initialRelY * cos;
      
      const deltaX = (currentLocalX - initialLocalX) / scale;
      const deltaY = (currentLocalY - initialLocalY) / scale;
      
      let newWidth = initialResizeSizeRef.current.width;
      let newHeight = initialResizeSizeRef.current.height;
      
      // Calculate resize based on corner
      switch (resizeCorner) {
        case "nw": // Top-left
          newWidth = Math.max(50, initialResizeSizeRef.current.width - deltaX);
          newHeight = Math.max(50, initialResizeSizeRef.current.height - deltaY);
          break;
        case "ne": // Top-right
          newWidth = Math.max(50, initialResizeSizeRef.current.width + deltaX);
          newHeight = Math.max(50, initialResizeSizeRef.current.height - deltaY);
          break;
        case "sw": // Bottom-left
          newWidth = Math.max(50, initialResizeSizeRef.current.width - deltaX);
          newHeight = Math.max(50, initialResizeSizeRef.current.height + deltaY);
          break;
        case "se": // Bottom-right
          newWidth = Math.max(50, initialResizeSizeRef.current.width + deltaX);
          newHeight = Math.max(50, initialResizeSizeRef.current.height + deltaY);
          break;
      }
      
      // Preserve aspect ratio if enabled
      if (preserveAspectRatio) {
        const currentAspect = newWidth / newHeight;
        if (Math.abs(currentAspect - aspectRatio) > 0.01) {
          // Adjust to maintain aspect ratio based on which dimension changed more
          const widthChange = Math.abs(newWidth - initialResizeSizeRef.current.width);
          const heightChange = Math.abs(newHeight - initialResizeSizeRef.current.height);
          
          if (widthChange > heightChange) {
            newHeight = newWidth / aspectRatio;
          } else {
            newWidth = newHeight * aspectRatio;
          }
        }
      }
      
      pendingUpdate = { width: newWidth, height: newHeight };

      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (pendingUpdate) {
          setSize(pendingUpdate);
          sizeRef.current = pendingUpdate;
          
          if (onResize) {
            onResize(pendingUpdate.width, pendingUpdate.height);
          }
          
          pendingUpdate = null;
        }
      });
    };

    const handleMouseUp = () => {
      const wasResizing = isResizing;
      cancelAnimationFrame(rafId);
      setIsResizing(false);
      setResizeCorner(null);
      if (wasResizing && onResizeEnd) {
        onResizeEnd();
      }
      initialResizeSizeRef.current = { width: sizeRef.current.width, height: sizeRef.current.height };
    };

    window.addEventListener("mousemove", handleMouseMove, { passive: true });
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, resizeCorner, scale, onResize, rotation, activeTool, isSpacePressed, preserveAspectRatio, aspectRatio]);

  // Handle rotation
  useEffect(() => {
    if (!isRotating || activeTool === "pan" || isSpacePressed) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - rotationStart.centerX;
      const dy = e.clientY - rotationStart.centerY;
      const currentAngle = Math.atan2(dy, dx) * (180 / Math.PI);
      
      const initialDx = rotationStart.x - rotationStart.centerX;
      const initialDy = rotationStart.y - rotationStart.centerY;
      const initialAngle = Math.atan2(initialDy, initialDx) * (180 / Math.PI);
      
      let rotationDelta = currentAngle - initialAngle;
      
      if (rotationDelta > 180) rotationDelta -= 360;
      if (rotationDelta < -180) rotationDelta += 360;
      
      const newRotation = (rotationStart.angle + rotationDelta) % 360;
      
      setRotation(newRotation);
      
      if (onRotate) {
        onRotate(newRotation);
      }
    };

    const handleMouseUp = () => {
      const wasRotating = isRotating;
      setIsRotating(false);
      if (wasRotating && onRotateEnd) {
        onRotateEnd();
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isRotating, rotationStart, onRotate, onRotateEnd, activeTool, isSpacePressed]);

  const handleSize = 8 * scale;
  const rotationHandleSize = 12 * scale;
  const rotationHandleOffset = rotationHandleSize * 1.5;
  const [hoveredCorner, setHoveredCorner] = useState<string | null>(null);

  // Calculate total rotation
  const totalRotation = rotation + pageRotation;

  if (!annotation.imageData) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className={cn("relative", className)}
      style={{
        ...style,
        transform: `rotate(${totalRotation}deg)`,
        transformOrigin: "center center",
          pointerEvents: (activeTool === "pan" || activeTool === "draw" || activeTool === "shape" || activeTool === "form" || activeTool === "stamp" || isSpacePressed) ? "none" : "auto",
      }}
      onMouseDown={activeTool === "select" && !isSpacePressed ? handleDragMouseDown : undefined}
    >
      {/* Hover border overlay */}
      {isHovered && activeTool === "select" && !isSelected && (
        <div
          className="absolute border-2 border-primary pointer-events-none"
          style={{
            left: `-4px`,
            top: `-4px`,
            width: `${(size.width * scale) + 8}px`,
            height: `${(size.height * scale) + 8}px`,
            borderRadius: "4px",
            zIndex: 31,
            boxShadow: "0 0 0 2px rgba(59, 130, 246, 0.3)",
          }}
        />
      )}
      
      {/* Image */}
      <img
        ref={imageRef}
        src={annotation.imageData}
        alt="Annotation"
        className={cn(
          "select-none",
          isSelected && "border border-primary/30",
          activeTool === "select" ? "cursor-move" : ""
        )}
        style={{
          width: `${size.width * scale}px`,
          height: `${size.height * scale}px`,
          objectFit: "contain",
          display: "block",
          pointerEvents: (activeTool === "pan" || activeTool === "draw" || activeTool === "shape" || activeTool === "form" || activeTool === "stamp" || isSpacePressed) ? "none" : "auto",
        }}
        draggable={false}
        onClick={(e) => {
          if (activeTool === "select" && onClick) {
            e.stopPropagation();
            onClick();
          }
        }}
        onMouseEnter={() => {
          if (activeTool === "select" && onMouseEnter) {
            onMouseEnter();
          }
        }}
        onMouseLeave={() => {
          if (activeTool === "select" && onMouseLeave) {
            onMouseLeave();
          }
        }}
      />
      
      {/* Corner handles for resizing */}
      {isSelected && (
        <>
          {/* Top-left corner */}
          <div
            data-corner-handle="true"
            className="absolute"
            onMouseDown={(e) => handleCornerMouseDown(e, "nw")}
            onMouseEnter={() => setHoveredCorner("nw")}
            onMouseLeave={() => setHoveredCorner(null)}
            style={{
              top: `-${handleSize / 2}px`,
              left: `-${handleSize / 2}px`,
              width: `${handleSize}px`,
              height: `${handleSize}px`,
              cursor: "nwse-resize",
              zIndex: 30,
            }}
            title="Resize"
          >
            <div
              className="absolute bg-primary border border-primary/50 rounded transition-all pointer-events-auto"
              style={{
                width: `${handleSize}px`,
                height: `${handleSize}px`,
                backgroundColor: hoveredCorner === "nw" ? "rgb(59, 130, 246)" : undefined,
                borderColor: hoveredCorner === "nw" ? "rgb(37, 99, 235)" : undefined,
                transform: hoveredCorner === "nw" ? "scale(1.2)" : "scale(1)",
                transition: "all 0.15s ease",
                cursor: "nwse-resize",
              }}
            />
          </div>
          
          {/* Top-right corner */}
          <div
            data-corner-handle="true"
            className="absolute"
            onMouseDown={(e) => handleCornerMouseDown(e, "ne")}
            onMouseEnter={() => setHoveredCorner("ne")}
            onMouseLeave={() => setHoveredCorner(null)}
            style={{
              top: `-${handleSize / 2}px`,
              right: `-${handleSize / 2}px`,
              width: `${handleSize}px`,
              height: `${handleSize}px`,
              cursor: "nesw-resize",
              zIndex: 30,
            }}
            title="Resize"
          >
            <div
              className="absolute bg-primary border border-primary/50 rounded transition-all pointer-events-auto"
              style={{
                width: `${handleSize}px`,
                height: `${handleSize}px`,
                backgroundColor: hoveredCorner === "ne" ? "rgb(59, 130, 246)" : undefined,
                borderColor: hoveredCorner === "ne" ? "rgb(37, 99, 235)" : undefined,
                transform: hoveredCorner === "ne" ? "scale(1.2)" : "scale(1)",
                transition: "all 0.15s ease",
                cursor: "nesw-resize",
              }}
            />
          </div>
          
          {/* Bottom-left corner */}
          <div
            data-corner-handle="true"
            className="absolute"
            onMouseDown={(e) => handleCornerMouseDown(e, "sw")}
            onMouseEnter={() => setHoveredCorner("sw")}
            onMouseLeave={() => setHoveredCorner(null)}
            style={{
              bottom: `-${handleSize / 2}px`,
              left: `-${handleSize / 2}px`,
              width: `${handleSize}px`,
              height: `${handleSize}px`,
              cursor: "nesw-resize",
              zIndex: 30,
            }}
            title="Resize"
          >
            <div
              className="absolute bg-primary border border-primary/50 rounded transition-all pointer-events-auto"
              style={{
                width: `${handleSize}px`,
                height: `${handleSize}px`,
                backgroundColor: hoveredCorner === "sw" ? "rgb(59, 130, 246)" : undefined,
                borderColor: hoveredCorner === "sw" ? "rgb(37, 99, 235)" : undefined,
                transform: hoveredCorner === "sw" ? "scale(1.2)" : "scale(1)",
                transition: "all 0.15s ease",
                cursor: "nesw-resize",
              }}
            />
          </div>
          
          {/* Bottom-right corner */}
          <div
            data-corner-handle="true"
            className="absolute"
            onMouseDown={(e) => handleCornerMouseDown(e, "se")}
            onMouseEnter={() => setHoveredCorner("se")}
            onMouseLeave={() => setHoveredCorner(null)}
            style={{
              bottom: `-${handleSize / 2}px`,
              right: `-${handleSize / 2}px`,
              width: `${handleSize}px`,
              height: `${handleSize}px`,
              cursor: "nwse-resize",
              zIndex: 30,
            }}
            title="Resize"
          >
            <div
              className="absolute bg-primary border border-primary/50 rounded transition-all pointer-events-auto"
              style={{
                width: `${handleSize}px`,
                height: `${handleSize}px`,
                backgroundColor: hoveredCorner === "se" ? "rgb(59, 130, 246)" : undefined,
                borderColor: hoveredCorner === "se" ? "rgb(37, 99, 235)" : undefined,
                transform: hoveredCorner === "se" ? "scale(1.2)" : "scale(1)",
                transition: "all 0.15s ease",
                cursor: "nwse-resize",
              }}
            />
          </div>
          
          {/* Center-top rotation handle */}
          <div
            data-rotation-handle="true"
            className="absolute pointer-events-auto"
            onMouseDown={(e) => {
              if (activeTool === "pan" || isSpacePressed) {
                e.stopPropagation();
                return;
              }
              
              e.preventDefault();
              e.stopPropagation();
              if (!containerRef.current) return;
              const rect = containerRef.current.getBoundingClientRect();
              const centerX = rect.left + rect.width / 2;
              const centerY = rect.top + rect.height / 2;
              setIsRotating(true);
              setRotationStart({ 
                x: e.clientX, 
                y: e.clientY, 
                angle: rotation,
                centerX,
                centerY
              });
            }}
            onMouseEnter={() => {
              setIsRotationHandleHovered(true);
            }}
            onMouseLeave={() => {
              setIsRotationHandleHovered(false);
            }}
            style={{
              top: `-${rotationHandleOffset}px`,
              left: "50%",
              transform: "translateX(-50%)",
              width: `${rotationHandleSize}px`,
              height: `${rotationHandleSize}px`,
              cursor: isRotating ? "grabbing" : "grab",
              zIndex: 30,
            }}
            title="Rotate"
          >
            <RotationHandle 
              size={rotationHandleSize} 
              isHovered={isRotationHandleHovered}
              isActive={isRotating}
            />
          </div>
        </>
      )}
    </div>
  );
}

