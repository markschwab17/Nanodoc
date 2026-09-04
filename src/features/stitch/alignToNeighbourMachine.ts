/**
 * "Align to neighbour" — the pure state machine.
 *
 * Mark, 2026-09-04: "Some of the controls are not super intuitive, how to lock a page
 * down while you 2 point snap click another sheet to it." And, after using it:
 * "sheets rarely rotate, it's mostly stacking and aligning the points."
 *
 * So the default is ONE point: pick the sheet that moves, click an anchor on it, click
 * the matching point on a sheet that is staying put, and it slides there — no rotation,
 * no resize. **Rotate too (2 points)** switches to the full two-points-each-side flow
 * for the rare sheet that is turned.
 *
 * Either way a finished move drops back to step 0 and the sheet that just moved JOINS
 * THE GROUP: it is placed now, and the next click picks the next sheet to bring in.
 * Chaining is the whole job — sheet 2 onto sheet 1, sheet 3 onto that pair — and the
 * failure Mark hit was the mode peeling the sheet it had just placed and dragging it
 * to the next one instead.
 *
 * The machine is free of React and of the store: it takes a click (tile id + canvas
 * point), a miss, a key, or a toggle, and returns the next state plus, at most, ONE
 * side effect (`apply`, the transform the caller commits as a single undo step) or ONE
 * refusal (a sentence naming what went wrong, then the step hint).
 */

import type { CanvasPoint } from "./stitchGeometry";

/** Where the mode is: which click it is waiting for. */
export type AlignStep = "idle" | "pickMoving" | "A1" | "A2" | "B1" | "B2";

export interface AlignMachine {
  step: AlignStep;
  /** **Rotate too (2 points)**. Off = one anchor each side, translation only. */
  twoPoint: boolean;
  /** The sheet the user chose to move. Every other sheet is locked while set. */
  movingTileId: string | null;
  /** The sheet clicked for B1 — the one the moving sheet is being brought to. */
  fixedTileId: string | null;
  /** The sheet the last apply moved. Kept selected so the arrow keys still nudge it,
   *  and it is what makes step 0 say "the NEXT sheet". */
  lastMovedTileId: string | null;
  /** Every sheet this session has placed: the group the next sheet joins. They are
   *  FIXED — a click at step 0 prefers a sheet that is not one of them, so the mode
   *  cannot pick up what it just put down. */
  placedTileIds: string[];
  /** [A1, A2, B1, B2] in canvas space. A* on the moving sheet, B* on the fixed one.
   *  One-point mode uses slots 0 and 2 only. */
  points: [CanvasPoint | null, CanvasPoint | null, CanvasPoint | null, CanvasPoint | null];
}

export type AlignEvent =
  | { type: "enter" }
  | { type: "exit" }
  | { type: "click"; tileId: string; point: CanvasPoint }
  /** A click that landed on no sheet at all. */
  | { type: "miss" }
  | { type: "escape" }
  | { type: "confirm" }
  /** The **Rotate too (2 points)** toggle. */
  | { type: "setTwoPoint"; value: boolean };

/** The transform the caller must commit, as ONE undo step, when the last click lands. */
export interface AlignApply {
  movingTileId: string;
  fixedTileId: string | null;
  /** The point(s) clicked on the moving sheet: one in one-point mode, two otherwise. */
  movingPoints: CanvasPoint[];
  /** Where they must end up — the matching point(s) on the fixed sheet. */
  fixedPoints: CanvasPoint[];
}

export type RefusalReason = "wrong-sheet" | "no-sheet";
export interface AlignRefusal {
  reason: RefusalReason;
  /** The whole sentence to show and announce — never colour alone. */
  message: string;
}

export interface AlignTransition {
  state: AlignMachine;
  refusal?: AlignRefusal;
  /** Set on the click that completes a move. */
  apply?: AlignApply;
}

export const IDLE_ALIGN: AlignMachine = {
  step: "idle",
  twoPoint: false,
  movingTileId: null,
  fixedTileId: null,
  lastMovedTileId: null,
  placedTileIds: [],
  points: [null, null, null, null],
};

/** Two-point copy, exactly as the round-3 plan's Global Constraints. */
export const ALIGN_STEP_HINTS: Record<AlignStep, string> = {
  idle: "",
  pickMoving: "Click the sheet you want to move",
  A1: "Click the first point on the sheet you're moving",
  A2: "Click the second point",
  B1: "Now click the matching first point on the fixed sheet",
  B2: "Click the matching second point",
};

/** One-point copy: one anchor each side, and no second point to talk about. */
export const ALIGN_ONE_POINT_HINTS: Record<"A1" | "B1", string> = {
  A1: "Click the anchor point on the sheet you're moving",
  B1: "Now click the matching point on a fixed sheet",
};

