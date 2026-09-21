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

describe("the canvas changing under a group", () => {
  it("prunes groups when replaceTiles swaps the sheets out", () => {
    // The auto-align composite replaces the grid; a group whose members went with it
    // would otherwise linger as an empty entry in the Add-to-group menu.
    const [a, b, c] = ids();
    useStitchStore.getState().createGroup([a, b]);
    expect(Object.keys(useStitchStore.getState().groups)).toHaveLength(1);

    useStitchStore.getState().replaceTiles([a, b], [blank(), blank()]);
    expect(useStitchStore.getState().groups).toEqual({});
    expect(useStitchStore.getState().tiles.every((t) => !t.groupId)).toBe(true);
    expect(useStitchStore.getState().tiles.some((t) => t.id === c)).toBe(true);
  });

  it("keeps a group whose members survive the swap", () => {
    const [a, b, c] = ids();
    const groupId = useStitchStore.getState().createGroup([a, b])!;
    useStitchStore.getState().replaceTiles([c], [blank()]);
    expect(useStitchStore.getState().groups[groupId]).toBeTruthy();
  });

  it("ungroups several groups in ONE undo step", () => {
    const [a, b, c] = ids();
    useStitchStore.getState().addTiles([blank()]);
    const [, , , d] = ids();
    const one = useStitchStore.getState().createGroup([a, b])!;
    const two = useStitchStore.getState().createGroup([c, d])!;
    const depth = useStitchStore.getState().undoStack.length;

    useStitchStore.getState().ungroupMany([one, two]);
    expect(useStitchStore.getState().groups).toEqual({});
    expect(useStitchStore.getState().undoStack.length).toBe(depth + 1);

    // …and one undo brings BOTH back.
    useStitchStore.getState().undo();
    expect(Object.keys(useStitchStore.getState().groups).sort()).toEqual([one, two].sort());
  });

  it("never gives two live groups the same colour", () => {
    // Six groups, then a create that dissolves some of them: the new group's colour is
    // chosen from what SURVIVES, not from the record that still lists the doomed ones.
    useStitchStore.getState().addTiles([blank(), blank(), blank(), blank(), blank(), blank()]);
    const all = ids();
    const madeIds = [
      useStitchStore.getState().createGroup([all[0], all[1]])!,
      useStitchStore.getState().createGroup([all[2], all[3]])!,
      useStitchStore.getState().createGroup([all[4], all[5]])!,
    ];
    // This create steals a member from each of the first two, dissolving both.
    useStitchStore.getState().createGroup([all[0], all[2]]);
    const live = Object.values(useStitchStore.getState().groups);
    const colors = live.map((g) => g.color);
    expect(new Set(colors).size).toBe(colors.length);
    expect(madeIds.length).toBe(3);
  });
});

describe("applyAlignedPair", () => {
  it("never moves a LOCKED sheet, even as part of the group", () => {
    const [a, b, c] = ids();
    useStitchStore.getState().updateTile(c, { locked: true });
    useStitchStore.getState().applyAlignedPair(
      [
        { id: b, patch: { x: 500 } },
        { id: c, patch: { x: 600 } },
      ],
      [a, b],
    );
    expect(useStitchStore.getState().tiles.find((t) => t.id === b)!.x).toBe(500);
    // The lock is the user saying "this one stays"; an align pair is not an exception.
    expect(useStitchStore.getState().tiles.find((t) => t.id === c)!.x).toBe(0);
  });


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
