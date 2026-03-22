/**
 * Image Annotation Component
 *
 * Renders and interacts with image annotations on the PDF canvas.
 * Architecture matches StampAnnotation: no internal size state,
 * reads dimensions from annotation props, updates store on every mousemove.
 */

import { useRef, useEffect, useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import type { Annotation } from "@/core/pdf/PDFEditor";
import { useUIStore } from "@/shared/stores/uiStore";

const RotationHandle = ({
  size,
  className,
  isHovered,
  isActive,
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
      boxShadow:
        isHovered || isActive
          ? "0 2px 8px rgba(0,0,0,0.2)"
          : "0 1px 4px rgba(0,0,0,0.1)",
    }}
  />
);

interface ImageAnnotationProps {
  annotation: Annotation;
  style?: React.CSSProperties;
  className?: string;
  scale: number;
  onResize?: (width: number, height: number) => void;
  onResizeWithPosition?: (
    x: number,
    y: number,
    width: number,
    height: number
  ) => void;
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
  onResizeWithPosition,
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
  const [rotationStart, setRotationStart] = useState({
    x: 0,
    y: 0,
    angle: 0,
    centerX: 0,
    centerY: 0,
  });
  const dragStartRef = useRef({ x: 0, y: 0 });
  // Stores initial annotation {x, y, width, height} when resize begins
  const resizeStartRef = useRef({ x: 0, y: 0, width: 0, height: 0 });
  const [isRotationHandleHovered, setIsRotationHandleHovered] = useState(false);
  const { zoomLevel } = useUIStore();

  // Read dimensions directly from annotation props — NO internal size state.
  // This is the key architectural choice that eliminates drift:
  // both CSS position (from parent) and dimensions (from props) come from
  // the same store update, in the same render cycle.
  const width = annotation.width || annotation.imageWidth || 200;
  const height = annotation.height || annotation.imageHeight || 200;
  const rotation = annotation.rotation || 0;
  const preserveAspectRatio = annotation.preserveAspectRatio !== false;
  const aspectRatio =
    (annotation.imageWidth || width) / (annotation.imageHeight || height);

  // ── Drag to move ──────────────────────────────────────────────────────
  const handleDragMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (activeTool === "pan" || isSpacePressed) {
        e.stopPropagation();
        return;
      }
      const target = e.target as HTMLElement;
      if (
        target.closest("[data-corner-handle]") ||
        target.closest("[data-rotation-handle]") ||
        target.closest("button")
      )
        return;

      if (e.ctrlKey || e.metaKey) {
        if (onDuplicate) onDuplicate(e);
        return;
      }

