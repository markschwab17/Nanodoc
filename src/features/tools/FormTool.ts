/**
 * Form Tool Handler
 * 
 * Handles form field creation and interaction
 */

import type { ToolHandler, ToolContext } from "./types";
import type { Annotation } from "@/core/pdf/PDFEditor";
import { useUIStore } from "@/shared/stores/uiStore";

let isCreatingField = false;
let fieldStart: { x: number; y: number } | null = null;

export const FormTool: ToolHandler = {
  handleMouseDown: (e: React.MouseEvent, context: ToolContext) => {
    const coords = context.getPDFCoordinates(e);
    if (!coords) return;
    
    const { currentFieldType } = useUIStore.getState();
    
    // For checkboxes and radio buttons, create immediately (no drag)
    if (currentFieldType === "checkbox" || currentFieldType === "radio") {
      const { pageNumber, currentDocument, addAnnotation } = context;
      
      if (!currentDocument) return;
      
      const size = 20; // Standard checkbox/radio size
      
      // getPDFCoordinates returns TOP Y, but annotation.y should be BOTTOM Y
      // For a square, bottomY = topY - height
      const topY = coords.y; // getPDFCoordinates returns top Y
      const bottomY = topY - size; // Convert to bottom Y
      
      const annotation: Annotation = {
        id: `form_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: "formField",
        pageNumber,
        x: coords.x,
        y: bottomY, // Use bottom Y (matches FormField.tsx convention)
        width: size,
        height: size,
        fieldType: currentFieldType,
        fieldName: `${currentFieldType}_${Date.now()}`,
        fieldValue: false,
        radioGroup: currentFieldType === "radio" ? "group1" : undefined,
      };
      
      addAnnotation(currentDocument.getId(), annotation);
      
      // Switch to select tool and select the newly created annotation
      useUIStore.getState().setActiveTool("select");
      context.setEditingAnnotation(annotation);
      
      // Dispatch event to notify that annotation was selected
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent("annotationSelected", { 
          detail: { annotationId: annotation.id } 
        }));
      });
      
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    
    // For other fields, start drag to define size
    isCreatingField = true;
    fieldStart = coords;
    context.setIsSelecting(true);
    context.setSelectionStart(coords);
    context.setSelectionEnd(coords);
    
    e.preventDefault();
    e.stopPropagation();
  },

  handleMouseMove: (e: React.MouseEvent, context: ToolContext) => {
    if (!isCreatingField || !fieldStart) return;
    
    const coords = context.getPDFCoordinates(e);
    if (!coords) return;
    
    context.setSelectionEnd(coords);
  },

  handleMouseUp: async (_e: React.MouseEvent, context: ToolContext, _selectionStart, selectionEnd) => {
    if (!isCreatingField || !fieldStart || !selectionEnd) {
      isCreatingField = false;
      fieldStart = null;
      context.setIsSelecting(false);
      context.setSelectionStart(null);
      context.setSelectionEnd(null);
      return;
    }
    
    const { pageNumber, currentDocument, addAnnotation } = context;
    
    if (!currentDocument) {
      isCreatingField = false;
      fieldStart = null;
      return;
    }
    
    const { currentFieldType } = useUIStore.getState();
    
    // Calculate dimensions
    // getPDFCoordinates returns TOP Y in PDF coordinates (Y increases upward)
    // For form fields, annotation.y should be BOTTOM Y (to match FormField.tsx usage)
    // So we need to convert: bottomY = topY - height
    const width = Math.abs(selectionEnd.x - fieldStart.x);
    const topY = Math.max(fieldStart.y, selectionEnd.y); // Top Y (larger Y in PDF)
    const bottomY = Math.min(fieldStart.y, selectionEnd.y); // Bottom Y (smaller Y in PDF)
    const height = topY - bottomY;
    const x = Math.min(fieldStart.x, selectionEnd.x);
    const y = bottomY; // Use bottom Y for annotation (matches FormField.tsx convention)
    
    // Set minimum sizes based on field type
    let finalWidth = width;
    let finalHeight = height;
    
    if (currentFieldType === "text") {
      finalWidth = Math.max(width, 100);
      finalHeight = Math.max(height, 30);
    } else if (currentFieldType === "dropdown") {
      finalWidth = Math.max(width, 150);
      finalHeight = Math.max(height, 30);
    } else if (currentFieldType === "date") {
      finalWidth = Math.max(width, 120);
      finalHeight = Math.max(height, 30);
    }
    
    // Check for minimum size
    if (finalWidth < 20 || finalHeight < 20) {
      isCreatingField = false;
      fieldStart = null;
      context.setIsSelecting(false);
      context.setSelectionStart(null);
      context.setSelectionEnd(null);
      return;
    }
    
    // Create form field annotation
    const annotation: Annotation = {
      id: `form_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: "formField",
      pageNumber,
      x,
      y,
      width: finalWidth,
      height: finalHeight,
      fieldType: currentFieldType,
      fieldName: `${currentFieldType}_${Date.now()}`,
      fieldValue: currentFieldType === "text" ? "" : false,
      options: currentFieldType === "dropdown" ? ["Option 1", "Option 2", "Option 3"] : undefined,
      multiline: currentFieldType === "text" && finalHeight > 60,
    };
    
    addAnnotation(currentDocument.getId(), annotation);
    
    // Switch to select tool and select the newly created annotation
    useUIStore.getState().setActiveTool("select");
    context.setEditingAnnotation(annotation);
    
    // Dispatch event to notify that annotation was selected
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent("annotationSelected", { 
        detail: { annotationId: annotation.id } 
      }));
    });
    
    // Reset state
    isCreatingField = false;
    fieldStart = null;
    context.setIsSelecting(false);
    context.setSelectionStart(null);
    context.setSelectionEnd(null);
  },
};

