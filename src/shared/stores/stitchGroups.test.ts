/**
 * Groups THROUGH the store: what the user can undo, what a delete does to a group, and
 * the one action that has to be atomic — a finished align pair, which moves sheets and
 * merges their groups in a single step.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useStitchStore } from "./stitchStore";
import type { StitchTile } from "@/features/stitch/stitchTypes";

const blank = (over: Partial<StitchTile> = {}): Omit<StitchTile, "id"> => ({
  sourcePdfBytes: new Uint8Array(0),
  sourcePageIndex: 0,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  ...over,
});

const ids = () => useStitchStore.getState().tiles.map((t) => t.id);
const groupIdOf = (id: string) => useStitchStore.getState().tiles.find((t) => t.id === id)?.groupId;

beforeEach(() => {
  useStitchStore.getState().reset();
  useStitchStore.getState().addTiles([blank(), blank(), blank()]);
});

describe("group actions in the store", () => {
  it("creates a group, selects it, and can be undone in one step", () => {
    const [a, b] = ids();
    const depth = useStitchStore.getState().undoStack.length;
    const groupId = useStitchStore.getState().createGroup([a, b]);

    expect(groupId).toBeTruthy();
    expect(groupIdOf(a)).toBe(groupId);
    expect(useStitchStore.getState().selectedTileIds.sort()).toEqual([a, b].sort());
    expect(useStitchStore.getState().groups[groupId!].name).toBe("Group 1");
    expect(useStitchStore.getState().undoStack.length).toBe(depth + 1);

    useStitchStore.getState().undo();
    expect(groupIdOf(a)).toBeUndefined();
    expect(useStitchStore.getState().groups).toEqual({});
  });

  it("undoing an Ungroup brings the SAME group back, name and colour intact", () => {
    const [a, b] = ids();
    const groupId = useStitchStore.getState().createGroup([a, b])!;
    const before = useStitchStore.getState().groups[groupId];

    useStitchStore.getState().ungroup(groupId);
    expect(useStitchStore.getState().groups).toEqual({});

    useStitchStore.getState().undo();
    expect(useStitchStore.getState().groups[groupId]).toEqual(before);
    expect(groupIdOf(a)).toBe(groupId);
  });

  it("adds to and detaches from a group", () => {
    const [a, b, c] = ids();
    const groupId = useStitchStore.getState().createGroup([a, b])!;
    useStitchStore.getState().addToGroup(groupId, [c]);
    expect(groupIdOf(c)).toBe(groupId);

    useStitchStore.getState().detachFromGroup([c]);
    expect(groupIdOf(c)).toBeUndefined();
    expect(groupIdOf(a)).toBe(groupId);
  });

  it("dissolves a group when a delete leaves it with one sheet", () => {
    const [a, b] = ids();
    const groupId = useStitchStore.getState().createGroup([a, b])!;
    useStitchStore.getState().removeTile(b);
    expect(useStitchStore.getState().groups[groupId]).toBeUndefined();
    expect(groupIdOf(a)).toBeUndefined();
  });

  it("refuses a group of one", () => {
    const [a] = ids();
    expect(useStitchStore.getState().createGroup([a])).toBeNull();
    expect(useStitchStore.getState().groups).toEqual({});
  });
});

describe("applyAlignedPair", () => {
  it("moves the sheets AND merges the groups in ONE undo step", () => {
    const [a, b, c] = ids();
    // "b" and "c" are already one group; aligning "b" to "a" brings "c" along and puts
    // all three in one composition.
    const existing = useStitchStore.getState().createGroup([b, c])!;
    const depth = useStitchStore.getState().undoStack.length;

    useStitchStore.getState().applyAlignedPair(
      [
        { id: b, patch: { x: 500, y: 200 } },
        { id: c, patch: { x: 600, y: 200 } },
      ],
      [a, b],
    );

    expect(useStitchStore.getState().tiles.find((t) => t.id === b)!.x).toBe(500);
    expect(useStitchStore.getState().tiles.find((t) => t.id === c)!.x).toBe(600);
    // One group for all three, keeping the identity the user already knew.
    expect(groupIdOf(a)).toBe(existing);
    expect(groupIdOf(b)).toBe(existing);
    expect(groupIdOf(c)).toBe(existing);
    expect(useStitchStore.getState().undoStack.length).toBe(depth + 1);

    // …and ONE undo puts back both the positions and the membership. A second step
    // here would leave the sheets moved but ungrouped, which nobody asked for.
    useStitchStore.getState().undo();
    expect(useStitchStore.getState().tiles.find((t) => t.id === b)!.x).toBe(0);
    expect(groupIdOf(a)).toBeUndefined();
    expect(groupIdOf(b)).toBe(existing);
  });

  it("groups two loose sheets that meet for the first time", () => {
    const [a, b] = ids();
    useStitchStore.getState().applyAlignedPair([{ id: b, patch: { x: 400, y: 0 } }], [a, b]);
    const groupId = groupIdOf(a);
    expect(groupId).toBeTruthy();
    expect(groupIdOf(b)).toBe(groupId);
    expect(useStitchStore.getState().groups[groupId!].name).toBe("Group 1");
  });
});
