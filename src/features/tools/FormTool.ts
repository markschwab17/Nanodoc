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

/** Reset module-level state (call when switching tools). */
export function resetFormToolState() {
  isCreatingField = false;
  fieldStart = null;
}

/** Immediate-click field types (no drag needed). */
const CLICK_FIELD_TYPES = new Set(["checkbox", "radio"]);

/** Get minimum dimensions for drag-created field types. */
function getMinimumSize(fieldType: string): { minW: number; minH: number } {
  switch (fieldType) {
    case "dropdown":
    case "listbox":
      return { minW: 150, minH: 30 };
    case "date":
    case "number":
    case "email":
      return { minW: 120, minH: 30 };
    case "signature":
      return { minW: 150, minH: 50 };
    case "text":
    default:
      return { minW: 100, minH: 30 };
  }
}

/** Build default field value for a given type. */
function getDefaultValue(fieldType: string): string | boolean {
  if (fieldType === "checkbox" || fieldType === "radio") return false;
  return "";
}

/** Build additional properties based on field type. */
function getTypeDefaults(fieldType: string, height: number): Partial<Annotation> {
  const extras: Partial<Annotation> = {};
  switch (fieldType) {
    case "dropdown":
    case "listbox":
      extras.options = ["Option 1", "Option 2", "Option 3"];
      break;
    case "text":
      extras.multiline = height > 60;
      break;
    case "email":
      extras.validationType = "email";
      extras.placeholder = "email@example.com";
      break;
    case "number":
      extras.validationType = "number";
      break;
    case "radio":
      extras.radioGroup = "Radio Group 1";
      break;
  }
  return extras;
}

export const FormTool: ToolHandler = {
  handleMouseDown: (e: React.MouseEvent, context: ToolContext) => {
    const coords = context.getPDFCoordinates(e);
    if (!coords) return;

    const { currentFieldType } = useUIStore.getState();

    // For checkboxes and radio buttons, create immediately (no drag)
    if (CLICK_FIELD_TYPES.has(currentFieldType)) {
      const { pageNumber, currentDocument, addAnnotation } = context;
      if (!currentDocument) return;

      const size = 20;
      const topY = coords.y;
      const bottomY = topY - size;

      const annotation: Annotation = {
        id: `form_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: "formField",
        pageNumber,
        x: coords.x,
        y: bottomY,
        width: size,
        height: size,
        fieldType: currentFieldType,
        fieldName: `${currentFieldType}_${Date.now()}`,
        fieldValue: false,
        ...getTypeDefaults(currentFieldType, size),
      };

      addAnnotation(currentDocument.getId(), annotation);
      useUIStore.getState().setActiveTool("select");
      context.setEditingAnnotation(annotation);

      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent("annotationSelected", {
          detail: { annotationId: annotation.id },
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
      resetFormToolState();
      context.setIsSelecting(false);
      context.setSelectionStart(null);
      context.setSelectionEnd(null);
      return;
    }

    const { pageNumber, currentDocument, addAnnotation } = context;

    if (!currentDocument) {
      resetFormToolState();
      return;
    }

    const { currentFieldType } = useUIStore.getState();

    const width = Math.abs(selectionEnd.x - fieldStart.x);
    const topY = Math.max(fieldStart.y, selectionEnd.y);
    const bottomY = Math.min(fieldStart.y, selectionEnd.y);
    const height = topY - bottomY;
    const x = Math.min(fieldStart.x, selectionEnd.x);
    const y = bottomY;

    const { minW, minH } = getMinimumSize(currentFieldType);
    const finalWidth = Math.max(width, minW);
    const finalHeight = Math.max(height, minH);

    // Check for minimum drag size
    if (finalWidth < 20 || finalHeight < 20) {
      resetFormToolState();
      context.setIsSelecting(false);
      context.setSelectionStart(null);
      context.setSelectionEnd(null);
      return;
    }

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
      fieldValue: getDefaultValue(currentFieldType),
      ...getTypeDefaults(currentFieldType, finalHeight),
    };

    addAnnotation(currentDocument.getId(), annotation);
    useUIStore.getState().setActiveTool("select");
    context.setEditingAnnotation(annotation);

    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent("annotationSelected", {
        detail: { annotationId: annotation.id },
      }));
    });

    resetFormToolState();
    context.setIsSelecting(false);
    context.setSelectionStart(null);
    context.setSelectionEnd(null);
  },
};
