/**
 * Right-click menu for the stitch canvas.
 *
 * Mark: "I feel like right click with a menu would be helpful."
 *
 * It wraps the canvas and reads the sheet under the cursor from the DOM
 * (`[data-stitch-tile-id]`) rather than re-deriving it from pan/zoom maths — the browser
 * has already hit-tested the transformed, rotated tiles for us, and a second
 * implementation of that would be a second thing to get wrong.
 *
 * Right-clicking a sheet that is not selected selects it first (grown to its group), so
 * the menu always acts on what the user can see is selected. What each entry can do,
 * and why it cannot, comes from `contextMenuModel` — a disabled row without a reason is
 * worse than no row.
 */

import { useCallback, useRef, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { cn } from "@/lib/utils";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { expandSelectionToGroups } from "./groups";
import {
  canvasMenuModel,
  sheetMenuModel,
  type CanvasMenuModel,
  type MenuAction,
  type SheetMenuModel,
} from "./contextMenuModel";

const ITEM_CLASS =
  "relative flex cursor-default select-none items-center justify-between gap-6 rounded px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50";
const CONTENT_CLASS =
  "z-[10000] min-w-[13rem] rounded-md border bg-popover p-1 text-popover-foreground shadow-lg";

function Hint({ action }: { action: MenuAction }) {
  if (action.enabled || !action.hint) return null;
  return <span className="text-[10px] text-muted-foreground">{action.hint}</span>;
}

export interface StitchContextMenuProps {
  children: React.ReactNode;
  /** Enter "Align to neighbour" (the menu's shortcut into the mode). */
  onAlignFromHere?: () => void;
  /** Zoom-to-fit, shared with the bottom bar's Center button. */
  onRecenter?: () => void;
  /** When true the menu does not open — a mode overlay owns the canvas. */
  disabled?: boolean;
}

export function StitchContextMenu({
  children,
  onAlignFromHere,
  onRecenter,
  disabled = false,
}: StitchContextMenuProps) {
  /**
   * The menu is built ONCE, when it opens.
   *
   * Subscribing to `tiles` / `groups` / `selectedTileIds` re-rendered this wrapper —
   * and therefore the whole canvas it wraps — on every drag frame, for a menu that is
   * shut 99.9% of the time. The store is read imperatively in the contextmenu handler
   * instead, which is also the only moment the answer can matter.
   */
  const [menu, setMenu] = useState<{
    sheet: SheetMenuModel | null;
    canvas: CanvasMenuModel;
    /** The sheets an action applies to: the selection, grown to whole groups. */
    acting: string[];
  } | null>(null);

  /** Radix hands the app handler straight through while `disabled`, so the guard is
   *  ours: in an align/cleanup mode a right-click must neither move the selection
   *  (the moving sheet IS the selection there) nor build a menu that never opens. */
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (disabledRef.current) return;
    const el = (e.target as HTMLElement | null)?.closest?.("[data-stitch-tile-id]");
    const id = el?.getAttribute("data-stitch-tile-id") ?? null;
    const store = useStitchStore.getState();

    // Act on what the user can SEE is selected: a right-click on a sheet outside the
    // current selection makes it (and its group) the selection first.
    let selection = store.selectedTileIds;
    if (id && !selection.includes(id)) {
      selection = expandSelectionToGroups(store.tiles, [id]);
      store.setSelectedTileIds(selection);
    }
    setMenu({
      sheet: id ? sheetMenuModel(store.tiles, store.groups, selection, id) : null,
      canvas: canvasMenuModel(store.tiles),
      acting: expandSelectionToGroups(store.tiles, selection),
    });
  }, []);

  const sheet = menu?.sheet ?? null;
  const canvas = menu?.canvas ?? { selectAll: { enabled: false }, fitToSheets: { enabled: false }, recenter: { enabled: true } };
  const acting = menu?.acting ?? [];

  const store = () => useStitchStore.getState();

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild disabled={disabled} onContextMenu={handleContextMenu}>
        <div className="w-full h-full">{children}</div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={CONTENT_CLASS} collisionPadding={8}>
          {sheet ? (
            <>
              <ContextMenu.Label className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                {sheet.group ? sheet.group.name : "Sheet"}
                {sheet.selectionCount > 1 ? ` · ${sheet.selectionCount} selected` : ""}
              </ContextMenu.Label>
              <ContextMenu.Item
                className={ITEM_CLASS}
                disabled={!sheet.selectGroup.enabled}
                onSelect={() => {
                  if (!sheet.group) return;
                  store().setSelectedTileIds(expandSelectionToGroups(store().tiles, [sheet.tileId]));
                }}
              >
                Select group
                <Hint action={sheet.selectGroup} />
              </ContextMenu.Item>
              <ContextMenu.Item
                className={ITEM_CLASS}
                disabled={!sheet.createGroup.enabled}
                onSelect={() => store().createGroup(acting)}
              >
                Create group
                <Hint action={sheet.createGroup} />
              </ContextMenu.Item>
              <ContextMenu.Sub>
                <ContextMenu.SubTrigger
                  className={ITEM_CLASS}
                  disabled={!sheet.addToGroupAction.enabled}
                >
                  Add to group
                  {sheet.addToGroupAction.enabled ? (
                    <span className="text-muted-foreground">›</span>
                  ) : (
                    <Hint action={sheet.addToGroupAction} />
                  )}
                </ContextMenu.SubTrigger>
                <ContextMenu.Portal>
                  <ContextMenu.SubContent className={CONTENT_CLASS} sideOffset={2}>
                    {sheet.addToGroup.map((g) => (
                      <ContextMenu.Item
                        key={g.id}
                        className={ITEM_CLASS}
                        onSelect={() => store().addToGroup(g.id, acting)}
                      >
                        <span className="flex items-center gap-2">
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-full"
                            style={{ background: g.color }}
                            aria-hidden
                          />
                          {g.name}
                        </span>
                      </ContextMenu.Item>
                    ))}
                  </ContextMenu.SubContent>
                </ContextMenu.Portal>
              </ContextMenu.Sub>
              <ContextMenu.Item
                className={ITEM_CLASS}
                disabled={!sheet.detach.enabled}
                onSelect={() => store().detachFromGroup([sheet.tileId])}
              >
                Detach from group
                <Hint action={sheet.detach} />
              </ContextMenu.Item>
              <ContextMenu.Item
                className={ITEM_CLASS}
                disabled={!sheet.ungroup.enabled}
                onSelect={() => sheet.group && store().ungroup(sheet.group.id)}
              >
                Ungroup
                <Hint action={sheet.ungroup} />
              </ContextMenu.Item>

              <ContextMenu.Separator className="my-1 h-px bg-border" />

              <ContextMenu.Item
                className={ITEM_CLASS}
                disabled={!sheet.order.enabled}
                onSelect={() => store().bringTilesToFront(acting)}
              >
                Bring to front
                <Hint action={sheet.order} />
              </ContextMenu.Item>
              <ContextMenu.Item
                className={ITEM_CLASS}
                disabled={!sheet.order.enabled}
                onSelect={() => store().sendTilesToBack(acting)}
              >
                Send to back
                <Hint action={sheet.order} />
              </ContextMenu.Item>
              <ContextMenu.Item
                className={ITEM_CLASS}
                onSelect={() =>
                  store().updateTiles(acting.map((id) => ({ id, patch: { locked: !sheet.locked } })))
                }
              >
                {sheet.lockLabel}
              </ContextMenu.Item>
              <ContextMenu.Item
                className={cn(ITEM_CLASS, "text-destructive data-[highlighted]:text-destructive")}
                onSelect={() => store().removeTiles(acting)}
              >
                {sheet.removeLabel}
              </ContextMenu.Item>

              <ContextMenu.Separator className="my-1 h-px bg-border" />

              <ContextMenu.Item
                className={ITEM_CLASS}
                disabled={!sheet.alignFromHere.enabled || !onAlignFromHere}
                onSelect={() => onAlignFromHere?.()}
              >
                Align to neighbour from here
                <Hint action={sheet.alignFromHere} />
              </ContextMenu.Item>
            </>
          ) : (
            <>
              <ContextMenu.Item
                className={ITEM_CLASS}
                disabled={!canvas.selectAll.enabled}
                onSelect={() => store().setSelectedTileIds(store().tiles.map((t) => t.id))}
              >
                Select all
                <Hint action={canvas.selectAll} />
              </ContextMenu.Item>
              <ContextMenu.Item
                className={ITEM_CLASS}
                disabled={!canvas.fitToSheets.enabled}
                onSelect={() => {
                  store().fitCanvasToTiles();
                  onRecenter?.();
                }}
              >
                Fit page to sheets
                <Hint action={canvas.fitToSheets} />
              </ContextMenu.Item>
              <ContextMenu.Item
                className={ITEM_CLASS}
                disabled={!onRecenter}
                onSelect={() => onRecenter?.()}
              >
                Recenter
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