/** Step 0 after a move: the mode stays open for the next neighbour. */
export const ALIGN_NEXT_SHEET_HINT = "Pick the next sheet to move, or press Done";

const REFUSAL_PREFIX: Record<RefusalReason, string> = {
  "wrong-sheet": "Not that sheet",
  "no-sheet": "No sheet there",
};

export function alignHint(state: AlignMachine): string {
  if (state.step === "pickMoving" && state.lastMovedTileId) return ALIGN_NEXT_SHEET_HINT;
  if (!state.twoPoint && (state.step === "A1" || state.step === "B1")) {
    return ALIGN_ONE_POINT_HINTS[state.step];
  }
  return ALIGN_STEP_HINTS[state.step];
}

function refuse(reason: RefusalReason, state: AlignMachine): AlignTransition {
  return { state, refusal: { reason, message: `${REFUSAL_PREFIX[reason]} — ${alignHint(state)}` } };
}

/** The loupe is only useful while the user is placing points. */
export function loupeActive(state: AlignMachine): boolean {
  return state.step === "A1" || state.step === "A2" || state.step === "B1" || state.step === "B2";
}

/** True while `tileId` is locked for the mode — every sheet except the moving one. */
export function isLockedForAlign(state: AlignMachine, tileId: string): boolean {
  return state.movingTileId != null && tileId !== state.movingTileId;
}

/** Has this sheet already been placed in this session? (Part of the fixed group.) */
export function isPlacedInAlign(state: AlignMachine, tileId: string): boolean {
  return state.placedTileIds.includes(tileId);
}

/**
 * The sheets a click at this step may land on: only the moving sheet while its own
 * point(s) are being placed, everything BUT it while the matching point(s) are, and
 * anything at all while one is being picked.
 *
 * The hit test uses this rather than testing every tile and refusing afterwards —
 * sheets overlap along a matchline, and a top-most hit test over all of them let the
 * wrong sheet swallow the click (and blank the loupe) exactly in the band where the
 * user is working.
 */
export function alignClickableTiles<T extends { id: string }>(
  state: AlignMachine,
  tiles: readonly T[]
): T[] {
  switch (state.step) {
    case "A1":
    case "A2":
      return tiles.filter((t) => t.id === state.movingTileId);
    case "B1":
    case "B2":
      return tiles.filter((t) => t.id !== state.movingTileId);
    case "pickMoving":
      return [...tiles];
    default:
      return [];
  }
}

/**
 * Which sheet a click at step 0 should PICK, when several are under the cursor.
 *
 * Every sheet is pickable — a placement can be redone — but a sheet this session has
 * already placed is tried LAST. Aligning sheet 2 onto sheet 1 routinely leaves it
 * covering the grid slot sheet 3 is still sitting in, and a plain top-most hit test
 * then handed the next click back to sheet 2: the mode peeled the sheet it had just
 * placed and walked it to sheet 3 instead of bringing sheet 3 into the group.
 */
export function alignPickTargets<T extends { id: string }>(
  state: AlignMachine,
  tiles: readonly T[]
): { preferred: T[]; fallback: T[] } {
  const placed = new Set(state.placedTileIds);
  return { preferred: tiles.filter((t) => !placed.has(t.id)), fallback: [...tiles] };
}

export type AlignPointerEvent = Extract<AlignEvent, { type: "click" } | { type: "miss" }>;

/**
 * What a pointer press should dispatch.
 *
 * `scoped` is the hit against the sheets this step accepts; `unscoped` is the hit
 * against ALL of them. A press that misses the scoped set but lands on some other
 * sheet is a wrong-sheet click, not a click into space — dispatching it as a click
 * makes the machine refuse it by name ("Not that sheet — …"), which is the whole
 * point of having refusals. Only a press that hits nothing at all is a miss.
 */
