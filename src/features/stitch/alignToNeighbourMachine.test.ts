import { describe, it, expect } from "vitest";
import {
  ALIGN_NEXT_SHEET_HINT,
  ALIGN_STEP_HINTS,
  IDLE_ALIGN,
  alignClickableTiles,
  alignPointerEvent,
  alignHint,
  isLockedForAlign,
  loupeActive,
  reduceAlign,
  type AlignMachine,
} from "./alignToNeighbourMachine";

const P = (x: number, y: number) => ({ x, y });

/** Walk the machine through a list of events, returning the last transition. */
function run(events: Parameters<typeof reduceAlign>[1][], from: AlignMachine = IDLE_ALIGN) {
  let state = from;
  let last = { state } as ReturnType<typeof reduceAlign>;
  for (const e of events) {
    last = reduceAlign(state, e);
    state = last.state;
  }
  return last;
}

const enter = { type: "enter" } as const;
const click = (tileId: string, x: number, y: number) =>
  ({ type: "click", tileId, point: P(x, y) }) as const;
/** The whole four-click sequence, moving "a" onto "b". */
const fullRun = [
  enter,
  click("a", 0, 0),
  click("a", 1, 1),
  click("a", 2, 2),
  click("b", 3, 3),
  click("b", 4, 4),
];

