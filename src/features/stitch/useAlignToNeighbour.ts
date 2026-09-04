/**
 * "Align to neighbour" — the React side of the mode.
 *
 * Owns the pure machine (`alignToNeighbourMachine`), the two toggles, the keyboard
 * (Esc backs up one click, Enter confirms), and the one write to the store: the 4th
 * click applies translation + rotation (+ uniform scale when **Match scale** is on) to
 * the moving tile through `updateTile`, which is a SINGLE undo step.
 *
 * The moving sheet is also made the selection when it is picked, which is what gives
 * the mode its arrow-key nudges for free — `useStitchKeyboard` already nudges the
 * selection by 1 screen pixel (10 with Shift) and coalesces a burst into one undo step.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { computeAlignToNeighbour, type CanvasPoint } from "./stitchGeometry";
import {
  IDLE_ALIGN,
  alignHint,
  isLockedForAlign,
  loupeActive,
  reduceAlign,
  type AlignApply,
  type AlignMachine,
} from "./alignToNeighbourMachine";

/** Feet of seam residual for a pair of sheets, from T0's seam report. */
export type SeamResidualLookup = (movingTileId: string, fixedTileId: string) => number | null;

export interface AlignToNeighbour {
  active: boolean;
  state: AlignMachine;
  /** The step hint (exact plan copy) for the click the mode is waiting for. */
  hint: string;
  /** Set when the last click was refused — the same hint, to be shown as a warning. */
  refusal: string | null;
  /** "Seam: 0.4 ft off along the matchline", or null when nothing is computable. */
  seamNote: string | null;
  matchScale: boolean;
  setMatchScale: (v: boolean) => void;
  snapToLines: boolean;
  setSnapToLines: (v: boolean) => void;
  /** True while the loupe should be up (the four point clicks). */
  showLoupe: boolean;
  movingTileId: string | null;
  isLocked: (tileId: string) => boolean;
  enter: () => void;
  exit: () => void;
  /** A click on a sheet, in canvas space (already snapped by the caller). */
  click: (tileId: string, point: CanvasPoint) => void;
}

export function useAlignToNeighbour(opts: { seamResidualFt?: SeamResidualLookup } = {}): AlignToNeighbour {
  const { seamResidualFt } = opts;
  const [state, setState] = useState<AlignMachine>(IDLE_ALIGN);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [seamNote, setSeamNote] = useState<string | null>(null);
  const [matchScale, setMatchScale] = useState(false);
  const [snapToLines, setSnapToLines] = useState(true);

  const matchScaleRef = useRef(matchScale);
  matchScaleRef.current = matchScale;
  const seamLookupRef = useRef(seamResidualFt);
  seamLookupRef.current = seamResidualFt;

  const active = state.step !== "idle";

  /** Commit the transform. One `updateTile` = one undo step. */
  const applyTransform = useCallback((apply: AlignApply) => {
    const store = useStitchStore.getState();
    const moving = store.tiles.find((t) => t.id === apply.movingTileId);
    if (!moving) return;
    const pose = computeAlignToNeighbour(
      moving,
      apply.movingPoints,
      apply.fixedPoints,
      matchScaleRef.current
    );
    store.updateTile(apply.movingTileId, matchScaleRef.current
      ? pose
      : { x: pose.x, y: pose.y, rotation: pose.rotation });

    const residual = apply.fixedTileId
      ? seamLookupRef.current?.(apply.movingTileId, apply.fixedTileId) ?? null
      : null;
    setSeamNote(
      residual != null && Number.isFinite(residual)
        ? `Seam: ${residual.toFixed(1)} ft off along the matchline`
        : null
    );
  }, []);

  /** The machine's current state, kept in a ref so `dispatch` stays a plain event
   *  handler — the store write and the seam note are effects, and a state updater is
   *  no place for either. */
  const stateRef = useRef<AlignMachine>(IDLE_ALIGN);

  const dispatch = useCallback(
    (event: Parameters<typeof reduceAlign>[1]) => {
      const prev = stateRef.current;
      const next = reduceAlign(prev, event);
      stateRef.current = next.state;
      setState(next.state);
      setRefusal(next.refusal ?? null);
      if (event.type === "enter" || (next.state.step === "idle" && prev.step !== "idle")) {
        setSeamNote(null);
      }
      if (next.apply) applyTransform(next.apply);
      // Picking the moving sheet makes it the selection, so the arrow-key nudge in
      // `useStitchKeyboard` moves exactly that sheet and nothing else.
      if (next.state.movingTileId !== prev.movingTileId) {
        useStitchStore.getState().setSelectedTileIds(
          next.state.movingTileId ? [next.state.movingTileId] : []
        );
      }
    },
    [applyTransform]
  );

  const enter = useCallback(() => dispatch({ type: "enter" }), [dispatch]);
  const exit = useCallback(() => dispatch({ type: "exit" }), [dispatch]);
  const click = useCallback(
    (tileId: string, point: CanvasPoint) => dispatch({ type: "click", tileId, point }),
    [dispatch]
  );

  // Esc backs up one click (and leaves at step 0); Enter confirms an applied result.
  // Capture phase, and stopPropagation, so the canvas's own Esc handling and the
  // old point-align listener never see these while the mode owns the keyboard.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        dispatch({ type: "escape" });
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        dispatch({ type: "confirm" });
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [active, dispatch]);

  const isLocked = useCallback((tileId: string) => isLockedForAlign(state, tileId), [state]);

  return useMemo(
    () => ({
      active,
      state,
      hint: alignHint(state),
      refusal,
      seamNote,
      matchScale,
      setMatchScale,
      snapToLines,
      setSnapToLines,
      showLoupe: loupeActive(state),
      movingTileId: state.movingTileId,
      isLocked,
      enter,
      exit,
      click,
    }),
    [active, state, refusal, seamNote, matchScale, snapToLines, isLocked, enter, exit, click]
  );
}