      setIsDragging(true);
      dragStartRef.current = { x: e.clientX, y: e.clientY };
    },
    [onDuplicate, activeTool, isSpacePressed]
  );

  useEffect(() => {
    if (!isDragging || activeTool === "pan" || isSpacePressed) return;

    const handleMouseMove = (e: MouseEvent) => {
      const screenDx = e.clientX - dragStartRef.current.x;
      const screenDy = e.clientY - dragStartRef.current.y;
      if (Math.sqrt(screenDx * screenDx + screenDy * screenDy) > 3) {
        e.preventDefault();
        if (onMove) onMove(screenDx / zoomLevel, -screenDy / zoomLevel);
        dragStartRef.current = { x: e.clientX, y: e.clientY };
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      if (onDragEnd) onDragEnd();
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, onMove, onDragEnd, activeTool, isSpacePressed, zoomLevel]);

  // ── Resize ────────────────────────────────────────────────────────────
  const handleCornerMouseDown = (e: React.MouseEvent, corner: string) => {
    if (activeTool !== "select" || isSpacePressed) return;
    e.preventDefault();
    e.stopPropagation();

    setIsResizing(true);
    setResizeCorner(corner);
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    resizeStartRef.current = {
      x: annotation.x,
      y: annotation.y,
      width,
      height,
    };
  };

  // Single useEffect for all interactions — identical pattern to StampAnnotation
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizing && resizeCorner && (onResize || onResizeWithPosition)) {
        const screenDx = e.clientX - dragStartRef.current.x;
        const screenDy = e.clientY - dragStartRef.current.y;
        const pdfDx = screenDx / zoomLevel;
        const pdfDy = screenDy / zoomLevel; // Don't flip Y for resize

        let newX = resizeStartRef.current.x;
        let newY = resizeStartRef.current.y;
        let newWidth = resizeStartRef.current.width;
        let newHeight = resizeStartRef.current.height;

        // Identical corner-pinning math from StampAnnotation (lines 168-225)
        if (resizeCorner === "nw") {
          const pinnedRX = resizeStartRef.current.x + resizeStartRef.current.width;
          const pinnedBY = resizeStartRef.current.y;
          const newTLX = resizeStartRef.current.x + pdfDx;
          const newTLY = resizeStartRef.current.y + resizeStartRef.current.height - pdfDy;
          newX = newTLX;
          newY = pinnedBY;
          newWidth = pinnedRX - newTLX;
          newHeight = newTLY - pinnedBY;
        } else if (resizeCorner === "ne") {
          const pinnedBY = resizeStartRef.current.y;
          const newTRX = resizeStartRef.current.x + resizeStartRef.current.width + pdfDx;
          const newTRY = resizeStartRef.current.y + resizeStartRef.current.height - pdfDy;
          newX = resizeStartRef.current.x;
          newY = pinnedBY;
          newWidth = newTRX - resizeStartRef.current.x;
          newHeight = newTRY - pinnedBY;
        } else if (resizeCorner === "sw") {
          const pinnedRX = resizeStartRef.current.x + resizeStartRef.current.width;
          const pinnedTY = resizeStartRef.current.y + resizeStartRef.current.height;
          const newBLX = resizeStartRef.current.x + pdfDx;
          const newBLY = resizeStartRef.current.y - pdfDy;
          newX = newBLX;
          newY = newBLY;
          newWidth = pinnedRX - newBLX;
          newHeight = pinnedTY - newBLY;
        } else if (resizeCorner === "se") {
          const pinnedTY = resizeStartRef.current.y + resizeStartRef.current.height;
          const newBRX = resizeStartRef.current.x + resizeStartRef.current.width + pdfDx;
          const newBRY = resizeStartRef.current.y - pdfDy;
          newX = resizeStartRef.current.x;
          newY = newBRY;
          newWidth = newBRX - resizeStartRef.current.x;
          newHeight = pinnedTY - newBRY;
        }

        // Flip if dragged past opposite edge
        if (newWidth < 0) { newX += newWidth; newWidth = -newWidth; }
        if (newHeight < 0) { newY += newHeight; newHeight = -newHeight; }

        // Aspect ratio preservation
        if (preserveAspectRatio && aspectRatio > 0) {
          const cur = newWidth / newHeight;
          if (Math.abs(cur - aspectRatio) > 0.01) {
            if (Math.abs(newWidth - resizeStartRef.current.width) > Math.abs(newHeight - resizeStartRef.current.height)) {
              newHeight = newWidth / aspectRatio;
            } else {
              newWidth = newHeight * aspectRatio;
            }
          }
        }

        if (onResizeWithPosition) {
          onResizeWithPosition(newX, newY, newWidth, newHeight);
        } else if (onResize) {
          onResize(newWidth, newHeight);
        }
      }
    };

    const handleMouseUp = () => {
      if (isResizing) {
        setIsResizing(false);
        setResizeCorner(null);
        if (onResizeEnd) onResizeEnd();
      }
    };

    if (isResizing) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      return () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
    }
  }, [
    isResizing,
    resizeCorner,
    onResize,
    onResizeWithPosition,
    onResizeEnd,
    zoomLevel,
    preserveAspectRatio,
    aspectRatio,
  ]);

  // ── Rotation ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isRotating || activeTool === "pan" || isSpacePressed) return;

    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - rotationStart.centerX;
      const dy = e.clientY - rotationStart.centerY;
      const currentAngle = Math.atan2(dy, dx) * (180 / Math.PI);
      const initialDx = rotationStart.x - rotationStart.centerX;
      const initialDy = rotationStart.y - rotationStart.centerY;
      const initialAngle = Math.atan2(initialDy, initialDx) * (180 / Math.PI);
      let delta = currentAngle - initialAngle;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      const newRotation = (rotationStart.angle + delta) % 360;
      if (onRotate) onRotate(newRotation);
    };

    const handleMouseUp = () => {
      setIsRotating(false);
      if (onRotateEnd) onRotateEnd();
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isRotating, rotationStart, onRotate, onRotateEnd, activeTool, isSpacePressed]);

  // ── Render ────────────────────────────────────────────────────────────
  const handleSize = 8 * scale;
  const rotationHandleSize = 12 * scale;
  const rotationHandleOffset = rotationHandleSize * 1.5;
  const [hoveredCorner, setHoveredCorner] = useState<string | null>(null);
  const totalRotation = rotation + pageRotation;

  if (!annotation.imageData) return null;

  return (
    <div
      ref={containerRef}
      className={cn("relative", className)}
      style={{
        ...style,
        transform: `rotate(${totalRotation}deg)`,
        transformOrigin: "center center",
        width: `${width}px`,
        height: `${height}px`,
        pointerEvents:
          activeTool === "pan" ||
          activeTool === "draw" ||
          activeTool === "shape" ||
          activeTool === "form" ||
          activeTool === "stamp" ||
          isSpacePressed
            ? "none"
            : "auto",
      }}
      onMouseDown={
        activeTool === "select" && !isSpacePressed
          ? handleDragMouseDown
          : undefined
      }
    >
      {/* Hover border */}
      {isHovered && activeTool === "select" && !isSelected && (
        <div
          className="absolute border-2 border-primary pointer-events-none"
          style={{
            left: "-4px",
            top: "-4px",
            width: `${width + 8}px`,
            height: `${height + 8}px`,
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
          width: `${width}px`,
          height: `${height}px`,
          objectFit: "contain",
          display: "block",
          pointerEvents:
            activeTool === "pan" ||
            activeTool === "draw" ||
            activeTool === "shape" ||
            activeTool === "form" ||
            activeTool === "stamp" ||
            isSpacePressed
              ? "none"
              : "auto",
        }}
        draggable={false}
        onClick={(e) => {
          if (activeTool === "select" && onClick) {
            e.stopPropagation();
            onClick();
          }
        }}
        onMouseEnter={() => {
          if (activeTool === "select" && onMouseEnter) onMouseEnter();
        }}
        onMouseLeave={() => {
          if (activeTool === "select" && onMouseLeave) onMouseLeave();
        }}
      />

      {/* Corner handles */}
      {isSelected && (
        <>
          {(["nw", "ne", "sw", "se"] as const).map((corner) => {
            const isTop = corner.startsWith("n");
            const isLeft = corner.endsWith("w");
            const cursor =
              corner === "nw" || corner === "se"
                ? "nwse-resize"
                : "nesw-resize";
            return (
              <div
                key={corner}
                data-corner-handle="true"
                className="absolute"
                onMouseDown={(e) => handleCornerMouseDown(e, corner)}
                onMouseEnter={() => setHoveredCorner(corner)}
                onMouseLeave={() => setHoveredCorner(null)}
                style={{
                  ...(isTop
                    ? { top: `-${handleSize / 2}px` }
                    : { bottom: `-${handleSize / 2}px` }),
                  ...(isLeft
                    ? { left: `-${handleSize / 2}px` }
                    : { right: `-${handleSize / 2}px` }),
                  width: `${handleSize}px`,
                  height: `${handleSize}px`,
                  cursor,
                  zIndex: 30,
                }}
                title="Resize"
              >
                <div
                  className="absolute bg-primary border border-primary/50 rounded transition-all pointer-events-auto"
                  style={{
                    width: `${handleSize}px`,
                    height: `${handleSize}px`,
                    backgroundColor:
                      hoveredCorner === corner
                        ? "rgb(59, 130, 246)"
                        : undefined,
                    borderColor:
                      hoveredCorner === corner
                        ? "rgb(37, 99, 235)"
                        : undefined,
                    transform:
                      hoveredCorner === corner ? "scale(1.2)" : "scale(1)",
                    transition: "all 0.15s ease",
                    cursor,
                  }}
                />
              </div>
            );
          })}

          {/* Rotation handle */}
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
              setIsRotating(true);
              setRotationStart({
                x: e.clientX,
                y: e.clientY,
                angle: rotation,
                centerX: rect.left + rect.width / 2,
                centerY: rect.top + rect.height / 2,
              });
            }}
            onMouseEnter={() => setIsRotationHandleHovered(true)}
            onMouseLeave={() => setIsRotationHandleHovered(false)}
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
