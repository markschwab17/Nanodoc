/**
 * Callout Tool Handler
 * 
 * Handles callout tool interactions: selection, creation, and rendering
 */

import type { ToolHandler, ToolContext } from "./types";
import type { Annotation } from "@/core/pdf/PDFEditor";

export const CalloutTool: ToolHandler = {
  handleMouseDown: (e: React.MouseEvent, context: ToolContext) => {
    const coords = context.getPDFCoordinates(e);
    if (coords) {
      context.setIsSelecting(true);
      context.setSelectionStart(coords);
      context.setSelectionEnd(coords);
    }
  },

  handleMouseUp: async (_e: React.MouseEvent, context: ToolContext, selectionStart, selectionEnd) => {
    if (!selectionStart || !selectionEnd) return;

    const { document, pageNumber, addAnnotation, editor, setEditingAnnotation, setAnnotationText } = context;
    const currentDocument = document;

    // Create callout from selection box
    const minX = Math.min(selectionStart.x, selectionEnd.x);
    const minY = Math.min(selectionStart.y, selectionEnd.y);
    const maxX = Math.max(selectionStart.x, selectionEnd.x);
    const maxY = Math.max(selectionStart.y, selectionEnd.y);
    const width = maxX - minX;
    const height = maxY - minY;

    // Only create if box is large enough
    if (width > 20 && height > 20) {
      const annotation: Annotation = {
        id: `callout_${Date.now()}`,
        type: "callout",
        pageNumber,
        x: minX,
        y: minY,
        width: width,
        height: height,
        arrowPoint: { x: minX + width / 2, y: minY + height / 2 },
        boxPosition: { x: minX + width + 20, y: minY },
        content: "",
        color: "#FFFF00",
      };

      // Add to app state first (so it renders immediately)
      addAnnotation(currentDocument.getId(), annotation);

      // Set as editing so user can type immediately
      setEditingAnnotation(annotation);
      setAnnotationText("");

      // Write to PDF document
      if (!editor) {
        console.warn("PDF editor not initialized, callout annotation not saved to PDF");
      } else {
        try {
          await editor.addCalloutAnnotation(currentDocument, annotation);
        } catch (err) {
          console.error("Error writing callout to PDF:", err);
        }
      }
    }

    context.setIsSelecting(false);
    context.setSelectionStart(null);
    context.setSelectionEnd(null);
  },
};

