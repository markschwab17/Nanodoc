/**
 * Text Tool Handler
 * 
 * Handles text annotation tool interactions: creation, editing, and rendering
 */

import type { ToolHandler, ToolContext } from "./types";
import type { Annotation } from "@/core/pdf/PDFEditor";

export const TextTool: ToolHandler = {
  handleMouseDown: (e: React.MouseEvent, context: ToolContext) => {
    const { annotations, containerRef, zoomLevelRef, fitMode, panOffset, panOffsetRef, setEditingAnnotation, setAnnotationText, setIsEditingMode } = context;

    // Check if clicking on an existing annotation first
    const clickedAnnotation = annotations?.find((annot) => {
      if (annot.type !== "text") return false;

      // Get the transformed div element
      const transformedDiv = containerRef.current?.querySelector('div[style*="transform"]') as HTMLElement;
      if (!transformedDiv) return false;

      const transformedRect = transformedDiv.getBoundingClientRect();

      // Convert mouse position to coordinates relative to the transformed div
      const transformedX = e.clientX - transformedRect.left;
      const transformedY = e.clientY - transformedRect.top;

      // Get canvas position (in canvas coordinates, before transform)
      const canvasPos = context.pdfToCanvas(annot.x, annot.y);

      // Account for the transform
      const currentZoom = zoomLevelRef?.current || 1.0;
      const currentPan = fitMode === "custom" ? panOffsetRef?.current || { x: 0, y: 0 } : panOffset || { x: 0, y: 0 };

      // Reverse the transform to get canvas coordinates
      const canvasX = (transformedX - currentPan.x) / currentZoom;
      const canvasY = (transformedY - currentPan.y) / currentZoom;

      // Check if click is within annotation bounds
      const width = annot.width || 200;
      const height = annot.height || 100;

      return (
        canvasX >= canvasPos.x &&
        canvasX <= canvasPos.x + width &&
        canvasY >= canvasPos.y &&
        canvasY <= canvasPos.y + height
      );
    });

    if (clickedAnnotation) {
      // Single click: select annotation
      e.preventDefault();
      e.stopPropagation();
      setEditingAnnotation(clickedAnnotation);
      setAnnotationText(clickedAnnotation.content || "");
      setIsEditingMode(false); // Start in selection mode, not edit mode
      return;
    }

    // Start creating text box
    const coords = context.getPDFCoordinates(e);
    if (coords) {
      context.setIsCreatingTextBox(true);
      context.setTextBoxStart(coords);
      context.setSelectionStart(coords);
      context.setSelectionEnd(coords);
    }
  },

  handleMouseUp: async (_e: React.MouseEvent, context: ToolContext, _selectionStart, selectionEnd, textBoxStart?) => {
    if (!textBoxStart) return;

    const { pageNumber, setEditingAnnotation, setAnnotationText, setIsEditingMode } = context;
    const isClick = !selectionEnd || (
      Math.abs((selectionEnd.x || 0) - textBoxStart.x) < 5 &&
      Math.abs((selectionEnd.y || 0) - textBoxStart.y) < 5
    );

    const defaultFontSize = 12;
    let width: number;
    let height: number;
    let autoFit = false;
    let boxX = textBoxStart.x;
    let boxY = textBoxStart.y;

    if (isClick) {
      // Click: auto-fit mode (typewriter style)
      autoFit = true;
      width = defaultFontSize * 9;
      height = defaultFontSize * 1.5; // Initial height, will auto-fit
    } else if (selectionEnd) {
      // Drag: fixed box size - use top-left corner of drag
      // Note: PDF coordinates have Y=0 at bottom, so larger Y = higher up
      // For top-left corner in PDF: use minX and maxY (maxY is the top)
      const minX = Math.min(textBoxStart.x, selectionEnd.x);
      const maxX = Math.max(textBoxStart.x, selectionEnd.x);
      const minY = Math.min(textBoxStart.y, selectionEnd.y); // Smaller Y = lower (closer to bottom)
      const maxY = Math.max(textBoxStart.y, selectionEnd.y); // Larger Y = higher (closer to top)
      boxX = minX;
      boxY = maxY; // Use maxY for top position in PDF coordinates
      width = Math.max(50, maxX - minX);
      height = Math.max(30, maxY - minY); // Height is positive (top - bottom)
    } else {
      return;
    }

    const tempAnnotation: Annotation = {
      id: `temp_annot_${Date.now()}`,
      type: "text",
      pageNumber,
      x: boxX,
      y: boxY,
      content: "",
      fontSize: defaultFontSize,
      fontFamily: "Arial",
      color: "#000000",
      width,
      height,
      autoFit, // Flag to indicate auto-fit mode
    };

    setEditingAnnotation(tempAnnotation);
    setAnnotationText("");
    setIsEditingMode(true);
    context.setIsCreatingTextBox(false);
    context.setTextBoxStart(null);
    context.setSelectionStart(null);
    context.setSelectionEnd(null);
  },
};

