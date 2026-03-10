/**
 * Signature Field Tool
 *
 * Used in e-sign prepare mode. Sender drags to place signature field
 * regions on the PDF, assigned to a specific recipient.
 * Follows the same pattern as FormTool.
 */

import type { ToolHandler, ToolContext } from "./types";
import type { Annotation } from "@/core/pdf/types";
import { useESignStore } from "@/shared/stores/esignStore";
import { useUIStore } from "@/shared/stores/uiStore";

let isCreatingField = false;
let fieldStart: { x: number; y: number } | null = null;

// Default sizes for different field types
const FIELD_DEFAULTS: Record<string, { minWidth: number; minHeight: number; defaultWidth: number; defaultHeight: number }> = {
  signature: { minWidth: 100, minHeight: 40, defaultWidth: 200, defaultHeight: 60 },
  initials: { minWidth: 40, minHeight: 30, defaultWidth: 80, defaultHeight: 40 },
  date: { minWidth: 80, minHeight: 25, defaultWidth: 150, defaultHeight: 30 },
  name: { minWidth: 80, minHeight: 25, defaultWidth: 200, defaultHeight: 30 },
  text: { minWidth: 60, minHeight: 25, defaultWidth: 200, defaultHeight: 30 },
};

export const SignatureFieldTool: ToolHandler = {
  handleMouseDown: (e: React.MouseEvent, context: ToolContext) => {
    const coords = context.getPDFCoordinates(e);
    if (!coords) return;

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
    if (!isCreatingField || !fieldStart) {
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

    const esign = useESignStore.getState();
    const fieldType = esign.currentFieldType;
    const signerEmail = esign.activeRecipient;
    const defaults = FIELD_DEFAULTS[fieldType] || FIELD_DEFAULTS.signature;

    if (!signerEmail) {
      isCreatingField = false;
      fieldStart = null;
      context.setIsSelecting(false);
      context.setSelectionStart(null);
      context.setSelectionEnd(null);
      return;
    }

    // Calculate dimensions (same coordinate logic as FormTool)
    let width: number;
    let height: number;
    let x: number;
    let y: number;

    if (selectionEnd) {
      width = Math.abs(selectionEnd.x - fieldStart.x);
      const topY = Math.max(fieldStart.y, selectionEnd.y);
      const bottomY = Math.min(fieldStart.y, selectionEnd.y);
      height = topY - bottomY;
      x = Math.min(fieldStart.x, selectionEnd.x);
      y = bottomY; // bottom Y for annotation storage
    } else {
      // Single click — use defaults
      width = defaults.defaultWidth;
      height = defaults.defaultHeight;
      x = fieldStart.x;
      y = fieldStart.y - height;
    }

    // Apply minimums
    width = Math.max(width, defaults.minWidth);
    height = Math.max(height, defaults.minHeight);

    // If too small (just a click), use default size
    if (width < 20 || height < 15) {
      width = defaults.defaultWidth;
      height = defaults.defaultHeight;
      y = fieldStart.y - height;
    }

    const recipient = esign.recipients.find((r) => r.email === signerEmail);
    const label = `${fieldType === "signature" ? "Sign" : fieldType === "initials" ? "Initial" : fieldType.charAt(0).toUpperCase() + fieldType.slice(1)} here`;

    const annotation: Annotation = {
      id: `esign_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: "signatureField",
      pageNumber,
      x,
      y,
      width,
      height,
      signerEmail,
      signatureFieldType: fieldType,
      signatureFieldRequired: true,
      signatureFieldLabel: label,
      signatureFieldStatus: "empty",
      color: recipient?.color || "#5070ff",
    };

    addAnnotation(currentDocument.getId(), annotation);

    // Switch to select tool and select the field
    useUIStore.getState().setActiveTool("select");
    context.setEditingAnnotation(annotation);

    requestAnimationFrame(() => {
      window.dispatchEvent(
        new CustomEvent("annotationSelected", {
          detail: { annotationId: annotation.id },
        })
      );
    });

    // Reset
    isCreatingField = false;
    fieldStart = null;
    context.setIsSelecting(false);
    context.setSelectionStart(null);
    context.setSelectionEnd(null);
  },
};
