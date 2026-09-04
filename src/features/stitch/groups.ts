/**
 * Sheet GROUPS.
 *
 * Mark: "We probably need to have 'groups' — shift click to select a group, 'create
 * group', 'detach', 'add to group'. That way you can move multiple and maintain their
 * spacing and position relative to the other items in a group."
 *
 * A group is a persistent fact about the composition, not a transient selection: once
 * two sheets have been aligned to each other, moving one has to move the other, and
 * that has to survive clicking away. So membership lives on the tile (`groupId`) and
 * the group's identity (name, colour) lives in one record beside the tiles.
 *
 * Everything here is pure: it takes tiles + groups and returns new tiles + groups. The
 * store's actions are thin wrappers that push one undo snapshot around a call. Groups
 * are display and interaction state only — export, the manifest and the training bundle
 * all read positions and never look at `groupId`.
 *
 * ONE INVARIANT, everywhere: a group needs at least two members. A group of one is
 * indistinguishable from an ungrouped sheet, and leaving it behind means a canvas that
 * slowly fills with empty groups the user cannot see or clear. Every operation that can
 * leave a group short dissolves it (`pruneGroups`).
 */

import type { StitchTile } from "./stitchTypes";

export interface TileGroup {
  id: string;
  name: string;
  /** A CSS colour, fixed rather than themed: it has to read against white paper in
   *  both light and dark mode, and it must stay the SAME colour in both so the group
   *  is recognisable when the user switches. */
  color: string;
}

export type TileGroups = Record<string, TileGroup>;

/**
 * The palette, in the order groups take it. Mid-tone and saturated so a 2 px outline
 * over white linework is unmistakable; destructive red is deliberately absent (a red
 * sheet outline reads as an error, not as "these three go together").
 */
export const GROUP_COLORS = [
  "hsl(217 91% 55%)", // blue
  "hsl(142 66% 38%)", // green
  "hsl(38 92% 45%)", // amber
  "hsl(271 70% 56%)", // violet
  "hsl(186 78% 36%)", // teal
  "hsl(330 74% 52%)", // pink
] as const;

let groupSeq = 0;
export function generateGroupId(): string {
  groupSeq += 1;
  return `grp_${Date.now().toString(36)}_${groupSeq}_${Math.random().toString(36).slice(2, 7)}`;
}

/** The next unused colour, wrapping once every colour is in play. */
export function nextGroupColor(groups: TileGroups): string {
  const used = new Set(Object.values(groups).map((g) => g.color));
  return GROUP_COLORS.find((c) => !used.has(c)) ?? GROUP_COLORS[Object.keys(groups).length % GROUP_COLORS.length];
}

/** "Group 1", "Group 2", … skipping any number already taken. */
export function nextGroupName(groups: TileGroups): string {
  const used = new Set(Object.values(groups).map((g) => g.name));
  for (let n = 1; ; n++) {
    const name = `Group ${n}`;
    if (!used.has(name)) return name;
  }
}

/** The ids of every tile in `groupId`. */
export function groupMembers(tiles: readonly StitchTile[], groupId: string): string[] {
  return tiles.filter((t) => t.groupId === groupId).map((t) => t.id);
}

/** The group a tile belongs to, if any. */
export function groupOf(tiles: readonly StitchTile[], tileId: string): string | null {
  return tiles.find((t) => t.id === tileId)?.groupId ?? null;
}

/**
 * Drop every group that no longer has two members, clearing the orphaned `groupId`s.
 *
 * Called after ANY membership change and after tiles are deleted — a group whose second
 * sheet was deleted is a group of one, and a group of one is not a group.
 */
export function pruneGroups(
  tiles: readonly StitchTile[],
  groups: TileGroups
): { tiles: StitchTile[]; groups: TileGroups } {
  const counts = new Map<string, number>();
  for (const t of tiles) if (t.groupId) counts.set(t.groupId, (counts.get(t.groupId) ?? 0) + 1);

  const dead = new Set<string>();
  for (const id of Object.keys(groups)) if ((counts.get(id) ?? 0) < 2) dead.add(id);
  for (const [id, n] of counts) if (n < 2 || !groups[id]) dead.add(id);
  if (dead.size === 0) return { tiles: [...tiles], groups };

  const nextGroups: TileGroups = {};
  for (const [id, g] of Object.entries(groups)) if (!dead.has(id)) nextGroups[id] = g;
  const nextTiles = tiles.map((t) => (t.groupId && dead.has(t.groupId) ? { ...t, groupId: undefined } : t));
  return { tiles: nextTiles, groups: nextGroups };
}

/**
 * Put `tileIds` in a NEW group.
 *
 * Any of them already in another group leave it first (a sheet is in one group or
 * none), and a group they emptied out is dissolved. Fewer than two sheets is not a
 * group and is a no-op — the caller's UI should have disabled the action.
 */
export function createGroupIn(
  tiles: readonly StitchTile[],
  groups: TileGroups,
  tileIds: readonly string[]
): { tiles: StitchTile[]; groups: TileGroups; groupId: string | null } {
  const ids = new Set(tileIds.filter((id) => tiles.some((t) => t.id === id)));
  if (ids.size < 2) return { tiles: [...tiles], groups, groupId: null };

  const groupId = generateGroupId();
  const created: TileGroup = {
    id: groupId,
    name: nextGroupName(groups),
    color: nextGroupColor(groups),
  };
  const nextTiles = tiles.map((t) => (ids.has(t.id) ? { ...t, groupId } : t));
  const pruned = pruneGroups(nextTiles, { ...groups, [groupId]: created });
  return { ...pruned, groupId: pruned.groups[groupId] ? groupId : null };
}

