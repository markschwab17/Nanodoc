import { describe, it, expect } from "vitest";
import {
  ALIGN_STEP_HINTS,
  IDLE_ALIGN,
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
    const last = run([
      enter,
      click("a", 0, 0),
      click("a", 10, 20),
      click("a", 30, 40),
      click("b", 100, 100),
      click("b", 130, 140),
    ]);
    expect(last.state.step).toBe("applied");
    expect(last.apply).toEqual({
      movingTileId: "a",
      fixedTileId: "b",
      movingPoints: [P(10, 20), P(30, 40)],
      fixedPoints: [P(100, 100), P(130, 140)],
    });
  });

  it("refuses a locked sheet during the A steps, with the step hint", () => {
    const state = run([enter, click("a", 0, 0)]).state;
    const refused = reduceAlign(state, click("b", 5, 5));
    expect(refused.refusal).toBe(ALIGN_STEP_HINTS.A1);
    expect(refused.state).toBe(state); // nothing recorded
    expect(refused.apply).toBeUndefined();
  });

  it("refuses the moving sheet during the B steps, with the step hint", () => {
    const state = run([enter, click("a", 0, 0), click("a", 1, 1), click("a", 2, 2)]).state;
    expect(state.step).toBe("B1");
    const refused = reduceAlign(state, click("a", 3, 3));
    expect(refused.refusal).toBe(ALIGN_STEP_HINTS.B1);
    expect(refused.state.step).toBe("B1");

    const atB2 = reduceAlign(state, click("b", 9, 9)).state;
    const refusedB2 = reduceAlign(atB2, click("a", 4, 4));
    expect(refusedB2.refusal).toBe(ALIGN_STEP_HINTS.B2);
    expect(refusedB2.apply).toBeUndefined();
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

  it("Enter confirms only at `applied`; elsewhere it changes nothing", () => {
    const midway = run([enter, click("a", 0, 0), click("a", 1, 1)]).state;
    expect(reduceAlign(midway, { type: "confirm" }).state).toBe(midway);

    const applied = run([
      enter,
      click("a", 0, 0),
      click("a", 1, 1),
      click("a", 2, 2),
      click("b", 3, 3),
      click("b", 4, 4),
    ]).state;
    expect(reduceAlign(applied, { type: "confirm" }).state).toEqual(IDLE_ALIGN);
    // Esc at `applied` also leaves, keeping the result (it is undoable on its own).
    expect(reduceAlign(applied, { type: "escape" }).state).toEqual(IDLE_ALIGN);
  });

  it("a click after the apply does nothing until the mode is re-entered", () => {
    const applied = run([
      enter,
      click("a", 0, 0),
      click("a", 1, 1),
      click("a", 2, 2),
      click("b", 3, 3),
      click("b", 4, 4),
    ]).state;
    const after = reduceAlign(applied, click("b", 5, 5));
    expect(after.state).toBe(applied);
    expect(after.apply).toBeUndefined();
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
    expect(loupeActive({ ...IDLE_ALIGN, step: "applied" })).toBe(false);
  });

  it("uses the plan's exact step copy", () => {
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
