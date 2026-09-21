import { describe, it, expect } from "vitest";
import {
  ALIGN_DIM_ANCHOR,
  ALIGN_ONE_POINT_HINTS,
  ALIGN_SAME_SHEET_REFUSAL,
  ALIGN_TWO_POINT_HINTS,
  IDLE_ALIGN,
  alignClickableTiles,
  alignHint,
  alignHitForStep,
  alignPickTargets,
  alignPointerEvent,
  alignSheetOpacity,
  isPlacedInAlign,
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

/** The default pair: a point on the sheet that stays, then the point that must meet it. */
const onePair = [enter, click("a", 10, 10), click("b", 90, 90)];
describe("the first click anchors the sheet that STAYS", () => {
  it("starts asking for the anchor point — there is no separate pick step", () => {
    const { state } = reduceAlign(IDLE_ALIGN, enter);
    expect(state.step).toBe("F1");
    expect(state.twoPoint).toBe(false);
    expect(state.fixedTileId).toBeNull();
    expect(state.movingTileId).toBeNull();
    expect(alignHint(state)).toBe("Click a point on the sheet that stays put");
  });

  it("the first click names the anchor and puts it in the group", () => {
    const { state } = run([enter, click("a", 10, 10)]);
    expect(state.step).toBe("M1");
    expect(state.fixedTileId).toBe("a");
    expect(state.points[0]).toEqual(P(10, 10));
    // Used as an anchor = part of the composition.
    expect(isPlacedInAlign(state, "a")).toBe(true);
    expect(alignHint(state)).toBe("Now click the matching point on the sheet to move");
  });

  it("the SECOND sheet is the one that moves — Mark's whole point", () => {
    const last = run(onePair);
    expect(last.apply).toEqual({
      movingTileId: "b",
      fixedTileId: "a",
      movingPoints: [P(90, 90)],
      fixedPoints: [P(10, 10)],
    });
    // …and the anchor is not the thing being transformed.
    expect(last.apply?.movingTileId).not.toBe("a");
  });

  it("returns to the anchor click with both sheets in the group", () => {
    const { state } = run(onePair);
    expect(state.step).toBe("F1");
    expect(state.fixedTileId).toBeNull();
    expect(state.movingTileId).toBeNull();
    expect(state.points).toEqual([null, null, null, null]);
    expect([...state.placedTileIds].sort()).toEqual(["a", "b"]);
    // The sheet that moved stays remembered, so the arrow keys still nudge it.
    expect(state.lastMovedTileId).toBe("b");
  });
});

describe("chaining a three-sheet set", () => {
  it("1 anchors 2, then either of them anchors 3 — and 1 and 2 never move again", () => {
    // Sheet 1 stays, sheet 2 comes to it.
    const first = run([enter, click("1", 10, 10), click("2", 200, 200)]);
    expect(first.apply?.fixedTileId).toBe("1");
    expect(first.apply?.movingTileId).toBe("2");

    // Now a point on sheet 2 (already placed) anchors sheet 3.
    const second = run([click("2", 50, 50), click("3", 500, 500)], first.state);
    expect(second.apply).toEqual({
      movingTileId: "3",
      fixedTileId: "2",
      movingPoints: [P(500, 500)],
      fixedPoints: [P(50, 50)],
    });
    // Neither of the first two was moved by the second pair.
    expect(second.apply?.movingTileId).not.toBe("1");
    expect(second.apply?.movingTileId).not.toBe("2");
    expect([...second.state.placedTileIds].sort()).toEqual(["1", "2", "3"]);
  });

  it("prefers an unplaced sheet for the MOVE click, so a placed one cannot steal it", () => {
    // Sheet "2", once aligned, covers the grid slot sheet "3" is still in — and it is
    // later in the array, so a plain top-most test finds it first.
    const state: AlignMachine = {
      ...IDLE_ALIGN,
      step: "M1",
      fixedTileId: "1",
      placedTileIds: ["1", "2"],
    };
    const placed = { id: "2", x: 0, y: 0, width: 400, height: 400, rotation: 0 };
    const unplaced = { id: "3", x: 100, y: 100, width: 100, height: 100, rotation: 0 };
    const anchor = { id: "1", x: 0, y: 0, width: 1000, height: 1000, rotation: 0 };
    const tiles = [anchor, unplaced, placed]; // placed drawn last = on top

    expect(alignHitForStep({ x: 150, y: 150 }, state, tiles)?.tile.id).toBe("3");
    // Where only the placed sheet is, it is still available to move again.
    expect(alignHitForStep({ x: 20, y: 20 }, state, tiles)?.tile.id).toBe("2");
    // The anchor is never a candidate at this step, even though it is under the cursor.
    const { preferred, fallback } = alignPickTargets(state, tiles);
    expect(preferred.map((t) => t.id)).toEqual(["3"]);
    expect(fallback.map((t) => t.id)).toEqual(["3", "2"]);
  });

  it("the anchor click has no preference — any sheet can be the one that stays", () => {
    const state: AlignMachine = { ...IDLE_ALIGN, step: "F1", placedTileIds: ["1"] };
    const placed = { id: "1", x: 0, y: 0, width: 400, height: 400, rotation: 0 };
    const fresh = { id: "2", x: 0, y: 0, width: 400, height: 400, rotation: 0 };
    // Top-most wins: the user is pointing at the sheet they mean to anchor to.
    expect(alignHitForStep({ x: 10, y: 10 }, state, [fresh, placed])?.tile.id).toBe("1");
    expect(alignHitForStep({ x: 10, y: 10 }, state, [placed, fresh])?.tile.id).toBe("2");
  });

  it("the group survives leaving and re-entering the mode mid-chain", () => {
    const afterPair = run(onePair).state;
    const left = reduceAlign(afterPair, { type: "exit" }).state;
    expect(left.step).toBe("idle");
    expect([...left.placedTileIds].sort()).toEqual(["a", "b"]);
    const back = reduceAlign(left, enter).state;
    expect(back.step).toBe("F1");
    expect([...back.placedTileIds].sort()).toEqual(["a", "b"]);
    expect(back.lastMovedTileId).toBeNull(); // a re-entry is a fresh session
  });
});

describe("Rotate too (2 points)", () => {
  it("takes two points on the anchor, then the two that match them", () => {
    const afterF1 = run([enter, rotateToo, click("a", 1, 1)]).state;
    expect(afterF1.step).toBe("F2");
    const afterF2 = reduceAlign(afterF1, click("a", 2, 2)).state;
    expect(afterF2.step).toBe("M1");
    const afterM1 = reduceAlign(afterF2, click("b", 11, 11)).state;
    expect(afterM1.step).toBe("M2");
    expect(afterM1.movingTileId).toBe("b");
    const last = reduceAlign(afterM1, click("b", 12, 12));
    expect(last.apply).toEqual({
      movingTileId: "b",
      fixedTileId: "a",
      movingPoints: [P(11, 11), P(12, 12)],
      fixedPoints: [P(1, 1), P(2, 2)],
    });
  });

  it("uses the exact four-step copy", () => {
    const s = { ...IDLE_ALIGN, twoPoint: true, step: "F1" as const };
    expect(alignHint(s)).toBe("Click the first point on the sheet that stays put");
    expect(alignHint({ ...s, step: "F2" })).toBe("Click the second point");
    expect(alignHint({ ...s, step: "M1" })).toBe(
      "Now click the matching first point on the sheet to move"
    );
    expect(alignHint({ ...s, step: "M2" })).toBe("Click the matching second point");
    expect(ALIGN_TWO_POINT_HINTS.F1).toBe("Click the first point on the sheet that stays put");
  });

  it("the toggle survives leaving and re-entering; flipping it mid-pair starts over", () => {
    const off = run([enter, rotateToo, { type: "exit" }]).state;
    expect(off.twoPoint).toBe(true);
    expect(reduceAlign(off, enter).state.twoPoint).toBe(true);

    const midway = run([enter, rotateToo, click("a", 1, 1)]).state;
    const flipped = reduceAlign(midway, { type: "setTwoPoint", value: false }).state;
    expect(flipped.twoPoint).toBe(false);
    expect(flipped.step).toBe("F1");
    expect(flipped.fixedTileId).toBeNull();
    expect(flipped.points).toEqual([null, null, null, null]);
  });
});

describe("refusals", () => {
  it("says so when the matching click lands back on the anchor", () => {
    const state = run([enter, click("a", 10, 10)]).state;
    const refused = reduceAlign(state, click("a", 20, 20));
    expect(refused.refusal).toEqual({
      reason: "same-sheet",
      message: "Click the matching point on a different sheet",
    });
    expect(refused.refusal?.message).toBe(ALIGN_SAME_SHEET_REFUSAL);
    expect(refused.state).toBe(state);
    expect(refused.apply).toBeUndefined();
  });

  it("keeps both of the anchor's points on the anchor", () => {
    const state = run([enter, rotateToo, click("a", 1, 1)]).state;
    const refused = reduceAlign(state, click("b", 5, 5));
    expect(refused.refusal).toEqual({
      reason: "wrong-sheet",
      message: `Not that sheet — ${ALIGN_TWO_POINT_HINTS.F2}`,
    });
  });

  it("keeps both of the moving sheet's points on the moving sheet", () => {
    const state = run([enter, rotateToo, click("a", 1, 1), click("a", 2, 2), click("b", 11, 11)]).state;
    expect(state.step).toBe("M2");
    const refused = reduceAlign(state, click("c", 30, 30));
    expect(refused.refusal?.reason).toBe("wrong-sheet");
    expect(refused.apply).toBeUndefined();
  });

  it("says so when a click lands on no sheet at all", () => {
    const state = run([enter]).state;
    const missed = reduceAlign(state, { type: "miss" });
    expect(missed.refusal).toEqual({
      reason: "no-sheet",
      message: `No sheet there — ${ALIGN_ONE_POINT_HINTS.F1}`,
    });
    expect(reduceAlign(IDLE_ALIGN, { type: "miss" }).refusal).toBeUndefined();
  });

  it("turns a press onto a sheet the step will not take into a click, not a miss", () => {
    const scoped = { tileId: "a", point: P(1, 1) };
    const other = { tileId: "b", point: P(5, 5) };
    expect(alignPointerEvent(scoped, other)).toEqual({ type: "click", tileId: "a", point: P(1, 1) });
    expect(alignPointerEvent(null, other)).toEqual({ type: "click", tileId: "b", point: P(5, 5) });
    expect(alignPointerEvent(null, null)).toEqual({ type: "miss" });
  });
});

describe("scoping and fading", () => {
  const tiles = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("scopes the clickable sheets to the step", () => {
    const anchoring = run([enter]).state;
    expect(alignClickableTiles(anchoring, tiles)).toHaveLength(3);

    const secondAnchorPoint = run([enter, rotateToo, click("a", 1, 1)]).state;
    expect(alignClickableTiles(secondAnchorPoint, tiles).map((t) => t.id)).toEqual(["a"]);

    const choosingMover = run([enter, click("a", 1, 1)]).state;
    expect(alignClickableTiles(choosingMover, tiles).map((t) => t.id)).toEqual(["b", "c"]);

    const secondMovingPoint = run([
      enter,
      rotateToo,
      click("a", 1, 1),
      click("a", 2, 2),
      click("b", 11, 11),
    ]).state;
    expect(alignClickableTiles(secondMovingPoint, tiles).map((t) => t.id)).toEqual(["b"]);

    expect(alignClickableTiles(IDLE_ALIGN, tiles)).toHaveLength(0);
  });

  it("fades nothing while the anchor is being chosen", () => {
    const anchoring = run([enter]).state;
    expect(alignSheetOpacity(anchoring, "a")).toBe(1);
    expect(alignSheetOpacity(anchoring, "b")).toBe(1);
  });

  it("fades the ANCHOR while the sheet to move is being chosen, never the candidates", () => {
    // Mark: "When you go to select the 2nd point on the other pdf page the other pdf is
    // dimmed." The sheet being read must be the bright one.
    const choosing = run([enter, click("a", 10, 10)]).state;
    expect(alignSheetOpacity(choosing, "a")).toBe(ALIGN_DIM_ANCHOR);
    expect(ALIGN_DIM_ANCHOR).toBe(0.25);
    expect(alignSheetOpacity(choosing, "b")).toBe(1);
    expect(alignSheetOpacity(choosing, "c")).toBe(1);
  });

  it("keeps that rule through the two-point flow's second pair", () => {
    const atM2 = run([enter, rotateToo, click("a", 1, 1), click("a", 2, 2), click("b", 11, 11)]).state;
    expect(alignSheetOpacity(atM2, "a")).toBe(ALIGN_DIM_ANCHOR);
    expect(alignSheetOpacity(atM2, "b")).toBe(1);
    // …and nothing fades while the anchor's own second point goes down.
    const atF2 = run([enter, rotateToo, click("a", 1, 1)]).state;
    expect(alignSheetOpacity(atF2, "b")).toBe(1);
  });

  it("fades nothing outside the mode", () => {
    expect(alignSheetOpacity(IDLE_ALIGN, "a")).toBe(1);
  });

  it("has the loupe up for every point click", () => {
    for (const step of ["F1", "F2", "M1", "M2"] as const) {
      expect(loupeActive({ ...IDLE_ALIGN, step })).toBe(true);
    }
    expect(loupeActive(IDLE_ALIGN)).toBe(false);
  });
});

describe("backing out and finishing", () => {
  it("Esc backs up one click, and exits once nothing is placed", () => {
    const atM1 = run([enter, click("a", 10, 10)]).state;
    const backToF1 = reduceAlign(atM1, { type: "escape" }).state;
    expect(backToF1.step).toBe("F1");
    expect(backToF1.fixedTileId).toBeNull();
    expect(backToF1.points[0]).toBeNull();
    expect(reduceAlign(backToF1, { type: "escape" }).state.step).toBe("idle");
  });

  it("Esc walks back through all four clicks of the two-point flow", () => {
    const atM2 = run([enter, rotateToo, click("a", 1, 1), click("a", 2, 2), click("b", 11, 11)]).state;
    expect(atM2.step).toBe("M2");
    const m1 = reduceAlign(atM2, { type: "escape" }).state;
    expect(m1.step).toBe("M1");
    expect(m1.movingTileId).toBeNull();
    expect(m1.points[2]).toBeNull();
    const f2 = reduceAlign(m1, { type: "escape" }).state;
    expect(f2.step).toBe("F2");
    expect(f2.points[1]).toBeNull();
    expect(f2.fixedTileId).toBe("a");
    const f1 = reduceAlign(f2, { type: "escape" }).state;
    expect(f1.step).toBe("F1");
    expect(f1.points[0]).toBeNull();
    expect(f1.fixedTileId).toBeNull();
  });

  it("Enter is Done: it leaves from anywhere, keeping the group", () => {
    const midPair = run([enter, click("a", 10, 10)]).state;
    const done = reduceAlign(midPair, { type: "confirm" }).state;
    expect(done.step).toBe("idle");
    expect(done.placedTileIds).toEqual(["a"]);
    expect(reduceAlign(IDLE_ALIGN, { type: "confirm" }).state).toEqual(IDLE_ALIGN);
  });

  it("exit from anywhere returns to idle", () => {
    const midPair = run([enter, click("a", 1, 1)]).state;
    expect(reduceAlign(midPair, { type: "exit" }).state.step).toBe("idle");
  });
});
