/**
 * "Align to neighbour" — the pure state machine.
 *
 * Mark, twice, and the second time is the one that shaped this: "Some of the controls
 * are not super intuitive, how to lock a page down while you 2 point snap click another
 * sheet to it" … then, after using it, "When you do the manual alignment and you click
 * the first PDF, that should be the PDF that doesn't move. Right now it moves to the
 * next PDF that you click."
 *
 * So the first click is the ANCHOR. You click a point on the sheet that stays put, then
 * the matching point on another sheet, and THAT sheet slides over to meet it. No pick
 * step, no mode to be in first: the two clicks say everything — this point, on this
 * sheet, is where that point, on that sheet, has to end up. It reads the way people
 * describe the job out loud, and it matches the mental model of building outwards from
 * a sheet you have already placed.
 *
 * By default it is one point each side, a pure translation: "sheets rarely rotate, it's
 * mostly stacking and aligning the points." **Rotate too (2 points)** takes two points
 * on the fixed sheet and then the two matching points on the sheet to move.
 *
 * Every completed pair leaves both sheets in the GROUP and returns to click 1, so a set
 * is built one neighbour at a time without ever leaving the mode.
 *
 * The machine is free of React and of the store: it takes a click (tile id + canvas
 * point), a miss, a key, or a toggle, and returns the next state plus, at most, ONE
 * side effect (`apply`, the transform the caller commits as a single undo step) or ONE
 * refusal (a sentence saying what to do instead).
 */

import { hitTestTileAtPoint, type CanvasPoint, type TilePose } from "./stitchGeometry";

/**
 * Where the mode is: which click it is waiting for.
 *
 * `F*` are on the sheet that STAYS (the anchor), `M*` on the sheet that MOVES.
 * One-point mode uses F1 and M1 only.
 */
export type AlignStep = "idle" | "F1" | "F2" | "M1" | "M2";

export interface AlignMachine {
  step: AlignStep;
  /** **Rotate too (2 points)**. Off = one anchor each side, translation only. */
  twoPoint: boolean;
  /** The sheet clicked first: it does NOT move. */
  fixedTileId: string | null;
  /** The sheet clicked second: it moves to meet the anchor. */
  movingTileId: string | null;
  /** The sheet the last apply moved. Stays selected, so the arrow keys nudge it. */
  lastMovedTileId: string | null;
  /** Every sheet this session has anchored to or placed: the composition so far. A
   *  sheet joins as soon as it is used as an anchor, and again when it is moved. */
  placedTileIds: string[];
  /** [F1, F2, M1, M2] in canvas space. One-point mode uses slots 0 and 2. */
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
  /** The sheet that moves. */
  movingTileId: string;
  /** The sheet it is being brought to, which does not move. */
  fixedTileId: string | null;
  /** The point(s) clicked on the moving sheet: one, or two with **Rotate too**. */
  movingPoints: CanvasPoint[];
  /** Where they must end up — the matching point(s) on the anchor sheet. */
  fixedPoints: CanvasPoint[];
}

export type RefusalReason = "wrong-sheet" | "same-sheet" | "no-sheet";
export interface AlignRefusal {
  reason: RefusalReason;
  /** The whole sentence to show and announce — never colour alone. */
  message: string;
}

export interface AlignTransition {
  state: AlignMachine;
  refusal?: AlignRefusal;
  /** Set on the click that completes a pair. */
  apply?: AlignApply;
}

export const IDLE_ALIGN: AlignMachine = {
  step: "idle",
  twoPoint: false,
  fixedTileId: null,
  movingTileId: null,
  lastMovedTileId: null,
  placedTileIds: [],
  points: [null, null, null, null],
};

/** One point each side — the default. */
export const ALIGN_ONE_POINT_HINTS: Record<"F1" | "M1", string> = {
  F1: "Click a point on the sheet that stays put",
  M1: "Now click the matching point on the sheet to move",
};

/** **Rotate too (2 points)**: two on the anchor, then the two that match them. */
export const ALIGN_TWO_POINT_HINTS: Record<"F1" | "F2" | "M1" | "M2", string> = {
  F1: "Click the first point on the sheet that stays put",
  F2: "Click the second point",
  M1: "Now click the matching first point on the sheet to move",
  M2: "Click the matching second point",
};

/** Said when the second click lands back on the anchor: the whole point is two sheets. */
export const ALIGN_SAME_SHEET_REFUSAL = "Click the matching point on a different sheet";

export function alignHint(state: AlignMachine): string {
  if (state.step === "idle") return "";
  if (!state.twoPoint) {
    return state.step === "F1" || state.step === "F2"
      ? ALIGN_ONE_POINT_HINTS.F1
      : ALIGN_ONE_POINT_HINTS.M1;
  }
  return ALIGN_TWO_POINT_HINTS[state.step];
}

