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
import { HANDLE_SIZE, RESIZE_CURSORS } from "./stitchConstants";

function angleDeg(clientX: number, clientY: number, centerX: number, centerY: number): number {
  return Math.atan2(clientY - centerY, clientX - centerX) * (180 / Math.PI);
}

export function GroupSelectionOverlay() {
  const { tiles, selectedTileIds, updateTilesNoUndo, zoomLevel, resizeLocked } = useStitchStore();
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

  const scale = Math.max(0.25, zoomLevel);

  const handleResizeStart = useCallback(
    (e: React.PointerEvent, dir: string) => {
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
        const s = Math.min(scaleX, scaleY);

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

  const pos: Record<string, CSSProperties> = {
    nw: { left: -HANDLE_SIZE / 2, top: -HANDLE_SIZE / 2 },
    n: { left: "50%", top: -HANDLE_SIZE / 2, marginLeft: -HANDLE_SIZE / 2 },
    ne: { left: "100%", top: -HANDLE_SIZE / 2, marginLeft: -HANDLE_SIZE / 2 },
    e: { left: "100%", top: "50%", marginLeft: -HANDLE_SIZE / 2, marginTop: -HANDLE_SIZE / 2 },
    se: { left: "100%", top: "100%", marginLeft: -HANDLE_SIZE / 2, marginTop: -HANDLE_SIZE / 2 },
    s: { left: "50%", top: "100%", marginLeft: -HANDLE_SIZE / 2, marginTop: -HANDLE_SIZE / 2 },
    sw: { left: -HANDLE_SIZE / 2, top: "100%", marginTop: -HANDLE_SIZE / 2 },
    w: { left: -HANDLE_SIZE / 2, top: "50%", marginTop: -HANDLE_SIZE / 2 },
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
        border: "2px solid hsl(var(--primary))",
        boxShadow: "0 0 0 1px hsl(var(--primary) / 0.3)",
      }}
    >
      {!resizeLocked && (["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map((dir) => (
        <div
          key={dir}
          className="absolute bg-primary rounded-md border-2 border-white shadow-md pointer-events-auto"
          style={{
            width: HANDLE_SIZE,
            height: HANDLE_SIZE,
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
          className="absolute -top-12 left-1/2 -translate-x-1/2 h-10 w-10 z-10 border-2 border-border shadow-md pointer-events-auto cursor-grab active:cursor-grabbing"
          title="Drag to rotate group"
          onPointerDown={handleRotatePointerDown}
          onPointerMove={handleRotatePointerMove}
          onPointerUp={handleRotatePointerUp}
          onPointerLeave={handleRotatePointerUp}
        >
          <RotateCw className="h-5 w-5" />
        </Button>
      )}
    </div>
  );
}
