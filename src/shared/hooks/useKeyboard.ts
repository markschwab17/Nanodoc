/**
 * useKeyboard Hook
 * 
 * Handles keyboard shortcuts for navigation, undo/redo, save, etc.
 */

import { useEffect } from "react";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useUIStore } from "@/shared/stores/uiStore";
import { usePDF } from "./usePDF";
import { useUndoRedo } from "./useUndoRedo";

export function useKeyboard() {
  const { currentPage, setCurrentPage, getCurrentDocument } = usePDFStore();
  const currentDocument = getCurrentDocument();
  const { setZoomLevel, zoomLevel, toggleReadMode } = useUIStore();
  const { closeCurrentDocument } = usePDF();
  const { undo, redo, canUndo, canRedo } = useUndoRedo();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle shortcuts when typing in inputs
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) {
        return;
      }

      // Save: Cmd/Ctrl + S
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        // Trigger save - this will be handled by the App component
        const saveButton = document.querySelector(
          '[data-action="save"]'
        ) as HTMLButtonElement;
        if (saveButton && !saveButton.disabled) {
          saveButton.click();
        }
        return;
      }

      // Close tab: Cmd/Ctrl + W
      if ((e.metaKey || e.ctrlKey) && e.key === "w") {
        e.preventDefault();
        closeCurrentDocument();
        return;
      }

      // Open file: Cmd/Ctrl + O
      if ((e.metaKey || e.ctrlKey) && e.key === "o") {
        e.preventDefault();
        const openButton = document.querySelector(
          '[data-action="open"]'
        ) as HTMLButtonElement;
        if (openButton) {
          openButton.click();
        }
        return;
      }

      // Undo: Cmd/Ctrl + Z
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        if (canUndo) {
          undo();
        }
        return;
      }

      // Redo: Cmd/Ctrl + Shift + Z (Mac) or Cmd/Ctrl + Y (Windows/Linux)
      if (
        ((e.metaKey || e.ctrlKey) && e.key === "y") ||
        ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "z")
      ) {
        e.preventDefault();
        if (canRedo) {
          redo();
        }
        return;
      }

      // Copy pages: Cmd/Ctrl + C (only when not in text input)
      if ((e.metaKey || e.ctrlKey) && e.key === "c") {
        // Trigger copy event - will be handled by ThumbnailCarousel
        const copyEvent = new CustomEvent("copyPages");
        window.dispatchEvent(copyEvent);
        // Don't prevent default - allow normal copy for text
        return;
      }

      // Paste pages: Cmd/Ctrl + V (only when not in text input)
      if ((e.metaKey || e.ctrlKey) && e.key === "v") {
        // Trigger paste event - will be handled by ThumbnailCarousel
        const pasteEvent = new CustomEvent("pastePages");
        window.dispatchEvent(pasteEvent);
        // Don't prevent default - allow normal paste for text
        return;
      }

      if (!currentDocument) return;

      // Page navigation
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        if (currentPage > 0) {
          setCurrentPage(currentPage - 1);
        }
        return;
      }

      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        const pageCount = currentDocument.getPageCount();
        if (currentPage < pageCount - 1) {
          setCurrentPage(currentPage + 1);
        }
        return;
      }

      // Zoom controls
      if ((e.metaKey || e.ctrlKey) && e.key === "=") {
        e.preventDefault();
        setZoomLevel(zoomLevel + 0.25);
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "-") {
        e.preventDefault();
        setZoomLevel(zoomLevel - 0.25);
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "0") {
        e.preventDefault();
        setZoomLevel(1.0);
        return;
      }

      // Home/End for first/last page
      if (e.key === "Home") {
        e.preventDefault();
        setCurrentPage(0);
        return;
      }

      if (e.key === "End") {
        e.preventDefault();
        const pageCount = currentDocument.getPageCount();
        setCurrentPage(pageCount - 1);
        return;
      }

      // Toggle read mode: R key
      if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        toggleReadMode();
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    currentDocument,
    currentPage,
    setCurrentPage,
    setZoomLevel,
    zoomLevel,
    closeCurrentDocument,
    undo,
    redo,
    canUndo,
    canRedo,
    toggleReadMode,
  ]);
}

