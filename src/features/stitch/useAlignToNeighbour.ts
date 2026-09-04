/**
 * "Align to neighbour" — the React side of the mode.
 *
 * Owns the pure machine (`alignToNeighbourMachine`), the toggles, the keyboard (Esc
 * backs up one click, Enter confirms), and the one write to the store: the click that
 * completes a move applies it to the moving tile through `updateTile`, which is a
 * SINGLE undo step. By default that is a translation — one anchor each side, nothing
 * rotated or resized; with **Rotate too (2 points)** it is the two-point similarity
 * (+ uniform scale when **Match scale** is also on).
 *
 * The sheet that moves is made the selection when it is named, which is what gives
 * the mode its arrow-key nudges for free — `useStitchKeyboard` already nudges the
 * selection by 1 screen pixel (10 with Shift) and coalesces a burst into one undo step.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStitchStore } from "@/shared/stores/stitchStore";
import {
  computeAlignToNeighbour,
  computeAlignTranslation,
  seamMissFt,
  type CanvasPoint,
} from "./stitchGeometry";
import { compositionFeetPerInch } from "./pageScales";
import { isTypingTarget } from "./useStitchKeyboard";
import {
  IDLE_ALIGN,
  alignClickableTiles,
  alignHint,
  alignSheetOpacity,
  isPlacedInAlign,
  loupeActive,
  reduceAlign,
  type AlignApply,
  type AlignMachine,
  type AlignRefusal,
} from "./alignToNeighbourMachine";

export interface AlignToNeighbour {
  active: boolean;
  state: AlignMachine;
  /** The step hint (exact plan copy) for the click the mode is waiting for. */
  hint: string;
  /** Set when the last click was refused: a full sentence ("Not that sheet — …"), so
   *  the refusal reads as words and not only as a colour. */
  refusal: AlignRefusal | null;
  /** "Seam: second point lands 0.4 ft off" — this move's own miss. Null while no move
   *  has been made, and while **Match scale** is on (it is 0 by construction there). */
  seamNote: string | null;
  /** **Rotate too (2 points)** — off by default: one anchor each side, translation
   *  only. On, it is the two-points-each-side flow with rotation. */
  twoPoint: boolean;
  setTwoPoint: (v: boolean) => void;
  /** Only meaningful (and only shown) while `twoPoint` is on. */
  matchScale: boolean;
  setMatchScale: (v: boolean) => void;
  snapToLines: boolean;
  setSnapToLines: (v: boolean) => void;
  /** True while the loupe should be up (every point click). */
  showLoupe: boolean;
  /** The sheet that will MOVE, once the second click has named it. */
  movingTileId: string | null;
  /** The anchor: the sheet the first click named, which does not move. */
  fixedTileId: string | null;
  /** How faded to draw a sheet at this step — the sheets a click cannot take. */
  sheetOpacity: (tileId: string) => number;
  /** Already placed by this session: part of the fixed group. */
  isPlaced: (tileId: string) => boolean;
  /** The sheets this step accepts a click on — what the hit test must search. */
  clickableTiles: <T extends { id: string }>(tiles: readonly T[]) => T[];
  enter: () => void;
  exit: () => void;
  /** A click on a sheet, in canvas space (already snapped by the caller). */
  click: (tileId: string, point: CanvasPoint) => void;
  /** A click that hit no sheet this step accepts. */
  miss: () => void;
}

