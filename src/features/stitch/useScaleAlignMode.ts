/**
 * State and actions for scale-alignment mode: lock PDF A (reference), then
 * click two points on A to define a reference line, then two points on B to
 * define the same physical distance. PDF B is resized so the line lengths match.
 */

import { useState, useCallback } from "react";
import { useStitchStore } from "@/shared/stores/stitchStore";
import {
  computeScaleAlignment,
  distance,
  type CanvasPoint,
} from "./stitchGeometry";

export type ScaleAlignStep = 0 | 1 | 2 | 3;

export interface ScaleAlignState {
  scaleAlignMode: boolean;
  referenceTileId: string | null;
  targetTileId: string | null;
  step: ScaleAlignStep;
  /** [A1, A2, B1, B2] in canvas space */
  points: [CanvasPoint | null, CanvasPoint | null, CanvasPoint | null, CanvasPoint | null];
}

const initialPoints: ScaleAlignState["points"] = [
  null,
  null,
  null,
  null,
];

export function useScaleAlignMode() {
  const tiles = useStitchStore((s) => s.tiles);
  const updateTile = useStitchStore((s) => s.updateTile);

  const [scaleAlignMode, setScaleAlignModeState] = useState(false);
  const [referenceTileId, setReferenceTileId] = useState<string | null>(null);
  const [targetTileId, setTargetTileId] = useState<string | null>(null);
  const [step, setStep] = useState<ScaleAlignStep>(0);
  const [points, setPoints] = useState<ScaleAlignState["points"]>(initialPoints);

  const lockedTileIds = tiles.filter((t) => t.locked).map((t) => t.id);
  const canEnterScaleAlign = lockedTileIds.length === 1;
  const singleLockedTileId =
    lockedTileIds.length === 1 ? lockedTileIds[0]! : null;

  const setScaleAlignMode = useCallback(
    (active: boolean) => {
      if (active) {
        if (lockedTileIds.length !== 1) return;
        setReferenceTileId(lockedTileIds[0]!);
        setTargetTileId(null);
        setStep(0);
        setPoints(initialPoints);
      }
      setScaleAlignModeState(active);
    },
    [lockedTileIds]
  );

  const cancelScaleAlign = useCallback(() => {
    setStep(0);
    setPoints(initialPoints);
    setTargetTileId(null);
    setScaleAlignModeState(false);
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
        if (tileId !== refId) return;
        setPoints((prev) => [prev[0], { ...canvasPoint }, prev[2], prev[3]]);
        setStep(2);
        return;
      }
      if (step === 2) {
        if (tileId === refId) return;
        setTargetTileId(tileId);
        setPoints((prev) => [prev[0], prev[1], { ...canvasPoint }, prev[3]]);
        setStep(3);
        return;
      }
      if (step === 3) {
        const targetId = targetTileId ?? tileId;
        if (tileId !== targetId) return;
        const a1 = points[0];
        const a2 = points[1];
        const b1 = points[2];
        if (a1 && a2 && b1) {
          const refLength = distance(a1, a2);
          const targetTile = tiles.find((t) => t.id === targetId);
          if (targetTile && refLength > 0) {
            const result = computeScaleAlignment(
              refLength,
              targetTile,
              [b1, canvasPoint]
            );
            updateTile(targetId, result);
          }
        }
        setStep(0);
        setPoints(initialPoints);
        setTargetTileId(null);
        setScaleAlignModeState(false);
      }
    },
    [
      referenceTileId,
      singleLockedTileId,
      step,
      targetTileId,
      points,
      tiles,
      updateTile,
    ]
  );

  return {
    scaleAlignMode,
    referenceTileId: referenceTileId ?? singleLockedTileId,
    targetTileId,
    step,
    points,
    canEnterScaleAlign,
    singleLockedTileId,
    setScaleAlignMode,
    cancelScaleAlign,
    recordPoint,
    tiles,
    updateTile,
  };
}
