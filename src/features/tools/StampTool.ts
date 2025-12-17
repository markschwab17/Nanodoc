/**
 * Stamp Tool Handler
 * 
 * Handles stamp placement on PDF
 */

import type { ToolHandler, ToolContext } from "./types";
import type { Annotation } from "@/core/pdf/PDFEditor";
import { useStampStore } from "@/shared/stores/stampStore";

let selectedStampId: string | null = null;
let stampPreviewPosition: { x: number; y: number } | null = null;
let previewUpdateCallback: (() => void) | null = null;

export const setSelectedStamp = (stampId: string | null) => {
  selectedStampId = stampId;
};

export const getSelectedStamp = () => selectedStampId;

export const getStampPreviewPosition = () => stampPreviewPosition;

export const setPreviewUpdateCallback = (callback: (() => void) | null) => {
  previewUpdateCallback = callback;
};

export const StampTool: ToolHandler = {
  handleMouseDown: (e: React.MouseEvent, context: ToolContext) => {
    const coords = context.getPDFCoordinates(e);
    if (!coords || !selectedStampId) return;
    
    const { pageNumber, currentDocument, addAnnotation } = context;
    
    if (!currentDocument) return;
    
    // Get stamp from store
    const stamp = useStampStore.getState().getStamp(selectedStampId);
    if (!stamp) return;
    
    // Mark stamp as used
    useStampStore.getState().markAsUsed(selectedStampId);
    
    // Default stamp size
    const defaultWidth = 100;
    const defaultHeight = 60;
    
    // Create stamp annotation
    const annotation: Annotation = {
      id: `stamp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: "stamp",
      pageNumber,
      x: coords.x,
      y: coords.y,
      width: defaultWidth,
      height: defaultHeight,
      stampId: stamp.id,
      stampData: { ...stamp },
      stampType: stamp.type,
      rotation: 0,
    };
    
    addAnnotation(currentDocument.getId(), annotation);
    
    // Clear preview
    stampPreviewPosition = null;
    
    e.preventDefault();
    e.stopPropagation();
  },

  handleMouseMove: (e: React.MouseEvent, context: ToolContext) => {
    if (!selectedStampId) return;
    
    const coords = context.getPDFCoordinates(e);
    if (!coords) return;
    
    stampPreviewPosition = coords;
    // Trigger re-render for preview
    if (previewUpdateCallback) {
      previewUpdateCallback();
    }
  },

  handleMouseUp: async () => {
    // Stamp is placed on mouse down, nothing to do on mouse up
  },
};

