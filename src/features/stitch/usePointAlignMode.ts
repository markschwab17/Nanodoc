/**
 * State and actions for point-alignment mode: lock PDF A, then select two point pairs
 * (A1,B1 then A2,B2) to align PDF B to PDF A.
 */

import { useState, useCallback } from "react";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { computeTwoPointAlignment, type CanvasPoint } from "./stitchGeometry";

export type PointAlignStep = 0 | 1 | 2 | 3;

export interface PointAlignState {
  pointAlignMode: boolean;
  referenceTileId: string | null;
  targetTileId: string | null;
  step: PointAlignStep;
  points: [CanvasPoint | null, CanvasPoint | null, CanvasPoint | null, CanvasPoint | null];
}

const initialPoints: PointAlignState["points"] = [null, null, null, null];

export function usePointAlignMode() {
  const tiles = useStitchStore((s) => s.tiles);
  const updateTile = useStitchStore((s) => s.updateTile);

  const [pointAlignMode, setPointAlignModeState] = useState(false);
  const [referenceTileId, setReferenceTileId] = useState<string | null>(null);
  const [targetTileId, setTargetTileId] = useState<string | null>(null);
  const [step, setStep] = useState<PointAlignStep>(0);
  const [points, setPoints] = useState<PointAlignState["points"]>(initialPoints);

  const lockedTileIds = tiles.filter((t) => t.locked).map((t) => t.id);
  const canEnterPointAlign = lockedTileIds.length === 1;
  const singleLockedTileId = lockedTileIds.length === 1 ? lockedTileIds[0]! : null;

  const setPointAlignMode = useCallback(
    (active: boolean) => {
      if (active) {
        if (lockedTileIds.length !== 1) return;
        setReferenceTileId(lockedTileIds[0]!);
        setTargetTileId(null);
        setStep(0);
        setPoints(initialPoints);
      }
      setPointAlignModeState(active);
    },
    [lockedTileIds]
  );

  const cancelPointAlign = useCallback(() => {
    setStep(0);
    setPoints(initialPoints);
    setTargetTileId(null);
    setPointAlignModeState(false);
  }, []);

  const recordPoint = useCallback(
    (tileId: string, canvasPoint: CanvasPoint) => {
      const refId = referenceTileId ?? singleLockedTileId;
      if (!refId) return;

      if (step === 0) {
        if (tileId !== refId) return;
        setPoints((prev) => [{ ...canvasPoint }, prev[1], prev[2], prev[3]]);
        setStep(1);
        return;
      }
      if (step === 1) {
        if (tileId === refId) return;
        setTargetTileId(tileId);
        setPoints((prev) => [prev[0], { ...canvasPoint }, prev[2], prev[3]]);
        setStep(2);
        return;
      }
      if (step === 2) {
        if (tileId !== refId) return;
        setPoints((prev) => [prev[0], prev[1], { ...canvasPoint }, prev[3]]);
        setStep(3);
        return;
      }
      if (step === 3) {
        const targetId = targetTileId ?? tileId;
        if (tileId !== targetId) return;
        const p0 = points[0];
        const p1 = points[1];
        const p2 = points[2];
        if (p0 && p1 && p2) {
          const targetTile = tiles.find((t) => t.id === targetId);
          if (targetTile) {
            const result = computeTwoPointAlignment(
              [p0, p2],
              targetTile,
              [p1, canvasPoint]
            );
            updateTile(targetId, result);
          }
        }
        setStep(0);
        setPoints(initialPoints);
        setTargetTileId(null);
        setPointAlignModeState(false);
      }
    },
    [referenceTileId, singleLockedTileId, step, targetTileId, points, tiles, updateTile]
  );

  return {
    pointAlignMode,
    referenceTileId: referenceTileId ?? singleLockedTileId,
    targetTileId,
    step,
    points,
    canEnterPointAlign,
    singleLockedTileId,
    setPointAlignMode,
    cancelPointAlign,
    recordPoint,
    tiles,
    updateTile,
  };
}
