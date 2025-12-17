/**
 * Stamp Tool Handler
 * 
 * Handles stamp placement on PDF
 */

import type { ToolHandler, ToolContext } from "./types";
import type { Annotation } from "@/core/pdf/PDFEditor";
import { useStampStore } from "@/shared/stores/stampStore";
import { useUIStore } from "@/shared/stores/uiStore";

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
  handleMouseDown: async (e: React.MouseEvent, context: ToolContext) => {
    const coords = context.getPDFCoordinates(e);
    if (!coords || !selectedStampId) return;
    
    const { pageNumber, currentDocument, addAnnotation } = context;
    
    if (!currentDocument) return;
    
    // Get stamp from store
    const stamp = useStampStore.getState().getStamp(selectedStampId);
    if (!stamp) return;
    
    // Mark stamp as used
    useStampStore.getState().markAsUsed(selectedStampId);
    
    // Calculate stamp size based on content
    let stampWidth = 100;
    let stampHeight = 60;
    
    // Use thumbnail dimensions if available (matches preview)
    // For text stamps without thumbnails, calculate from text data
    if (stamp.thumbnail) {
      // Calculate from thumbnail aspect ratio (same logic as preview)
      const img = new Image();
      img.src = stamp.thumbnail;
      
      // Wait for image to load to get dimensions
      await new Promise<void>((resolve) => {
        if (img.complete) {
          resolve();
        } else {
          img.onload = () => resolve();
          img.onerror = () => resolve();
        }
      });
      
      if (img.width && img.height) {
        // Thumbnail is generated at scale 6, so convert to PDF points
        // The thumbnail dimensions represent the actual stamp size at high resolution
        // Convert from thumbnail pixels to PDF points: divide by scale (6)
        const scale = 6; // Thumbnail generation scale
        const thumbnailWidthInPoints = img.width / scale;
        const thumbnailHeightInPoints = img.height / scale;
        
        // Use the actual thumbnail dimensions (scaled down) to match exactly what's rendered
        stampWidth = thumbnailWidthInPoints;
        stampHeight = thumbnailHeightInPoints;
        
        // Apply size multiplier
        const sizeMultiplier = useStampStore.getState().stampSizeMultiplier;
        stampWidth *= sizeMultiplier;
        stampHeight *= sizeMultiplier;
        
        // Ensure minimum size
        if (stampWidth < 50) stampWidth = 50;
        if (stampHeight < 30) stampHeight = 30;
      }
    } else if (stamp.type === "text" && stamp.text) {
      // Calculate size for text stamps based on content (fallback if no thumbnail)
      const lines = stamp.text.split('\n');
      const baseFontSize = 12; // Base font size in PDF points
      const lineHeight = baseFontSize * 1.2;
      
      const borderOffset = stamp.borderOffset || 8;
      const borderThickness = stamp.borderEnabled ? (stamp.borderThickness || 2) : 0;
      const contentPadding = borderOffset;
      
      const canvas = window.document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.font = `${baseFontSize}px ${stamp.font || "Arial"}`;
        let maxTextWidth = 0;
        lines.forEach((line) => {
          const metrics = ctx.measureText(line);
          if (metrics.width > maxTextWidth) {
            maxTextWidth = metrics.width;
          }
        });
        
        const textBlockHeight = lines.length * lineHeight;
        const contentWidth = maxTextWidth + contentPadding * 2;
        const contentHeight = textBlockHeight + contentPadding * 2;
        
        const totalWidth = contentWidth + borderThickness;
        const totalHeight = contentHeight + borderThickness;
        
        stampWidth = totalWidth;
        stampHeight = totalHeight;
        
        // Apply size multiplier
        const sizeMultiplier = useStampStore.getState().stampSizeMultiplier;
        stampWidth *= sizeMultiplier;
        stampHeight *= sizeMultiplier;
        
        if (stampWidth < 50) stampWidth = 50;
        if (stampHeight < 30) stampHeight = 30;
      }
    } else if (stamp.thumbnail) {
      // For image/signature stamps, calculate size from thumbnail
      const img = new Image();
      img.src = stamp.thumbnail;
      
      // Wait for image to load to get dimensions
      await new Promise<void>((resolve) => {
        if (img.complete) {
          resolve();
        } else {
          img.onload = () => resolve();
          img.onerror = () => resolve(); // Resolve anyway if image fails to load
        }
      });
      
      if (img.width && img.height) {
        // Calculate aspect ratio
        const aspectRatio = img.width / img.height;
        
        // Use thumbnail aspect ratio with reasonable base size
        const baseWidth = 150;
        stampWidth = baseWidth;
        stampHeight = baseWidth / aspectRatio;
        
        // If the calculated height is too large, scale down based on height instead
        if (stampHeight > 200) {
          const baseHeight = 200;
          stampHeight = baseHeight;
          stampWidth = baseHeight * aspectRatio;
        }
        
        // Ensure minimum size
        if (stampWidth < 50) stampWidth = 50;
        if (stampHeight < 30) stampHeight = 30;
      }
    }
    
    // Create stamp annotation
    const annotation: Annotation = {
      id: `stamp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: "stamp",
      pageNumber,
      x: coords.x,
      y: coords.y,
      width: stampWidth,
      height: stampHeight,
      stampId: stamp.id,
      stampData: { ...stamp },
      stampType: stamp.type,
      rotation: 0,
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

