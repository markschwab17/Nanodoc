/**
 * Groups are a persistent fact about the composition, so the rules that matter are the
 * ones about what happens to them when the canvas changes underneath: a member is
 * deleted, a sheet joins another group, two groups meet in an align pair.
 */
import { describe, expect, it } from "vitest";
import {
  GROUP_COLORS,
  addToGroupIn,
  alignFollowers,
  createGroupIn,
  detachFromGroupIn,
  expandSelectionToGroups,
  groupMembers,
  mergeGroupsFor,
  nextGroupColor,
  nextGroupName,
  pruneGroups,
  selectionSummary,
  toggleGroupInSelection,
  ungroupIn,
  type TileGroups,
} from "./groups";
import type { StitchTile } from "./stitchTypes";

const tile = (id: string, over: Partial<StitchTile> = {}): StitchTile => ({
  id,
  sourcePdfBytes: new Uint8Array(0),
  sourcePageIndex: 0,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  ...over,
});

const sheets = (...ids: string[]) => ids.map((id) => tile(id));

describe("creating a group", () => {
  it("puts the sheets in one group and names it", () => {
    const { tiles, groups, groupId } = createGroupIn(sheets("a", "b", "c"), {}, ["a", "b"]);
    expect(groupId).toBeTruthy();
    expect(groupMembers(tiles, groupId!)).toEqual(["a", "b"]);
    expect(tiles.find((t) => t.id === "c")!.groupId).toBeUndefined();
    expect(groups[groupId!].name).toBe("Group 1");
    expect(groups[groupId!].color).toBe(GROUP_COLORS[0]);
  });

  it("refuses a group of one — that is just a sheet", () => {
    const before = sheets("a", "b");
    const { tiles, groups, groupId } = createGroupIn(before, {}, ["a"]);
    expect(groupId).toBeNull();
    expect(groups).toEqual({});
    expect(tiles.every((t) => !t.groupId)).toBe(true);
  });

  it("ignores ids that are not on the canvas", () => {
    const { groupId } = createGroupIn(sheets("a"), {}, ["a", "ghost"]);
    expect(groupId).toBeNull();
  });

  it("takes sheets out of their old group, dissolving it if it is left with one", () => {
    const first = createGroupIn(sheets("a", "b", "c", "d"), {}, ["a", "b"]);
    const second = createGroupIn(first.tiles, first.groups, ["b", "c"]);
    // "a" was left alone in Group 1, so Group 1 is gone.
    expect(Object.keys(second.groups)).toEqual([second.groupId]);
    expect(second.tiles.find((t) => t.id === "a")!.groupId).toBeUndefined();
    expect(groupMembers(second.tiles, second.groupId!).sort()).toEqual(["b", "c"]);
  });

  it("gives each live group its own colour and a free name", () => {
    const one = createGroupIn(sheets("a", "b", "c", "d"), {}, ["a", "b"]);
    const two = createGroupIn(one.tiles, one.groups, ["c", "d"]);
    expect(two.groups[two.groupId!].color).toBe(GROUP_COLORS[1]);
    expect(two.groups[two.groupId!].name).toBe("Group 2");
    expect(nextGroupColor(two.groups)).toBe(GROUP_COLORS[2]);
    expect(nextGroupName(two.groups)).toBe("Group 3");
  });
});

describe("changing membership", () => {
  const base = createGroupIn(sheets("a", "b", "c", "d"), {}, ["a", "b"]);

  it("adds a sheet to an existing group", () => {
    const { tiles } = addToGroupIn(base.tiles, base.groups, base.groupId!, ["c"]);
    expect(groupMembers(tiles, base.groupId!).sort()).toEqual(["a", "b", "c"]);
  });

  it("ignores an add to a group that does not exist", () => {
    const { tiles, groups } = addToGroupIn(base.tiles, base.groups, "nope", ["c"]);
    expect(tiles.find((t) => t.id === "c")!.groupId).toBeUndefined();
    expect(groups).toBe(base.groups);
  });

  it("detaches a sheet, dissolving the group it leaves too small", () => {
    const { tiles, groups } = detachFromGroupIn(base.tiles, base.groups, ["a"]);
    expect(tiles.every((t) => !t.groupId)).toBe(true);
    expect(groups).toEqual({});
  });

  it("detaching from a three-sheet group leaves the other two grouped", () => {
    const three = addToGroupIn(base.tiles, base.groups, base.groupId!, ["c"]);
    const { tiles, groups } = detachFromGroupIn(three.tiles, three.groups, ["c"]);
    expect(groupMembers(tiles, base.groupId!).sort()).toEqual(["a", "b"]);
    expect(groups[base.groupId!]).toBeTruthy();
  });

  it("ungroup dissolves the whole thing", () => {
    const { tiles, groups } = ungroupIn(base.tiles, base.groups, base.groupId!);
    expect(tiles.every((t) => !t.groupId)).toBe(true);
    expect(groups).toEqual({});
  });

  it("prunes a group whose second sheet was deleted", () => {
    const afterDelete = base.tiles.filter((t) => t.id !== "b");
    const { tiles, groups } = pruneGroups(afterDelete, base.groups);
    expect(groups).toEqual({});
    expect(tiles.find((t) => t.id === "a")!.groupId).toBeUndefined();
  });

  it("clears a groupId pointing at a group that no longer exists", () => {
    const orphaned = [tile("a", { groupId: "ghost" }), tile("b", { groupId: "ghost" })];
    const { tiles, groups } = pruneGroups(orphaned, {} as TileGroups);
    expect(groups).toEqual({});
    expect(tiles.every((t) => !t.groupId)).toBe(true);
  });
});

