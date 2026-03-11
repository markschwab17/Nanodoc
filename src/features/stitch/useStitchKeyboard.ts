/**
 * Keyboard shortcuts for stitch view: Undo, Redo, Delete/Backspace, Arrow-key nudge.
 *
 * Nudge is zoom-aware: each arrow press moves exactly 1 screen pixel
 * (1/zoomLevel document points). This gives ultra-fine control when
 * zoomed in and reasonable steps when zoomed out.
 *
 *   Arrow        → 1 screen pixel  (= 1/zoom pt)
 *   Shift+Arrow  → 10 screen pixels (= 10/zoom pt)
 */

import { useEffect } from "react";
import { useStitchStore } from "@/shared/stores/stitchStore";

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

      // Arrow-key nudge: 1 screen pixel per press (zoom-aware)
      if (
        (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        !inInput &&
        selectedTileIds.length > 0
      ) {
        e.preventDefault();
        e.stopPropagation();
        const store = useStitchStore.getState();
        const zoom = Math.max(0.25, store.zoomLevel);
        const step = e.shiftKey ? 10 / zoom : 1 / zoom;

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
