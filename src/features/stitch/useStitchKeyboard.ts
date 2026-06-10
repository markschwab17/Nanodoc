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
import { MIN_ZOOM } from "./stitchConstants";

/** Gap (ms) between nudges that starts a new undo step. */
const NUDGE_BURST_MS = 800;

function isTypingTarget(): boolean {
  const target = document.activeElement as HTMLElement | null;
  return (
    target?.tagName === "INPUT" ||
    target?.tagName === "TEXTAREA" ||
    target?.isContentEditable === true
  );
}

export function useStitchKeyboard() {
  useEffect(() => {
    // One undo snapshot per burst of arrow nudges, not one per keypress.
    let lastNudgeAt = 0;

    const onKeyDown = (e: KeyboardEvent) => {
      // Never hijack shortcuts while the user is typing in a field —
      // native select-all / text undo must keep working.
      if (isTypingTarget()) return;

      const store = useStitchStore.getState();
      const key = e.key.toLowerCase();

      if ((e.ctrlKey || e.metaKey) && key === "a") {
        e.preventDefault();
        e.stopPropagation();
        if (store.tiles.length > 0) {
          store.setSelectedTileIds(store.tiles.map((t) => t.id));
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && key === "z") {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && key === "y") {
        e.preventDefault();
        e.stopPropagation();
        store.redo();
        return;
      }

      // Arrow-key nudge: 1 screen pixel per press (zoom-aware)
      if (
        (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        store.selectedTileIds.length > 0
      ) {
        e.preventDefault();
        e.stopPropagation();
        const zoom = Math.max(MIN_ZOOM, store.zoomLevel);
        const step = e.shiftKey ? 10 / zoom : 1 / zoom;

        let dx = 0;
        let dy = 0;
        if (e.key === "ArrowUp") dy = -step;
        if (e.key === "ArrowDown") dy = step;
        if (e.key === "ArrowLeft") dx = -step;
        if (e.key === "ArrowRight") dx = step;

        const unlockedIds = store.selectedTileIds.filter(
          (id) => !store.tiles.find((t) => t.id === id)?.locked
        );
        if (unlockedIds.length === 0) return;

        const now = Date.now();
        if (now - lastNudgeAt > NUDGE_BURST_MS) {
          store.pushUndoSnapshot();
        }
        lastNudgeAt = now;

        const updates = unlockedIds.map((id) => {
          const t = store.tiles.find((x) => x.id === id)!;
          return { id, patch: { x: t.x + dx, y: t.y + dy } as const };
        });
        store.updateTilesNoUndo(updates);
        return;
      }

      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (store.selectedTileIds.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        store.removeTiles(store.selectedTileIds);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
