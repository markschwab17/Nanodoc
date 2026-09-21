/**
 * Overlay when 2+ tiles are selected: group bounding box with collective move, resize, and rotate.
 * Rotate: drag the rotate handle for custom 360° rotation (same as single-tile in StitchTile).
 */

import { useCallback, useRef, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getGroupBounds } from "./stitchGeometry";
import { ABSOLUTE_MIN_ZOOM, HANDLE_SIZE, RESIZE_CURSORS, RULER_SIZE } from "./stitchConstants";
import {
  OVERLAY_ACCENT,
  OVERLAY_INK,
  OVERLAY_PAPER,
  OVERLAY_PILL_STYLE,
  RING_SCREEN_PX,
  badgeLeftInset,
  badgePlacement,
  screenPx,
} from "./canvasOverlayStyle";

function angleDeg(clientX: number, clientY: number, centerX: number, centerY: number): number {
  return Math.atan2(clientY - centerY, clientX - centerX) * (180 / Math.PI);
}

export function GroupSelectionOverlay() {
  const tiles = useStitchStore((s) => s.tiles);
  const selectedTileIds = useStitchStore((s) => s.selectedTileIds);
  const groups = useStitchStore((s) => s.groups);
  const updateTilesNoUndo = useStitchStore((s) => s.updateTilesNoUndo);
  const zoomLevel = useStitchStore((s) => s.zoomLevel);
  const resizeLocked = useStitchStore((s) => s.resizeLocked);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [rotationDragStart, setRotationDragStart] = useState<{
    startAngleDeg: number;
    centerScreenX: number;
    centerScreenY: number;
    groupCenterX: number;
    groupCenterY: number;
    tileSnapshots: Array<{ id: string; x: number; y: number; width: number; height: number; rotation: number }>;
  } | null>(null);

  const selectedTiles = useMemo(
    () => tiles.filter((t) => selectedTileIds.includes(t.id)),
    [tiles, selectedTileIds]
  );
  const unlockedTiles = useMemo(
    () => selectedTiles.filter((t) => !t.locked),
    [selectedTiles]
  );
  const bounds = useMemo(() => getGroupBounds(selectedTiles), [selectedTiles]);
  /** "3 sheets" — plus the group's name and colour when the selection IS one group. */
  const groupLabel = useMemo(() => {
    const text = `${selectedTiles.length} sheet${selectedTiles.length === 1 ? "" : "s"}`;
    const groupIds = [...new Set(selectedTiles.map((t) => t.groupId).filter((g): g is string => !!g))];
    const whole =
      groupIds.length === 1 && selectedTiles.every((t) => t.groupId === groupIds[0])
        ? groups[groupIds[0]]
        : undefined;
    return whole
      ? { text: `${text} · ${whole.name}`, dotColor: whole.color }
      : { text, dotColor: null as string | null };
  }, [selectedTiles, groups]);
  const groupCenter = useMemo(
    () => ({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }),
    [bounds]
  );

  const resizeStartRef = useRef<{
    dir: string;
    clientX: number;
    clientY: number;
    boundsX: number;
    boundsY: number;
    boundsW: number;
    boundsH: number;
    tiles: Array<{ id: string; x: number; y: number; width: number; height: number }>;
    centerX: number;
    centerY: number;
  } | null>(null);

  // Actual zoom (see StitchTile): MIN_ZOOM is no longer the floor, so clamping to it would
  // scale group drags/handles wrong once the user is zoomed further out than 25%.
  const scale = Math.max(ABSOLUTE_MIN_ZOOM, zoomLevel);
  /** Where the label goes: above the box, or inside it when the box's top is off the
   *  top of the viewport (the badge used to be clipped away up there). */
  const panOffsetY = useStitchStore((s) => s.panOffset.y);
  const panOffsetX = useStitchStore((s) => s.panOffset.x);
  const badgeSpot = badgePlacement(panOffsetY + (bounds.y + RULER_SIZE) * scale);
  /** Same idea for the left edge, in canvas units (this layer is scaled by `scale`). */
  const badgeLeft = badgeLeftInset(panOffsetX + (bounds.x + RULER_SIZE) * scale) / scale;

  const handleResizeStart = useCallback(
    (e: React.PointerEvent, dir: string) => {
      // The right button opens the context menu; it must not start a resize (which
      // pushes an undo snapshot and clears redo for a click that moves nothing).
      if (e.button === 2) return;
      e.stopPropagation();
      if (resizeLocked || unlockedTiles.length === 0) return;
      // Push undo snapshot before continuous resize
      useStitchStore.getState().pushUndoSnapshot();
      const centerX = bounds.x + bounds.width / 2;
      const centerY = bounds.y + bounds.height / 2;
      resizeStartRef.current = {
        dir,
        clientX: e.clientX,
        clientY: e.clientY,
        boundsX: bounds.x,
        boundsY: bounds.y,
        boundsW: bounds.width,
        boundsH: bounds.height,
        tiles: unlockedTiles.map((t) => ({ id: t.id, x: t.x, y: t.y, width: t.width, height: t.height })),
        centerX,
        centerY,
      };
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [bounds, unlockedTiles, resizeLocked]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const resize = resizeStartRef.current;
      if (!resize) return;
      const dx = (e.clientX - resize.clientX) / scale;
      const dy = (e.clientY - resize.clientY) / scale;
        const MIN = 20;
        let newW = resize.boundsW;
        let newH = resize.boundsH;
        const cx = resize.centerX;
        const cy = resize.centerY;

        if (resize.dir.includes("e")) newW = Math.max(MIN, resize.boundsW + dx);
        if (resize.dir.includes("w")) newW = Math.max(MIN, resize.boundsW - dx);
        if (resize.dir.includes("s")) newH = Math.max(MIN, resize.boundsH + dy);
        if (resize.dir.includes("n")) newH = Math.max(MIN, resize.boundsH - dy);

        const scaleX = newW / resize.boundsW;
        const scaleY = newH / resize.boundsH;
        // Edge handles change only one axis — the other stays 1, so min()
        // would clamp growth to a no-op. Use the dragged axis for edges,
        // min() only for corners (uniform, conservative).
        const isEdgeHandle = resize.dir.length === 1;
        const s = isEdgeHandle
          ? resize.dir === "e" || resize.dir === "w"
            ? scaleX
            : scaleY
          : Math.min(scaleX, scaleY);

        const updates = resize.tiles.map((t) => {
          const tcx = t.x + t.width / 2;
          const tcy = t.y + t.height / 2;
          const newCx = cx + (tcx - cx) * s;
          const newCy = cy + (tcy - cy) * s;
          const newWidth = t.width * s;
          const newHeight = t.height * s;
          return {
            id: t.id,
            patch: {
              x: newCx - newWidth / 2,
              y: newCy - newHeight / 2,
              width: newWidth,
              height: newHeight,
            },
          };
        });
        updateTilesNoUndo(updates);
    },
    [scale, updateTilesNoUndo]
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    resizeStartRef.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch (_) {}
  }, []);

  const handleRotatePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button === 2) return;
      e.stopPropagation();
      e.preventDefault();
      if (resizeLocked || unlockedTiles.length === 0) return;
      // Push undo snapshot before continuous rotation
      useStitchStore.getState().pushUndoSnapshot();
      const el = overlayRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const centerScreenX = rect.left + rect.width / 2;
      const centerScreenY = rect.top + rect.height / 2;
      const startAngleDeg = angleDeg(e.clientX, e.clientY, centerScreenX, centerScreenY);
      setRotationDragStart({
        startAngleDeg,
        centerScreenX,
        centerScreenY,
        groupCenterX: groupCenter.x,
        groupCenterY: groupCenter.y,
        tileSnapshots: unlockedTiles.map((t) => ({
          id: t.id,
          x: t.x,
          y: t.y,
          width: t.width,
          height: t.height,
          rotation: (t.rotation ?? 0) % 360,
        })),
      });
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [groupCenter, unlockedTiles, resizeLocked]
  );

  const handleRotatePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!rotationDragStart) return;
      const currentAngleDeg = angleDeg(
        e.clientX,
        e.clientY,
        rotationDragStart.centerScreenX,
        rotationDragStart.centerScreenY
      );
      let deltaDeg = currentAngleDeg - rotationDragStart.startAngleDeg;
      if (deltaDeg > 180) deltaDeg -= 360;
      if (deltaDeg < -180) deltaDeg += 360;
      const rad = (deltaDeg * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const cx = rotationDragStart.groupCenterX;
      const cy = rotationDragStart.groupCenterY;
      const updates = rotationDragStart.tileSnapshots.map((t) => {
        const tcx = t.x + t.width / 2;
        const tcy = t.y + t.height / 2;
        const newCx = cx + (tcx - cx) * cos - (tcy - cy) * sin;
        const newCy = cy + (tcx - cx) * sin + (tcy - cy) * cos;
        const newRotation = (t.rotation + deltaDeg + 360) % 360;
        return {
          id: t.id,
          patch: {
            x: newCx - t.width / 2,
            y: newCy - t.height / 2,
            rotation: newRotation,
          },
        };
      });
      updateTilesNoUndo(updates);
    },
    [rotationDragStart, updateTilesNoUndo]
  );

  const handleRotatePointerUp = useCallback(
    (e: React.PointerEvent) => {
      setRotationDragStart(null);
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    },
    []
  );

  if (selectedTileIds.length < 2) return null;

  // Controls live inside the zoom-scaled canvas — divide by zoom so they stay
  // a constant size on screen.
  const invZoom = 1 / scale;
  const hs = HANDLE_SIZE * invZoom;
  const buttonPx = 32 * 0.9 * invZoom;
  const buttonTop = -48 * invZoom;
  const pos: Record<string, CSSProperties> = {
    nw: { left: -hs / 2, top: -hs / 2 },
    n: { left: "50%", top: -hs / 2, marginLeft: -hs / 2 },
    ne: { left: "100%", top: -hs / 2, marginLeft: -hs / 2 },
    e: { left: "100%", top: "50%", marginLeft: -hs / 2, marginTop: -hs / 2 },
    se: { left: "100%", top: "100%", marginLeft: -hs / 2, marginTop: -hs / 2 },
    s: { left: "50%", top: "100%", marginLeft: -hs / 2, marginTop: -hs / 2 },
    sw: { left: -hs / 2, top: "100%", marginTop: -hs / 2 },
    w: { left: -hs / 2, top: "50%", marginTop: -hs / 2 },
  };

  return (
    <div
      ref={overlayRef}
      data-stitch-group-overlay
      className="absolute pointer-events-none z-[5]"
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
        // Fixed accent with a white counter-line, at a real 3 screen px whatever the
        // zoom — at a fit zoom of 14 % the old 2px border was a quarter of a pixel.
        border: `${screenPx(RING_SCREEN_PX, scale)}px solid ${OVERLAY_ACCENT}`,
        boxShadow: `0 0 0 ${screenPx(1, scale)}px ${OVERLAY_PAPER}, inset 0 0 0 ${screenPx(1, scale)}px ${OVERLAY_PAPER}`,
      }}
    >
      {/* What is selected, in words, pinned to the box. A ring alone does not survive a
          zoomed-out canvas full of sheets — Mark could not tell whether one or several
          were selected. The label sits ABOVE the box and scales down with the zoom so
          it stays the same size on screen. */}
      <div
        className="absolute flex items-center gap-1.5 whitespace-nowrap rounded px-1.5 py-0.5 font-medium shadow"
        style={{
          left: badgeLeft,
          top: 0,
          // Above the box, unless the box's top edge is off the top of the viewport —
          // then inside it, because a badge above that is simply clipped away.
          transform:
            badgeSpot === "above"
              ? `translate(0, -100%) translate(0, ${-4 * invZoom}px) scale(${invZoom})`
              : `translate(${4 * invZoom}px, ${4 * invZoom}px) scale(${invZoom})`,
          transformOrigin: badgeSpot === "above" ? "left bottom" : "left top",
          fontSize: 11,
          // An opaque INK pill with white text, never the group's colour behind white
          // text — that was unreadable on amber, and invisible in dark mode when the
          // pill came from a theme token.
          ...OVERLAY_PILL_STYLE,
        }}
      >
        {groupLabel.dotColor && (
          <span
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ background: groupLabel.dotColor }}
            aria-hidden
          />
        )}
        {groupLabel.text}
      </div>
      {!resizeLocked && (["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map((dir) => (
        <div
          key={dir}
          // White fill, dark border — fixed colours over paper (canvasOverlayStyle).
          className="absolute rounded-md shadow-md pointer-events-auto"
          style={{
            width: hs,
            height: hs,
            background: OVERLAY_PAPER,
            borderStyle: "solid",
            borderColor: OVERLAY_INK,
            borderWidth: 2 * invZoom,
            cursor: RESIZE_CURSORS[dir] ?? "se-resize",
            ...pos[dir],
          }}
          onPointerDown={(e) => {
            handleResizeStart(e, dir);
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
        />
      ))}
      {!resizeLocked && (
        <Button
          type="button"
          variant="secondary"
          size="icon"
          className="absolute left-1/2 -translate-x-1/2 z-10 border-2 border-border shadow-md pointer-events-auto cursor-grab active:cursor-grabbing"
          style={{ width: buttonPx, height: buttonPx, top: buttonTop }}
          title="Drag to rotate group"
          onPointerDown={handleRotatePointerDown}
          onPointerMove={handleRotatePointerMove}
          onPointerUp={handleRotatePointerUp}
          onPointerLeave={handleRotatePointerUp}
        >
          <RotateCw className="h-full w-full shrink-0" />
        </Button>
      )}
    </div>
  );
}