function refuse(reason: RefusalReason, state: AlignMachine): AlignTransition {
  const message =
    reason === "same-sheet"
      ? ALIGN_SAME_SHEET_REFUSAL
      : `${reason === "wrong-sheet" ? "Not that sheet" : "No sheet there"} — ${alignHint(state)}`;
  return { state, refusal: { reason, message } };
}

/** The loupe is up for every point click — which is all of them. */
export function loupeActive(state: AlignMachine): boolean {
  return state.step !== "idle";
}

/** Has this sheet been used yet in this session? (Anchored to, or placed.) */
export function isPlacedInAlign(state: AlignMachine, tileId: string): boolean {
  return state.placedTileIds.includes(tileId);
}

/** How faded a sheet is drawn while the moving point is being placed. */
export const ALIGN_DIM_ANCHOR = 0.25;

/**
 * The opacity a sheet should be drawn at, for the step the mode is on.
 *
 * The rule is "fade what you cannot click", and Mark hit the cost of getting it wrong
 * immediately — aiming at a sheet the mode had greyed out means reading the faint half
 * of the picture to find the line you have to hit.
 *
 *   F1 / F2   nothing fades: any sheet can be the anchor (the group is outlined).
 *   M1 / M2   the ANCHOR fades to 25 % — its point is already placed and marked, and it
 *             is usually lying over the sheets you are choosing between. Every
 *             candidate stays at full strength.
 */
export function alignSheetOpacity(state: AlignMachine, tileId: string): number {
  if (state.step !== "M1" && state.step !== "M2") return 1;
  return tileId === state.fixedTileId ? ALIGN_DIM_ANCHOR : 1;
}

/**
 * The sheets a click at this step may land on: anything at all for the anchor, the
 * anchor itself for its second point, anything BUT the anchor for the sheet to move,
 * and that sheet alone for its second point.
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
    case "F1":
      return [...tiles];
    case "F2":
      return tiles.filter((t) => t.id === state.fixedTileId);
    case "M1":
      return tiles.filter((t) => t.id !== state.fixedTileId);
    case "M2":
      return tiles.filter((t) => t.id === state.movingTileId);
    default:
      return [];
  }
}

/**
 * Which sheet the MOVE click should take, when several are under the cursor.
 *
 * Every candidate is clickable, but a sheet this session has already placed is tried
 * LAST: an aligned sheet routinely ends up covering the grid slot the next sheet is
 * still sitting in, and a plain top-most test then handed the click to the sheet that
 * was already done.
 */
export function alignPickTargets<T extends { id: string }>(
  state: AlignMachine,
  tiles: readonly T[]
): { preferred: T[]; fallback: T[] } {
  const clickable = alignClickableTiles(state, tiles);
  const placed = new Set(state.placedTileIds);
  return { preferred: clickable.filter((t) => !placed.has(t.id)), fallback: clickable };
}

/**
 * The sheet a press lands on, for the step the mode is on.
 *
 * Only the M1 step needs two passes (unplaced first — see `alignPickTargets`); every
 * other step has one honest candidate set and takes the top-most hit in it.
 */
export function alignHitForStep<T extends TilePose & { id: string }>(
  coords: CanvasPoint,
  state: AlignMachine,
  tiles: readonly T[]
): { tile: T; point: CanvasPoint } | null {
  if (state.step === "M1") {
    const { preferred, fallback } = alignPickTargets(state, tiles);
    return hitTestTileAtPoint(coords, preferred, true) ?? hitTestTileAtPoint(coords, fallback, true);
  }
  return hitTestTileAtPoint(coords, alignClickableTiles(state, tiles), true);
}

export type AlignPointerEvent = Extract<AlignEvent, { type: "click" } | { type: "miss" }>;

/**
 * What a pointer press should dispatch.
 *
 * `scoped` is the hit against the sheets this step accepts; `unscoped` is the hit
 * against ALL of them. A press that misses the scoped set but lands on some other
 * sheet is a wrong sheet, not a click into space — dispatching it as a click makes the
 * machine say which sheet it wanted instead. Only a press that hits nothing at all is
 * a miss.
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

const withPlaced = (placed: readonly string[], ids: (string | null)[]): string[] => {
  const next = [...placed];
  for (const id of ids) if (id && !next.includes(id)) next.push(id);
  return next;
};

/** Back to the first click, carrying everything a session accumulates. */
function ready(state: AlignMachine, over: Partial<AlignMachine> = {}): AlignMachine {
  return {
    ...IDLE_ALIGN,
    step: "F1",
    twoPoint: state.twoPoint,
    lastMovedTileId: state.lastMovedTileId,
    placedTileIds: state.placedTileIds,
    ...over,
  };
}