/** Add `tileIds` to an existing group (leaving whatever group they were in). */
export function addToGroupIn(
  tiles: readonly StitchTile[],
  groups: TileGroups,
  groupId: string,
  tileIds: readonly string[]
): { tiles: StitchTile[]; groups: TileGroups } {
  if (!groups[groupId]) return { tiles: [...tiles], groups };
  const ids = new Set(tileIds);
  const nextTiles = tiles.map((t) => (ids.has(t.id) ? { ...t, groupId } : t));
  return pruneGroups(nextTiles, groups);
}

/** Take `tileIds` out of whatever group they are in. */
export function detachFromGroupIn(
  tiles: readonly StitchTile[],
  groups: TileGroups,
  tileIds: readonly string[]
): { tiles: StitchTile[]; groups: TileGroups } {
  const ids = new Set(tileIds);
  const nextTiles = tiles.map((t) => (ids.has(t.id) && t.groupId ? { ...t, groupId: undefined } : t));
  return pruneGroups(nextTiles, groups);
}

/** Dissolve a whole group; every member becomes ungrouped. */
export function ungroupIn(
  tiles: readonly StitchTile[],
  groups: TileGroups,
  groupId: string
): { tiles: StitchTile[]; groups: TileGroups } {
  const nextTiles = tiles.map((t) => (t.groupId === groupId ? { ...t, groupId: undefined } : t));
  const nextGroups: TileGroups = { ...groups };
  delete nextGroups[groupId];
  return pruneGroups(nextTiles, nextGroups);
}

/**
 * Merge every group any of `tileIds` belongs to into ONE group containing all of them.
 *
 * This is what a completed "Align to neighbour" pair does: the sheet that stayed and
 * the sheet that came to meet it are now one rigid thing, and so is everything either
 * of them was already grouped with. The oldest surviving group keeps its identity so
 * its name and colour do not change under the user mid-chain.
 */
export function mergeGroupsFor(
  tiles: readonly StitchTile[],
  groups: TileGroups,
  tileIds: readonly string[]
): { tiles: StitchTile[]; groups: TileGroups; groupId: string | null } {
  const seeds = tileIds.filter((id) => tiles.some((t) => t.id === id));
  if (seeds.length < 2) return { tiles: [...tiles], groups, groupId: null };

  const memberIds = new Set(seeds);
  const groupIds: string[] = [];
  for (const id of seeds) {
    const gid = groupOf(tiles, id);
    if (!gid || groupIds.includes(gid)) continue;
    groupIds.push(gid);
    for (const m of groupMembers(tiles, gid)) memberIds.add(m);
  }
  // Keep the first EXISTING group's identity; only invent one when neither side had one.
  const keepId = groupIds.find((g) => groups[g]);
  if (keepId) {
    const nextTiles = tiles.map((t) => (memberIds.has(t.id) ? { ...t, groupId: keepId } : t));
    const nextGroups: TileGroups = {};
    for (const [id, g] of Object.entries(groups)) if (!groupIds.includes(id) || id === keepId) nextGroups[id] = g;
    const pruned = pruneGroups(nextTiles, nextGroups);
    return { ...pruned, groupId: pruned.groups[keepId] ? keepId : null };
  }
  return createGroupIn(tiles, groups, [...memberIds]);
}

/**
 * Grow a selection to whole groups.
 *
 * Selecting one sheet of a group selects the group: that is what makes a group a thing
 * you can move. Applied before every drag and every nudge, so a group never comes apart
 * by accident.
 */
export function expandSelectionToGroups(
  tiles: readonly StitchTile[],
  selectedIds: readonly string[]
): string[] {
  const byGroup = new Map<string, string[]>();
  for (const t of tiles) {
    if (!t.groupId) continue;
    (byGroup.get(t.groupId) ?? byGroup.set(t.groupId, []).get(t.groupId)!).push(t.id);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of selectedIds) {
    const gid = tiles.find((t) => t.id === id)?.groupId;
    const ids = gid ? byGroup.get(gid) ?? [id] : [id];
    for (const memberId of ids) {
      if (seen.has(memberId)) continue;
      seen.add(memberId);
      out.push(memberId);
    }
  }
  return out;
}

/**
 * Shift-click: toggle a sheet — and its whole group — in or out of the selection.
 *
 * "In" is decided by the sheet the user actually clicked, so shift-clicking a member of
 * a half-selected group brings the whole group in rather than arguing about it.
 */
export function toggleGroupInSelection(
  tiles: readonly StitchTile[],
  selectedIds: readonly string[],
  tileId: string
): string[] {
  const members = expandSelectionToGroups(tiles, [tileId]);
  const memberSet = new Set(members);
  if (selectedIds.includes(tileId)) return selectedIds.filter((id) => !memberSet.has(id));
  return [...selectedIds.filter((id) => !memberSet.has(id)), ...members];
}

/** What the selection is, in words: "3 sheets selected · Group 2". */
export function selectionSummary(
  tiles: readonly StitchTile[],
  groups: TileGroups,
  selectedIds: readonly string[]
): string | null {
  if (selectedIds.length === 0) return null;
  const selected = tiles.filter((t) => selectedIds.includes(t.id));
  if (selected.length === 0) return null;
  const count = `${selected.length} sheet${selected.length === 1 ? "" : "s"} selected`;
  const groupIds = [...new Set(selected.map((t) => t.groupId).filter((g): g is string => !!g))];
  // Only name a group when the selection IS one group — "Group 2" beside a selection
  // that also contains three loose sheets would be a lie about what will move.
  if (groupIds.length === 1 && selected.every((t) => t.groupId === groupIds[0])) {
    const group = groups[groupIds[0]];
    if (group) return `${count} · ${group.name}`;
  }
  return count;
}
