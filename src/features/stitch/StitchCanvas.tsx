/**
 * Stitch canvas: pan/zoom container, canvas background, crop overlay, and tiles.
 * Optional content-delete mode: draw a box to erase content in that region.
 */

import { useRef, useEffect, useCallback, useState } from "react";
import { Loader2 } from "lucide-react";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { StitchTile } from "./StitchTile";
import { GroupSelectionOverlay } from "./GroupSelectionOverlay";
import type { CanvasRect } from "./imageUtils";
import { useStitchPanZoom } from "./useStitchPanZoom";
import { MIN_ERASE_SIZE, STROKE_POINT_MIN_DIST } from "./stitchConstants";
import { hitTestTileAtPoint, type CanvasPoint } from "./stitchGeometry";

export interface StitchCanvasProps {
  /** When true, user can draw a selection box to delete content in that area. */
  contentDeleteMode?: boolean;
  /** Called when user finishes drawing an erase box (canvas-space rect). */
  onContentDeleteRect?: (rect: CanvasRect) => void;
  /** When true, user can paint a stroke to delete elements along the path. */
  deleteElementMode?: boolean;
  /** Called when user finishes a stroke (click or drag); path is canvas-space points. */
  onDeleteElementAlongPath?: (path: Array<{ x: number; y: number }>) => void;
  /** Brief visual feedback: canvas rects of the region(s) that were just erased (shown for ~1.5s). */
  erasedRegionFeedback?: Array<{ x: number; y: number; w: number; h: number }>;
  /** When true, show a loading overlay (e.g. while erasing along path). */
  isDeletingAlongPath?: boolean;
  /** Point-align mode: click two point pairs to align target to reference. */
  pointAlignMode?: boolean;
  pointAlignReferenceId?: string | null;
  pointAlignTargetId?: string | null;
  pointAlignStep?: 0 | 1 | 2 | 3;
  pointAlignPoints?: [CanvasPoint | null, CanvasPoint | null, CanvasPoint | null, CanvasPoint | null];
  /** Called with (tileId, canvasPoint) when user clicks in point-align mode. */
  onPointAlignClick?: (tileId: string, point: CanvasPoint) => void;
  /** Scale-align mode: click two points on reference (PDF A), then two on target (PDF B) to resize B to match scale. */
  scaleAlignMode?: boolean;
  scaleAlignReferenceId?: string | null;
  scaleAlignTargetId?: string | null;
  scaleAlignStep?: 0 | 1 | 2 | 3;
  scaleAlignPoints?: [CanvasPoint | null, CanvasPoint | null, CanvasPoint | null, CanvasPoint | null];
  onScaleAlignClick?: (tileId: string, point: CanvasPoint) => void;
  /** When true, drag pans the canvas (same as holding Space). */
  panMode?: boolean;
  /** Optional ref to receive the viewport container element (e.g. for recenter). */
  forwardedContainerRef?: React.RefObject<HTMLDivElement | null>;
}

