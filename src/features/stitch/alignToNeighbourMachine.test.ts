import { describe, it, test, expect } from "vitest";
import {
  ALIGN_DIM_FIXED,
  ALIGN_DIM_MOVER,
  ALIGN_NEXT_SHEET_HINT,
  alignHitForPick,
  alignSheetOpacity,
  ALIGN_ONE_POINT_HINTS,
  ALIGN_STEP_HINTS,
  IDLE_ALIGN,
  alignClickableTiles,
  alignHint,
  alignPickTargets,
  alignPointerEvent,
  isPlacedInAlign,
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
const rotateToo = { type: "setTwoPoint", value: true } as const;
const click = (tileId: string, x: number, y: number) =>
  ({ type: "click", tileId, point: P(x, y) }) as const;

/** The default flow: pick, one anchor, one matching point. */
const oneMove = [enter, click("a", 0, 0), click("a", 10, 10), click("b", 90, 90)];
/** The same with **Rotate too** on: two points each side. */
const twoPointMove = [
  enter,
  rotateToo,
  click("a", 0, 0),
  click("a", 1, 1),
  click("a", 2, 2),
  click("b", 3, 3),
  click("b", 4, 4),
];

describe("alignToNeighbour state machine — one point by default", () => {
  it("enters at pickMoving with nothing chosen, and no rotation asked for", () => {
    const { state } = reduceAlign(IDLE_ALIGN, enter);
    expect(state.step).toBe("pickMoving");
    expect(state.twoPoint).toBe(false);
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

  it("one anchor, one matching point, and the sheet slides", () => {
    const afterAnchor = run([enter, click("a", 0, 0), click("a", 10, 10)]);
    // No A2: the very next click is the matching point on the fixed sheet.
    expect(afterAnchor.state.step).toBe("B1");
    const last = reduceAlign(afterAnchor.state, click("b", 90, 90));
    expect(last.apply).toEqual({
      movingTileId: "a",
      fixedTileId: "b",
      movingPoints: [P(10, 10)],
      fixedPoints: [P(90, 90)],
    });
  });

  it("uses the one-point copy for its two clicks", () => {
    const anchor = run([enter, click("a", 0, 0)]).state;
    expect(alignHint(anchor)).toBe("Click the anchor point on the sheet you're moving");
    expect(alignHint(anchor)).toBe(ALIGN_ONE_POINT_HINTS.A1);
    const matching = reduceAlign(anchor, click("a", 1, 1)).state;
    expect(alignHint(matching)).toBe("Now click the matching point on a fixed sheet");
  });

  it("Esc backs out of the matching point to the anchor, then to the pick, then exits", () => {
    const atB1 = run([enter, click("a", 0, 0), click("a", 10, 10)]).state;
    const backToA1 = reduceAlign(atB1, { type: "escape" }).state;
    expect(backToA1.step).toBe("A1");
    expect(backToA1.points[0]).toBeNull();
    expect(backToA1.movingTileId).toBe("a");
    const backToPick = reduceAlign(backToA1, { type: "escape" }).state;
    expect(backToPick.step).toBe("pickMoving");
    expect(reduceAlign(backToPick, { type: "escape" }).state).toEqual(IDLE_ALIGN);
  });
});

describe("chaining onto the group", () => {
  it("BOTH sheets join the group — the anchor is the foundation, not a spare", () => {
    // Leaving the anchor out left sheet 1 un-outlined and top of the pick order, so a
    // click aimed at sheet 3 could pick it up and slide the thing everything else had
    // been aligned to.
    const afterFirst = run(oneMove).state;
    expect([...afterFirst.placedTileIds].sort()).toEqual(["a", "b"]);
    expect(isPlacedInAlign(afterFirst, "a")).toBe(true);
    expect(isPlacedInAlign(afterFirst, "b")).toBe(true);
  });

  it("the group survives leaving and re-entering the mode mid-chain", () => {
    const afterFirst = run(oneMove).state;
    const left = reduceAlign(afterFirst, { type: "exit" }).state;
    expect(left.step).toBe("idle");
    expect([...left.placedTileIds].sort()).toEqual(["a", "b"]);
    const back = reduceAlign(left, enter).state;
    expect(back.step).toBe("pickMoving");
    expect([...back.placedTileIds].sort()).toEqual(["a", "b"]);
    // A fresh session's wording, though: this is not "the next sheet" any more.
    expect(back.lastMovedTileId).toBeNull();
  });

  it("the sheet that just moved becomes FIXED, and the next click picks a new mover", () => {
    // Mark's bug: after sheet 2 locked on, going for sheet 3 peeled sheet 2 off and
    // walked it over instead of bringing sheet 3 into the group.
    const afterFirst = run(oneMove).state;
    expect(afterFirst.step).toBe("pickMoving");
    expect(afterFirst.movingTileId).toBeNull(); // nothing is being moved any more
    expect(afterFirst.lastMovedTileId).toBe("a");
    expect(isPlacedInAlign(afterFirst, "a")).toBe(true);
    expect(alignHint(afterFirst)).toBe(ALIGN_NEXT_SHEET_HINT);
    // Nothing is locked between moves — any sheet can be picked next.
    expect(isLockedForAlign(afterFirst, "b")).toBe(false);
  });

  it("runs the exact three-sheet chain: 2 onto 1, then 3 onto the pair", () => {
    // Sheet "2" moves onto sheet "1".
    const first = run([enter, click("2", 0, 0), click("2", 10, 10), click("1", 100, 100)]);
    expect(first.apply?.movingTileId).toBe("2");

    // Now sheet "3". The first click PICKS it — it is not an A point for sheet 2.
    const picked = reduceAlign(first.state, click("3", 500, 500)).state;
    expect(picked.step).toBe("A1");
    expect(picked.movingTileId).toBe("3");

    // Its anchor, then the matching point on sheet 2 — which is part of the group now.
    const anchored = reduceAlign(picked, click("3", 510, 510)).state;
    const done = reduceAlign(anchored, click("2", 300, 300));
    expect(done.apply).toEqual({
      movingTileId: "3",
      fixedTileId: "2",
      movingPoints: [P(510, 510)],
      fixedPoints: [P(300, 300)],
    });
    // Sheet 2 was NOT moved by this second pass: it was the reference.
    expect(done.apply?.movingTileId).not.toBe("2");
    // Both are placed now, and the mode is ready for a fourth sheet.
    expect(done.state.step).toBe("pickMoving");
    expect([...done.state.placedTileIds].sort()).toEqual(["1", "2", "3"]);
    expect(done.state.movingTileId).toBeNull();
  });

  it("a placed sheet is tried LAST when picking, so it cannot steal the next click", () => {
    // Sheet 2, once aligned, routinely covers the grid slot sheet 3 is still in — and
    // a top-most hit test then handed the click back to sheet 2.
    const afterFirst = run([enter, click("2", 0, 0), click("2", 1, 1), click("1", 9, 9)]).state;
    const tiles = [{ id: "1" }, { id: "2" }, { id: "3" }];
    const { preferred, fallback } = alignPickTargets(afterFirst, tiles);
    // Sheets 1 and 2 are both placed now (mover and anchor), so only 3 is preferred.
    expect(preferred.map((t) => t.id)).toEqual(["3"]);
    // Still reachable: a click that only lands on a placed sheet can re-pick it.
    expect(fallback.map((t) => t.id)).toEqual(["1", "2", "3"]);
    // And every sheet remains clickable at step 0.
    expect(alignClickableTiles(afterFirst, tiles)).toHaveLength(3);
  });

  it("re-picking a placed sheet does not list it twice in the group", () => {
    const afterFirst = run(oneMove).state;
    const again = run([click("a", 5, 5), click("a", 6, 6), click("b", 7, 7)], afterFirst);
    expect(again.state.placedTileIds).toEqual(["a", "b"]);
  });

  it("picks the unplaced sheet even when a placed one is drawn on top of it", () => {
    // The literal failure: sheet "2", once aligned, covers the grid slot sheet "3" is
    // still in — and it is LATER in the array, so a plain top-most test finds it first.
    const placed = { id: "2", x: 0, y: 0, width: 400, height: 400, rotation: 0 };
    const unplaced = { id: "3", x: 100, y: 100, width: 100, height: 100, rotation: 0 };
    const state: AlignMachine = { ...IDLE_ALIGN, step: "pickMoving", placedTileIds: ["1", "2"] };
    const tiles = [unplaced, placed]; // placed drawn last = on top
    expect(alignHitForPick({ x: 150, y: 150 }, state, tiles)?.tile.id).toBe("3");
    // Where only the placed sheet is, it is still pickable — a placement can be redone.
    expect(alignHitForPick({ x: 20, y: 20 }, state, tiles)?.tile.id).toBe("2");
    // And nothing under the cursor is still nothing.
    expect(alignHitForPick({ x: 900, y: 900 }, state, tiles)).toBeNull();
  });
});

describe("Rotate too (2 points)", () => {
  it("switches to two points each side and applies rotation on the fourth click", () => {
    const last = run(twoPointMove);
    expect(last.apply).toEqual({
      movingTileId: "a",
      fixedTileId: "b",
      movingPoints: [P(1, 1), P(2, 2)],
      fixedPoints: [P(3, 3), P(4, 4)],
    });
  });

  it("keeps the plan's exact four-step copy", () => {
    const s = { ...IDLE_ALIGN, twoPoint: true };
    expect(alignHint({ ...s, step: "A1" })).toBe(
      "Click the first point on the sheet you're moving"
    );
    expect(alignHint({ ...s, step: "A2" })).toBe("Click the second point");
    expect(alignHint({ ...s, step: "B1" })).toBe(
      "Now click the matching first point on the fixed sheet"
    );
    expect(alignHint({ ...s, step: "B2" })).toBe("Click the matching second point");
    expect(ALIGN_STEP_HINTS.pickMoving).toBe("Click the sheet you want to move");
  });

  it("the toggle survives leaving and re-entering the mode", () => {
    const off = run([enter, rotateToo, { type: "exit" }]).state;
    expect(off.step).toBe("idle");
    expect(off.twoPoint).toBe(true);
    expect(reduceAlign(off, enter).state.twoPoint).toBe(true);
  });

  it("flipping the toggle mid-sequence restarts the points, keeping the mover", () => {
    const midway = run([enter, rotateToo, click("a", 0, 0), click("a", 1, 1)]).state;
    expect(midway.step).toBe("A2");
    const flipped = reduceAlign(midway, { type: "setTwoPoint", value: false }).state;
    expect(flipped.twoPoint).toBe(false);
    expect(flipped.step).toBe("A1");
    expect(flipped.movingTileId).toBe("a");
    expect(flipped.points).toEqual([null, null, null, null]);
  });

  it("Esc walks back through all four clicks", () => {
    const atB2 = run([
      enter,
      rotateToo,
      click("a", 0, 0),
      click("a", 1, 1),
      click("a", 2, 2),
      click("b", 3, 3),
    ]).state;
    expect(atB2.step).toBe("B2");
    const b1 = reduceAlign(atB2, { type: "escape" }).state;
    expect(b1.step).toBe("B1");
    expect(b1.points[2]).toBeNull();
    expect(b1.fixedTileId).toBeNull();
    const a2 = reduceAlign(b1, { type: "escape" }).state;
    expect(a2.step).toBe("A2");
    expect(a2.points[1]).toBeNull();
    const a1 = reduceAlign(a2, { type: "escape" }).state;
    expect(a1.step).toBe("A1");
    expect(a1.points[0]).toBeNull();
    expect(reduceAlign(a1, { type: "escape" }).state.step).toBe("pickMoving");
  });

  it("B2 may land on a different fixed sheet than B1", () => {
    const last = run([
      enter,
      rotateToo,
      click("a", 0, 0),
      click("a", 1, 1),
      click("a", 2, 2),
      click("b", 3, 3),
      click("c", 4, 4),
    ]);
    expect(last.apply?.fixedPoints).toEqual([P(3, 3), P(4, 4)]);
    expect(last.apply?.fixedTileId).toBe("b");
  });
});

describe("refusals and scoping", () => {
  it("scopes the clickable sheets to the step", () => {
    const tiles = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const picking = run([enter]).state;
    expect(alignClickableTiles(picking, tiles)).toHaveLength(3);

    const placingA = run([enter, click("a", 0, 0)]).state;
    expect(alignClickableTiles(placingA, tiles).map((t) => t.id)).toEqual(["a"]);

    const placingB = run([enter, click("a", 0, 0), click("a", 1, 1)]).state;
    expect(placingB.step).toBe("B1");
    expect(alignClickableTiles(placingB, tiles).map((t) => t.id)).toEqual(["b", "c"]);

    expect(alignClickableTiles(IDLE_ALIGN, tiles)).toHaveLength(0);
  });

  it("refuses a locked sheet while the anchor is being placed", () => {
    const state = run([enter, click("a", 0, 0)]).state;
    const refused = reduceAlign(state, click("b", 5, 5));
    expect(refused.refusal).toEqual({
      reason: "wrong-sheet",
      message: `Not that sheet — ${ALIGN_ONE_POINT_HINTS.A1}`,
    });
    expect(refused.state).toBe(state); // nothing recorded
    expect(refused.apply).toBeUndefined();
  });

  it("refuses the moving sheet while the matching point is being placed", () => {
    const state = run([enter, click("a", 0, 0), click("a", 1, 1)]).state;
    expect(state.step).toBe("B1");
    const refused = reduceAlign(state, click("a", 3, 3));
    expect(refused.refusal?.reason).toBe("wrong-sheet");
    expect(refused.apply).toBeUndefined();
  });

  it("turns a press onto the wrong sheet into a refusable click, not a miss", () => {
    const scoped = { tileId: "a", point: P(1, 1) };
    const other = { tileId: "b", point: P(5, 5) };
    expect(alignPointerEvent(scoped, other)).toEqual({ type: "click", tileId: "a", point: P(1, 1) });
    expect(alignPointerEvent(null, other)).toEqual({ type: "click", tileId: "b", point: P(5, 5) });
    expect(alignPointerEvent(null, null)).toEqual({ type: "miss" });
  });

  it("says so when a click lands on no sheet at all", () => {
    const state = run([enter, click("a", 0, 0)]).state;
    const missed = reduceAlign(state, { type: "miss" });
    expect(missed.refusal).toEqual({
      reason: "no-sheet",
      message: `No sheet there — ${ALIGN_ONE_POINT_HINTS.A1}`,
    });
    expect(missed.state).toBe(state);
    expect(reduceAlign(IDLE_ALIGN, { type: "miss" }).refusal).toBeUndefined();
  });
});

describe("finishing", () => {
  it("Enter is Done between moves and does nothing mid-sequence", () => {
    const midway = run([enter, click("a", 0, 0)]).state;
    expect(reduceAlign(midway, { type: "confirm" }).state).toBe(midway);
    const afterMove = run(oneMove).state;
    const done = reduceAlign(afterMove, { type: "confirm" }).state;
    expect(done.step).toBe("idle");
    // Done leaves the mode; the group it built is remembered for a re-entry.
    expect([...done.placedTileIds].sort()).toEqual(["a", "b"]);
  });

  it("exit from anywhere returns to idle", () => {
    const midway = run([enter, click("a", 0, 0)]).state;
    expect(reduceAlign(midway, { type: "exit" }).state).toEqual(IDLE_ALIGN);
  });

  it("the loupe is up for exactly the point clicks", () => {
    expect(loupeActive({ ...IDLE_ALIGN, step: "pickMoving" })).toBe(false);
    for (const step of ["A1", "A2", "B1", "B2"] as const) {
      expect(loupeActive({ ...IDLE_ALIGN, step })).toBe(true);
    }
    expect(loupeActive(IDLE_ALIGN)).toBe(false);
  });
});

describe("what is faded at each step", () => {
  // Mark: "When you go to select the 2nd point on the other pdf page the other pdf is
  // dimmed." The rule is "fade what you cannot click", not "fade everything but the
  // mover" — otherwise the sheet you are aiming at is the faint half of the picture.
  const picking = run([enter]).state;
  const placingA = run([enter, click("a", 0, 0)]).state;
  const placingB = run([enter, click("a", 0, 0), click("a", 1, 1)]).state;

  test("nothing fades while a sheet is being picked — every one is a candidate", () => {
    expect(alignSheetOpacity(picking, "a")).toBe(1);
    expect(alignSheetOpacity(picking, "b")).toBe(1);
  });

  test("the fixed sheets fade while the mover's own point goes down", () => {
    expect(placingA.step).toBe("A1");
    expect(alignSheetOpacity(placingA, "a")).toBe(1);
    expect(alignSheetOpacity(placingA, "b")).toBe(ALIGN_DIM_FIXED);
    expect(ALIGN_DIM_FIXED).toBe(0.4);
  });

  test("the fixed sheets come BACK while the matching point goes down, and the mover fades", () => {
    expect(placingB.step).toBe("B1");
    expect(alignSheetOpacity(placingB, "b")).toBe(1); // the sheet being read
    expect(alignSheetOpacity(placingB, "a")).toBe(ALIGN_DIM_MOVER);
    expect(ALIGN_DIM_MOVER).toBeLessThan(ALIGN_DIM_FIXED);
  });

  test("the same holds on the two-point flow's second pair", () => {
    const atA2 = run([enter, rotateToo, click("a", 0, 0), click("a", 1, 1)]).state;
    expect(atA2.step).toBe("A2");
    expect(alignSheetOpacity(atA2, "b")).toBe(ALIGN_DIM_FIXED);
    const atB2 = run([enter, rotateToo, click("a", 0, 0), click("a", 1, 1), click("a", 2, 2), click("b", 3, 3)]).state;
    expect(atB2.step).toBe("B2");
    expect(alignSheetOpacity(atB2, "b")).toBe(1);
    expect(alignSheetOpacity(atB2, "a")).toBe(ALIGN_DIM_MOVER);
  });

  test("outside the mode nothing is faded", () => {
    expect(alignSheetOpacity(IDLE_ALIGN, "a")).toBe(1);
  });
});
