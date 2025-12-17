/**
 * Select Text Tool Handler
 * 
 * Handles text selection tool interactions: character-by-character selection and copying
 */

import type { ToolHandler, ToolContext } from "./types";
import { getSpansInSelectionFromPage } from "@/core/pdf/PDFTextExtractor";

// Throttle text extraction to avoid too many async calls during drag
let lastExtractionTime = 0;
const EXTRACTION_THROTTLE_MS = 16; // Update every ~16ms (60fps) for smooth live preview

export const SelectTextTool: ToolHandler = {
  handleMouseDown: async (e: React.MouseEvent, context: ToolContext) => {
    const coords = context.getPDFCoordinates(e);
    if (!coords) return;
    
    // Only set isSelecting if we're actually going to drag (track mouse movement)
    // For clicks, we'll handle selection in mouseUp
    // Store initial position but don't show rectangle yet
    context.setSelectionStart(coords);
    context.setSelectionEnd(coords);
    // Don't set isSelecting=true yet - wait for mouseMove to indicate dragging
  },

  handleMouseMove: async (e: React.MouseEvent, context: ToolContext) => {
    // Check if we have a selection start (mouse was pressed)
    // Note: We don't check isSelecting here because we need to allow initial drag detection
    if (!context.selectionStart) return;
    
    const coords = context.getPDFCoordinates(e);
    if (!coords) return;
    
    // If mouse has moved significantly, this is a drag - update selection and show live preview
    const start = context.selectionStart;
    const distance = Math.sqrt(
      Math.pow(coords.x - start.x, 2) + Math.pow(coords.y - start.y, 2)
    );
    
    if (distance > 2) { // 2 points threshold to distinguish drag from click
      // This is a drag - set isSelecting if not already set
      if (!context.isSelecting) {
        context.setIsSelecting(true);
      }
      
      // Only continue if we're actively selecting (isSelecting is true)
      // This prevents updates after mouse release sets isSelecting to false
      if (!context.isSelecting) return;
      
      context.setSelectionEnd(coords);
      
      // Extract text in real-time for live preview (throttled to avoid too many async calls)
      const now = Date.now();
      if (context.currentDocument && context.setSelectedTextSpans && (now - lastExtractionTime) > EXTRACTION_THROTTLE_MS) {
        lastExtractionTime = now;
        // Use requestAnimationFrame to ensure UI updates smoothly
        requestAnimationFrame(async () => {
          try {
            const result = await getSpansInSelectionFromPage(
              context.currentDocument!,
              context.pageNumber,
              start,
              coords
            );
            context.setSelectedTextSpans!(result.spans);
          } catch (error) {
            console.error("Error extracting text for live preview:", error);
          }
        });
      }
    }
  },

  handleMouseUp: async (_e: React.MouseEvent, context: ToolContext, selectionStart, selectionEnd) => {
    const isClick = selectionStart && selectionEnd && Math.abs(selectionStart.x - selectionEnd.x) < 1 && Math.abs(selectionStart.y - selectionEnd.y) < 1;
    
    if (!selectionStart || !selectionEnd) {
      context.setIsSelecting(false);
      context.setSelectionStart(null);
      context.setSelectionEnd(null);
      return;
    }

    // If this was a click (not a drag), clear selection
    if (isClick) {
      context.setIsSelecting(false);
      context.setSelectionStart(null);
      context.setSelectionEnd(null);
      if (context.setSelectedTextSpans) {
        context.setSelectedTextSpans([]);
      }
      return;
    }

    // For drag: Stop the selection process (set isSelecting=false) but keep the spans visible
    // The selectedTextSpans will remain visible until user clicks elsewhere
    // IMPORTANT: Clear selectionStart/selectionEnd to prevent handleMouseMove from continuing to process
    // after mouse release. The spans are already stored in selectedTextSpans, so we don't need these anymore.
    context.setIsSelecting(false);
    context.setSelectionStart(null);
    context.setSelectionEnd(null);
  },

  renderPreview: (selectionStart, selectionEnd) => {
    if (!selectionStart || !selectionEnd) return null;
    
    // The actual rendering of text selection highlights will be done in PageCanvas
    // This is just a placeholder for the tool's preview
    return null;
  },
};


