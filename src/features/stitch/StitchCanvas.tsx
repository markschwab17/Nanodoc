/**
 * Stitch canvas: pan/zoom container, canvas background, crop overlay, and tiles.
 * Optional content-delete mode: draw a box to erase content in that region.
 */

import { useRef, useEffect, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { StitchTile } from "./StitchTile";
import { GroupSelectionOverlay } from "./GroupSelectionOverlay";
import type { CanvasRect } from "./imageUtils";
import { useStitchPanZoom } from "./useStitchPanZoom";
import { MIN_ERASE_SIZE, PT_PER_INCH, STROKE_POINT_MIN_DIST } from "./stitchConstants";

const RULER_SIZE = 24;
const PT_PER_HALF_INCH = PT_PER_INCH / 2;

function rulerLabel(inches: number): string {
  return inches % 1 === 0 ? String(inches) : inches.toFixed(1);
}
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
  /** When false, the canvas background (paper/grid) is hidden; PDFs remain visible. */
  canvasVisible?: boolean;
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
  pointAlignReferenceId: _pointAlignReferenceId,
  pointAlignTargetId: _pointAlignTargetId,
  pointAlignStep = 0,
  pointAlignPoints = [null, null, null, null],
  onPointAlignClick,
  scaleAlignMode = false,
  scaleAlignPoints = [null, null, null, null],
  onScaleAlignClick,
  panMode = false,
  canvasVisible = true,
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
  const isSpacePanRef = useRef(false);
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

  /** Container rect for portal overlay (point/scale align) so overlay covers viewport and receives clicks outside canvas. */
  const [containerRect, setContainerRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!pointAlignMode) setPointAlignMouse(null);
  }, [pointAlignMode]);

  // Keep container rect in sync so portal overlay can match viewport area with position:fixed
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerRect(el.getBoundingClientRect());
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const win = el.ownerDocument?.defaultView;
    win?.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      win?.removeEventListener("scroll", update, true);
    };
  }, [pointAlignMode, scaleAlignMode, contentDeleteMode]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        e.stopPropagation();
        isSpacePanRef.current = true;
        setIsSpacePan(true);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        e.stopPropagation();
        isSpacePanRef.current = false;
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
    // Canvas content is inset by RULER_SIZE; (0,0) is at (RULER_SIZE, RULER_SIZE) in inner div
    return {
      x: (clientX - rect.left) / zoom - RULER_SIZE,
      y: (clientY - rect.top) / zoom - RULER_SIZE,
    };
  }, []);

  const handlePointerDownCapture = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      if (contentDeleteMode || deleteElementMode || pointAlignMode || scaleAlignMode) return;
      const panActive = panMode || isSpacePanRef.current;
      if (panActive && containerRef.current) {
        panStartRef.current = {
          x: e.clientX,
          y: e.clientY,
          panX: panOffsetRef.current.x,
          panY: panOffsetRef.current.y,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
        e.stopPropagation();
      }
    },
    [contentDeleteMode, deleteElementMode, panMode, pointAlignMode, scaleAlignMode]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      if (contentDeleteMode || deleteElementMode || pointAlignMode || scaleAlignMode) return;
      const panActive = panMode || isSpacePanRef.current;
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
      className="w-full h-full overflow-hidden bg-muted relative"
      style={{
        cursor: contentDeleteMode || deleteElementMode || pointAlignMode || scaleAlignMode ? "crosshair" : panMode || isSpacePan ? "grab" : "default",
      }}
      onPointerDownCapture={handlePointerDownCapture}
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
          width: RULER_SIZE + canvasWidth,
          height: RULER_SIZE + canvasHeight,
          transform: `scale(${zoomLevel})`,
          transformOrigin: "0 0",
        }}
      >
        {canvasVisible && (
          <>
            {/* Left ruler: 0.5" increments; numbers sit above tick lines */}
            <svg
              className="absolute pointer-events-none z-[2]"
              style={{ left: 0, top: RULER_SIZE, width: RULER_SIZE, height: canvasHeight }}
              viewBox={`0 0 ${RULER_SIZE} ${canvasHeight}`}
              preserveAspectRatio="none"
              aria-label="Vertical ruler"
            >
              <rect width={RULER_SIZE} height={canvasHeight} fill="hsl(var(--muted))" fillOpacity={0.5} stroke="hsl(var(--border))" strokeWidth={1} />
              {Array.from({ length: Math.floor(canvasHeight / PT_PER_HALF_INCH) + 1 }, (_, i) => {
                const y = i * PT_PER_HALF_INCH;
                if (y > canvasHeight) return null;
                const inches = y / PT_PER_INCH;
                const textY = y === 0 ? 6 : y - 6;
                return (
                  <g key={y}>
                    <line x1={18} y1={y} x2={24} y2={y} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.85} strokeWidth={1} />
                    <text x={10} y={textY} textAnchor="middle" dominantBaseline="middle" fill="hsl(var(--muted-foreground))" fontSize={9} fontWeight={500}>
                      {rulerLabel(inches)}
                    </text>
                  </g>
                );
              })}
              {canvasHeight % PT_PER_HALF_INCH !== 0 && (
                <g key={`v-end-${canvasHeight}`}>
                  <line x1={18} y1={canvasHeight} x2={24} y2={canvasHeight} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.85} strokeWidth={1} />
                  <text x={10} y={canvasHeight - 6} textAnchor="middle" dominantBaseline="middle" fill="hsl(var(--muted-foreground))" fontSize={9} fontWeight={500}>
                    {(canvasHeight / PT_PER_INCH).toFixed(1)}
                  </text>
                </g>
              )}
            </svg>
            {/* Top ruler: 0.5" increments; numbers sit above tick lines */}
            <svg
              className="absolute pointer-events-none z-[2]"
              style={{ left: RULER_SIZE, top: 0, width: canvasWidth, height: RULER_SIZE }}
              viewBox={`0 0 ${canvasWidth} ${RULER_SIZE}`}
              preserveAspectRatio="none"
              aria-label="Horizontal ruler"
            >
              <rect width={canvasWidth} height={RULER_SIZE} fill="hsl(var(--muted))" fillOpacity={0.5} stroke="hsl(var(--border))" strokeWidth={1} />
              {Array.from({ length: Math.floor(canvasWidth / PT_PER_HALF_INCH) + 1 }, (_, i) => {
                const x = i * PT_PER_HALF_INCH;
                if (x > canvasWidth) return null;
                const inches = x / PT_PER_INCH;
                return (
                  <g key={x}>
                    <line x1={x} y1={10} x2={x} y2={24} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.85} strokeWidth={1} />
                    <text x={i === 0 ? Math.max(6, x) : x} y={5} textAnchor="middle" dominantBaseline="middle" fill="hsl(var(--muted-foreground))" fontSize={9} fontWeight={500}>
                      {rulerLabel(inches)}
                    </text>
                  </g>
                );
              })}
              {canvasWidth % PT_PER_HALF_INCH !== 0 && (
                <g key={`h-end-${canvasWidth}`}>
                  <line x1={canvasWidth} y1={10} x2={canvasWidth} y2={24} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.85} strokeWidth={1} />
                  <text x={canvasWidth} y={5} textAnchor="middle" dominantBaseline="middle" fill="hsl(var(--muted-foreground))" fontSize={9} fontWeight={500}>
                    {(canvasWidth / PT_PER_INCH).toFixed(1)}
                  </text>
                </g>
              )}
            </svg>
          </>
        )}
            {/* Canvas area: background, guidelines, tiles (inset by RULER_SIZE so rulers sit outside) — always rendered */}
            <div
              className="absolute"
              style={{ left: RULER_SIZE, top: RULER_SIZE, width: canvasWidth, height: canvasHeight }}
            >
        {canvasVisible && (
          <>
              <div className="absolute inset-0 border border-border bg-background" />
              {/* Inch guidelines (1" = 72 pt) — true 1" boundaries; scale stamp and rulers align to these */}
              <svg
              className="absolute left-0 top-0 pointer-events-none z-[1]"
              width={canvasWidth}
              height={canvasHeight}
              viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
              preserveAspectRatio="none"
              aria-hidden
            >
              {Array.from({ length: Math.floor(canvasWidth / PT_PER_INCH) + 1 }, (_, i) => {
                const x = i * PT_PER_INCH;
                return (
                  <line
                    key={`v-${x}`}
                    x1={x}
                    y1={0}
                    x2={x}
                    y2={canvasHeight}
                    stroke="hsl(var(--muted-foreground))"
                    strokeOpacity={0.22}
                    strokeWidth={1}
                  />
                );
              })}
              {Array.from({ length: Math.floor(canvasHeight / PT_PER_INCH) + 1 }, (_, i) => {
                const y = i * PT_PER_INCH;
                return (
                  <line
                    key={`h-${y}`}
                    x1={0}
                    y1={y}
                    x2={canvasWidth}
                    y2={y}
                    stroke="hsl(var(--muted-foreground))"
                    strokeOpacity={0.22}
                    strokeWidth={1}
                  />
                );
              })}
            </svg>
          </>
        )}
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
      </div>
      {/* Content-delete overlay: portal so erase works outside canvas (e.g. rulers, viewport margin) */}
      {contentDeleteMode &&
        containerRect &&
        createPortal(
          <div
            className="fixed z-[100] cursor-crosshair"
            style={{
              left: containerRect.left,
              top: containerRect.top,
              width: containerRect.width,
              height: containerRect.height,
              pointerEvents: "auto",
            }}
            onPointerDown={(e) => {
              if (e.button === 0 && onContentDeleteRect) {
                const coords = clientToCanvas(e.clientX, e.clientY);
                if (coords) {
                  isDeleteSelectingRef.current = true;
                  setDeleteSelection({ start: coords, current: coords });
                  (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
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
                try {
                  (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
                } catch (_) {}
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
          />,
          document.body
        )}
      {/* Point/scale align overlay: portal with fixed position so preview is never clipped by canvas/container */}
      {(pointAlignMode || scaleAlignMode) &&
        (onPointAlignClick || onScaleAlignClick) &&
        containerRect &&
        createPortal(
          <div
            className="fixed z-[100] cursor-crosshair"
            style={{
              left: containerRect.left,
              top: containerRect.top,
              width: containerRect.width,
              height: containerRect.height,
              pointerEvents: "auto",
            }}
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
          >
            {/* Markers and lines in overlay (screen) space so they stay visible outside the canvas clip */}
            {(pointAlignPoints.some((p) => p != null) || scaleAlignPoints.some((p) => p != null)) && (() => {
              const zoom = Math.max(0.25, zoomLevel);
              const toOverlay = (p: { x: number; y: number }) => ({
                x: panOffset.x + (p.x + RULER_SIZE) * zoom,
                y: panOffset.y + (p.y + RULER_SIZE) * zoom,
              });
              const pts = pointAlignMode ? pointAlignPoints : scaleAlignPoints;
              // Scale with zoom; use larger minimums so markers stay visible when zoomed out
              const markerR = Math.max(10, 8 * zoom);
              const markerStroke = Math.max(2, 2.5 * zoom);
              const dashLen = Math.max(4, 5 * zoom);
              return (
                <svg
                  className="absolute left-0 top-0 w-full h-full pointer-events-none"
                  width={containerRect.width}
                  height={containerRect.height}
                  viewBox={`0 0 ${containerRect.width} ${containerRect.height}`}
                  preserveAspectRatio="none"
                >
                  {pts.map(
                    (p, i) =>
                      p && (() => {
                        const o = toOverlay(p);
                        return (
                          <g key={i}>
                            <circle
                              cx={o.x}
                              cy={o.y}
                              r={markerR}
                              fill="hsl(var(--primary))"
                              stroke="hsl(var(--background))"
                              strokeWidth={markerStroke}
                              opacity={0.9}
                            />
                            <text
                              x={o.x}
                              y={o.y}
                              textAnchor="middle"
                              dominantBaseline="central"
                              fill="hsl(var(--primary-foreground))"
                              fontSize={Math.max(14, 12 * zoom)}
                              fontWeight="bold"
                            >
                              {i + 1}
                            </text>
                          </g>
                        );
                      })()
                  )}
                  {pointAlignMode && pointAlignStep >= 2 && pointAlignPoints[0] && pointAlignPoints[1] && (() => {
                    const a = toOverlay(pointAlignPoints[0]);
                    const b = toOverlay(pointAlignPoints[1]);
                    return (
                      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="hsl(var(--primary))" strokeWidth={markerStroke} strokeDasharray={`${dashLen} ${dashLen}`} opacity={0.8} />
                    );
                  })()}
                  {pointAlignMode && pointAlignStep === 1 && pointAlignPoints[0] && pointAlignMouse && (() => {
                    const a = toOverlay(pointAlignPoints[0]);
                    const b = toOverlay(pointAlignMouse);
                    return (
                      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="hsl(var(--primary))" strokeWidth={markerStroke} strokeDasharray={`${dashLen} ${dashLen}`} opacity={0.7} />
                    );
                  })()}
                  {pointAlignMode && pointAlignStep === 3 && pointAlignPoints[2] && pointAlignMouse && (() => {
                    const a = toOverlay(pointAlignPoints[2]);
                    const b = toOverlay(pointAlignMouse);
                    return (
                      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="hsl(var(--primary))" strokeWidth={markerStroke} strokeDasharray={`${dashLen} ${dashLen}`} opacity={0.7} />
                    );
                  })()}
                  {scaleAlignMode && scaleAlignPoints[0] && scaleAlignPoints[1] && (() => {
                    const a = toOverlay(scaleAlignPoints[0]);
                    const b = toOverlay(scaleAlignPoints[1]);
                    return (
                      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="hsl(var(--primary))" strokeWidth={markerStroke} strokeDasharray={`${dashLen} ${dashLen}`} opacity={0.8} />
                    );
                  })()}
                  {scaleAlignMode && scaleAlignPoints[2] && scaleAlignPoints[3] && (() => {
                    const a = toOverlay(scaleAlignPoints[2]);
                    const b = toOverlay(scaleAlignPoints[3]);
                    return (
                      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="hsl(var(--primary))" strokeWidth={markerStroke} strokeDasharray={`${dashLen} ${dashLen}`} opacity={0.8} />
                    );
                  })()}
                </svg>
              );
            })()}
          </div>,
          document.body
        )}
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
