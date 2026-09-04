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

import { useEffect, useRef } from "react";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { ABSOLUTE_MIN_ZOOM } from "./stitchConstants";
import { expandSelectionToGroups, groupOf } from "./groups";

/** Gap (ms) between nudges that starts a new undo step. */
const NUDGE_BURST_MS = 800;

/**
 * Is the user typing into something?
 *
 * The one copy of this test. Every keyboard owner in stitch — this hook, the align
 * mode, the view's own select-all — has to make the same judgement, and three
 * slightly different copies of it is how a shortcut ends up eating a keystroke inside
 * a filename field.
 */
export function isTypingTarget(): boolean {
  const target = document.activeElement as HTMLElement | null;
  return (
    target?.tagName === "INPUT" ||
    target?.tagName === "TEXTAREA" ||
    target?.isContentEditable === true
  );
}

export interface StitchKeyboardOptions {
  /** When true, Delete/Backspace and Ctrl+A do nothing — a mode owns the selection
   *  (Align to neighbour keeps the sheet being moved selected so the nudges work, and
   *  deleting or replacing that selection mid-alignment is never what was meant).
   *  The nudge itself stays live. */
  selectionEditsDisabled?: boolean;
}

export function useStitchKeyboard(options: StitchKeyboardOptions = {}) {
  // Read through a ref so the listener is installed once and still sees the latest
  // value — the flag flips as modes come and go, not as the app loads.
  const optionsRef = useRef(options);
  optionsRef.current = options;

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
        if (optionsRef.current.selectionEditsDisabled) return;
        e.preventDefault();
        e.stopPropagation();
        if (store.tiles.length > 0) {
          store.setSelectedTileIds(store.tiles.map((t) => t.id));
        }
        return;
      }
      // Cmd/Ctrl+G groups the selection; add Shift to take it apart again.
      if ((e.ctrlKey || e.metaKey) && key === "g") {
        e.preventDefault();
        e.stopPropagation();
        if (optionsRef.current.selectionEditsDisabled) return;
        const ids = store.selectedTileIds;
        if (e.shiftKey) {
          // Ungroup whatever groups the selection touches — the whole group each time,
          // because a half-ungrouped group is not what "ungroup" means, and all of them
          // in ONE undo step.
          const groupIds = [...new Set(ids.map((id) => groupOf(store.tiles, id)).filter((g): g is string => !!g))];
          store.ungroupMany(groupIds);
        } else if (ids.length >= 2) {
          store.createGroup(ids);
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
        const zoom = Math.max(ABSOLUTE_MIN_ZOOM, store.zoomLevel);
        const step = e.shiftKey ? 10 / zoom : 1 / zoom;

        let dx = 0;
        let dy = 0;
        if (e.key === "ArrowUp") dy = -step;
        if (e.key === "ArrowDown") dy = step;
        if (e.key === "ArrowLeft") dx = -step;
        if (e.key === "ArrowRight") dx = step;

        // A nudge moves whole groups: selecting one member and pressing an arrow must
        // not slide it out of the composition it belongs to.
        const selection = expandSelectionToGroups(store.tiles, store.selectedTileIds);
        const unlockedIds = selection.filter(
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
      if (optionsRef.current.selectionEditsDisabled) return;
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
