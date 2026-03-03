/**
 * Single tile on the stitch canvas: image, drag to move, resize handles when selected, rotate.
 * Rotation: drag the rotate handle for custom 360° rotation (like main app); angle stored in degrees.
 *
 * Performance: wrapped in React.memo so only the tile that changed re-renders.
 * Uses granular Zustand selectors and getState() in handlers to avoid subscribing
 * to the full tiles array (which changes on every drag frame).
 */

import { memo, useCallback, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { StitchTile as StitchTileType } from "@/shared/stores/stitchStore";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { snapTilePosition } from "@/features/stitch/snapToEdges";
import { getScaleStampDimensions } from "@/features/stitch/scaleStamp";
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

export const StitchTile = memo(function StitchTile({ tile }: { tile: StitchTileType }) {
  // Granular selectors — only re-render when THIS tile's selection state changes
  const isSelected = useStitchStore(useCallback((s) => s.selectedTileIds.includes(tile.id), [tile.id]));
  const isSingleSelected = useStitchStore(useCallback((s) => s.selectedTileIds.length === 1 && s.selectedTileIds[0] === tile.id, [tile.id]));
  const isMultiSelected = useStitchStore(useCallback((s) => s.selectedTileIds.length > 1 && s.selectedTileIds.includes(tile.id), [tile.id]));
  const resizeLocked = useStitchStore((s) => s.resizeLocked);
  const zoomLevel = useStitchStore((s) => s.zoomLevel);

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
    aspectRatio: number;
  } | null>(null);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const store = useStitchStore.getState();
      const currentIds = store.selectedTileIds;

      // Push undo snapshot BEFORE the drag starts so we can undo back to this state
      store.pushUndoSnapshot();

      if (e.shiftKey) {
        const newIds = currentIds.includes(tile.id)
          ? currentIds.filter((i) => i !== tile.id)
          : [...currentIds, tile.id];
        store.setSelectedTileIds(newIds);
        if (newIds.includes(tile.id)) {
          const currentTiles = store.tiles;
          const unlockedIds = newIds.filter(
            (id) => !currentTiles.find((x) => x.id === id)?.locked
          );
          const positions = unlockedIds.map((id) => {
            const t = currentTiles.find((x) => x.id === id)!;
            return { id, x: t.x, y: t.y };
          });
          dragStartRef.current =
            positions.length > 0
              ? { type: "group", x: e.clientX, y: e.clientY, positions }
              : null;
        } else {
          dragStartRef.current = null;
        }
      } else {
        const currentTiles = store.tiles;
        const currentTile = currentTiles.find((x) => x.id === tile.id);
        const locked = Boolean(currentTile?.locked);
        if (currentIds.length >= 2 && currentIds.includes(tile.id) && !locked) {
          const unlockedIds = currentIds.filter(
            (id) => !currentTiles.find((x) => x.id === id)?.locked
          );
          const positions = unlockedIds.map((id) => {
            const t = currentTiles.find((x) => x.id === id)!;
            return { id, x: t.x, y: t.y };
          });
          dragStartRef.current =
            positions.length > 0
              ? { type: "group", x: e.clientX, y: e.clientY, positions }
              : null;
        } else {
          store.setSelectedTileIds([tile.id]);
          if (!locked && currentTile) {
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
    [tile.id]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragStartRef.current;
      const resize = resizeStartRef.current;
      if (!drag && !resize) return;

      // Read all needed values from store to avoid stale closures and extra subscriptions
      const store = useStitchStore.getState();
      const scale = Math.max(0.25, store.zoomLevel);

      const dragOrResizeX = drag?.type === "single" ? drag.x : drag?.type === "group" ? drag.x : resize?.x ?? 0;
      const dragOrResizeY = drag?.type === "single" ? drag.y : drag?.type === "group" ? drag.y : resize?.y ?? 0;
      const dxCanvas = (e.clientX - (resize ? resize.x : dragOrResizeX)) / scale;
      const dyCanvas = (e.clientY - (resize ? resize.y : dragOrResizeY)) / scale;

      if (resize) {
        const currentTileForResize = store.tiles.find((x) => x.id === tile.id);
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
          if (height < MIN) { height = MIN; width = height * ar; }
          if (resize.dir === "w") tileX = x0 + w0 - width;
        } else if (resize.dir === "n" || resize.dir === "s") {
          height = resize.dir === "s" ? Math.max(MIN, h0 + dyCanvas) : Math.max(MIN, h0 - dyCanvas);
          width = height * ar;
          if (width < MIN) { width = MIN; height = width / ar; }
          if (resize.dir === "n") tileY = y0 + h0 - height;
        } else {
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
        if (store.snapToEdges) {
          const snapped = snapTilePosition(
            tile.id, tileX, tileY, width, height,
            store.tiles, store.canvasWidth, store.canvasHeight
          );
          finalX = snapped.x;
          finalY = snapped.y;
        }
        // No undo during continuous resize — snapshot was pushed on pointerDown
        store.updateTileNoUndo(tile.id, { width, height, x: finalX, y: finalY });
        return;
      }

      if (drag?.type === "group") {
        const stillUnlocked = new Set(
          store.tiles.filter((t) => !t.locked).map((t) => t.id)
        );
        const updates = drag.positions
          .filter(({ id }) => stillUnlocked.has(id))
          .map(({ id, x, y }) => ({
            id,
            patch: { x: x + dxCanvas, y: y + dyCanvas } as const,
          }));
        if (updates.length > 0) store.updateTilesNoUndo(updates);
        return;
      }

      if (drag?.type === "single") {
        const currentTileForDrag = store.tiles.find((x) => x.id === tile.id);
        if (currentTileForDrag?.locked) {
          dragStartRef.current = null;
          return;
        }
        let newX = drag.tileX + dxCanvas;
        let newY = drag.tileY + dyCanvas;
        if (store.snapToEdges) {
          const currentTile = store.tiles.find((t) => t.id === tile.id);
          const snapped = snapTilePosition(
            tile.id, newX, newY,
            currentTile?.width ?? tile.width, currentTile?.height ?? tile.height,
            store.tiles, store.canvasWidth, store.canvasHeight
          );
          newX = snapped.x;
          newY = snapped.y;
        }
        // No undo during continuous drag — snapshot was pushed on pointerDown
        store.updateTileNoUndo(tile.id, { x: newX, y: newY });
      }
    },
    [tile.id, tile.width, tile.height]
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    dragStartRef.current = null;
    resizeStartRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  const handleResizeStart = useCallback(
    (e: React.PointerEvent, dir: string) => {
      e.stopPropagation();
      const store = useStitchStore.getState();
      if (store.resizeLocked || tile.locked) return;
      // Push undo before resize starts
      store.pushUndoSnapshot();
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
      const store = useStitchStore.getState();
      if (store.resizeLocked || tile.locked) return;
      // Push undo before rotate starts
      store.pushUndoSnapshot();
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
        // Use no-undo variant — snapshot was already pushed on rotate start
        useStitchStore.getState().updateTileNoUndo(tile.id, { rotation: finalRotation });
        setRotationDragStart(null);
        setRotationWhileDragging(null);
      }
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    },
    [rotationDragStart, rotationWhileDragging, baseRotation, tile.id]
  );

  const handleToggleLock = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      // Lock toggle is a discrete action — use the normal undo variant
      useStitchStore.getState().updateTile(tile.id, { locked: !tile.locked });
    },
    [tile.id, tile.locked]
  );

  if (!tile.imageDataUrl) return null;

  // Scale stamps: always render at canonical size so far-left and far-right scale lines are exactly 1"
  const isScaleStampWithScale = Boolean(tile.isScaleStamp && tile.scaleStampFeetPerInch != null);
  const displayWidth = isScaleStampWithScale
    ? getScaleStampDimensions(tile.scaleStampFeetPerInch!).widthPt
    : tile.width;
  const displayHeight = isScaleStampWithScale
    ? getScaleStampDimensions(tile.scaleStampFeetPerInch!).heightPt
    : tile.height;

  return (
    <div
      ref={tileContainerRef}
      data-stitch-tile
      className="absolute border-2 border-transparent hover:border-primary/50"
      style={{
        left: tile.x,
        top: tile.y,
        width: displayWidth,
        height: displayHeight,
        borderColor: isSelected ? "hsl(var(--primary))" : undefined,
        boxShadow: isMultiSelected ? "0 0 0 2px hsl(var(--primary) / 0.5)" : undefined,
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
        className="w-full h-full pointer-events-none select-none object-fill"
        draggable={false}
      />
      {isSingleSelected && (
        <>
          {!resizeLocked && !isLocked &&
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
          {!resizeLocked && !isLocked && (
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
            style={{
              width: `${(32 * 0.9) / zoomLevel}px`,
              height: `${(32 * 0.9) / zoomLevel}px`,
            }}
            title={isLocked ? "Unlock position" : "Lock position"}
            onClick={handleToggleLock}
          >
            {isLocked ? (
              <Lock className="h-full w-full shrink-0" />
            ) : (
              <Unlock className="h-full w-full shrink-0" />
            )}
          </Button>
        </>
      )}
    </div>
  );
});
