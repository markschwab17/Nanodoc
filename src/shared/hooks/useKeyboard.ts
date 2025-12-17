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
import { useTextAnnotationClipboardStore } from "@/shared/stores/textAnnotationClipboardStore";

export function useKeyboard() {
  const { currentPage, setCurrentPage, getCurrentDocument } = usePDFStore();
  const currentDocument = getCurrentDocument();
  const { setZoomLevel, zoomLevel, toggleReadMode, activeTool, setActiveTool } = useUIStore();
  const { closeCurrentDocument } = usePDF();
  const { undo, redo, canUndo, canRedo } = useUndoRedo();
  const { hasTextAnnotation } = useTextAnnotationClipboardStore();

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

      // Help: F1 or Cmd/Ctrl + ? (Shift + /)
      if (
        e.key === "F1" ||
        ((e.metaKey || e.ctrlKey) && (e.key === "?" || (e.shiftKey && e.key === "/")))
      ) {
        e.preventDefault();
        // Dispatch a custom event to open help dialog
        const helpEvent = new CustomEvent("openHelp");
        window.dispatchEvent(helpEvent);
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

      // Copy pages: Cmd/Ctrl + C (only when not in text input and not copying text box)
      if ((e.metaKey || e.ctrlKey) && e.key === "c") {
        // Check if a text box is selected (check for focused text editor)
        const activeElement = document.activeElement as HTMLElement;
        const isTextEditorFocused = activeElement && 
          activeElement.hasAttribute("contenteditable") && 
          activeElement.getAttribute("data-rich-text-editor") === "true";
        
        // Only block page copying if a text editor is actually focused
        // Allow page copying even when select tool is active (users can select pages too)
        if (isTextEditorFocused) {
          // Don't prevent default - let PageCanvas handle text box copy
          return;
        }
        
        // Check if we're in text tool mode (but not if text editor is focused, already handled above)
        // In text tool mode without focused editor, still allow page copying
        // The ThumbnailCarousel will handle it and check if pages are selected
        
        // Trigger copy event - will be handled by ThumbnailCarousel
        // ThumbnailCarousel will check if pages are selected and handle accordingly
        const copyEvent = new CustomEvent("copyPages");
        window.dispatchEvent(copyEvent);
        // Don't prevent default - allow normal copy for text
        return;
      }

      // Paste pages: Cmd/Ctrl + V (only when not in text input and not pasting text box)
      if ((e.metaKey || e.ctrlKey) && e.key === "v") {
        // Check if we have a text box in clipboard - if so, let PageCanvas handle it
        // Don't dispatch pastePages event for text boxes
        if (hasTextAnnotation()) {
          // Don't prevent default - let PageCanvas handle text box paste
          // But don't dispatch pastePages event
          return;
        }
        
        // Only trigger paste event for pages if we don't have a text box in clipboard
        // Trigger paste event - will be handled by ThumbnailCarousel
        const pasteEvent = new CustomEvent("pastePages");
        window.dispatchEvent(pasteEvent);
        // Don't prevent default - allow normal paste for text
        return;
      }

      // Tool switching shortcuts
      // Select tool: Cmd/Ctrl + A (only when not in edit mode)
      // Note: When in edit mode, CTRL+A is handled by RichTextEditor to select all text
      if ((e.metaKey || e.ctrlKey) && e.key === "a") {
        e.preventDefault();
        setActiveTool("select");
        return;
      }

      // Text tool: Cmd/Ctrl + T
      if ((e.metaKey || e.ctrlKey) && e.key === "t") {
        e.preventDefault();
        setActiveTool("text");
        return;
      }

      // Redact tool: Cmd/Ctrl + R
      if ((e.metaKey || e.ctrlKey) && e.key === "r") {
        e.preventDefault();
        setActiveTool("redact");
        return;
      }

      // Highlight tool: Cmd/Ctrl + H
      if ((e.metaKey || e.ctrlKey) && e.key === "h") {
        e.preventDefault();
        setActiveTool("highlight");
        return;
      }

      // Print: Cmd/Ctrl + P
      if ((e.metaKey || e.ctrlKey) && e.key === "p") {
        e.preventDefault();
        // Find and click the print button
        const printButton = document.querySelector(
          'button[title="Print PDF"]'
        ) as HTMLButtonElement;
        if (printButton && !printButton.disabled) {
          printButton.click();
        }
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

      // Toggle read mode: R key (only when not using Ctrl/Cmd)
      if ((e.key === "r" || e.key === "R") && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        toggleReadMode();
        return;
      }

      // Delete: Delete or Backspace key - delete currently selected annotation
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        
        // Dispatch delete event - Editor.tsx will handle it
        const deleteEvent = new CustomEvent("deleteSelectedAnnotation");
        window.dispatchEvent(deleteEvent);
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
    activeTool,
    hasTextAnnotation,
    setActiveTool,
  ]);
}

