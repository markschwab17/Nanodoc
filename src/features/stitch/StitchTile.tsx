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
import { expandSelectionToGroups, toggleGroupInSelection } from "@/features/stitch/groups";
import {
  OVERLAY_INK,
  OVERLAY_PAPER,
  groupMemberRingStyle,
  hoverRingStyle,
  screenPx,
  selectionRingStyle,
} from "@/features/stitch/canvasOverlayStyle";
import { ABSOLUTE_MIN_ZOOM, HANDLE_SIZE, RESIZE_CURSORS } from "@/features/stitch/stitchConstants";
import { cssClipPathWithHoles, cssClipToRect } from "./cleanup/clipRegions";
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
  const resizeLocked = useStitchStore((s) => s.resizeLocked);
  // The committed sheet raster, from the side slice. Subscribed (not read via
  // getState) so the tile paints as soon as the raster lands.
  const committedRaster = useStitchStore(useCallback((s) => s.tileRasters[tile.id], [tile.id]));
  const zoomLevel = useStitchStore((s) => s.zoomLevel);
  /** This sheet's group colour, if it is in a group. */
  const groupColor = useStitchStore(
    useCallback((s) => (tile.groupId ? s.groups[tile.groupId]?.color : undefined), [tile.groupId])
  );

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
  /**
   * Whether this tile should be promoted to its own compositor layer.
   *
   * `willChange: transform` used to be set unconditionally, which gives EVERY
   * tile a permanent GPU surface — at 3072x2048 that is roughly a full-size
   * texture per sheet, and ten sheets is what makes an integrated-GPU laptop
   * start swapping. The promotion only pays for itself while the tile is
   * actually about to move, so it goes on when the pointer arrives (hover, the
   * frame before a drag can start) and comes off when it leaves.
   */
  const [pointerOver, setPointerOver] = useState(false);
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
      // The right button opens the context menu (StitchContextMenu wraps the canvas);
      // it must not start a drag or change the selection out from under the menu.
      if (e.button === 2) return;
      e.stopPropagation();
      e.preventDefault();
      const store = useStitchStore.getState();
      const currentIds = store.selectedTileIds;
      const currentTiles = store.tiles;

      // Snapshot only once the pointer actually moves (see handlePointerMove)
      pendingUndoSnapshotRef.current = true;

      /** The unlocked members of a selection, with their start positions. A drag moves
       *  exactly these, which is how a GROUP keeps its internal spacing: the selection
       *  was expanded to whole groups before we got here. */
      const dragPositions = (ids: string[]) =>
        ids
          .filter((id) => !currentTiles.find((x) => x.id === id)?.locked)
          .map((id) => {
            const t = currentTiles.find((x) => x.id === id)!;
            return { id, x: t.x, y: t.y };
          });

      if (e.shiftKey) {
        // Shift-click toggles the sheet AND its group: half a group in the selection
        // would come apart on the next drag.
        const newIds = toggleGroupInSelection(currentTiles, currentIds, tile.id);
        store.setSelectedTileIds(newIds);
        if (newIds.includes(tile.id)) {
          const positions = dragPositions(newIds);
          dragStartRef.current =
            positions.length > 0
              ? { type: "group", x: e.clientX, y: e.clientY, positions }
              : null;
        } else {
          dragStartRef.current = null;
        }
      } else {
        const currentTile = currentTiles.find((x) => x.id === tile.id);
        const locked = Boolean(currentTile?.locked);
        // Clicking a grouped sheet selects its whole group — that IS the group.
        const wanted = expandSelectionToGroups(currentTiles, [tile.id]);
        const keepSelection =
          currentIds.length >= 2 && currentIds.includes(tile.id) && !locked;
        const ids = keepSelection ? currentIds : wanted;
        if (!keepSelection) store.setSelectedTileIds(ids);

        if (locked) {
          dragStartRef.current = null;
        } else if (ids.length >= 2) {
          const positions = dragPositions(ids);
          dragStartRef.current =
            positions.length > 0
              ? { type: "group", x: e.clientX, y: e.clientY, positions }
              : null;
        } else if (currentTile) {
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
      // The ACTUAL zoom, guarded only against a divide-by-zero: the zoom floor is now
      // dynamic and legitimately goes below MIN_ZOOM, and clamping here would make a drag
      // move the tile by the wrong distance down there.
      const scale = Math.max(ABSOLUTE_MIN_ZOOM, store.zoomLevel);

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

  const handlePointerEnter = useCallback(() => setPointerOver(true), []);
  const handlePointerLeave = useCallback((e: React.PointerEvent) => {
    setPointerOver(false);
    handlePointerUp(e);
  }, [handlePointerUp]);

  const handleResizeStart = useCallback(
    (e: React.PointerEvent, dir: string) => {
      // The right button belongs to the context menu: starting a resize here would push
      // an undo snapshot and wipe the redo stack for a click that moves nothing.
      if (e.button === 2) return;
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
      if (e.button === 2) return;
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

  // An image-less tile with no explanation is nothing to draw. One that FAILED
  // to encode is drawn as a visible error card: the user has to be able to see
  // and remove it, which an invisible-but-selectable tile made impossible.
  // An override on the tile (erase result / scale stamp / cleanup crop / legacy
  // tile) wins; otherwise the committed sheet raster.
  const rasterSrc = tile.imageDataUrl ?? committedRaster;
  if (!rasterSrc && !tile.rasterError) return null;

  // Display always honors tile.width/height — the export draws at tile size,
  // so the canvas must show the same thing (scale stamps included).
  const displayWidth = tile.width;
  const displayHeight = tile.height;
  // hiddenRegions are stored as fractions (0..1) of the tile — scale to px for
  // the clip helper. Rotated tiles are NOT clipped (v1): the export drops holes
  // on rotated tiles too, so preview and export stay consistent.
  const isRotated = (tile.rotation ?? 0) !== 0;
  const relocated = isRotated ? [] : tile.relocatedRegions ?? [];
  // Hide hiddenRegions AND every relocated region's SOURCE (its content is
  // redrawn at the offset below).
  const holesPx = [
    ...(tile.hiddenRegions ?? []),
    ...relocated.map((r) => r.rect),
  ].map((r) => ({
    x: r.x * tile.width,
    y: r.y * tile.height,
    w: r.w * tile.width,
    h: r.h * tile.height,
  }));
  const hiddenClip = isRotated ? null : cssClipPathWithHoles(tile.width, tile.height, holesPx);

  // Selection chrome: FIXED colours, SCREEN-pixel widths (see canvasOverlayStyle — the
  // sheets are white paper in both themes, and the layer this lives in is zoom-scaled).
  // Hover wins over the group's dashed outline: the ring under the cursor should always
  // be the one that says "this is what you are about to click".
  const ringZoom = Math.max(ABSOLUTE_MIN_ZOOM, zoomLevel);
  const ring = isSelected
    ? selectionRingStyle(ringZoom, groupColor)
    : pointerOver
      ? hoverRingStyle(ringZoom)
      : groupColor
        ? groupMemberRingStyle(ringZoom, groupColor)
        : null;

  return (
    <div
      ref={tileContainerRef}
      data-stitch-tile
      // The right-click menu finds its target by asking the DOM what is under the
      // cursor, so the id has to be ON the element (see StitchContextMenu).
      data-stitch-tile-id={tile.id}
      className="absolute"
      style={{
        left: 0,
        top: 0,
        width: displayWidth,
        height: displayHeight,
        // SCREEN-space widths. These used to be plain `2px` inside the zoom-scaled
        // layer, so at a fit-the-set zoom of 0.3 the selection ring was 0.6 px — Mark:
        // "it's also very difficult to tell when a pdf is selected". Dividing by the
        // zoom keeps the ring the same weight however far out the canvas is.
        outline: ring?.outline,
        outlineOffset: ring?.outlineOffset,
        // The white counter-stroke inside the ring, plus a halo outside it in the
        // GROUP's colour when the sheet is in one, so a selected group reads as one
        // object and not as n sheets that happen to be lit up.
        boxShadow: ring && "boxShadow" in ring ? (ring.boxShadow as string) : undefined,
        transform: `translate(${tile.x}px, ${tile.y}px)${displayRotation ? ` rotate(${displayRotation}deg)` : ""}`,
        transformOrigin: "center center",
        // Promoted only while the tile is in play — see `pointerOver`. A
        // rotation drag keeps the promotion even when the pointer wanders off
        // the tile, because the rotate handle is what is being dragged.
        willChange: pointerOver || rotationDragStart !== null ? "transform" : undefined,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      {rasterSrc ? (
        <img
          src={rasterSrc}
          alt=""
          className="w-full h-full pointer-events-none select-none object-fill"
          draggable={false}
          style={{
            clipPath: hiddenClip ?? undefined,
            WebkitClipPath: hiddenClip ?? undefined,
          }}
        />
      ) : (
        <div className="w-full h-full pointer-events-none select-none flex items-center justify-center border-2 border-dashed border-destructive/60 bg-destructive/5 p-4 text-center">
          <span className="text-destructive text-sm font-medium">{tile.rasterError}</span>
        </div>
      )}
      {/* Relocated pieces: a copy of the sheet clipped to the source region and
          translated by the offset, so the cut-out content shows at its new spot. */}
      {rasterSrc && relocated.map((r, i) => {
        const clip = cssClipToRect(tile.width, tile.height, {
          x: r.rect.x * tile.width,
          y: r.rect.y * tile.height,
          w: r.rect.w * tile.width,
          h: r.rect.h * tile.height,
        });
        return (
          <img
            key={i}
            src={rasterSrc}
            alt=""
            className="absolute inset-0 w-full h-full pointer-events-none select-none object-fill"
            draggable={false}
            style={{
              transform: `translate(${r.dx * tile.width}px, ${r.dy * tile.height}px)`,
              clipPath: clip ?? undefined,
              WebkitClipPath: clip ?? undefined,
            }}
          />
        );
      })}
      {isSingleSelected && (() => {
        // Controls live inside the zoom-scaled canvas — divide by zoom so they
        // stay a constant size on screen (like the lock button always did).
        const invZoom = 1 / Math.max(ABSOLUTE_MIN_ZOOM, zoomLevel);
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
                  // White fill, dark border: fixed colours, because a handle sits on
                  // paper that is white in both themes and often on black linework.
                  className="absolute rounded-md shadow-md z-10"
                  style={{
                    width: hs,
                    height: hs,
                    background: OVERLAY_PAPER,
                    borderStyle: "solid",
                    borderColor: OVERLAY_INK,
                    borderWidth: screenPx(2, Math.max(ABSOLUTE_MIN_ZOOM, zoomLevel)),
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