export function useAlignToNeighbour(): AlignToNeighbour {
  const [state, setState] = useState<AlignMachine>(IDLE_ALIGN);
  const [refusal, setRefusal] = useState<AlignRefusal | null>(null);
  const [seamNote, setSeamNote] = useState<string | null>(null);
  const [matchScale, setMatchScale] = useState(false);
  const [snapToLines, setSnapToLines] = useState(true);

  const matchScaleRef = useRef(matchScale);
  matchScaleRef.current = matchScale;

  const active = state.step !== "idle";

  /** Commit the transform. One `updateTile` = one undo step. */
  const applyTransform = useCallback((apply: AlignApply) => {
    const store = useStitchStore.getState();
    const moving = store.tiles.find((t) => t.id === apply.movingTileId);
    if (!moving) return;
    const [a1, a2] = apply.movingPoints;
    const [b1, b2] = apply.fixedPoints;

    // The default: one anchor each side, so the sheet SLIDES. No rotation is derived
    // from a single point, and none is invented.
    if (!a2 || !b2) {
      if (!a1 || !b1) return;
      store.updateTile(apply.movingTileId, computeAlignTranslation(moving, a1, b1));
      setSeamNote(null);
      return;
    }

    const matchScaleOn = matchScaleRef.current;
    const pose = computeAlignToNeighbour(moving, [a1, a2], [b1, b2], matchScaleOn);
    store.updateTile(
      apply.movingTileId,
      matchScaleOn ? pose : { x: pose.x, y: pose.y, rotation: pose.rotation }
    );

    // The honest figure for THIS move: the first point lands exactly and the rotation
    // makes the spans parallel, so the whole of what could not be reconciled is the
    // difference in the two spans' length. With Match scale on that difference is zero
    // by construction, so there is nothing to say.
    if (matchScaleOn) {
      setSeamNote(null);
      return;
    }
    const feetPerInch = compositionFeetPerInch({
      referenceScaleFeetPerInch: store.referenceScaleFeetPerInch,
      compositionScaleFactor: store.compositionScaleFactor,
      tileScaleFeetPerInch: moving.scaleFeetPerInch,
    });
    const miss = seamMissFt([a1, a2], [b1, b2], feetPerInch);
    setSeamNote(
      Number.isFinite(miss) ? `Seam: second point lands ${miss.toFixed(1)} ft off` : null
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
      // The note describes the move that was just made; entering, leaving, or starting
      // the next sheet all retire it.
      if (
        event.type === "enter" ||
        event.type === "setTwoPoint" ||
        next.state.step === "idle" ||
        event.type === "click"
      ) {
        setSeamNote(null);
      }
      // …and then the apply, which sets the note for the move it just made.
      if (next.apply) applyTransform(next.apply);
      // The moving sheet (or, between moves, the one just moved) is the selection, so
      // the arrow-key nudge in `useStitchKeyboard` moves exactly that sheet.
      const wanted = next.state.movingTileId ?? next.state.lastMovedTileId;
      const before = prev.movingTileId ?? prev.lastMovedTileId;
      if (wanted !== before) {
        useStitchStore.getState().setSelectedTileIds(wanted ? [wanted] : []);
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
  const miss = useCallback(() => dispatch({ type: "miss" }), [dispatch]);

  // Esc backs up one click (and leaves at step 0); Enter is Done between moves.
  // Capture phase, and stopPropagation, so the canvas's own Esc handling and the
  // old point-align listener never see these while the mode owns the keyboard.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Never steal the keys from a field — Esc closes a popover, Enter submits.
      if (isTypingTarget()) return;
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

  const isPlaced = useCallback((tileId: string) => isPlacedInAlign(state, tileId), [state]);
  const sheetOpacity = useCallback((tileId: string) => alignSheetOpacity(state, tileId), [state]);
  const clickableTiles = useCallback(
    <T extends { id: string }>(tiles: readonly T[]) => alignClickableTiles(state, tiles),
    [state]
  );
  const setTwoPoint = useCallback(
    (value: boolean) => dispatch({ type: "setTwoPoint", value }),
    [dispatch]
  );

  return useMemo(
    () => ({
      active,
      state,
      hint: alignHint(state),
      refusal,
      seamNote,
      twoPoint: state.twoPoint,
      setTwoPoint,
      matchScale,
      setMatchScale,
      snapToLines,
      setSnapToLines,
      showLoupe: loupeActive(state),
      movingTileId: state.movingTileId,
      fixedTileId: state.fixedTileId,
      sheetOpacity,
      isPlaced,
      clickableTiles,
      enter,
      exit,
      click,
      miss,
    }),
    [
      active, state, refusal, seamNote, matchScale, snapToLines,
      setTwoPoint, sheetOpacity, isPlaced, clickableTiles, enter, exit, click, miss,
    ]
  );
}
