/**
 * "Align to neighbour" — the pure state machine.
 *
 * Mark, 2026-09-04: "Some of the controls are not super intuitive, how to lock a page
 * down while you 2 point snap click another sheet to it."
 *
 * The old point-align made the user find the lock icon on a tile FIRST, then click four
 * points in an order that alternated between the two sheets (ref, target, ref, target).
 * This one asks a question instead: which sheet are you moving? Everything else locks
 * itself, and the four clicks then read left-to-right — two on the sheet that moves,
 * two on the sheet it has to meet.
 *
 * The machine is deliberately free of React and of the store: it takes a click (tile id
 * + canvas point), a key, or a mode toggle, and returns the next state plus, at most,
 * ONE side effect (`apply`, the transform the caller commits as a single undo step) or
 * ONE refusal (the step hint, re-shown because the click landed on the wrong sheet).
 */

import type { CanvasPoint } from "./stitchGeometry";

/** Where the mode is: which click it is waiting for. */
export type AlignStep = "idle" | "pickMoving" | "A1" | "A2" | "B1" | "B2" | "applied";

export interface AlignMachine {
  step: AlignStep;
  /** The sheet the user chose to move. Every other sheet is locked while set. */
  movingTileId: string | null;
  /** The sheet clicked for B1 — the one the moving sheet is being brought to. */
  fixedTileId: string | null;
  /** [A1, A2, B1, B2] in canvas space. A* on the moving sheet, B* on the fixed one. */
  points: [CanvasPoint | null, CanvasPoint | null, CanvasPoint | null, CanvasPoint | null];
}

export type AlignEvent =
  | { type: "enter" }
  | { type: "exit" }
  | { type: "click"; tileId: string; point: CanvasPoint }
  | { type: "escape" }
  | { type: "confirm" };

/** The transform the caller must commit (as ONE undo step) when the 4th click lands. */
export interface AlignApply {
  movingTileId: string;
  fixedTileId: string | null;
  /** The two points clicked on the moving sheet, in canvas space. */
  movingPoints: [CanvasPoint, CanvasPoint];
  /** Where those two points must end up — the two points clicked on the fixed sheet. */
  fixedPoints: [CanvasPoint, CanvasPoint];
}

export interface AlignTransition {
  state: AlignMachine;
  /** Set when the click was refused: the step hint, unchanged, to be re-shown. */
  refusal?: string;
  /** Set on the 4th click. */
  apply?: AlignApply;
}

export const IDLE_ALIGN: AlignMachine = {
  step: "idle",
  movingTileId: null,
  fixedTileId: null,
  points: [null, null, null, null],
};

/** Copy exactly as the round-3 plan's Global Constraints. */
export const ALIGN_STEP_HINTS: Record<AlignStep, string> = {
  idle: "",
  pickMoving: "Click the sheet you want to move",
  A1: "Click the first point on the sheet you're moving",
  A2: "Click the second point",
  B1: "Now click the matching first point on the fixed sheet",
  B2: "Click the matching second point",
  applied: "Aligned. Press Enter to finish, or nudge with the arrow keys.",
};

export function alignHint(state: AlignMachine): string {
  return ALIGN_STEP_HINTS[state.step];
}

/** The loupe is only useful while the user is placing the four points. */
export function loupeActive(state: AlignMachine): boolean {
  return state.step === "A1" || state.step === "A2" || state.step === "B1" || state.step === "B2";
}

/** True while `tileId` is locked for the mode — every sheet except the moving one. */
export function isLockedForAlign(state: AlignMachine, tileId: string): boolean {
  return state.movingTileId != null && tileId !== state.movingTileId;
}

const withPoint = (
  points: AlignMachine["points"],
  index: 0 | 1 | 2 | 3,
  point: CanvasPoint | null
): AlignMachine["points"] => {
  const next = [...points] as AlignMachine["points"];
  next[index] = point ? { x: point.x, y: point.y } : null;
  return next;
};

/** One click, one key, one toggle → the next state (+ at most one effect). */
export function reduceAlign(state: AlignMachine, event: AlignEvent): AlignTransition {
  switch (event.type) {
    case "enter":
      return { state: { ...IDLE_ALIGN, step: "pickMoving" } };
    case "exit":
      return { state: IDLE_ALIGN };
    case "confirm":
      // Enter at `applied` leaves the mode KEEPING the result; anywhere else it is
      // not a shortcut for the click the user still owes us.
      return state.step === "applied" ? { state: IDLE_ALIGN } : { state };
    case "escape":
      return reduceEscape(state);
    case "click":
      return reduceClick(state, event.tileId, event.point);
  }
}

function reduceEscape(state: AlignMachine): AlignTransition {
  switch (state.step) {
    case "idle":
      return { state };
    case "pickMoving":
      // Nothing left to back out of — Esc here leaves the mode.
      return { state: IDLE_ALIGN };
    case "A1":
      return { state: { ...IDLE_ALIGN, step: "pickMoving" } };
    case "A2":
      return { state: { ...state, step: "A1", points: withPoint(state.points, 0, null) } };
    case "B1":
      return { state: { ...state, step: "A2", points: withPoint(state.points, 1, null) } };
    case "B2":
      return {
        state: {
          ...state,
          step: "B1",
          fixedTileId: null,
          points: withPoint(state.points, 2, null),
        },
      };
    case "applied":
      // The transform is already committed and undoable on its own; Esc just leaves.
      return { state: IDLE_ALIGN };
  }
}

function reduceClick(state: AlignMachine, tileId: string, point: CanvasPoint): AlignTransition {
  switch (state.step) {
    case "idle":
    case "applied":
      return { state };
    case "pickMoving":
      return { state: { ...IDLE_ALIGN, step: "A1", movingTileId: tileId } };
    case "A1":
    case "A2": {
      if (tileId !== state.movingTileId) {
        return { state, refusal: ALIGN_STEP_HINTS[state.step] };
      }
      const index = state.step === "A1" ? 0 : 1;
      return {
        state: {
          ...state,
          step: state.step === "A1" ? "A2" : "B1",
          points: withPoint(state.points, index, point),
        },
      };
    }
    case "B1": {
      if (tileId === state.movingTileId) {
        return { state, refusal: ALIGN_STEP_HINTS.B1 };
      }
      return {
        state: { ...state, step: "B2", fixedTileId: tileId, points: withPoint(state.points, 2, point) },
      };
    }
    case "B2": {
      if (tileId === state.movingTileId) {
        return { state, refusal: ALIGN_STEP_HINTS.B2 };
      }
      const points = withPoint(state.points, 3, point);
      const [a1, a2, b1] = points;
      // Belt and braces: the only way to reach B2 is through A1/A2/B1.
      if (!a1 || !a2 || !b1 || !state.movingTileId) return { state };
      return {
        state: { ...state, step: "applied", points },
        apply: {
          movingTileId: state.movingTileId,
          fixedTileId: state.fixedTileId,
          movingPoints: [a1, a2],
          fixedPoints: [b1, { x: point.x, y: point.y }],
        },
      };
    }
  }
}