describe("merging (what an align pair does)", () => {
  it("makes one group out of two loose sheets", () => {
    const { tiles, groupId } = mergeGroupsFor(sheets("a", "b"), {}, ["a", "b"]);
    expect(groupMembers(tiles, groupId!).sort()).toEqual(["a", "b"]);
  });

  it("pulls a loose sheet into the existing group, keeping its identity", () => {
    const base = createGroupIn(sheets("a", "b", "c"), {}, ["a", "b"]);
    const merged = mergeGroupsFor(base.tiles, base.groups, ["b", "c"]);
    expect(merged.groupId).toBe(base.groupId);
    expect(merged.groups[base.groupId!].name).toBe("Group 1"); // unchanged under the user
    expect(groupMembers(merged.tiles, merged.groupId!).sort()).toEqual(["a", "b", "c"]);
  });

  it("joins two whole groups into one", () => {
    const one = createGroupIn(sheets("a", "b", "c", "d"), {}, ["a", "b"]);
    const two = createGroupIn(one.tiles, one.groups, ["c", "d"]);
    const merged = mergeGroupsFor(two.tiles, two.groups, ["b", "c"]);
    expect(groupMembers(merged.tiles, merged.groupId!).sort()).toEqual(["a", "b", "c", "d"]);
    expect(Object.keys(merged.groups)).toEqual([merged.groupId]);
  });

  it("is a no-op for a single sheet", () => {
    const { groupId, groups } = mergeGroupsFor(sheets("a"), {}, ["a"]);
    expect(groupId).toBeNull();
    expect(groups).toEqual({});
  });
});

describe("selection", () => {
  const base = createGroupIn(sheets("a", "b", "c"), {}, ["a", "b"]);

  it("selecting one member selects the group", () => {
    expect(expandSelectionToGroups(base.tiles, ["a"]).sort()).toEqual(["a", "b"]);
  });

  it("leaves an ungrouped sheet alone and never repeats an id", () => {
    expect(expandSelectionToGroups(base.tiles, ["c"])).toEqual(["c"]);
    expect(expandSelectionToGroups(base.tiles, ["a", "b", "c"]).sort()).toEqual(["a", "b", "c"]);
  });

  it("shift-click adds the whole group, and takes the whole group away again", () => {
    const added = toggleGroupInSelection(base.tiles, ["c"], "a");
    expect(added.sort()).toEqual(["a", "b", "c"]);
    const removed = toggleGroupInSelection(base.tiles, added, "b");
    expect(removed).toEqual(["c"]);
  });

  it("describes the selection in words, naming the group only when it IS the group", () => {
    expect(selectionSummary(base.tiles, base.groups, [])).toBeNull();
    expect(selectionSummary(base.tiles, base.groups, ["c"])).toBe("1 sheet selected");
    expect(selectionSummary(base.tiles, base.groups, ["a", "b"])).toBe("2 sheets selected · Group 1");
    // A group plus a loose sheet is not "Group 1" — that would misdescribe what moves.
    expect(selectionSummary(base.tiles, base.groups, ["a", "b", "c"])).toBe("3 sheets selected");
  });
});

describe("who travels with the sheet an align pair moves", () => {
  it("takes the mover's whole group", () => {
    const g = createGroupIn(sheets("a", "b", "c"), {}, ["b", "c"]);
    expect(alignFollowers(g.tiles, "b", "a")).toEqual(["c"]);
  });

  it("leaves the ANCHOR's group behind — including when both sides share one group", () => {
    // Tightening a seam between two members of one composition. If the anchor came
    // along, the whole group would slide and the two points would stay exactly as far
    // apart as they started.
    const g = createGroupIn(sheets("a", "b", "c"), {}, ["a", "b", "c"]);
    expect(alignFollowers(g.tiles, "b", "a")).toEqual([]);
  });

  it("leaves every member of the anchor's group behind", () => {
    const one = createGroupIn(sheets("a", "b", "c", "d"), {}, ["a", "b"]);
    const two = createGroupIn(one.tiles, one.groups, ["c", "d"]);
    // Moving "c" onto "a": "d" follows, "b" (the anchor's group) does not.
    expect(alignFollowers(two.tiles, "c", "a")).toEqual(["d"]);
  });

  it("is empty for a loose sheet", () => {
    expect(alignFollowers(sheets("a", "b"), "b", "a")).toEqual([]);
  });
});
