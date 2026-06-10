/**
 * Content-delete and delete-element-along-path logic for stitch view.
 *
 * Performance: stroke-based delete now decodes each tile's image ONCE,
 * runs all flood-fills directly on the raw ImageData buffer (no PNG
 * encode/decode between points), and encodes back to a data URL ONCE
 * at the end.  This eliminates ~1000 PNG round-trips per stroke.
 */

import { useState, useCallback, useRef } from "react";
import { useStitchStore } from "@/shared/stores/stitchStore";
import {
  eraseRectFromTile,
  eraseConnectedAt,
  decodeTileImage,
  encodeTileImage,
  floodFillErase,
} from "./imageUtils";
import { getTileAABB } from "./stitchGeometry";
import {
  DELETE_ELEMENT_COLOR_TOLERANCE,
  STROKE_BRUSH_OFFSETS,
} from "./stitchConstants";

function interpolatePath(
  path: Array<{ x: number; y: number }>,
  step: number
): Array<{ x: number; y: number }> {
  if (path.length <= 1) return path;
  const out: Array<{ x: number; y: number }> = [path[0]];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const n = Math.max(1, Math.ceil(dist / step));
    for (let j = 1; j <= n; j++) {
      const t = j / n;
      out.push({ x: a.x + dx * t, y: a.y + dy * t });
    }
  }
  return out;
}

export function useStitchContentDelete(showNotification: (msg: string, type: "success" | "error" | "info") => void) {
  const tiles = useStitchStore((s) => s.tiles);
  const updateTiles = useStitchStore((s) => s.updateTiles);
  const [erasedRegionFeedback, setErasedRegionFeedback] = useState<
    Array<{ x: number; y: number; w: number; h: number }>
  >([]);
  const [isDeletingAlongPath, setIsDeletingAlongPath] = useState(false);
  // Concurrent erases decode the same source image and the last write wins —
  // guard so a second erase can't start while one is in flight.
  const eraseInFlightRef = useRef(false);
  const feedbackTimerRef = useRef<number | null>(null);

  const showErasedFeedback = useCallback((rects: Array<{ x: number; y: number; w: number; h: number }>) => {
    if (feedbackTimerRef.current != null) window.clearTimeout(feedbackTimerRef.current);
    setErasedRegionFeedback(rects);
    feedbackTimerRef.current = window.setTimeout(() => setErasedRegionFeedback([]), 1500);
  }, []);

  const handleContentDeleteRect = useCallback(
    async (rect: { x: number; y: number; w: number; h: number }) => {
      if (eraseInFlightRef.current) return;
      eraseInFlightRef.current = true;
      setIsDeletingAlongPath(true);
      try {
        const updates: Array<{ id: string; patch: { imageDataUrl: string; imageModified: true } }> = [];
        for (const tile of tiles) {
          const newDataUrl = await eraseRectFromTile(tile, rect);
          if (newDataUrl) {
            updates.push({ id: tile.id, patch: { imageDataUrl: newDataUrl, imageModified: true } });
          }
        }
        if (updates.length > 0) {
          updateTiles(updates);
          showNotification(`Content removed from ${updates.length} tile(s).`, "success");
        }
      } catch (e) {
        console.error(e);
        showNotification("Could not remove content.", "error");
      } finally {
        eraseInFlightRef.current = false;
        setIsDeletingAlongPath(false);
      }
    },
    [tiles, updateTiles, showNotification]
  );

  const handleDeleteElementAlongPath = useCallback(
    async (path: Array<{ x: number; y: number }>) => {
      if (path.length === 0) return;
      if (eraseInFlightRef.current) return;
      eraseInFlightRef.current = true;
      const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
      const updates: Array<{ id: string; patch: { imageDataUrl: string; imageModified: true } }> = [];
      setIsDeletingAlongPath(true);
      try {
        if (path.length === 1) {
          // Single click — use the original async path (one decode, one encode)
          const { x: canvasX, y: canvasY } = path[0];
          for (const tile of tiles) {
            const result = await eraseConnectedAt(tile, canvasX, canvasY, {
              colorTolerance: DELETE_ELEMENT_COLOR_TOLERANCE,
              skipBackground: true,
            });
            if (result) {
              updates.push({ id: tile.id, patch: { imageDataUrl: result.dataUrl, imageModified: true } });
              rects.push(result.canvasRect);
            }
          }
        } else {
          // Stroke: decode each tile ONCE, flood-fill all points on raw pixels, encode ONCE.
          const densePath = interpolatePath(path, 1);
          // Loop (not spread) — dense paths can exceed engine argument limits
          let pathMinX = Infinity, pathMaxX = -Infinity, pathMinY = Infinity, pathMaxY = -Infinity;
          for (const p of densePath) {
            if (p.x < pathMinX) pathMinX = p.x;
            if (p.x > pathMaxX) pathMaxX = p.x;
            if (p.y < pathMinY) pathMinY = p.y;
            if (p.y > pathMaxY) pathMaxY = p.y;
          }

          for (const tile of tiles) {
            // Rotation-aware footprint for culling
            const aabb = getTileAABB(tile);
            const tileRight = aabb.x + aabb.width;
            const tileBottom = aabb.y + aabb.height;
            if (
              pathMaxX < aabb.x ||
              pathMinX >= tileRight ||
              pathMaxY < aabb.y ||
              pathMinY >= tileBottom
            )
              continue;

            if (!tile.imageDataUrl) continue;

            // Decode ONCE
            const { imageData, width: imgW, height: imgH } = await decodeTileImage(tile.imageDataUrl);
            let changed = false;

            // Yield to keep UI responsive before heavy loop
            await new Promise<void>((r) => setTimeout(r, 0));

            for (const pt of densePath) {
              for (const [dx, dy] of STROKE_BRUSH_OFFSETS) {
                const x = pt.x + dx;
                const y = pt.y + dy;
                if (x < aabb.x || x >= tileRight || y < aabb.y || y >= tileBottom) continue;

                const rect = floodFillErase(
                  imageData, imgW, imgH,
                  tile, x, y,
                  DELETE_ELEMENT_COLOR_TOLERANCE,
                  true, // skipBackground
                  248,  // whiteThreshold
                );
                if (rect) {
                  rects.push(rect);
                  changed = true;
                }
              }
            }

            if (changed) {
              // Encode ONCE
              updates.push({ id: tile.id, patch: { imageDataUrl: encodeTileImage(imageData), imageModified: true } });
            }
          }
        }
        if (updates.length > 0) {
          updateTiles(updates);
        }
        if (rects.length > 0) {
          showErasedFeedback(rects);
          showNotification(
            path.length === 1
              ? "Element removed."
              : "Elements along stroke removed.",
            "success"
          );
        } else {
          showNotification(
            "No content along the stroke. Draw over lines or shapes to remove them.",
            "info"
          );
        }
      } catch (e) {
        console.error(e);
        showNotification("Could not remove elements.", "error");
      } finally {
        eraseInFlightRef.current = false;
        setIsDeletingAlongPath(false);
      }
    },
    [tiles, updateTiles, showNotification, showErasedFeedback]
  );

  return {
    handleContentDeleteRect,
    handleDeleteElementAlongPath,
    erasedRegionFeedback,
    isDeletingAlongPath,
  };
}