export function alignPointerEvent(
  scoped: { tileId: string; point: CanvasPoint } | null,
  unscoped: { tileId: string; point: CanvasPoint } | null
): AlignPointerEvent {
  const hit = scoped ?? unscoped;
  return hit ? { type: "click", tileId: hit.tileId, point: hit.point } : { type: "miss" };
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

/** Step 0, carrying everything a session accumulates. */
function backToPick(state: AlignMachine, over: Partial<AlignMachine> = {}): AlignMachine {
  return {
    ...IDLE_ALIGN,
    step: "pickMoving",
    twoPoint: state.twoPoint,
    lastMovedTileId: state.lastMovedTileId,
    placedTileIds: state.placedTileIds,
    ...over,
  };
}

/** One click, one key, one toggle → the next state (+ at most one effect). */
export function reduceAlign(state: AlignMachine, event: AlignEvent): AlignTransition {
  switch (event.type) {
    case "enter":
      // The toggle is a preference, not a step: it survives leaving and re-entering.
      return { state: { ...IDLE_ALIGN, step: "pickMoving", twoPoint: state.twoPoint } };
    case "exit":
      return { state: { ...IDLE_ALIGN, twoPoint: state.twoPoint } };
    case "setTwoPoint": {
      if (state.twoPoint === event.value) return { state };
      const next = { ...state, twoPoint: event.value };
      // Switching mid-sequence changes how many clicks are owed, so the points so far
      // are void — back to the first anchor, keeping the sheet being moved.
      if (state.step === "A1" || state.step === "A2" || state.step === "B1" || state.step === "B2") {
        return {
          state: { ...next, step: "A1", fixedTileId: null, points: [null, null, null, null] },
        };
      }
      return { state: next };
    }
    case "confirm":
      // Enter is Done: it finishes the session between moves. Mid-sequence it is not a
      // shortcut for the click the user still owes us.
      return state.step === "pickMoving" ? { state: { ...IDLE_ALIGN, twoPoint: state.twoPoint } } : { state };
    case "escape":
      return reduceEscape(state);
    case "miss":
      return state.step === "idle" ? { state } : refuse("no-sheet", state);
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
      return { state: { ...IDLE_ALIGN, twoPoint: state.twoPoint } };
    case "A1":
      return { state: backToPick(state) };
    case "A2":
      return { state: { ...state, step: "A1", points: withPoint(state.points, 0, null) } };
    case "B1":
      // One-point mode has no A2: backing out of the matching point returns to the
      // single anchor, clearing it.
      return state.twoPoint
        ? { state: { ...state, step: "A2", points: withPoint(state.points, 1, null) } }
        : { state: { ...state, step: "A1", points: withPoint(state.points, 0, null) } };
    case "B2":
      return {
        state: {
          ...state,
          step: "B1",
          fixedTileId: null,
          points: withPoint(state.points, 2, null),
        },
      };
  }
}

/** The move is done: the sheet joins the placed group and step 0 comes back. */
function applied(state: AlignMachine, movingTileId: string, apply: AlignApply): AlignTransition {
  return {
    state: backToPick(state, {
      lastMovedTileId: movingTileId,
      placedTileIds: state.placedTileIds.includes(movingTileId)
        ? state.placedTileIds
        : [...state.placedTileIds, movingTileId],
    }),
    apply,
  };
}

function reduceClick(state: AlignMachine, tileId: string, point: CanvasPoint): AlignTransition {
  switch (state.step) {
    case "idle":
      return { state };
    case "pickMoving":
      return {
        state: {
          ...IDLE_ALIGN,
          step: "A1",
          twoPoint: state.twoPoint,
          movingTileId: tileId,
          lastMovedTileId: state.lastMovedTileId,
          placedTileIds: state.placedTileIds,
        },
      };
    case "A1": {
      if (tileId !== state.movingTileId) return refuse("wrong-sheet", state);
      return {
        state: {
          ...state,
          step: state.twoPoint ? "A2" : "B1",
          points: withPoint(state.points, 0, point),
        },
      };
    }
    case "A2": {
      if (tileId !== state.movingTileId) return refuse("wrong-sheet", state);
      return { state: { ...state, step: "B1", points: withPoint(state.points, 1, point) } };
    }
    case "B1": {
      if (tileId === state.movingTileId) return refuse("wrong-sheet", state);
      const points = withPoint(state.points, 2, point);
      if (state.twoPoint) {
        return { state: { ...state, step: "B2", fixedTileId: tileId, points } };
      }
      // One point each side: this click finishes the move.
      const a1 = points[0];
      if (!a1 || !state.movingTileId) return { state };
      return applied(state, state.movingTileId, {
        movingTileId: state.movingTileId,
        fixedTileId: tileId,
        movingPoints: [a1],
        fixedPoints: [{ x: point.x, y: point.y }],
      });
    }
    case "B2": {
      if (tileId === state.movingTileId) return refuse("wrong-sheet", state);
      const points = withPoint(state.points, 3, point);
      const [a1, a2, b1] = points;
      // Belt and braces: the only way to reach B2 is through A1/A2/B1.
      if (!a1 || !a2 || !b1 || !state.movingTileId) return { state };
      return applied(state, state.movingTileId, {
        movingTileId: state.movingTileId,
        fixedTileId: state.fixedTileId,
        movingPoints: [a1, a2],
        fixedPoints: [b1, { x: point.x, y: point.y }],
      });
    }
  }
}
