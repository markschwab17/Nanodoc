/**
 * Coordinate Helper Functions
 * 
 * Standardized coordinate conversion utilities to prevent Y-axis flipping issues.
 * These functions ensure consistent coordinate handling across all tools.
 */

/**
 * Normalize selection coordinates to a standard rectangle format
 * 
 * PDF coordinate system:
 * - Y=0 is at the BOTTOM of the page
 * - Y increases UPWARD (larger Y = higher on page)
 * - (x, y) represents the BOTTOM-LEFT corner
 * - (x + width, y + height) represents the TOP-RIGHT corner
 * 
 * @param selectionStart - Start point of selection (already in PDF coordinates from getPDFCoordinates)
 * @param selectionEnd - End point of selection (already in PDF coordinates from getPDFCoordinates)
 * @returns Normalized rectangle with bottom-left corner and dimensions
 */
export function normalizeSelectionToRect(
  selectionStart: { x: number; y: number },
  selectionEnd: { x: number; y: number }
): { x: number; y: number; width: number; height: number } {
  // Normalize coordinates to handle any drag direction
  const minX = Math.min(selectionStart.x, selectionEnd.x);
  const minY = Math.min(selectionStart.y, selectionEnd.y); // Bottom edge (smaller Y in PDF)
  const maxX = Math.max(selectionStart.x, selectionEnd.x);
  const maxY = Math.max(selectionStart.y, selectionEnd.y); // Top edge (larger Y in PDF)
  
  const width = maxX - minX;
  const height = maxY - minY;
  
  // Return bottom-left corner (minX, minY) with width and height
  // This is the standard PDF coordinate format: (x, y) is bottom-left, extends upward and rightward
  return {
    x: minX,        // Left edge (bottom-left X)
    y: minY,        // Bottom edge (bottom-left Y) - CRITICAL: smallest Y value
    width: width,   // Extends rightward from x
    height: height, // Extends upward from y (top edge is at y + height)
  };
}

/**
 * Validate that a rectangle annotation has correct PDF coordinates
 * 
 * @param annotation - Annotation to validate
 * @param pageHeight - Height of the page in PDF coordinates
 * @returns true if valid, false if coordinates are flipped
 */
export function validatePDFRect(
  annotation: { x: number; y: number; width: number; height: number },
  pageHeight: number
): { isValid: boolean; error?: string } {
  // Check that y (bottom) is less than y + height (top) in PDF coordinates
  // In PDF: smaller Y = lower on page (closer to bottom), larger Y = higher on page (closer to top)
  const bottomY = annotation.y;
  const topY = annotation.y + annotation.height;
  
  if (bottomY >= topY) {
    return {
      isValid: false,
      error: `Invalid PDF coordinates: bottom Y (${bottomY}) >= top Y (${topY}). In PDF coordinates, Y=0 is at bottom and increases upward.`,
    };
  }
  
  // Check that coordinates are within page bounds
  if (bottomY < 0 || topY > pageHeight) {
    return {
      isValid: false,
      error: `Coordinates out of bounds: bottom Y (${bottomY}), top Y (${topY}), page height (${pageHeight})`,
    };
  }
  
  return { isValid: true };
}














