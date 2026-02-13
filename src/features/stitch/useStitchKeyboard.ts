/**
 * Keyboard shortcuts for stitch view: Undo, Redo, Delete/Backspace for selected tiles.
 */

import { useEffect } from "react";
import { useStitchStore } from "@/shared/stores/stitchStore";

export function useStitchKeyboard() {
  const { selectedTileIds, removeTile, undo, redo } = useStitchStore();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = document.activeElement as HTMLElement | null;
      const inInput =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true;

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
  }, [selectedTileIds, removeTile, undo, redo]);
}
