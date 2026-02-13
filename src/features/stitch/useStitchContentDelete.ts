/**
 * Content-delete and delete-element-along-path logic for stitch view.
 */

import { useState, useCallback } from "react";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { eraseRectFromTile, eraseConnectedAt } from "./imageUtils";
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
  const { tiles, updateTile } = useStitchStore();
  const [erasedRegionFeedback, setErasedRegionFeedback] = useState<
    Array<{ x: number; y: number; w: number; h: number }>
  >([]);
  const [isDeletingAlongPath, setIsDeletingAlongPath] = useState(false);

  const handleContentDeleteRect = useCallback(
    async (rect: { x: number; y: number; w: number; h: number }) => {
      let updated = 0;
      for (const tile of tiles) {
        const newDataUrl = await eraseRectFromTile(tile, rect);
        if (newDataUrl) {
          updateTile(tile.id, { imageDataUrl: newDataUrl });
          updated++;
        }
      }
      if (updated > 0) {
        showNotification(`Content removed from ${updated} tile(s).`, "success");
      }
    },
    [tiles, updateTile, showNotification]
  );

  const handleDeleteElementAlongPath = useCallback(
    async (path: Array<{ x: number; y: number }>) => {
      if (path.length === 0) return;
      const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
      setIsDeletingAlongPath(true);
      try {
        if (path.length === 1) {
          const { x: canvasX, y: canvasY } = path[0];
          for (const tile of tiles) {
            const result = await eraseConnectedAt(tile, canvasX, canvasY, {
              colorTolerance: DELETE_ELEMENT_COLOR_TOLERANCE,
              skipBackground: true,
            });
            if (result) {
              updateTile(tile.id, { imageDataUrl: result.dataUrl });
              rects.push(result.canvasRect);
            }
          }
        } else {
          const densePath = interpolatePath(path, 1);
          const pathMinX = Math.min(...densePath.map((p) => p.x));
          const pathMaxX = Math.max(...densePath.map((p) => p.x));
          const pathMinY = Math.min(...densePath.map((p) => p.y));
          const pathMaxY = Math.max(...densePath.map((p) => p.y));
          for (const tile of tiles) {
            const tileRight = tile.x + tile.width;
            const tileBottom = tile.y + tile.height;
            if (
              pathMaxX < tile.x ||
              pathMinX >= tileRight ||
              pathMaxY < tile.y ||
              pathMinY >= tileBottom
            )
              continue;
            let currentImageDataUrl = tile.imageDataUrl;
            for (const pt of densePath) {
              for (const [dx, dy] of STROKE_BRUSH_OFFSETS) {
                const x = pt.x + dx;
                const y = pt.y + dy;
                if (
                  x < tile.x ||
                  x >= tileRight ||
                  y < tile.y ||
                  y >= tileBottom
                )
                  continue;
                const result = await eraseConnectedAt(tile, x, y, {
                  colorTolerance: DELETE_ELEMENT_COLOR_TOLERANCE,
                  skipBackground: true,
                  currentImageDataUrl,
                });
                if (result) {
                  currentImageDataUrl = result.dataUrl;
                  rects.push(result.canvasRect);
                }
              }
            }
            if (currentImageDataUrl !== tile.imageDataUrl) {
              updateTile(tile.id, { imageDataUrl: currentImageDataUrl });
            }
          }
        }
        if (rects.length > 0) {
          setErasedRegionFeedback(rects);
          window.setTimeout(() => setErasedRegionFeedback([]), 1500);
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
        setIsDeletingAlongPath(false);
      }
    },
    [tiles, updateTile, showNotification]
  );

  return {
    handleContentDeleteRect,
    handleDeleteElementAlongPath,
    erasedRegionFeedback,
    isDeletingAlongPath,
  };
}
