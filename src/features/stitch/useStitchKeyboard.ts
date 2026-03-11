/**
 * Keyboard shortcuts for stitch view: Undo, Redo, Delete/Backspace, Arrow-key nudge.
 *
 * Arrow keys move selected tiles by 1pt (≈1px).  Hold Shift for 10pt steps.
 * This enables precise sub-snap alignment that mouse dragging can't achieve.
 */

import { useEffect } from "react";
import { useStitchStore } from "@/shared/stores/stitchStore";

/** Default nudge distance in points (1pt ≈ 1/72 inch). */
const NUDGE_SMALL = 1;
/** Shift+arrow nudge distance. */
const NUDGE_LARGE = 10;

export function useStitchKeyboard() {
  const { selectedTileIds, removeTile, undo, redo, tiles, setSelectedTileIds } = useStitchStore();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = document.activeElement as HTMLElement | null;
      const inInput =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true;

      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        e.stopPropagation();
        if (!inInput && tiles.length > 0) {
          setSelectedTileIds(tiles.map((t) => t.id));
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "y") {
        e.preventDefault();
        e.stopPropagation();
        redo();
        return;
      }

      // Arrow-key nudge
      if (
        (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        !inInput &&
        selectedTileIds.length > 0
      ) {
        e.preventDefault();
        e.stopPropagation();
        const store = useStitchStore.getState();
        const step = e.shiftKey ? NUDGE_LARGE : NUDGE_SMALL;
        let dx = 0;
        let dy = 0;
        if (e.key === "ArrowUp") dy = -step;
        if (e.key === "ArrowDown") dy = step;
        if (e.key === "ArrowLeft") dx = -step;
        if (e.key === "ArrowRight") dx = step;

        const unlockedIds = selectedTileIds.filter(
          (id) => !store.tiles.find((t) => t.id === id)?.locked
        );
        if (unlockedIds.length === 0) return;

        const updates = unlockedIds.map((id) => {
          const t = store.tiles.find((x) => x.id === id)!;
          return { id, patch: { x: t.x + dx, y: t.y + dy } as const };
        });
        store.updateTiles(updates);
        return;
      }

      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (inInput) return;
      if (selectedTileIds.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        selectedTileIds.forEach((id) => removeTile(id));
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [selectedTileIds, removeTile, undo, redo, tiles, setSelectedTileIds]);
}