describe("alignToNeighbour state machine", () => {
  it("enters at pickMoving with nothing chosen", () => {
    const { state } = reduceAlign(IDLE_ALIGN, enter);
    expect(state.step).toBe("pickMoving");
    expect(state.movingTileId).toBeNull();
    expect(state.points).toEqual([null, null, null, null]);
  });

  it("the first click picks the moving sheet and locks every other one", () => {
    const { state } = run([enter, click("a", 1, 1)]);
    expect(state.step).toBe("A1");
    expect(state.movingTileId).toBe("a");
    expect(isLockedForAlign(state, "b")).toBe(true);
    expect(isLockedForAlign(state, "a")).toBe(false);
    // No point was recorded by the pick — it only chose the sheet.
    expect(state.points).toEqual([null, null, null, null]);
  });

  it("runs A1 → A2 → B1 → B2 and applies on the fourth click", () => {
    const last = run(fullRun);
    expect(last.apply).toEqual({
      movingTileId: "a",
      fixedTileId: "b",
      movingPoints: [P(1, 1), P(2, 2)],
      fixedPoints: [P(3, 3), P(4, 4)],
    });
  });

  it("loops back to pickMoving for the next neighbour, remembering what moved", () => {
    const { state } = run(fullRun);
    expect(state.step).toBe("pickMoving");
    expect(state.movingTileId).toBeNull();
    expect(state.lastMovedTileId).toBe("a");
    expect(state.points).toEqual([null, null, null, null]);
    expect(alignHint(state)).toBe(ALIGN_NEXT_SHEET_HINT);
    // Nothing is locked between moves — any sheet can be picked next.
    expect(isLockedForAlign(state, "b")).toBe(false);
    // …and picking one starts a fresh sequence.
    const next = reduceAlign(state, click("c", 9, 9));
    expect(next.state.step).toBe("A1");
    expect(next.state.movingTileId).toBe("c");
    expect(next.state.lastMovedTileId).toBe("a");
  });

  it("scopes the clickable sheets to the step", () => {
    const tiles = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const picking = run([enter]).state;
    expect(alignClickableTiles(picking, tiles)).toHaveLength(3);

    const placingA = run([enter, click("a", 0, 0)]).state;
    expect(alignClickableTiles(placingA, tiles).map((t) => t.id)).toEqual(["a"]);

    const placingB = run([enter, click("a", 0, 0), click("a", 1, 1), click("a", 2, 2)]).state;
    expect(alignClickableTiles(placingB, tiles).map((t) => t.id)).toEqual(["b", "c"]);

    expect(alignClickableTiles(IDLE_ALIGN, tiles)).toHaveLength(0);
  });

  it("refuses a locked sheet during the A steps, naming what went wrong", () => {
    const state = run([enter, click("a", 0, 0)]).state;
    const refused = reduceAlign(state, click("b", 5, 5));
    expect(refused.refusal).toEqual({
      reason: "wrong-sheet",
      message: `Not that sheet — ${ALIGN_STEP_HINTS.A1}`,
    });
    expect(refused.state).toBe(state); // nothing recorded
    expect(refused.apply).toBeUndefined();
  });

  it("refuses the moving sheet during the B steps", () => {
    const state = run([enter, click("a", 0, 0), click("a", 1, 1), click("a", 2, 2)]).state;
    expect(state.step).toBe("B1");
    expect(reduceAlign(state, click("a", 3, 3)).refusal).toEqual({
      reason: "wrong-sheet",
      message: `Not that sheet — ${ALIGN_STEP_HINTS.B1}`,
    });

    const atB2 = reduceAlign(state, click("b", 9, 9)).state;
    const refusedB2 = reduceAlign(atB2, click("a", 4, 4));
    expect(refusedB2.refusal?.reason).toBe("wrong-sheet");
    expect(refusedB2.apply).toBeUndefined();
  });

  it("turns a press onto the wrong sheet into a refusable click, not a miss", () => {
    const scoped = { tileId: "a", point: P(1, 1) };
    const other = { tileId: "b", point: P(5, 5) };
    // The step's own sheet was hit: that is the click.
    expect(alignPointerEvent(scoped, other)).toEqual({ type: "click", tileId: "a", point: P(1, 1) });
    // It missed the step's sheets but landed on another one — a WRONG SHEET, which the
    // machine then refuses by name rather than reporting as empty canvas.
    expect(alignPointerEvent(null, other)).toEqual({ type: "click", tileId: "b", point: P(5, 5) });
    // Nothing under the cursor at all.
    expect(alignPointerEvent(null, null)).toEqual({ type: "miss" });
  });

  it("refuses that wrong-sheet press with the sheet wording, not the empty wording", () => {
    const state = run([enter, click("a", 0, 0)]).state;
    const event = alignPointerEvent(null, { tileId: "b", point: P(5, 5) });
    const refused = reduceAlign(state, event);
    expect(refused.refusal).toEqual({
      reason: "wrong-sheet",
      message: `Not that sheet — ${ALIGN_STEP_HINTS.A1}`,
    });
  });

  it("says so when a click lands on no sheet at all", () => {
    const state = run([enter, click("a", 0, 0)]).state;
    const missed = reduceAlign(state, { type: "miss" });
    expect(missed.refusal).toEqual({
      reason: "no-sheet",
      message: `No sheet there — ${ALIGN_STEP_HINTS.A1}`,
    });
    expect(missed.state).toBe(state);
    // A miss outside the mode is not a refusal.
    expect(reduceAlign(IDLE_ALIGN, { type: "miss" }).refusal).toBeUndefined();
  });

  it("Esc backs up exactly one click, all the way to pickMoving, then exits", () => {
    const atB2 = run([
      enter,
      click("a", 0, 0),
      click("a", 1, 1),
      click("a", 2, 2),
      click("b", 3, 3),
    ]).state;
    expect(atB2.step).toBe("B2");

    const backToB1 = reduceAlign(atB2, { type: "escape" }).state;
    expect(backToB1.step).toBe("B1");
    expect(backToB1.points[2]).toBeNull();
    expect(backToB1.fixedTileId).toBeNull();

    const backToA2 = reduceAlign(backToB1, { type: "escape" }).state;
    expect(backToA2.step).toBe("A2");
    expect(backToA2.points[1]).toBeNull();
    expect(backToA2.points[0]).toEqual(P(1, 1));

    const backToA1 = reduceAlign(backToA2, { type: "escape" }).state;
    expect(backToA1.step).toBe("A1");
    expect(backToA1.points[0]).toBeNull();
    expect(backToA1.movingTileId).toBe("a");

    const backToPick = reduceAlign(backToA1, { type: "escape" }).state;
    expect(backToPick.step).toBe("pickMoving");
    expect(backToPick.movingTileId).toBeNull();

    const exited = reduceAlign(backToPick, { type: "escape" }).state;
    expect(exited).toEqual(IDLE_ALIGN);
  });

  it("Esc mid-sequence after a move keeps the memory of what moved", () => {
    const afterMove = run(fullRun).state;
    const started = reduceAlign(afterMove, click("c", 1, 1)).state;
    const backed = reduceAlign(started, { type: "escape" }).state;
    expect(backed.step).toBe("pickMoving");
    expect(backed.lastMovedTileId).toBe("a");
  });

  it("Enter is Done between moves and does nothing mid-sequence", () => {
    const midway = run([enter, click("a", 0, 0), click("a", 1, 1)]).state;
    expect(reduceAlign(midway, { type: "confirm" }).state).toBe(midway);

    const afterMove = run(fullRun).state;
    expect(reduceAlign(afterMove, { type: "confirm" }).state).toEqual(IDLE_ALIGN);
  });

  it("B2 may land on a different fixed sheet than B1", () => {
    const last = run([
      enter,
      click("a", 0, 0),
      click("a", 1, 1),
      click("a", 2, 2),
      click("b", 3, 3),
      click("c", 4, 4),
    ]);
    expect(last.apply?.fixedPoints).toEqual([P(3, 3), P(4, 4)]);
    expect(last.apply?.fixedTileId).toBe("b");
  });

  it("the loupe is up for exactly the four point clicks", () => {
    expect(loupeActive({ ...IDLE_ALIGN, step: "pickMoving" })).toBe(false);
    for (const step of ["A1", "A2", "B1", "B2"] as const) {
      expect(loupeActive({ ...IDLE_ALIGN, step })).toBe(true);
    }
    expect(loupeActive(IDLE_ALIGN)).toBe(false);
  });

  it("uses the plan's exact step copy", () => {
    expect(alignHint({ ...IDLE_ALIGN, step: "pickMoving" })).toBe("Click the sheet you want to move");
    expect(alignHint({ ...IDLE_ALIGN, step: "A1" })).toBe(
      "Click the first point on the sheet you're moving"
    );
    expect(alignHint({ ...IDLE_ALIGN, step: "A2" })).toBe("Click the second point");
    expect(alignHint({ ...IDLE_ALIGN, step: "B1" })).toBe(
      "Now click the matching first point on the fixed sheet"
    );
    expect(alignHint({ ...IDLE_ALIGN, step: "B2" })).toBe("Click the matching second point");
  });

  it("exit from anywhere returns to idle", () => {
    const midway = run([enter, click("a", 0, 0), click("a", 1, 1)]).state;
    expect(reduceAlign(midway, { type: "exit" }).state).toEqual(IDLE_ALIGN);
  });
});
