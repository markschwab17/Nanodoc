/**
 * "Align to neighbour" — the on-canvas surface.
 *
 * The first click anchors the sheet that STAYS; the second names the sheet that moves
 * to meet it (Mark: "when you click the first PDF, that should be the PDF that doesn't
 * move"). One full-viewport overlay (portaled to the body, like the other stitch modes
 * so the markers are never clipped) that does four things:
 *   • fades whatever the current step will not take a click on — the anchor, once it
 *     has been chosen — which IS the lock: there is no lock icon to find any more, and
 *     nothing else can be dragged while the mode is up;
 *   • takes the point clicks — one each side by default, two each with **Rotate too** —
 *     snapping each to captured linework when **Snap to lines** is on, and paints the
 *     markers with their connecting lines;
 *   • carries the loupe under the cursor for the four point clicks;
 *   • shows the step hint, the two toggles and — after a move — how far the second
 *     point actually landed from where it was asked to.
 *
 * A finished pair returns to the anchor click with BOTH sheets in the group, so a plan
 * set is built one neighbour at a time without leaving the mode.
 *
 * Middle-drag pan, the space-bar pan and the wheel zoom all keep working: pointerdown is
 * offered to the canvas's shared pan first (`beginPan` takes the middle button, and the
 * left button while Space is held), and the wheel handler already looks through
 * `[data-stitch-overlay]`, which this overlay carries.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { ABSOLUTE_MIN_ZOOM, RULER_SIZE } from "./stitchConstants";
import { hitTestTileAtPoint, tileLocalToCanvas, type CanvasPoint } from "./stitchGeometry";
import { alignHitForStep, alignPointerEvent } from "./alignToNeighbourMachine";
import { AlignLoupe } from "./AlignLoupe";
import { useLoupeRender } from "./useLoupeRender";
import type { AlignToNeighbour } from "./useAlignToNeighbour";
import type { StitchTile } from "./stitchTypes";

/** [F1, F2, M1, M2] — F on the sheet that stays, M on the sheet that moves. */
const POINT_LABELS_2 = ["F1", "F2", "M1", "M2"] as const;
/** One point each side: there is no "1" and "2" to distinguish. */
const POINT_LABELS_1 = ["F", "", "M", ""] as const;

export interface AlignToNeighbourModeProps {
  align: AlignToNeighbour;
  /** Client rect of the canvas viewport. */
  containerRect: DOMRect;
  clientToCanvas: (clientX: number, clientY: number) => CanvasPoint | null;
  /** The canvas's shared pan (middle button, or left while Space is held); returns
   *  true when it took the event. */
  beginPan: (e: React.PointerEvent) => boolean;
  preventMiddleAutoscroll: (e: React.MouseEvent) => void;
  isMiddlePan: boolean;
}

