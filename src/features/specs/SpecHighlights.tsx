/**
 * Spec Highlights Component
 * 
 * Renders highlight overlays on PDF pages for extracted specifications.
 */

import { useEffect, useRef } from "react";
import { useSpecExtractionStore } from "@/shared/stores/specExtractionStore";

interface SpecHighlightsProps {
  documentId: string;
  pageNumber: number;
  scale: number;
  pageWidth: number;
  pageHeight: number;
}

export function SpecHighlights({
  documentId,
  pageNumber,
  scale,
  pageWidth,
  pageHeight,
}: SpecHighlightsProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { getSpecHighlights } = useSpecExtractionStore();
  const highlights = getSpecHighlights(documentId);
  
  const pageHighlights = highlights.filter(h => h.page === pageNumber);
  
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || pageHighlights.length === 0) return;
    
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    
    // Set canvas size
    canvas.width = pageWidth * scale;
    canvas.height = pageHeight * scale;
    
    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Draw highlights
    for (const highlight of pageHighlights) {
      const [x0, y0, x1, y1] = highlight.bbox;
      
      // Convert PDF coordinates to canvas coordinates
      // PDF: Y=0 at bottom, increases upward
      // Canvas: Y=0 at top, increases downward
      const canvasX0 = x0 * scale;
      const canvasY0 = (pageHeight - y1) * scale; // Flip Y
      const canvasX1 = x1 * scale;
      const canvasY1 = (pageHeight - y0) * scale; // Flip Y
      
      const width = canvasX1 - canvasX0;
      const height = canvasY1 - canvasY0;
      
      // Draw highlight rectangle
      ctx.fillStyle = highlight.color || "#fbbf24";
      ctx.globalAlpha = 0.3;
      ctx.fillRect(canvasX0, canvasY0, width, height);
      
      // Draw border
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = highlight.color || "#fbbf24";
      ctx.lineWidth = 1;
      ctx.strokeRect(canvasX0, canvasY0, width, height);
    }
  }, [pageHighlights, scale, pageWidth, pageHeight]);
  
  if (pageHighlights.length === 0) return null;
  
  return (
    <canvas
      ref={canvasRef}
      className="absolute top-0 left-0 pointer-events-none"
      style={{
        width: `${pageWidth}px`,
        height: `${pageHeight}px`,
      }}
    />
  );
}
