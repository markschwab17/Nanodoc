import { describe, expect, it } from "vitest";
import { canvasMenuModel, sheetMenuModel } from "./contextMenuModel";
import { createGroupIn } from "./groups";
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

const loose = [tile("a"), tile("b"), tile("c")];
const grouped = createGroupIn(loose, {}, ["a", "b"]);

describe("the sheet menu", () => {
  it("offers group actions only on a sheet that is in one, and says why not", () => {
    const model = sheetMenuModel(loose, {}, ["a"], "a")!;
    expect(model.group).toBeNull();
    expect(model.selectGroup).toEqual({ enabled: false, hint: "not in a group" });
    expect(model.detach.enabled).toBe(false);
    expect(model.ungroup).toEqual({ enabled: false, hint: "not in a group" });
  });

  it("offers them on a grouped sheet, and names the group", () => {
    const model = sheetMenuModel(grouped.tiles, grouped.groups, ["a"], "a")!;
    expect(model.group?.name).toBe("Group 1");
    expect(model.selectGroup.enabled).toBe(true);
    expect(model.detach.enabled).toBe(true);
    expect(model.ungroup.enabled).toBe(true);
  });

  it("counts the selection AS IT WILL MOVE — grown to whole groups", () => {
    // One member selected, but the group is what a drag or a Create group would take.
    const model = sheetMenuModel(grouped.tiles, grouped.groups, ["a"], "a")!;
    expect(model.selectionCount).toBe(2);
    expect(model.createGroup.enabled).toBe(true);
  });

  it("refuses Create group on a single loose sheet, with the reason", () => {
    const model = sheetMenuModel(loose, {}, ["a"], "a")!;
    expect(model.selectionCount).toBe(1);
    expect(model.createGroup).toEqual({ enabled: false, hint: "select 2 or more" });
  });

  it("lists only the groups a sheet could actually join", () => {
    const onMember = sheetMenuModel(grouped.tiles, grouped.groups, ["a"], "a")!;
    // Its own group is never offered as a destination.
    expect(onMember.addToGroup).toHaveLength(0);
    expect(onMember.addToGroupAction).toEqual({ enabled: false, hint: "no other group" });

    const onLoose = sheetMenuModel(grouped.tiles, grouped.groups, ["c"], "c")!;
    expect(onLoose.addToGroup.map((g) => g.name)).toEqual(["Group 1"]);
    expect(onLoose.addToGroupAction.enabled).toBe(true);
  });

  it("says 'no groups yet' on a canvas with none", () => {
    const model = sheetMenuModel(loose, {}, ["a"], "a")!;
    expect(model.addToGroupAction).toEqual({ enabled: false, hint: "no groups yet" });
  });

  it("labels the lock entry by what the click will DO", () => {
    expect(sheetMenuModel(loose, {}, ["a"], "a")!.lockLabel).toBe("Lock");
    const locked = [tile("a", { locked: true }), tile("b")];
    expect(sheetMenuModel(locked, {}, ["a"], "a")!.lockLabel).toBe("Unlock");
  });

  it("disables ordering and aligning on a canvas that cannot use them", () => {
    const alone = [tile("a")];
    const model = sheetMenuModel(alone, {}, ["a"], "a")!;
    expect(model.order).toEqual({ enabled: false, hint: "only one sheet" });
    expect(model.alignFromHere).toEqual({ enabled: false, hint: "needs two sheets" });
    // …and enables them once there is something to order against.
    const pair = sheetMenuModel(loose, {}, ["a"], "a")!;
    expect(pair.order.enabled).toBe(true);
    expect(pair.alignFromHere.enabled).toBe(true);
  });

  it("returns nothing for a sheet that is not there", () => {
    expect(sheetMenuModel(loose, {}, [], "ghost")).toBeNull();
  });
});

describe("the empty-canvas menu", () => {
  it("offers what there is to offer", () => {
    const model = canvasMenuModel(loose);
    expect(model.selectAll.enabled).toBe(true);
    expect(model.fitToSheets.enabled).toBe(true);
    expect(model.recenter.enabled).toBe(true);
  });

  it("says why an empty canvas can do almost nothing", () => {
    const model = canvasMenuModel([]);
    expect(model.selectAll).toEqual({ enabled: false, hint: "no sheets yet" });
    expect(model.fitToSheets).toEqual({ enabled: false, hint: "no sheets yet" });
    // Recentring an empty canvas still puts the page back in view.
    expect(model.recenter.enabled).toBe(true);
  });
});