export function StitchCanvas({
  contentDeleteMode = false,
  onContentDeleteRect,
  deleteElementMode = false,
  onDeleteElementAlongPath,
  erasedRegionFeedback = [],
  isDeletingAlongPath = false,
  pointAlignMode = false,
  pointAlignReferenceId,
  pointAlignTargetId,
  pointAlignStep = 0,
  pointAlignPoints = [null, null, null, null],
  onPointAlignClick,
  scaleAlignMode = false,
  scaleAlignPoints = [null, null, null, null],
  onScaleAlignClick,
  panMode = false,
  forwardedContainerRef,
}: StitchCanvasProps = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const setContainerRef = useCallback(
    (el: HTMLDivElement | null) => {
      (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
      if (forwardedContainerRef) (forwardedContainerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    },
    [forwardedContainerRef]
  );
  const innerRef = useRef<HTMLDivElement>(null);
  const {
    canvasWidth,
    canvasHeight,
    tiles,
    panOffset,
    zoomLevel,
    cropRect,
    setPanOffset,
    setSelectedTileIds,
  } = useStitchStore();

  const { panOffsetRef, zoomLevelRef } = useStitchPanZoom(containerRef);

  const [isSpacePan, setIsSpacePan] = useState(false);
  const panStartRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const [deleteSelection, setDeleteSelection] = useState<{
    start: { x: number; y: number };
    current: { x: number; y: number };
  } | null>(null);
  const isDeleteSelectingRef = useRef(false);

  const [deleteStrokePath, setDeleteStrokePath] = useState<Array<{ x: number; y: number }>>([]);
  const [deleteStrokeCurrent, setDeleteStrokeCurrent] = useState<{ x: number; y: number } | null>(null);
  const deleteStrokePathRef = useRef<Array<{ x: number; y: number }>>([]);

  /** In point-align mode, canvas coords of mouse for live preview line (step 1: A1→mouse, step 3: A2→mouse). */
  const [pointAlignMouse, setPointAlignMouse] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!pointAlignMode) setPointAlignMouse(null);
  }, [pointAlignMode]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        e.stopPropagation();
        setIsSpacePan(true);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        e.stopPropagation();
        setIsSpacePan(false);
        panStartRef.current = null;
      }
    };
    const opts: AddEventListenerOptions = { capture: true };
    document.addEventListener("keydown", handleKeyDown, opts);
    document.addEventListener("keyup", handleKeyUp, opts);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, opts);
      document.removeEventListener("keyup", handleKeyUp, opts);
    };
  }, []);

  const clientToCanvas = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const inner = innerRef.current;
    if (!inner) return null;
    const rect = inner.getBoundingClientRect();
    const zoom = zoomLevelRef.current;
    return {
      x: (clientX - rect.left) / zoom,
      y: (clientY - rect.top) / zoom,
    };
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      if (contentDeleteMode || deleteElementMode || pointAlignMode || scaleAlignMode) return;
      const panActive = panMode || isSpacePan;
      if (panActive && containerRef.current) {
        panStartRef.current = {
          x: e.clientX,
          y: e.clientY,
          panX: panOffsetRef.current.x,
          panY: panOffsetRef.current.y,
        };
      } else {
        const target = e.target as HTMLElement;
        // Only clear selection when clicking on background (not a tile or group overlay)
        if (!target.closest("[data-stitch-tile]") && !target.closest("[data-stitch-group-overlay]")) {
          setSelectedTileIds([]);
        }
      }
    },
    [contentDeleteMode, deleteElementMode, panMode, pointAlignMode, scaleAlignMode, setSelectedTileIds]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const start = panStartRef.current;
      if (start) {
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        const newPan = { x: start.panX + dx, y: start.panY + dy };
        panOffsetRef.current = newPan;
        setPanOffset(newPan);
      }
    },
    [setPanOffset]
  );

  const handlePointerUp = useCallback(() => {
    panStartRef.current = null;
  }, []);

  return (
    <div
      ref={setContainerRef}
      className="w-full h-full overflow-hidden bg-muted relative cursor-grab active:cursor-grabbing"
      style={{
        cursor: contentDeleteMode || deleteElementMode || pointAlignMode || scaleAlignMode ? "crosshair" : panMode || isSpacePan ? "grab" : undefined,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={() => {
        panStartRef.current = null;
      }}
    >
      <div
        ref={innerRef}
        className="absolute origin-top-left"
        style={{
          left: panOffset.x,
          top: panOffset.y,
          width: canvasWidth,
          height: canvasHeight,
          transform: `scale(${zoomLevel})`,
          transformOrigin: "0 0",
        }}
      >
        <div
          className="absolute inset-0 border border-border bg-background"
          style={{
            width: canvasWidth,
            height: canvasHeight,
            backgroundImage: `
              linear-gradient(to right, rgba(0,0,0,0.03) 1px, transparent 1px),
              linear-gradient(to bottom, rgba(0,0,0,0.03) 1px, transparent 1px)
            `,
            backgroundSize: "24px 24px",
          }}
        />
        {cropRect && (
          <div
            className="absolute border-2 border-dashed border-primary pointer-events-none"
            style={{
              left: cropRect.x,
              top: cropRect.y,
              width: cropRect.w,
              height: cropRect.h,
            }}
          />
        )}
        {tiles.map((tile) => (
          <StitchTile key={tile.id} tile={tile} zoomLevel={zoomLevel} />
        ))}
        <GroupSelectionOverlay />
        {(pointAlignMode || scaleAlignMode) && (onPointAlignClick || onScaleAlignClick) && (
          <div
            className="absolute inset-0 z-10 cursor-crosshair pointer-events-auto"
            style={{ width: canvasWidth, height: canvasHeight }}
            onPointerMove={(e) => {
              if (!pointAlignMode || (pointAlignStep !== 1 && pointAlignStep !== 3)) return;
              const coords = clientToCanvas(e.clientX, e.clientY);
              setPointAlignMouse(coords ?? null);
            }}
            onPointerLeave={() => setPointAlignMouse(null)}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              const coords = clientToCanvas(e.clientX, e.clientY);
              if (!coords) return;
              const hit = hitTestTileAtPoint(coords, tiles, true);
              if (hit) {
                if (pointAlignMode && onPointAlignClick) onPointAlignClick(hit.tile.id, hit.point);
                if (scaleAlignMode && onScaleAlignClick) onScaleAlignClick(hit.tile.id, hit.point);
              }
            }}
          />
        )}
        {(pointAlignPoints.some((p) => p != null) || scaleAlignPoints.some((p) => p != null)) && (() => {
          const zoom = Math.max(0.25, zoomLevel);
          const markerR = Math.max(1, 6 / zoom);
          const markerStroke = Math.max(0.5, 2 / zoom);
          const markerFontSize = Math.max(6, 10 / zoom);
          const dashLen = Math.max(1, 4 / zoom);
          return (
            <svg
              className="absolute left-0 top-0 pointer-events-none z-[11]"
              width={canvasWidth}
              height={canvasHeight}
              viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
              preserveAspectRatio="none"
            >
              {(pointAlignMode ? pointAlignPoints : scaleAlignPoints).map(
                (p, i) =>
                  p && (
                    <g key={i}>
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={markerR}
                        fill="hsl(var(--primary))"
                        stroke="hsl(var(--background))"
                        strokeWidth={markerStroke}
                        opacity={0.9}
                      />
                      <text
                        x={p.x}
                        y={p.y}
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill="hsl(var(--primary-foreground))"
                        fontSize={markerFontSize}
                        fontWeight="bold"
                      >
                        {i + 1}
                      </text>
                    </g>
                  )
              )}
              {pointAlignMode && pointAlignStep >= 2 && pointAlignPoints[0] && pointAlignPoints[1] && (
                <line
                  x1={pointAlignPoints[0].x}
                  y1={pointAlignPoints[0].y}
                  x2={pointAlignPoints[1].x}
                  y2={pointAlignPoints[1].y}
                  stroke="hsl(var(--primary))"
                  strokeWidth={markerStroke}
                  strokeDasharray={`${dashLen} ${dashLen}`}
                  opacity={0.8}
                />
              )}
              {pointAlignMode && pointAlignStep === 1 && pointAlignPoints[0] && pointAlignMouse && (
                <line
                  x1={pointAlignPoints[0].x}
                  y1={pointAlignPoints[0].y}
                  x2={pointAlignMouse.x}
                  y2={pointAlignMouse.y}
                  stroke="hsl(var(--primary))"
                  strokeWidth={markerStroke}
                  strokeDasharray={`${dashLen} ${dashLen}`}
                  opacity={0.7}
                />
              )}
              {pointAlignMode && pointAlignStep === 3 && pointAlignPoints[2] && pointAlignMouse && (
                <line
                  x1={pointAlignPoints[2].x}
                  y1={pointAlignPoints[2].y}
                  x2={pointAlignMouse.x}
                  y2={pointAlignMouse.y}
                  stroke="hsl(var(--primary))"
                  strokeWidth={markerStroke}
                  strokeDasharray={`${dashLen} ${dashLen}`}
                  opacity={0.7}
                />
              )}
              {scaleAlignMode && scaleAlignPoints[0] && scaleAlignPoints[1] && (
                <line
                  x1={scaleAlignPoints[0].x}
                  y1={scaleAlignPoints[0].y}
                  x2={scaleAlignPoints[1].x}
                  y2={scaleAlignPoints[1].y}
                  stroke="hsl(var(--primary))"
                  strokeWidth={markerStroke}
                  strokeDasharray={`${dashLen} ${dashLen}`}
                  opacity={0.8}
                />
              )}
              {scaleAlignMode && scaleAlignPoints[2] && scaleAlignPoints[3] && (
                <line
                  x1={scaleAlignPoints[2].x}
                  y1={scaleAlignPoints[2].y}
                  x2={scaleAlignPoints[3].x}
                  y2={scaleAlignPoints[3].y}
                  stroke="hsl(var(--primary))"
                  strokeWidth={markerStroke}
                  strokeDasharray={`${dashLen} ${dashLen}`}
                  opacity={0.8}
                />
              )}
            </svg>
          );
        })()}
        {contentDeleteMode && (
          <div
            className="absolute inset-0 z-10 pointer-events-auto"
            style={{ width: canvasWidth, height: canvasHeight }}
            onPointerDown={(e) => {
              if (e.button === 0 && onContentDeleteRect) {
                const coords = clientToCanvas(e.clientX, e.clientY);
                if (coords) {
                  isDeleteSelectingRef.current = true;
                  setDeleteSelection({ start: coords, current: coords });
                }
              }
            }}
            onPointerMove={(e) => {
              if (isDeleteSelectingRef.current && deleteSelection) {
                const coords = clientToCanvas(e.clientX, e.clientY);
                if (coords) setDeleteSelection((prev) => (prev ? { ...prev, current: coords } : null));
              }
            }}
            onPointerUp={(e) => {
              if (e.button === 0 && isDeleteSelectingRef.current && deleteSelection && onContentDeleteRect) {
                isDeleteSelectingRef.current = false;
                const { start, current } = deleteSelection;
                const x = Math.min(start.x, current.x);
                const y = Math.min(start.y, current.y);
                const w = Math.abs(current.x - start.x);
                const h = Math.abs(current.y - start.y);
                if (w >= MIN_ERASE_SIZE && h >= MIN_ERASE_SIZE) onContentDeleteRect({ x, y, w, h });
                setDeleteSelection(null);
              }
            }}
            onPointerLeave={() => {
              if (isDeleteSelectingRef.current && deleteSelection && onContentDeleteRect) {
                const { start, current } = deleteSelection;
                const x = Math.min(start.x, current.x);
                const y = Math.min(start.y, current.y);
                const w = Math.abs(current.x - start.x);
                const h = Math.abs(current.y - start.y);
                if (w >= MIN_ERASE_SIZE && h >= MIN_ERASE_SIZE) onContentDeleteRect({ x, y, w, h });
                isDeleteSelectingRef.current = false;
                setDeleteSelection(null);
              }
            }}
          />
        )}
        {deleteElementMode && (
          <div
            className="absolute left-0 top-0 z-10 cursor-crosshair"
            style={{
              width: canvasWidth,
              height: canvasHeight,
              pointerEvents: "auto",
            }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (e.button !== 0 || !onDeleteElementAlongPath) return;
              const coords = clientToCanvas(e.clientX, e.clientY);
              if (coords) {
                (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
                const path = [coords];
                deleteStrokePathRef.current = path;
                setDeleteStrokePath(path);
                setDeleteStrokeCurrent(coords);
              }
            }}
            onPointerMove={(e) => {
              if (deleteStrokePathRef.current.length === 0) return;
              const coords = clientToCanvas(e.clientX, e.clientY);
              if (!coords) return;
              setDeleteStrokeCurrent(coords);
              const last = deleteStrokePathRef.current[deleteStrokePathRef.current.length - 1];
              const dx = coords.x - last.x;
              const dy = coords.y - last.y;
              if (dx * dx + dy * dy >= STROKE_POINT_MIN_DIST * STROKE_POINT_MIN_DIST) {
                const next = [...deleteStrokePathRef.current, coords];
                deleteStrokePathRef.current = next;
                setDeleteStrokePath(next);
              }
            }}
            onPointerUp={(e) => {
              if (e.button !== 0) return;
              try {
                (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
              } catch (_) {}
              const current = deleteStrokeCurrent;
              setDeleteStrokeCurrent(null);
              let path = [...deleteStrokePathRef.current];
              if (current && path.length > 0) {
                const last = path[path.length - 1];
                if (last.x !== current.x || last.y !== current.y) path = [...path, current];
              }
              deleteStrokePathRef.current = [];
              setDeleteStrokePath([]);
              if (path.length > 0 && onDeleteElementAlongPath) onDeleteElementAlongPath(path);
            }}
            onPointerLeave={() => {
              if (deleteStrokePathRef.current.length > 0) {
                setDeleteStrokeCurrent(null);
                const path = [...deleteStrokePathRef.current];
                deleteStrokePathRef.current = [];
                setDeleteStrokePath([]);
                if (onDeleteElementAlongPath) onDeleteElementAlongPath(path);
              }
            }}
          />
        )}
        {(deleteStrokePath.length >= 1 || deleteStrokeCurrent) && (
          <svg
            className="absolute left-0 top-0 pointer-events-none z-[15]"
            width={canvasWidth}
            height={canvasHeight}
            viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
            preserveAspectRatio="none"
          >
            {(() => {
              const points = deleteStrokeCurrent
                ? [...deleteStrokePath, deleteStrokeCurrent]
                : deleteStrokePath;
              if (points.length >= 2) {
                return (
                  <polyline
                    points={points.map((p) => `${p.x},${p.y}`).join(" ")}
                    fill="none"
                    stroke="hsl(var(--destructive))"
                    strokeWidth={10}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={0.8}
                  />
                );
              }
              if (points.length === 1) {
                return (
                  <circle
                    cx={points[0].x}
                    cy={points[0].y}
                    r={6}
                    fill="hsl(var(--destructive))"
                    opacity={0.8}
                  />
                );
              }
              return null;
            })()}
          </svg>
        )}
        {deleteSelection && (
          <div
            className="absolute border-2 border-destructive bg-destructive/10 pointer-events-none z-20"
            style={{
              left: Math.min(deleteSelection.start.x, deleteSelection.current.x),
              top: Math.min(deleteSelection.start.y, deleteSelection.current.y),
              width: Math.abs(deleteSelection.current.x - deleteSelection.start.x),
              height: Math.abs(deleteSelection.current.y - deleteSelection.start.y),
            }}
          />
        )}
        {erasedRegionFeedback.length > 0 &&
          erasedRegionFeedback.map((rect, i) => (
            <div
              key={`feedback-${i}-${rect.x}-${rect.y}`}
              className="absolute pointer-events-none z-20 border-2 border-destructive bg-destructive/20"
              style={{
                left: rect.x,
                top: rect.y,
                width: Math.max(2, rect.w),
                height: Math.max(2, rect.h),
              }}
            />
          ))}
      </div>
      {isDeletingAlongPath && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-background/70 backdrop-blur-[2px]"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="flex flex-col items-center gap-3 rounded-lg border bg-background px-5 py-4 shadow-lg">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <span className="text-sm font-medium text-muted-foreground">Removing elements…</span>
          </div>
        </div>
      )}
    </div>
  );
}
