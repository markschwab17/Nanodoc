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
import { computeResizedPose } from "@/features/stitch/stitchGeometry";
import { HANDLE_SIZE, MIN_ZOOM, RESIZE_CURSORS } from "@/features/stitch/stitchConstants";
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
  // Snapshot is deferred to the first actual move: plain clicks must not
  // pollute the undo stack or wipe the redo stack.
  const pendingUndoSnapshotRef = useRef(false);
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
    rotation: number;
    aspectRatio: number;
  } | null>(null);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const store = useStitchStore.getState();
      const currentIds = store.selectedTileIds;

      // Snapshot only once the pointer actually moves (see handlePointerMove)
      pendingUndoSnapshotRef.current = true;

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
      const scale = Math.max(MIN_ZOOM, store.zoomLevel);

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
        const pose = computeResizedPose(
          {
            dir: resize.dir,
            x: resize.tileX,
            y: resize.tileY,
            width: resize.width,
            height: resize.height,
            rotation: resize.rotation,
            aspectRatio: resize.aspectRatio,
          },
          dxCanvas,
          dyCanvas
        );

        let finalX = pose.x;
        let finalY = pose.y;
        // Edge snapping assumes an axis-aligned tile — skip it while rotated
        if (store.snapToEdges && resize.rotation === 0) {
          const snapped = snapTilePosition(
            tile.id, pose.x, pose.y, pose.width, pose.height,
            store.tiles, store.canvasWidth, store.canvasHeight
          );
          finalX = snapped.x;
          finalY = snapped.y;
        }
        // No undo during continuous resize — snapshot was pushed on pointerDown
        store.updateTileNoUndo(tile.id, { width: pose.width, height: pose.height, x: finalX, y: finalY });
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
        if (updates.length > 0) {
          if (pendingUndoSnapshotRef.current) {
            store.pushUndoSnapshot();
            pendingUndoSnapshotRef.current = false;
          }
          store.updateTilesNoUndo(updates);
        }
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
        // Snapshot once at the start of the actual drag, then no-undo updates
        if (pendingUndoSnapshotRef.current) {
          store.pushUndoSnapshot();
          pendingUndoSnapshotRef.current = false;
        }
        store.updateTileNoUndo(tile.id, { x: newX, y: newY });
      }
    },
    [tile.id, tile.width, tile.height]
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    dragStartRef.current = null;
    resizeStartRef.current = null;
    pendingUndoSnapshotRef.current = false;
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
        rotation: (tile.rotation ?? 0) % 360,
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

  // Display always honors tile.width/height — the export draws at tile size,
  // so the canvas must show the same thing (scale stamps included).
  const displayWidth = tile.width;
  const displayHeight = tile.height;

  return (
    <div
      ref={tileContainerRef}
      data-stitch-tile
      className="absolute hover:outline hover:outline-2 hover:outline-primary/50"
      style={{
        left: 0,
        top: 0,
        width: displayWidth,
        height: displayHeight,
        outline: isSelected ? "2px solid hsl(var(--primary))" : undefined,
        outlineOffset: isSelected ? "-2px" : undefined,
        boxShadow: isMultiSelected ? "0 0 0 2px hsl(var(--primary) / 0.5)" : undefined,
        transform: `translate(${tile.x}px, ${tile.y}px)${displayRotation ? ` rotate(${displayRotation}deg)` : ""}`,
        transformOrigin: "center center",
        willChange: "transform",
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
      {isSingleSelected && (() => {
        // Controls live inside the zoom-scaled canvas — divide by zoom so they
        // stay a constant size on screen (like the lock button always did).
        const invZoom = 1 / Math.max(MIN_ZOOM, zoomLevel);
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
          <>
            {!resizeLocked && !isLocked &&
              (["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map((dir) => (
                <div
                  key={dir}
                  className="absolute bg-primary rounded-md border-white shadow-md z-10"
                  style={{
                    width: hs,
                    height: hs,
                    borderWidth: 2 * invZoom,
                    cursor: RESIZE_CURSORS[dir] ?? "se-resize",
                    ...pos[dir],
                  }}
                  onPointerDown={(e) => handleResizeStart(e, dir)}
                />
              ))}
            {!resizeLocked && !isLocked && (
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="absolute left-1/2 -translate-x-1/2 z-10 border-2 border-border shadow-md cursor-grab active:cursor-grabbing"
                style={{ width: buttonPx, height: buttonPx, top: buttonTop }}
                title="Drag to rotate"
                onPointerDown={handleRotatePointerDown}
                onPointerMove={handleRotatePointerMove}
                onPointerUp={handleRotatePointerUp}
                onPointerLeave={handleRotatePointerUp}
              >
                <RotateCw className="h-full w-full shrink-0" />
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              size="icon"
              className={`absolute z-10 border-2 border-border shadow-md ${isLocked ? "left-1/2 -translate-x-1/2" : "right-0 translate-x-1/2"}`}
              style={{ width: buttonPx, height: buttonPx, top: buttonTop }}
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
        );
      })()}
    </div>
  );
});