export function AlignToNeighbourMode({
  align,
  containerRect,
  clientToCanvas,
  beginPan,
  preventMiddleAutoscroll,
  isMiddlePan,
}: AlignToNeighbourModeProps) {
  const tiles = useStitchStore((s) => s.tiles);
  const tileRasters = useStitchStore((s) => s.tileRasters);
  const groups = useStitchStore((s) => s.groups);
  const zoomLevel = useStitchStore((s) => s.zoomLevel);
  const panOffset = useStitchStore((s) => s.panOffset);

  const [hoverTileId, setHoverTileId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<CanvasPoint | null>(null);

  // Keyed on the SESSION, not on the four point steps: a session aligns one neighbour
  // after another, and tearing the worker, the open documents and the captured
  // geometry down between moves meant paying for all of it again on the next sheet.
  // It all goes when the mode exits (or the overlay unmounts).
  const loupe = useLoupeRender({
    active: align.active,
    zoom: zoomLevel,
    snapEnabled: align.snapToLines,
  });

  const { track, clear: clearLoupe, resolveClick } = loupe;

  // The magnifier itself is per-step: between moves there is nothing to magnify, so
  // the view is dropped (the documents and grids behind it stay).
  useEffect(() => {
    if (!align.showLoupe) clearLoupe();
  }, [align.showLoupe, clearLoupe]);

  const toOverlay = useCallback(
    (p: CanvasPoint) => ({
      x: panOffset.x + (p.x + RULER_SIZE) * zoomLevel,
      y: panOffset.y + (p.y + RULER_SIZE) * zoomLevel,
    }),
    [panOffset.x, panOffset.y, zoomLevel]
  );

  /** Corner polygon of a tile in overlay (screen) space, rotation included. */
  const tilePolygon = useCallback(
    (tile: StitchTile) =>
      [
        tileLocalToCanvas(0, 0, tile),
        tileLocalToCanvas(tile.width, 0, tile),
        tileLocalToCanvas(tile.width, tile.height, tile),
        tileLocalToCanvas(0, tile.height, tile),
      ]
        .map(toOverlay)
        .map((p) => `${p.x},${p.y}`)
        .join(" "),
    [toOverlay]
  );

  /** The anchor, once chosen: outlined for the rest of the pair so it is obvious
   *  which sheet everything is being brought to. */
  const anchorTile = useMemo(
    () => tiles.find((t) => t.id === align.state.fixedTileId) ?? null,
    [tiles, align.state.fixedTileId]
  );

  /**
   * The sheet a press lands on for the CURRENT step.
   *
   * At step 0 the sheets this session has already placed are tried last: aligning
   * sheet 2 onto sheet 1 routinely leaves it covering the grid slot sheet 3 is still
   * in, and a plain top-most test then handed the next click back to sheet 2 — the
   * mode peeled the sheet it had just placed instead of bringing in the next one.
   */
  /** Part of the composition already: this session placed it, or it is in a group. */
  const isPlaced = useCallback(
    (tileId: string) =>
      align.isPlaced(tileId) || Boolean(tiles.find((t) => t.id === tileId)?.groupId),
    [align, tiles]
  );

  const hitForStep = useCallback(
    (coords: CanvasPoint) => alignHitForStep(coords, align.state, tiles, isPlaced),
    [align.state, isPlaced, tiles]
  );

  /** Only the steps that draw a rubber band need the live cursor. In one-point mode
   *  that band runs from the anchor point to the cursor — it IS the move. */
  const wantsCursor =
    align.state.step === "F2" ||
    align.state.step === "M2" ||
    (!align.twoPoint && align.state.step === "M1");

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const coords = clientToCanvas(e.clientX, e.clientY);
      setCursor(wantsCursor ? coords : null);
      // Hit-test ONLY the step's own sheets: along a matchline the sheets overlap, and
      // testing all of them let the neighbour on top swallow the click and blank the
      // loupe exactly where the work happens.
      const hit = coords ? hitForStep(coords) : null;
      // Only the two steps that CHOOSE a sheet need the highlight; on the others the
      // sheet is already settled and a hover glow is just noise.
      const choosing = align.state.step === "F1" || align.state.step === "M1";
      setHoverTileId(choosing ? hit?.tile.id ?? null : null);
      if (!align.showLoupe) return;
      track(hit?.tile ?? null, hit?.point ?? null, { x: e.clientX, y: e.clientY });
    },
    [align.showLoupe, align.state.step, clientToCanvas, hitForStep, track, wantsCursor]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (beginPan(e)) return;
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const coords = clientToCanvas(e.clientX, e.clientY);
      const scoped = coords ? hitForStep(coords) : null;
      // A press that missed the step's own sheets may still have landed on another
      // one: that is a WRONG SHEET, and it must be refused by name rather than read as
      // a click into empty space.
      const unscoped = coords && !scoped ? hitTestTileAtPoint(coords, tiles, true) : null;
      const event = alignPointerEvent(
        scoped ? { tileId: scoped.tile.id, point: scoped.point } : null,
        unscoped ? { tileId: unscoped.tile.id, point: unscoped.point } : null
      );
      if (event.type === "miss") {
        align.miss();
        return;
      }
      // Only a click the step will actually take gets snapped — a refusal records
      // nothing, so there is nothing to snap.
      const point = scoped && align.showLoupe ? resolveClick(scoped.tile, event.point) : event.point;
      align.click(event.tileId, point);
    },
    [align, beginPan, clientToCanvas, hitForStep, resolveClick, tiles]
  );

  const markerZoom = Math.max(ABSOLUTE_MIN_ZOOM, zoomLevel);
  const markerR = Math.max(9, 7 * markerZoom);
  const markerStroke = Math.max(2, 2.5 * markerZoom);
  const dash = Math.max(4, 5 * markerZoom);

  const pts = align.state.points;
  const pointLabels = align.twoPoint ? POINT_LABELS_2 : POINT_LABELS_1;
  const liveFrom =
    align.state.step === "F2" || (!align.twoPoint && align.state.step === "M1")
      ? pts[0]
      : align.state.step === "M2"
        ? pts[2]
        : null;

  const loupeSubjectTile = useMemo(
    () => (loupe.view ? tiles.find((t) => t.id === loupe.view!.tileId) ?? null : null),
    [loupe.view, tiles]
  );

  return createPortal(
    <>
      <div
        data-stitch-overlay
        className={cn("fixed z-[100]", isMiddlePan ? "cursor-grabbing" : "cursor-crosshair")}
        style={{
          left: containerRect.left,
          top: containerRect.top,
          width: containerRect.width,
          height: containerRect.height,
          pointerEvents: "auto",
          touchAction: "none",
        }}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => {
          setHoverTileId(null);
          setCursor(null);
          clearLoupe();
        }}
        onMouseDown={preventMiddleAutoscroll}
        onPointerDown={handlePointerDown}
      >
        <svg
          className="absolute left-0 top-0 w-full h-full pointer-events-none"
          width={containerRect.width}
          height={containerRect.height}
          viewBox={`0 0 ${containerRect.width} ${containerRect.height}`}
          preserveAspectRatio="none"
        >
          {/* A scrim over the sheet this step will NOT take a click on: the ANCHOR,
              while the sheet to move is being chosen. Its point is already placed and
              marked, and it usually lies over the sheets being chosen between — Mark
              caught the cost of getting this backwards, aiming at a sheet the mode had
              greyed out. The markers are drawn after this, so they stay legible. */}
          {tiles.map((tile) => {
            const opacity = align.sheetOpacity(tile.id);
            return opacity < 1 ? (
              <polygon
                key={`dim-${tile.id}`}
                points={tilePolygon(tile)}
                fill="hsl(var(--background))"
                opacity={1 - opacity}
              />
            ) : null;
          })}
          {/* The composition so far: every sheet this session has anchored to or
              moved. Outlined on the two steps that CHOOSE a sheet, which is exactly
              when the user is asking "what have I already placed" — and the move click
              prefers a sheet that is NOT one of them.
              Undo does not remove a sheet from the group; it only orders that
              preference, and the next pair re-adds whatever it touches. */}
          {(align.state.step === "F1" || align.state.step === "M1") &&
            tiles.map((tile) => {
              // A sheet is part of the composition if this session placed it OR it is
              // in a group — after the first pair those are the same thing, and the
              // group is the durable record. Outlined in the GROUP's own colour so two
              // separate compositions on one canvas do not read as one.
              const color = tile.groupId ? groups[tile.groupId]?.color : undefined;
              if (!color && !align.isPlaced(tile.id)) return null;
              return (
                <polygon
                  key={`placed-${tile.id}`}
                  points={tilePolygon(tile)}
                  fill="none"
                  stroke={color ?? "hsl(var(--primary))"}
                  strokeWidth={1.5}
                  opacity={color ? 0.7 : 0.45}
                />
              );
            })}
          {/* Whatever the cursor is over is what a click would take. */}
          {hoverTileId &&
            (() => {
              const tile = tiles.find((t) => t.id === hoverTileId);
              if (!tile) return null;
              return (
                <polygon
                  points={tilePolygon(tile)}
                  fill="hsl(var(--primary))"
                  fillOpacity={0.12}
                  stroke="hsl(var(--primary))"
                  strokeWidth={3}
                />
              );
            })()}
          {/* The anchor stays outlined for the rest of the pair. */}
          {anchorTile && (
            <polygon
              points={tilePolygon(anchorTile)}
              fill="none"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              strokeDasharray={`${dash * 2} ${dash}`}
              opacity={0.9}
            />
          )}
          {/* F1→F2 and M1→M2, plus the rubber band to the cursor. */}
          {pts[0] && pts[1] && (() => {
            const a = toOverlay(pts[0]);
            const b = toOverlay(pts[1]);
            return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="hsl(var(--primary))" strokeWidth={markerStroke} strokeDasharray={`${dash} ${dash}`} opacity={0.85} />;
          })()}
          {pts[2] && pts[3] && (() => {
            const a = toOverlay(pts[2]);
            const b = toOverlay(pts[3]);
            return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="hsl(var(--primary))" strokeWidth={markerStroke} strokeDasharray={`${dash} ${dash}`} opacity={0.85} />;
          })()}
          {liveFrom && cursor && (() => {
            const a = toOverlay(liveFrom);
            const b = toOverlay(cursor);
            return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="hsl(var(--primary))" strokeWidth={markerStroke} strokeDasharray={`${dash} ${dash}`} opacity={0.6} />;
          })()}
          {pts.map((p, i) =>
            p ? (
              (() => {
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
                      opacity={0.92}
                    />
                    <text
                      x={o.x}
                      y={o.y}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fill="hsl(var(--primary-foreground))"
                      fontSize={Math.max(11, 10 * markerZoom)}
                      fontWeight="bold"
                    >
                      {pointLabels[i]}
                    </text>
                  </g>
                );
              })()
            ) : null
          )}
        </svg>

        {/* Mode bar. Inside the overlay so it moves with the canvas viewport, but it
            takes its own pointer events so the toggles are clickable.

            It WRAPS. On a narrow window (or the CTO takeoff panel, which is narrower
            still) the single row ran off the side of the screen and the hint was cut
            in half — so the bar is capped at the viewport, the hint truncates with its
            full text on hover, and the toggles drop to a second row rather than
            pushing anything out of sight. */}
        <div
          className="absolute left-1/2 -translate-x-1/2 bottom-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 rounded-lg border bg-popover/95 px-3 py-2 text-xs text-popover-foreground shadow-lg"
          style={{ pointerEvents: "auto", maxWidth: "calc(100vw - 32px)" }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerMove={(e) => {
            // The bar swallows the move, so the overlay never sees the cursor leave the
            // sheet — without this the magnifier hangs where it last was.
            e.stopPropagation();
            clearLoupe();
          }}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="font-semibold shrink-0">Align to neighbour</span>
            <span
              className={cn(
                "min-w-0 truncate",
                align.refusal ? "text-destructive font-medium" : "text-muted-foreground"
              )}
              title={align.refusal?.message ?? align.hint}
              role="status"
              aria-live="polite"
            >
              {align.refusal?.message ?? align.hint}
            </span>
          </div>
          {align.seamNote && (
            <span className="min-w-0 truncate rounded bg-primary/10 px-2 py-0.5 font-medium text-primary" title={align.seamNote}>
              {align.seamNote}
            </span>
          )}
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
            <label className="flex items-center gap-1.5 shrink-0 cursor-pointer select-none">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                checked={align.twoPoint}
                onChange={(e) => align.setTwoPoint(e.target.checked)}
              />
              Rotate too (2 points)
            </label>
            {/* Only meaningful with a second point: scale is the ratio of two spans. */}
            {align.twoPoint && (
              <label className="flex items-center gap-1.5 shrink-0 cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                  checked={align.matchScale}
                  onChange={(e) => align.setMatchScale(e.target.checked)}
                />
                Match scale
              </label>
            )}
            <label className="flex items-center gap-1.5 shrink-0 cursor-pointer select-none">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
                checked={align.snapToLines}
                onChange={(e) => align.setSnapToLines(e.target.checked)}
              />
              Snap to lines
            </label>
            <Button variant="ghost" size="sm" className="h-6 shrink-0" onClick={align.exit}>
              {align.state.lastMovedTileId ? "Done" : "Cancel"}
            </Button>
          </div>
        </div>
      </div>

      {align.showLoupe && (
        <AlignLoupe
          view={loupe.view}
          cropCanvas={loupe.cropCanvas}
          tile={loupeSubjectTile}
          fallbackUrl={
            loupeSubjectTile
              ? loupeSubjectTile.imageDataUrl ?? tileRasters[loupeSubjectTile.id]
              : undefined
          }
          viewport={{
            left: containerRect.left,
            top: containerRect.top,
            width: containerRect.width,
            height: containerRect.height,
          }}
          hint={align.hint}
        />
      )}
    </>,
    document.body
  );
}
