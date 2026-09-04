/**
 * What the canvas's right-click menu should offer, and why an entry is unavailable.
 *
 * Mark: "I feel like right click with a menu would be helpful."
 *
 * Kept out of the component and pure, because "can I group this" is a rule about the
 * canvas, not about a menu — and because a disabled item with no reason is worse than
 * no item at all. Every entry that can be unavailable carries the short phrase the menu
 * shows beside it.
 */

import type { StitchTile } from "./stitchTypes";
import { expandSelectionToGroups, groupOf, type TileGroup, type TileGroups } from "./groups";

export interface MenuAction {
  enabled: boolean;
  /** Shown greyed beside a disabled entry: why not. */
  hint?: string;
}

export interface SheetMenuModel {
  tileId: string;
  /** The group this sheet is in, if any. */
  group: TileGroup | null;
  locked: boolean;
  /** How many sheets the action would act on, once the selection is grown to groups. */
  selectionCount: number;
  selectGroup: MenuAction;
  createGroup: MenuAction;
  /** Groups this sheet could be added to (never the one it is already in). */
  addToGroup: TileGroup[];
  addToGroupAction: MenuAction;
  detach: MenuAction;
  ungroup: MenuAction;
  lock: MenuAction;
  /** "Lock" or "Unlock", by what the click would DO. */
  lockLabel: "Lock" | "Unlock";
  order: MenuAction;
  remove: MenuAction;
  /** "Delete sheet" / "Delete group (5 sheets)" — the entry says what it will take,
   *  because Delete on one member of a group deletes the group. */
  removeLabel: string;
  alignFromHere: MenuAction;
}

/**
 * The menu for a right-click ON a sheet.
 *
 * `selectedIds` is the selection as it stands AFTER the right-click has settled it (the
 * canvas selects the sheet under the cursor if it was not already selected), so the
 * counts here are what the user is looking at.
 */
export function sheetMenuModel(
  tiles: readonly StitchTile[],
  groups: TileGroups,
  selectedIds: readonly string[],
  tileId: string
): SheetMenuModel | null {
  const tile = tiles.find((t) => t.id === tileId);
  if (!tile) return null;

  const groupId = groupOf(tiles, tileId);
  const group = groupId ? groups[groupId] ?? null : null;
  const selection = expandSelectionToGroups(tiles, selectedIds);
  const selectionCount = selection.length;
  const otherGroups = Object.values(groups).filter((g) => g.id !== groupId);
  const sheetsOnCanvas = tiles.length;

  return {
    tileId,
    group,
    locked: Boolean(tile.locked),
    selectionCount,
    selectGroup: group
      ? { enabled: true }
      : { enabled: false, hint: "not in a group" },
    createGroup:
      selectionCount >= 2
        ? { enabled: true }
        : { enabled: false, hint: "select 2 or more" },
    addToGroup: otherGroups,
    addToGroupAction:
      otherGroups.length > 0
        ? { enabled: true }
        : { enabled: false, hint: group ? "no other group" : "no groups yet" },
    detach: group ? { enabled: true } : { enabled: false, hint: "not in a group" },
    ungroup: group ? { enabled: true } : { enabled: false, hint: "not in a group" },
    lock: { enabled: true },
    lockLabel: tile.locked ? "Unlock" : "Lock",
    order: sheetsOnCanvas > 1 ? { enabled: true } : { enabled: false, hint: "only one sheet" },
    remove: { enabled: true },
    removeLabel:
      selectionCount > 1 ? `Delete ${selectionCount} sheets` : "Delete sheet",
    alignFromHere:
      sheetsOnCanvas >= 2
        ? { enabled: true }
        : { enabled: false, hint: "needs two sheets" },
  };
}

export interface CanvasMenuModel {
  selectAll: MenuAction;
  fitToSheets: MenuAction;
  recenter: MenuAction;
}

/** The menu for a right-click on empty canvas. */
export function canvasMenuModel(tiles: readonly StitchTile[]): CanvasMenuModel {
  const hasTiles = tiles.length > 0;
  const empty = { enabled: false, hint: "no sheets yet" } as const;
  return {
    selectAll: hasTiles ? { enabled: true } : empty,
    fitToSheets: hasTiles ? { enabled: true } : empty,
    recenter: { enabled: true },
  };
}
