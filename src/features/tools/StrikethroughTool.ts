/**
 * Strikethrough Tool — select text to create a strikethrough + comment annotation.
 *
 * Reuses the HighlightTool's text selection logic (text detection, live preview,
 * quad extraction) but creates a "strikethrough" annotation instead of "highlight".
 * Only supports text mode (no overlay/freehand) — if no text is detected, does nothing.
 */

import type { ToolHandler, ToolContext } from "./types";
import type { Annotation } from "@/core/pdf/types";
import { useUIStore } from "@/shared/stores/uiStore";
import { wrapAnnotationOperation } from "@/shared/stores/undoHelpers";
import { getSpansInSelectionFromPage } from "@/core/pdf/PDFTextExtractor";

let dragStartCoords: { x: number; y: number } | null = null;
let lastExtractionTime = 0;
const EXTRACTION_THROTTLE_MS = 16;

export const StrikethroughTool: ToolHandler = {
  async handleMouseDown(e: React.MouseEvent, context: ToolContext) {
    const coords = context.getPDFCoordinates(e);
    if (!coords) return;

    // Clear previous preview
    if (context.setSelectedTextSpans) {
      context.setSelectedTextSpans([]);
    }
    if (context.setIsHighlightTextMode) {
      context.setIsHighlightTextMode(true); // Always text mode for strikethrough
    }

    dragStartCoords = coords;
    context.setIsSelecting(true);
    context.setSelectionStart(coords);
    context.setSelectionEnd(coords);
  },

  async handleMouseMove(e: React.MouseEvent, context: ToolContext) {
    if (!context.isSelecting || !context.selectionStart) return;

    const coords = context.getPDFCoordinates(e);
    if (!coords) return;

    context.setSelectionEnd(coords);

    // Live text selection preview (throttled)
    const now = Date.now();
    if (context.currentDocument && context.setSelectedTextSpans && (now - lastExtractionTime) > EXTRACTION_THROTTLE_MS) {
      lastExtractionTime = now;
      const currentDoc = context.currentDocument;
      const currentPageNumber = context.pageNumber;
      const startPoint = context.selectionStart;
      const endPoint = coords;
      const setSpans = context.setSelectedTextSpans;

      (async () => {
        try {
          const result = await getSpansInSelectionFromPage(currentDoc, currentPageNumber, startPoint!, endPoint);
          setSpans(result.spans);
        } catch {
          // Silently ignore errors during live preview
        }
      })();
    }
  },

  async handleMouseUp(_e: React.MouseEvent, context: ToolContext, selectionStart, selectionEnd) {
    if (!selectionStart) {
      context.setIsSelecting(false);
      context.setSelectionStart(null);
      context.setSelectionEnd(null);
      dragStartCoords = null;
      return;
    }

    const finalEnd = selectionEnd || dragStartCoords || selectionStart;

    // Check if just a click (no drag)
    const distance = Math.sqrt(
      Math.pow(finalEnd.x - selectionStart.x, 2) +
      Math.pow(finalEnd.y - selectionStart.y, 2)
    );
    if (distance < 2) {
      context.setIsSelecting(false);
      context.setSelectionStart(null);
      context.setSelectionEnd(null);
      dragStartCoords = null;
      if (context.setSelectedTextSpans) context.setSelectedTextSpans([]);
      return;
    }

    const currentDocument = context.document;
    const pageNumber = context.pageNumber;

    try {
      const mupdfDoc = currentDocument.getMupdfDocument();
      const page = mupdfDoc.loadPage(pageNumber);
      const pageMetadata = currentDocument.getPageMetadata(pageNumber);
      const pageHeight = pageMetadata?.height || 792;

      // Normalize coordinates
      const minX = Math.min(selectionStart.x, finalEnd.x);
      const minY = Math.min(selectionStart.y, finalEnd.y);
      const maxX = Math.max(selectionStart.x, finalEnd.x);
      const maxY = Math.max(selectionStart.y, finalEnd.y);

      // Convert to display coords for mupdf
      const displayMinY = pageHeight - maxY;
      const displayMaxY = pageHeight - minY;

      const p = [minX, displayMinY];
      const q = [maxX, displayMaxY];
      const structuredText = page.toStructuredText("preserve-whitespace");
      let quads = structuredText.highlight(p, q);

      if (!quads || quads.length === 0) {
        const expandedP = [minX - 2, displayMinY - 2];
        const expandedQ = [maxX + 2, displayMaxY + 2];
        quads = structuredText.highlight(expandedP, expandedQ);
      }

      if (!quads || quads.length === 0) {
        // No text found — don't create annotation
        context.setIsSelecting(false);
        context.setSelectionStart(null);
        context.setSelectionEnd(null);
        if (context.setSelectedTextSpans) context.setSelectedTextSpans([]);
        dragStartCoords = null;
        return;
      }

      // Extract selected text
      let selectedText = "";
      try {
        selectedText = structuredText.asText();
      } catch {
        // Ignore
      }

      // Convert quads from display coords to PDF coords
      const pdfQuads = quads.map((quad: any) => {
        let rawQuad: number[];
        if (Array.isArray(quad) && quad.length >= 8) {
          rawQuad = quad;
        } else {
          rawQuad = [quad.x0 || 0, quad.y0 || 0, quad.x1 || 0, quad.y1 || 0,
                     quad.x2 || 0, quad.y2 || 0, quad.x3 || 0, quad.y3 || 0];
        }
        return [
          rawQuad[0], pageHeight - rawQuad[1],
          rawQuad[2], pageHeight - rawQuad[3],
          rawQuad[4], pageHeight - rawQuad[5],
          rawQuad[6], pageHeight - rawQuad[7],
        ];
      });

      const documentId = currentDocument.getId();
      const annotation: Annotation = {
        id: `strikethrough_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: "strikethrough",
        pageNumber,
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
        quads: pdfQuads,
        selectedText,
        color: "#EF4444",
        highlightMode: "text",
        commentContent: "",
        redlineSuggestion: "",
      };

      wrapAnnotationOperation(
        () => {
          context.addAnnotation(documentId, annotation);
        },
        "addAnnotation",
        documentId,
        annotation.id,
        annotation
      );

      // Switch to select tool so user can click the strikethrough to add a comment
      useUIStore.getState().setActiveTool("select");
    } catch (err) {
      console.warn("[StrikethroughTool] Failed to create strikethrough:", err);
    }

    // Clean up
    context.setIsSelecting(false);
    context.setSelectionStart(null);
    context.setSelectionEnd(null);
    if (context.setSelectedTextSpans) context.setSelectedTextSpans([]);
    dragStartCoords = null;
  },
};
