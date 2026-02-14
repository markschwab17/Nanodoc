/**
 * Single tile on the stitch canvas: image, drag to move, resize handles when selected, rotate.
 * Rotation: drag the rotate handle for custom 360° rotation (like main app); angle stored in degrees.
 */

import { useCallback, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { StitchTile as StitchTileType } from "@/shared/stores/stitchStore";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { snapTilePosition } from "@/features/stitch/snapToEdges";
import { HANDLE_SIZE, RESIZE_CURSORS } from "@/features/stitch/stitchConstants";
import { Lock, RotateCw, Unlock } from "lucide-react";
import { Button } from "@/components/ui/button";

type DragStart =
  | { type: "single"; x: number; y: number; tileX: number; tileY: number }
  | {
      type: "group";
      x: number;
      y: number;
      positions: Array<{ id: string; x: number; y: number }>;
    };

function angleDeg(clientX: number, clientY: number, centerX: number, centerY: number): number {
  return Math.atan2(clientY - centerY, clientX - centerX) * (180 / Math.PI);
}

export function StitchTile({ tile, zoomLevel }: { tile: StitchTileType; zoomLevel: number }) {
  const {
    updateTile,
    updateTiles,
    setSelectedTileIds,
    selectedTileIds,
    snapToEdges,
    tiles,
    canvasWidth,
    canvasHeight,
  } = useStitchStore();
  const isSelected = selectedTileIds.includes(tile.id);
  const isSingleSelected = selectedTileIds.length === 1 && selectedTileIds[0] === tile.id;
  const isLocked = Boolean(tile.locked);
  const dragStartRef = useRef<DragStart | null>(null);
  const tileContainerRef = useRef<HTMLDivElement | null>(null);
  const [rotationDragStart, setRotationDragStart] = useState<{
    initialRotationDeg: number;
    startAngleDeg: number;
    centerX: number;
    centerY: number;
  } | null>(null);
  const [rotationWhileDragging, setRotationWhileDragging] = useState<number | null>(null);
  const resizeStartRef = useRef<{
    dir: string;
    x: number;
    y: number;
    width: number;
    height: number;
    tileX: number;
    tileY: number;
    aspectRatio: number; // width / height, kept constant during resize
  } | null>(null);

  const scale = Math.max(0.25, zoomLevel);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      // Read current selection from store so we never use a stale closure
      const currentIds = useStitchStore.getState().selectedTileIds;
      if (e.shiftKey) {
        const newIds = currentIds.includes(tile.id)
          ? currentIds.filter((i) => i !== tile.id)
          : [...currentIds, tile.id];
        setSelectedTileIds(newIds);
        if (newIds.includes(tile.id)) {
          const currentTiles = useStitchStore.getState().tiles;
          const unlockedIds = newIds.filter(
            (id) => !currentTiles.find((x) => x.id === id)?.locked
          );
          const positions = unlockedIds.map((id) => {
            const t = currentTiles.find((x) => x.id === id)!;
            return { id, x: t.x, y: t.y };
          });
          dragStartRef.current =
            positions.length > 0
              ? {
                  type: "group",
                  x: e.clientX,
                  y: e.clientY,
                  positions,
                }
              : null;
        } else {
          dragStartRef.current = null;
        }
      } else {
        const currentTiles = useStitchStore.getState().tiles;
        const currentTile = currentTiles.find((x) => x.id === tile.id);
        const isLocked = Boolean(currentTile?.locked);
        // If 2+ tiles are selected and we're clicking on one of them, keep selection and start group drag
        if (currentIds.length >= 2 && currentIds.includes(tile.id) && !isLocked) {
          const unlockedIds = currentIds.filter(
            (id) => !currentTiles.find((x) => x.id === id)?.locked
          );
          const positions = unlockedIds.map((id) => {
            const t = currentTiles.find((x) => x.id === id)!;
            return { id, x: t.x, y: t.y };
          });
          dragStartRef.current =
            positions.length > 0
              ? {
                  type: "group",
                  x: e.clientX,
                  y: e.clientY,
                  positions,
                }
              : null;
        } else {
          setSelectedTileIds([tile.id]);
          if (!isLocked && currentTile) {
            dragStartRef.current = {
              type: "single",
              x: e.clientX,
              y: e.clientY,
              tileX: currentTile.x,
              tileY: currentTile.y,
            };
          } else {
            dragStartRef.current = null;
          }
        }
      }
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [tile.id, setSelectedTileIds]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragStartRef.current;
      const resize = resizeStartRef.current;
      const dragOrResizeX = drag?.type === "single" ? drag.x : drag?.type === "group" ? drag.x : resize?.x ?? 0;
      const dragOrResizeY = drag?.type === "single" ? drag.y : drag?.type === "group" ? drag.y : resize?.y ?? 0;
      const dxCanvas = (e.clientX - (resize ? resize.x : dragOrResizeX)) / scale;
      const dyCanvas = (e.clientY - (resize ? resize.y : dragOrResizeY)) / scale;
      if (resize) {
        const currentTileForResize = useStitchStore.getState().tiles.find((x) => x.id === tile.id);
        if (currentTileForResize?.locked) {
          resizeStartRef.current = null;
          return;
        }
        const MIN = 20;
        const { width: w0, height: h0, tileX: x0, tileY: y0, aspectRatio: ar } = resize;
        let width: number;
        let height: number;
        let tileX = x0;
        let tileY = y0;

        if (resize.dir === "e" || resize.dir === "w") {
          width = resize.dir === "e" ? Math.max(MIN, w0 + dxCanvas) : Math.max(MIN, w0 - dxCanvas);
          height = width / ar;
          if (height < MIN) {
            height = MIN;
            width = height * ar;
          }
          if (resize.dir === "w") tileX = x0 + w0 - width;
        } else if (resize.dir === "n" || resize.dir === "s") {
          height = resize.dir === "s" ? Math.max(MIN, h0 + dyCanvas) : Math.max(MIN, h0 - dyCanvas);
          width = height * ar;
          if (width < MIN) {
            width = MIN;
            height = width / ar;
          }
          if (resize.dir === "n") tileY = y0 + h0 - height;
        } else {
          // Corner: uniform scale to preserve aspect ratio
          const scaleX = resize.dir.includes("e") ? (w0 + dxCanvas) / w0 : (w0 - dxCanvas) / w0;
          const scaleY = resize.dir.includes("s") ? (h0 + dyCanvas) / h0 : (h0 - dyCanvas) / h0;
          const minScale = Math.max(MIN / w0, MIN / h0);
          const s = Math.max(minScale, Math.min(scaleX, scaleY));
          width = w0 * s;
          height = h0 * s;
          if (resize.dir.includes("w")) tileX = x0 + w0 - width;
          if (resize.dir.includes("n")) tileY = y0 + h0 - height;
        }

        let finalX = tileX;
        let finalY = tileY;
        if (snapToEdges) {
          const snapped = snapTilePosition(
            tile.id,
            tileX,
            tileY,
            width,
            height,
            tiles,
            canvasWidth,
            canvasHeight
          );
          finalX = snapped.x;
          finalY = snapped.y;
        }
        updateTile(tile.id, { width, height, x: finalX, y: finalY });
        return;
      }
      if (drag?.type === "group") {
        const currentTilesForGroup = useStitchStore.getState().tiles;
        const stillUnlocked = new Set(
          currentTilesForGroup.filter((t) => !t.locked).map((t) => t.id)
        );
        const updates = drag.positions
          .filter(({ id }) => stillUnlocked.has(id))
          .map(({ id, x, y }) => ({
            id,
            patch: { x: x + dxCanvas, y: y + dyCanvas } as const,
          }));
        if (updates.length > 0) updateTiles(updates);
        return;
      }
      if (drag?.type === "single") {
        const currentTileForDrag = useStitchStore.getState().tiles.find((x) => x.id === tile.id);
        if (currentTileForDrag?.locked) {
          dragStartRef.current = null;
          return;
        }
        let newX = drag.tileX + dxCanvas;
        let newY = drag.tileY + dyCanvas;
        if (snapToEdges) {
          const snapped = snapTilePosition(
            tile.id,
            newX,
            newY,
            tile.width,
            tile.height,
            tiles,
            canvasWidth,
            canvasHeight
          );
          newX = snapped.x;
          newY = snapped.y;
        }
        updateTile(tile.id, { x: newX, y: newY });
      }
    },
    [
      tile.id,
      tile.locked,
      tile.width,
      tile.height,
      scale,
      updateTile,
      updateTiles,
      snapToEdges,
      tiles,
      canvasWidth,
      canvasHeight,
    ]
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    dragStartRef.current = null;
    resizeStartRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  const handleResizeStart = useCallback(
    (e: React.PointerEvent, dir: string) => {
      e.stopPropagation();
      if (tile.locked) return;
      const { width, height, x: tileX, y: tileY } = tile;
      resizeStartRef.current = {
        dir,
        x: e.clientX,
        y: e.clientY,
        width,
        height,
        tileX,
        tileY,
        aspectRatio: width / height,
      };
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [tile.width, tile.height, tile.x, tile.y, tile.locked]
  );

  const baseRotation = (tile.rotation ?? 0) % 360;
  const displayRotation = rotationWhileDragging ?? baseRotation;

  const handleRotatePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (tile.locked) return;
      const el = tileContainerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const startAngleDeg = angleDeg(e.clientX, e.clientY, centerX, centerY);
      setRotationDragStart({
        initialRotationDeg: baseRotation,
        startAngleDeg,
        centerX,
        centerY,
      });
      setRotationWhileDragging(baseRotation);
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [tile.locked, baseRotation]
  );

  const handleRotatePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!rotationDragStart) return;
      const currentAngleDeg = angleDeg(e.clientX, e.clientY, rotationDragStart.centerX, rotationDragStart.centerY);
      let deltaDeg = currentAngleDeg - rotationDragStart.startAngleDeg;
      if (deltaDeg > 180) deltaDeg -= 360;
      if (deltaDeg < -180) deltaDeg += 360;
      const newRotation = (rotationDragStart.initialRotationDeg + deltaDeg + 360) % 360;
      setRotationWhileDragging(newRotation);
    },
    [rotationDragStart]
  );

  const handleRotatePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (rotationDragStart !== null) {
        const finalRotation = rotationWhileDragging ?? baseRotation;
        updateTile(tile.id, { rotation: finalRotation });
        setRotationDragStart(null);
        setRotationWhileDragging(null);
      }
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    },
    [rotationDragStart, rotationWhileDragging, baseRotation, tile.id, updateTile]
  );

  const handleToggleLock = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      updateTile(tile.id, { locked: !tile.locked });
    },
    [tile.id, tile.locked, updateTile]
  );

  if (!tile.imageDataUrl) return null;

  return (
    <div
      ref={tileContainerRef}
      data-stitch-tile
      className="absolute border-2 border-transparent hover:border-primary/50"
      style={{
        left: tile.x,
        top: tile.y,
        width: tile.width,
        height: tile.height,
        borderColor: isSelected ? "hsl(var(--primary))" : undefined,
        boxShadow: isSelected && selectedTileIds.length > 1 ? "0 0 0 2px hsl(var(--primary) / 0.5)" : undefined,
        transform: displayRotation ? `rotate(${displayRotation}deg)` : undefined,
        transformOrigin: "center center",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
    >
      <img
        src={tile.imageDataUrl}
        alt=""
        className="w-full h-full object-fill pointer-events-none select-none"
        draggable={false}
      />
      {isSingleSelected && (
        <>
          {!isLocked &&
            (["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map((dir) => {
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
                  key={dir}
                  className="absolute bg-primary rounded-md border-2 border-white shadow-md z-10"
                  style={{
                    width: HANDLE_SIZE,
                    height: HANDLE_SIZE,
                    cursor: RESIZE_CURSORS[dir] ?? "se-resize",
                    ...pos[dir],
                  }}
                  onPointerDown={(e) => handleResizeStart(e, dir)}
                />
              );
            })}
          {!isLocked && (
            <Button
              type="button"
              variant="secondary"
              size="icon"
              className="absolute -top-12 left-1/2 -translate-x-1/2 h-10 w-10 z-10 border-2 border-border shadow-md cursor-grab active:cursor-grabbing"
              title="Drag to rotate"
              onPointerDown={handleRotatePointerDown}
              onPointerMove={handleRotatePointerMove}
              onPointerUp={handleRotatePointerUp}
              onPointerLeave={handleRotatePointerUp}
            >
              <RotateCw className="h-5 w-5" />
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            size="icon"
            className={`absolute -top-12 z-10 border-2 border-border shadow-md ${isLocked ? "left-1/2 -translate-x-1/2" : "right-0 translate-x-1/2"}`}
            title={isLocked ? "Unlock position" : "Lock position"}
            onClick={handleToggleLock}
          >
            {isLocked ? (
              <Lock className="h-5 w-5" />
            ) : (
              <Unlock className="h-5 w-5" />
            )}
          </Button>
        </>
      )}
    </div>
  );
}
