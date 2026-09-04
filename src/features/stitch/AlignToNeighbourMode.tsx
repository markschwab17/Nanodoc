/**
 * "Align to neighbour" — the on-canvas surface.
 *
 * One full-viewport overlay (portaled to the body, like the other stitch modes so the
 * markers are never clipped) that does four things:
 *   • dims every sheet except the one being moved, which IS the lock — there is no lock
 *     icon to find any more, and nothing else can be dragged while the mode is up;
 *   • takes the four clicks, snapping each to captured linework when **Snap to lines**
 *     is on, and paints A1/A2/B1/B2 with their connecting lines;
 *   • carries the loupe under the cursor for the four point clicks;
 *   • shows the step hint, the two toggles and — after a move — how far the second
 *     point actually landed from where it was asked to.
 *
 * A finished move returns to step 0 ("Pick the next sheet to move, or press Done"), so a
 * plan set is aligned neighbour by neighbour without leaving and re-entering the mode.
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
import { AlignLoupe } from "./AlignLoupe";
import { useLoupeRender } from "./useLoupeRender";
import type { AlignToNeighbour } from "./useAlignToNeighbour";
import type { StitchTile } from "./stitchTypes";

const POINT_LABELS = ["A1", "A2", "B1", "B2"] as const;

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
  const zoomLevel = useStitchStore((s) => s.zoomLevel);
  const panOffset = useStitchStore((s) => s.panOffset);

  const [hoverTileId, setHoverTileId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<CanvasPoint | null>(null);

  const loupe = useLoupeRender({
    active: align.showLoupe,
    zoom: zoomLevel,
    snapEnabled: align.snapToLines,
  });

  const { track, clear: clearLoupe, resolveClick } = loupe;

  // Leaving the point-click steps takes the magnifier (and its document) with it.
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

  const movingTile = useMemo(
    () => tiles.find((t) => t.id === align.movingTileId) ?? null,
    [tiles, align.movingTileId]
  );

  /** The sheets THIS step accepts — the hit test never looks at any other. */
  const clickable = useMemo(() => align.clickableTiles(tiles), [align, tiles]);

  /** Only the steps that draw a rubber band need the live cursor. */
  const wantsCursor = align.state.step === "A2" || align.state.step === "B2";

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const coords = clientToCanvas(e.clientX, e.clientY);
      setCursor(wantsCursor ? coords : null);
      // Hit-test ONLY the step's own sheets: along a matchline the sheets overlap, and
      // testing all of them let the neighbour on top swallow the click and blank the
      // loupe exactly where the work happens.
      const hit = coords ? hitTestTileAtPoint(coords, clickable, true) : null;
      setHoverTileId(align.state.step === "pickMoving" ? hit?.tile.id ?? null : null);
      if (!align.showLoupe) return;
      track(hit?.tile ?? null, hit?.point ?? null, { x: e.clientX, y: e.clientY });
    },
    [align.showLoupe, align.state.step, clickable, clientToCanvas, track, wantsCursor]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (beginPan(e)) return;
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const coords = clientToCanvas(e.clientX, e.clientY);
      const hit = coords ? hitTestTileAtPoint(coords, clickable, true) : null;
      if (!hit) {
        // Empty canvas, or a sheet this step will not take: say so rather than
        // swallowing the click silently.
        align.miss();
        return;
      }
      const point = align.showLoupe ? resolveClick(hit.tile, hit.point) : hit.point;
      align.click(hit.tile.id, point);
    },
    [align, beginPan, clickable, clientToCanvas, resolveClick]
  );

  const markerZoom = Math.max(ABSOLUTE_MIN_ZOOM, zoomLevel);
  const markerR = Math.max(9, 7 * markerZoom);
  const markerStroke = Math.max(2, 2.5 * markerZoom);
  const dash = Math.max(4, 5 * markerZoom);

  const pts = align.state.points;
  const liveFrom =
    align.state.step === "A2" ? pts[0] : align.state.step === "B2" ? pts[2] : null;

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
          {/* Locked sheets are dimmed to 40% — that dimming IS the lock. */}
          {tiles.map((tile) =>
            align.isLocked(tile.id) ? (
              <polygon
                key={`dim-${tile.id}`}
                points={tilePolygon(tile)}
                fill="hsl(var(--background))"
                opacity={0.6}
              />
            ) : null
          )}
          {/* Step 0: whatever the cursor is over is what a click would pick up. */}
          {align.state.step === "pickMoving" &&
            hoverTileId &&
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
          {/* The sheet that is moving stays outlined for the rest of the mode. */}
          {movingTile && (
            <polygon
              points={tilePolygon(movingTile)}
              fill="none"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              strokeDasharray={`${dash * 2} ${dash}`}
              opacity={0.9}
            />
          )}
          {/* A1→A2 and B1→B2, plus the rubber band to the cursor. */}
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
                  <g key={POINT_LABELS[i]}>
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
                      {POINT_LABELS[i]}
                    </text>
                  </g>
                );
              })()
            ) : null
          )}
        </svg>

        {/* Mode bar. Inside the overlay so it moves with the canvas viewport, but it
            takes its own pointer events so the toggles are clickable. */}
        <div
          className="absolute left-1/2 -translate-x-1/2 bottom-4 flex items-center gap-3 rounded-lg border bg-popover/95 px-3 py-2 text-xs shadow-lg"
          style={{ pointerEvents: "auto" }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerMove={(e) => e.stopPropagation()}
        >
          <span className="font-semibold shrink-0">Align to neighbour</span>
          <span
            className={cn("shrink-0", align.refusal ? "text-destructive font-medium" : "text-muted-foreground")}
            role="status"
            aria-live="polite"
          >
            {align.refusal?.message ?? align.hint}
          </span>
          {align.seamNote && (
            <span className="shrink-0 rounded bg-primary/10 px-2 py-0.5 font-medium text-primary">
              {align.seamNote}
            </span>
          )}
          <label className="flex items-center gap-1.5 shrink-0 cursor-pointer select-none">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
              checked={align.matchScale}
              onChange={(e) => align.setMatchScale(e.target.checked)}
            />
            Match scale
          </label>
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