/** Leaving: the toggle and the group are remembered for the next time. */
function closed(state: AlignMachine): AlignMachine {
  return { ...IDLE_ALIGN, twoPoint: state.twoPoint, placedTileIds: state.placedTileIds };
}

/** One click, one key, one toggle → the next state (+ at most one effect). */
export function reduceAlign(state: AlignMachine, event: AlignEvent): AlignTransition {
  switch (event.type) {
    case "enter":
      // The toggle is a preference and the GROUP is a fact about the canvas — both
      // survive leaving and re-entering, so a chain interrupted by a pan-tool detour
      // resumes with the sheets it had already placed still part of the composition.
      // Ids of sheets that have since been deleted are inert: nothing looks them up
      // except the pick order and the outline, and both skip an id with no tile.
      // `lastMovedTileId` is per session: a re-entry has not moved anything yet.
      return { state: ready(state, { lastMovedTileId: null }) };
    case "exit":
      return { state: closed(state) };
    case "setTwoPoint": {
      if (state.twoPoint === event.value) return { state };
      const next = { ...state, twoPoint: event.value };
      // Switching mid-pair changes how many clicks are owed, so the points so far are
      // void — back to the anchor click.
      if (state.step !== "idle") return { state: ready(next) };
      return { state: next };
    }
    case "confirm":
      // Enter is Done. Unlike Esc (which walks back one click at a time) it leaves
      // outright, which is what makes it a way OUT of a half-finished pair.
      return state.step === "idle" ? { state } : { state: closed(state) };
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
    case "F1":
      // Nothing placed yet — Esc here leaves the mode.
      return { state: closed(state) };
    case "F2":
      return {
        state: { ...state, step: "F1", fixedTileId: null, points: withPoint(state.points, 0, null) },
      };
    case "M1":
      return state.twoPoint
        ? { state: { ...state, step: "F2", points: withPoint(state.points, 1, null) } }
        : {
            state: {
              ...state,
              step: "F1",
              fixedTileId: null,
              points: withPoint(state.points, 0, null),
            },
          };
    case "M2":
      return {
        state: {
          ...state,
          step: "M1",
          movingTileId: null,
          points: withPoint(state.points, 2, null),
        },
      };
  }
}

/** The pair is done: both sheets are part of the composition, and click 1 comes back. */
function applied(state: AlignMachine, apply: AlignApply): AlignTransition {
  return {
    state: ready(state, {
      lastMovedTileId: apply.movingTileId,
      placedTileIds: withPlaced(state.placedTileIds, [apply.fixedTileId, apply.movingTileId]),
    }),
    apply,
  };
}

function reduceClick(state: AlignMachine, tileId: string, point: CanvasPoint): AlignTransition {
  switch (state.step) {
    case "idle":
      return { state };
    case "F1":
      // The anchor. It joins the composition the moment it is used as one.
      return {
        state: {
          ...state,
          step: state.twoPoint ? "F2" : "M1",
          fixedTileId: tileId,
          movingTileId: null,
          placedTileIds: withPlaced(state.placedTileIds, [tileId]),
          points: withPoint([null, null, null, null], 0, point),
        },
      };
    case "F2": {
      // Both anchor points have to be on the anchor sheet: they define one line on it.
      if (tileId !== state.fixedTileId) return refuse("wrong-sheet", state);
      return { state: { ...state, step: "M1", points: withPoint(state.points, 1, point) } };
    }
    case "M1": {
      // The whole gesture is "this sheet, to that one" — a second click on the anchor
      // says nothing.
      if (tileId === state.fixedTileId) return refuse("same-sheet", state);
      const points = withPoint(state.points, 2, point);
      if (state.twoPoint) {
        return { state: { ...state, step: "M2", movingTileId: tileId, points } };
      }
      const f1 = points[0];
      if (!f1) return { state };
      return applied(state, {
        movingTileId: tileId,
        fixedTileId: state.fixedTileId,
        movingPoints: [{ x: point.x, y: point.y }],
        fixedPoints: [f1],
      });
    }
    case "M2": {
      // The moving pair defines a line on the MOVING sheet; both points must be on it.
      if (tileId !== state.movingTileId) return refuse("wrong-sheet", state);
      const points = withPoint(state.points, 3, point);
      const [f1, f2, m1] = points;
      if (!f1 || !f2 || !m1 || !state.movingTileId) return { state };
      return applied(state, {
        movingTileId: state.movingTileId,
        fixedTileId: state.fixedTileId,
        movingPoints: [m1, { x: point.x, y: point.y }],
        fixedPoints: [f1, f2],
      });
    }
  }
}
