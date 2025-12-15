/**
 * PDF Editor
 * 
 * Provides PDF manipulation operations using mupdf-js:
 * - Page reordering
 * - Page insertion/deletion
 * - Annotation management
 * - Document saving
 */

import type { PDFDocument } from "./PDFDocument";

export interface PageReorderOperation {
  fromIndex: number;
  toIndex: number;
}

export interface Annotation {
  id: string;
  type: "text" | "highlight" | "note" | "callout" | "redact";
  pageNumber: number;
  x: number;
  y: number;
  width?: number;
  height?: number;
  content?: string;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  rotation?: number;
  hasBackground?: boolean;
  backgroundColor?: string;
  // For highlights
  quads?: number[][]; // Array of quads [x0, y0, x1, y1, x2, y2, x3, y3]
  selectedText?: string;
  strokeWidth?: number; // Stroke width for overlay highlights
  opacity?: number; // Opacity for highlights (0.0-1.0)
  highlightMode?: "text" | "overlay"; // Highlight mode: text selection or overlay
  // For overlay highlights: path points
  path?: Array<{ x: number; y: number }>; // Path points for overlay highlights
  // For callouts
  arrowPoint?: { x: number; y: number };
  boxPosition?: { x: number; y: number };
  // For text annotations: if true, box auto-fits to text (typewriter mode)
  autoFit?: boolean;
  // Store the actual mupdf annotation object for updates
  pdfAnnotation?: any;
}

export class PDFEditor {
  private mupdf: any;

  constructor(mupdf: any) {
    this.mupdf = mupdf;
  }

  /**
   * Reorder pages in a document
   */
  async reorderPages(
    document: PDFDocument,
    operations: PageReorderOperation[]
  ): Promise<void> {
    const mupdfDoc = document.getMupdfDocument();
    const pageCount = document.getPageCount();

    // Convert to PDFDocument if needed
    const pdfDoc = mupdfDoc.asPDF();
    if (!pdfDoc) {
      throw new Error("Document is not a PDF");
    }

    // Build new page order
    const pageOrder: number[] = Array.from({ length: pageCount }, (_, i) => i);
    
    // Apply reorder operations
    for (const op of operations) {
      const [moved] = pageOrder.splice(op.fromIndex, 1);
      pageOrder.splice(op.toIndex, 0, moved);
    }

    // Use rearrangePages method
    pdfDoc.rearrangePages(pageOrder);
  }

  /**
   * Insert a blank page at a specific index
   */
  async insertBlankPage(
    document: PDFDocument,
    index: number,
    width: number = 612,
    height: number = 792
  ): Promise<void> {
    const mupdfDoc = document.getMupdfDocument();
    const pdfDoc = mupdfDoc.asPDF();
    if (!pdfDoc) {
      throw new Error("Document is not a PDF");
    }

    // Validate index - should be between 0 and pageCount (inclusive)
    const pageCount = pdfDoc.countPages();
    if (index < 0 || index > pageCount) {
      throw new Error(`Invalid page index: ${index}. Must be between 0 and ${pageCount}`);
    }

    // Create a temporary blank PDF document with one page
    const tempPdfDoc = new this.mupdf.PDFDocument();
    const mediabox: [number, number, number, number] = [0, 0, width, height];
    tempPdfDoc.addPage(mediabox, 0, null, null);
    
    // Use graftPage to copy the blank page from temp document to target at the specified index
    // graftPage(targetIndex, sourceDoc, sourcePageIndex)
    pdfDoc.graftPage(index, tempPdfDoc, 0);
  }

  /**
   * Insert pages from another PDF document
   */
  async insertPagesFromDocument(
    targetDoc: PDFDocument,
    sourceDoc: PDFDocument,
    targetIndex: number,
    sourcePageIndices: number[] = []
  ): Promise<void> {
    const targetMupdf = targetDoc.getMupdfDocument();
    const sourceMupdf = sourceDoc.getMupdfDocument();
    const sourcePageCount = sourceDoc.getPageCount();

    const targetPdf = targetMupdf.asPDF();
    const sourcePdf = sourceMupdf.asPDF();
    
    if (!targetPdf || !sourcePdf) {
      throw new Error("Documents must be PDFs");
    }

    const pagesToInsert =
      sourcePageIndices.length > 0
        ? sourcePageIndices
        : Array.from({ length: sourcePageCount }, (_, i) => i);

    // Use graftPage to copy pages from source to target
    for (let i = 0; i < pagesToInsert.length; i++) {
      const sourcePageIndex = pagesToInsert[i];
      targetPdf.graftPage(targetIndex + i, sourcePdf, sourcePageIndex);
    }
  }

  /**
   * Delete pages from document
   */
  async deletePages(
    document: PDFDocument,
    pageIndices: number[]
  ): Promise<void> {
    const mupdfDoc = document.getMupdfDocument();
    const pdfDoc = mupdfDoc.asPDF();
    
    if (!pdfDoc) {
      throw new Error("Document is not a PDF");
    }
    
    // Sort indices in descending order to delete from end to start
    const sortedIndices = [...pageIndices].sort((a, b) => b - a);
    
    for (const index of sortedIndices) {
      pdfDoc.deletePage(index);
    }
  }

  /**
   * Rotate a page by specified degrees
   * @param document PDF document
   * @param pageNumber Page number (0-indexed)
   * @param degrees Rotation in degrees (90, 180, 270, or -90, -180, -270)
   */
  async rotatePage(
    document: PDFDocument,
    pageNumber: number,
    degrees: number
  ): Promise<void> {
    
    const mupdfDoc = document.getMupdfDocument();
    const pdfDoc = mupdfDoc.asPDF();
    
    if (!pdfDoc) {
      throw new Error("Document is not a PDF");
    }

    const page = pdfDoc.loadPage(pageNumber);
    
    // Get current rotation from page dictionary using getObject()
    let currentRotation = 0;
    try {
      // Use getObject() method from the page prototype
      const pageObj = page.getObject();
      if (pageObj) {
        const rotateValue = pageObj.get("Rotate");
        if (rotateValue !== null && rotateValue !== undefined) {
          // Handle different return types
          if (typeof rotateValue === 'number') {
            currentRotation = rotateValue;
          } else if (rotateValue.valueOf && typeof rotateValue.valueOf === 'function') {
            currentRotation = rotateValue.valueOf();
          } else if (typeof rotateValue === 'object' && 'value' in rotateValue) {
            currentRotation = rotateValue.value;
          }
        }
      }
    } catch (e) {
      console.warn("Could not read current rotation, assuming 0:", e);
      currentRotation = 0;
    }
    
    // Normalize current rotation to 0-360 range
    currentRotation = ((currentRotation % 360) + 360) % 360;
    
    // Calculate new rotation (add relative rotation to current)
    // PDF Rotate field: 0=0°, 90=90° counter-clockwise, 180=180°, 270=270° counter-clockwise
    // The degrees parameter is the amount to ADD to current rotation
    let newRotation = currentRotation + degrees;
    
    // Normalize to 0-360 range (handles values > 360 or < 0)
    newRotation = ((newRotation % 360) + 360) % 360;
    
    // Round to nearest 90 degrees for PDF compatibility (PDF only supports 0, 90, 180, 270)
    let finalRotation = Math.round(newRotation / 90) * 90;
    
    // Ensure finalRotation is in 0-360 range
    finalRotation = ((finalRotation % 360) + 360) % 360;
    
    // Special case: if rounding gives us 360, use 0 instead
    if (finalRotation === 360) {
      finalRotation = 0;
    }
    
    
    try {
      // Get page object dictionary using getObject()
      const pageObj = page.getObject();
      if (!pageObj) {
        throw new Error("Could not get page object");
      }
      
      // Try different methods to set the rotation
      let rotationSet = false;
      
      // Method 1: Use put with newNumber (preferred method)
      if (pageObj.put && pdfDoc.newNumber) {
        try {
          const rotateNumber = pdfDoc.newNumber(finalRotation);
          pageObj.put("Rotate", rotateNumber);
          rotationSet = true;
        } catch (e) {
          console.warn("Method 1 (put with newNumber) failed:", e);
        }
      }
      
      // Method 2: Use put with plain number
      if (!rotationSet && pageObj.put) {
        try {
          pageObj.put("Rotate", finalRotation);
          rotationSet = true;
        } catch (e) {
          console.warn("Method 2 (put with number) failed:", e);
        }
      }
      
      // Method 3: Use set method
      if (!rotationSet && pageObj.set) {
        try {
          pageObj.set("Rotate", finalRotation);
          rotationSet = true;
        } catch (e) {
          console.warn("Method 3 (set) failed:", e);
        }
      }
      
      
      if (!rotationSet) {
        throw new Error("All rotation setting methods failed");
      }
      
      // Verify rotation was set by reading it back
      const verifyRotateValue = pageObj.get("Rotate");
      let verifiedRotation = 0;
      if (verifyRotateValue !== null && verifyRotateValue !== undefined) {
        if (typeof verifyRotateValue === 'number') {
          verifiedRotation = verifyRotateValue;
        } else if (verifyRotateValue.valueOf && typeof verifyRotateValue.valueOf === 'function') {
          verifiedRotation = verifyRotateValue.valueOf();
        } else if (typeof verifyRotateValue === 'object' && 'value' in verifyRotateValue) {
          verifiedRotation = verifyRotateValue.value;
        }
      }
      verifiedRotation = ((verifiedRotation % 360) + 360) % 360;
      
    } catch (e) {
      console.error("Error setting page rotation:", e);
      throw new Error(`Failed to rotate page: ${e}`);
    }
    
    // Update page metadata to reflect new rotation
    // This is important because rotation affects page bounds (width/height swap at 90/270)
    // We need to reload the page to get updated bounds
    pdfDoc.loadPage(pageNumber);
    
    // Rotate annotations on this page to match the page rotation
    await this.rotatePageAnnotations(document, pageNumber, currentRotation, finalRotation);
    
    document.refreshPageMetadata();
    
  }

  /**
   * Rotate annotations on a page when the page is rotated
   * @param document PDF document
   * @param pageNumber Page number (0-indexed)
   * @param oldRotation Previous rotation (0, 90, 180, 270)
   * @param newRotation New rotation (0, 90, 180, 270)
   */
  private async rotatePageAnnotations(
    document: PDFDocument,
    pageNumber: number,
    oldRotation: number,
    newRotation: number
  ): Promise<void> {
    // Calculate relative rotation
    const relativeRotation = ((newRotation - oldRotation + 360) % 360);
    
    
    if (relativeRotation === 0) {
      return; // No rotation change
    }
    
    // Get annotations for this page from the store
    const pdfStore = (await import("@/shared/stores/pdfStore")).usePDFStore.getState();
    const documentId = document.getId();
    const allAnnotations = pdfStore.getAnnotations(documentId);
    const pageAnnotations = allAnnotations.filter(ann => ann.pageNumber === pageNumber);
    
    if (pageAnnotations.length === 0) {
      return; // No annotations to rotate
    }
    
    // Get page dimensions for coordinate transformation
    const pageMetadata = document.getPageMetadata(pageNumber);
    if (!pageMetadata) {
      return;
    }
    
    // Get original mediabox dimensions (before rotation swap)
    // page.getBounds() returns rotated bounds, so we need to reverse the swap based on oldRotation
    // to get the original mediabox dimensions
    let mediaboxWidth: number;
    let mediaboxHeight: number;
    
    if (oldRotation === 90 || oldRotation === 270) {
      // Old rotation was 90° or 270°, so display dimensions are swapped
      // Original mediabox: width = displayHeight, height = displayWidth
      mediaboxWidth = pageMetadata.height;
      mediaboxHeight = pageMetadata.width;
    } else {
      // Old rotation was 0° or 180°, so display dimensions match mediabox
      mediaboxWidth = pageMetadata.width;
      mediaboxHeight = pageMetadata.height;
    }
    
    const pageWidth = mediaboxWidth;
    const pageHeight = mediaboxHeight;
    
    
      // Transform each annotation's coordinates based on rotation
      // Note: PDF coordinates use bottom-left origin, but our annotations use top-left
      // We need to account for this when transforming
      for (const annotation of pageAnnotations) {
        
        let newX = annotation.x;
        let newY = annotation.y;
        let newWidth = annotation.width;
        let newHeight = annotation.height;
        
        // Apply rotation transformation
        // For 90° rotation (counter-clockwise): (x, y) -> (pageHeight - y - height, x), swap width/height
        // For 270° rotation (clockwise): (x, y) -> (y, pageWidth - x - width), swap width/height
        // For 180° rotation: (x, y) -> (pageWidth - x - width, pageHeight - y - height)
        
        const annWidth = newWidth || 0;
        const annHeight = newHeight || 0;
        
        if (relativeRotation === 90) {
          // Rotate 90° counter-clockwise
          // When page rotates 90° CCW, the coordinate system rotates
          // To keep annotation in same visual position relative to page content:
          // 
          // CRITICAL: Annotations are stored with (x, y) as bottom-left corner in PDF coordinates
          // After 90° CCW rotation, we need to find the new bottom-left corner position
          //
          // Original coordinate system: X=0 at left, Y=0 at bottom
          // Rotated coordinate system: X=0 at left (was bottom), Y=0 at bottom (was right)
          //
          // For 90° CCW rotation:
          // - Old bottom-left (x, y) → New bottom-left position
          // - newX = oldY (old vertical position becomes new horizontal)
          // - newY = oldX (old horizontal position becomes new vertical, at bottom)
          //
          // After 90° rotation, the rotated coordinate system has:
          // - X range: 0 to originalHeight (pageHeight = 1735)
          // - Y range: 0 to originalWidth (pageWidth = 2592)
          // So the transformed coordinates are in this rotated coordinate system
          //
          // CRITICAL: The old left edge (x=0) becomes the new bottom edge (y=0 in rotated system)
          // So oldX directly maps to newY (the distance from left becomes distance from bottom)
          // However, we need to account for the fact that the annotation's visual position
          // should remain the same. The old X coordinate (distance from left) should become
          // the new Y coordinate (distance from bottom), but we need to flip it because
          // the coordinate system has rotated.
          //
          // Actually, let's think about this more carefully:
          // - Old left edge (x=0) → New bottom edge (y=0)
          // - Old right edge (x=pageWidth) → New top edge (y=pageWidth in rotated system)
          // So for a point at oldX, the distance from left is oldX
          // After rotation, this becomes the distance from bottom, which is newY
          // Therefore: newY = oldX
          // For 90° CCW rotation, transform coordinates to keep annotation in same visual position
          // CRITICAL: Think about the coordinate system transformation geometrically
          // When page rotates 90° CCW:
          // - Old left edge (x=0) → New bottom edge (y=0 in rotated system)
          // - Old right edge (x=pageWidth) → New top edge (y=pageWidth in rotated system)
          // - Old bottom edge (y=0) → New left edge (x=0 in rotated system)
          // - Old top edge (y=pageHeight) → New right edge (x=pageHeight in rotated system)
          //
          // For a point at (oldX, oldY) to stay in same visual position:
          // - newX = oldY (old vertical position becomes new horizontal)
          // - newY = pageWidth - oldX (old horizontal position, flipped, becomes new vertical)
          const tempX = newX; // Save oldX
          newX = newY; // oldY becomes newX
          newY = pageWidth - tempX; // oldX becomes newY, flipped
          // Swap width and height
          const tempWidth = newWidth;
          newWidth = newHeight;
          newHeight = tempWidth;
          
        } else if (relativeRotation === 270) {
          // Rotate 270° counter-clockwise (90° clockwise)
          // For 90° clockwise (270° CCW), the transformation is:
          // - newX = mediaboxHeight - oldY - annotationHeight
          // - newY = oldX
          const tempX = newX;
          newX = pageHeight - newY - annHeight;
          newY = tempX;
          // Swap width and height
          const tempWidth = newWidth;
          newWidth = newHeight;
          newHeight = tempWidth;
        } else if (relativeRotation === 180) {
          // Rotate 180°
          // Top-left corner: (x, y) -> (pageWidth - x - width, pageHeight - y - height)
          newX = pageWidth - newX - annWidth;
          newY = pageHeight - newY - annHeight;
        }
        
        
        // Update annotation coordinates
      const updates: Partial<typeof annotation> = {
        x: newX,
        y: newY,
      };
      
      if (newWidth !== undefined) updates.width = newWidth;
      if (newHeight !== undefined) updates.height = newHeight;
      
      // Also transform quads for highlights
      // Quads are arrays of [x0, y0, x1, y1, x2, y2, x3, y3] representing a quadrilateral
      if (annotation.quads && annotation.quads.length > 0) {
        const transformedQuads = annotation.quads.map(quad => {
          if (quad.length < 8) return quad; // Invalid quad
          
          if (relativeRotation === 90) {
            // Rotate 90° counter-clockwise: (x, y) -> (pageHeight - y, x)
            return [
              pageHeight - quad[1], quad[0], // x0, y0
              pageHeight - quad[3], quad[2], // x1, y1
              pageHeight - quad[5], quad[4], // x2, y2
              pageHeight - quad[7], quad[6], // x3, y3
            ];
          } else if (relativeRotation === 270) {
            // Rotate 270° counter-clockwise (90° clockwise): (x, y) -> (y, pageWidth - x)
            return [
              quad[1], pageWidth - quad[0], // x0, y0
              quad[3], pageWidth - quad[2], // x1, y1
              quad[5], pageWidth - quad[4], // x2, y2
              quad[7], pageWidth - quad[6], // x3, y3
            ];
          } else if (relativeRotation === 180) {
            // Rotate 180°: (x, y) -> (pageWidth - x, pageHeight - y)
            return [
              pageWidth - quad[0], pageHeight - quad[1], // x0, y0
              pageWidth - quad[2], pageHeight - quad[3], // x1, y1
              pageWidth - quad[4], pageHeight - quad[5], // x2, y2
              pageWidth - quad[6], pageHeight - quad[7], // x3, y3
            ];
          }
          return quad;
        });
        updates.quads = transformedQuads;
      }
      
      // Transform callout arrow and box positions
      if (annotation.arrowPoint) {
        if (relativeRotation === 90) {
          updates.arrowPoint = {
            x: pageHeight - annotation.arrowPoint.y,
            y: annotation.arrowPoint.x,
          };
        } else if (relativeRotation === 270) {
          updates.arrowPoint = {
            x: annotation.arrowPoint.y,
            y: pageWidth - annotation.arrowPoint.x,
          };
        } else if (relativeRotation === 180) {
          updates.arrowPoint = {
            x: pageWidth - annotation.arrowPoint.x,
            y: pageHeight - annotation.arrowPoint.y,
          };
        }
      }
      
      if (annotation.boxPosition) {
        if (relativeRotation === 90) {
          updates.boxPosition = {
            x: pageHeight - annotation.boxPosition.y,
            y: annotation.boxPosition.x,
          };
        } else if (relativeRotation === 270) {
          updates.boxPosition = {
            x: annotation.boxPosition.y,
            y: pageWidth - annotation.boxPosition.x,
          };
        } else if (relativeRotation === 180) {
          updates.boxPosition = {
            x: pageWidth - annotation.boxPosition.x,
            y: pageHeight - annotation.boxPosition.y,
          };
        }
      }
      
      // Update annotation in store
      pdfStore.updateAnnotation(documentId, annotation.id, updates);
    }
  }

  /**
   * Resize a page to new dimensions
   * @param document PDF document
   * @param pageNumber Page number (0-indexed)
   * @param width New width in points
   * @param height New height in points
   */
  async resizePage(
    document: PDFDocument,
    pageNumber: number,
    width: number,
    height: number
  ): Promise<void> {
    const mupdfDoc = document.getMupdfDocument();
    const pdfDoc = mupdfDoc.asPDF();
    
    if (!pdfDoc) {
      throw new Error("Document is not a PDF");
    }

    const page = pdfDoc.loadPage(pageNumber);
    
    // Get the page object to modify MediaBox
    const pageObj = page.getObject();
    if (!pageObj) {
      throw new Error("Could not get page object");
    }
    
    // Get current bounds to preserve origin
    const currentBounds = page.getBounds(); // [x0, y0, x1, y1]
    const x0 = currentBounds[0];
    const y0 = currentBounds[1];
    
    // Create new MediaBox array with new dimensions
    // MediaBox format: [x0, y0, x1, y1]
    const newMediaBox = [x0, y0, x0 + width, y0 + height];
    
    // Try different methods to set MediaBox
    let success = false;
    
    // Method 1: Try put with plain array
    try {
      pageObj.put("MediaBox", newMediaBox);
      success = true;
    } catch (e) {
      console.warn("Method 1 (put with array) failed:", e);
    }
    
    // Method 2: Try using set if put failed
    if (!success && pageObj.set) {
      try {
        pageObj.set("MediaBox", newMediaBox);
        success = true;
      } catch (e) {
        console.warn("Method 2 (set with array) failed:", e);
      }
    }
    
    if (!success) {
      throw new Error("Failed to set MediaBox - all methods failed");
    }
    
    // Update page metadata
    document.refreshPageMetadata();
  }

  /**
   * Resize all pages in a document to the same dimensions
   */
  async resizeAllPages(
    document: PDFDocument,
    width: number,
    height: number
  ): Promise<void> {
    const pageCount = document.getPageCount();
    
    // Resize each page
    for (let i = 0; i < pageCount; i++) {
      await this.resizePage(document, i, width, height);
    }
    
    // Final metadata refresh
    document.refreshPageMetadata();
  }

  /**
   * Add text annotation to a page
   */
  async addTextAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    const mupdfDoc = document.getMupdfDocument();
    const pdfDoc = mupdfDoc.asPDF();
    
    if (!pdfDoc) {
      throw new Error("Document is not a PDF");
    }

    const page = pdfDoc.loadPage(annotation.pageNumber);
    
    // Create text annotation
    const rect: [number, number, number, number] = [
      annotation.x,
      annotation.y,
      annotation.x + (annotation.width || 100),
      annotation.y + (annotation.height || 50),
    ];
    
    const annot = page.createAnnotation("FreeText");
    annot.setRect(rect);
    annot.setContents(annotation.content || "");
    
    if (annotation.color) {
      // Convert hex color to RGB array [0-1 range]
      const hex = annotation.color.replace("#", "");
      const r = parseInt(hex.substring(0, 2), 16) / 255;
      const g = parseInt(hex.substring(2, 4), 16) / 255;
      const b = parseInt(hex.substring(4, 6), 16) / 255;
      annot.setColor([r, g, b]);
    }
    
    annot.update();
  }

  /**
   * Add highlight annotation to a page
   */
  async addHighlightAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    const mupdfDoc = document.getMupdfDocument();
    const pdfDoc = mupdfDoc.asPDF();
    
    if (!pdfDoc) {
      throw new Error("Document is not a PDF");
    }

    const page = pdfDoc.loadPage(annotation.pageNumber);
    
    // For overlay highlights, quads might be empty (path is used instead for rendering)
    // For text highlights, quads are required
    if (annotation.highlightMode === "text" && (!annotation.quads || annotation.quads.length === 0)) {
      throw new Error("Text highlight annotation requires quads");
    }
    
    // For overlay highlights, generate quads from path if quads are empty
    if (annotation.highlightMode === "overlay" && (!annotation.quads || annotation.quads.length === 0)) {
      if (annotation.path && annotation.path.length >= 2) {
        // Generate quads from path - create a quad for each path segment
        const quads: number[][] = [];
        const strokeWidth = annotation.strokeWidth || 15;
        const halfWidth = strokeWidth / 2;
        
        for (let i = 0; i < annotation.path.length - 1; i++) {
          const p1 = annotation.path[i];
          const p2 = annotation.path[i + 1];
          
          const dx = p2.x - p1.x;
          const dy = p2.y - p1.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          
          if (len === 0) continue;
          
          const perpX = -dy / len;
          const perpY = dx / len;
          
          quads.push([
            p1.x + perpX * halfWidth, p1.y + perpY * halfWidth,
            p1.x - perpX * halfWidth, p1.y - perpY * halfWidth,
            p2.x - perpX * halfWidth, p2.y - perpY * halfWidth,
            p2.x + perpX * halfWidth, p2.y + perpY * halfWidth
          ]);
        }
        
        annotation.quads = quads;
      } else {
        // If no path and no quads, create a minimal quad from bounds
        const x = annotation.x;
        const y = annotation.y;
        const w = annotation.width || 10;
        const h = annotation.height || 10;
        annotation.quads = [[x, y, x + w, y, x + w, y + h, x, y + h]];
      }
    }
    
    // Ensure we have quads before creating annotation
    if (!annotation.quads || annotation.quads.length === 0) {
      throw new Error("Highlight annotation requires quads or path");
    }
    
    // Create highlight annotation
    const annot = page.createAnnotation("Highlight");
    
    // Set quads (array of Quad objects, each Quad is [x0, y0, x1, y1, x2, y2, x3, y3])
    if (annotation.quads && annotation.quads.length > 0) {
      // Convert number[][] to Quad[] format expected by mupdf
      const quadList = annotation.quads.map((quad) => {
        if (Array.isArray(quad) && quad.length >= 8) {
          return quad as any; // Quad type
        }
        return [0, 0, 0, 0, 0, 0, 0, 0];
      });
      annot.setQuadPoints(quadList);
    }
    
    // Set highlight color (default yellow)
    const color = annotation.color || "#FFFF00";
    const hex = color.replace("#", "");
    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;
    annot.setColor([r, g, b]);
    
    // Set opacity if provided (PDF annotations support opacity via CA field)
    if (annotation.opacity !== undefined) {
      try {
        // Try to set opacity using setOpacity or CA field
        if (annot.setOpacity) {
          annot.setOpacity(annotation.opacity);
        } else {
          // Fallback: set CA (constant alpha) field directly
          const annotObj = annot.getObject();
          if (annotObj) {
            annotObj.put("CA", annotation.opacity);
          }
        }
      } catch (error) {
        console.warn("Could not set highlight opacity:", error);
      }
    }
    
    // Store stroke width in annotation metadata if provided (for overlay highlights)
    // Note: PDF Highlight annotations don't directly support stroke width,
    // but we store it in the annotation for rendering purposes
    if (annotation.strokeWidth !== undefined) {
      try {
        const annotObj = annot.getObject();
        if (annotObj) {
          // Store as custom metadata
          annotObj.put("StrokeWidth", annotation.strokeWidth);
        }
      } catch (error) {
        console.warn("Could not store stroke width:", error);
      }
    }
    
    if (annotation.content) {
      annot.setContents(annotation.content);
    }
    
    annot.update();
  }

  /**
   * Add callout annotation to a page
   * Callouts are implemented as FreeText annotations with custom styling
   */
  async addCalloutAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    const mupdfDoc = document.getMupdfDocument();
    const pdfDoc = mupdfDoc.asPDF();
    
    if (!pdfDoc) {
      throw new Error("Document is not a PDF");
    }

    const page = pdfDoc.loadPage(annotation.pageNumber);
    
    // Create FreeText annotation for callout
    const boxPos = annotation.boxPosition || { x: annotation.x + 50, y: annotation.y - 50 };
    const rect: [number, number, number, number] = [
      boxPos.x,
      boxPos.y,
      boxPos.x + (annotation.width || 150),
      boxPos.y + (annotation.height || 80),
    ];
    
    const annot = page.createAnnotation("FreeText");
    annot.setRect(rect);
    annot.setContents(annotation.content || "");
    
    if (annotation.color) {
      const hex = annotation.color.replace("#", "");
      const r = parseInt(hex.substring(0, 2), 16) / 255;
      const g = parseInt(hex.substring(2, 4), 16) / 255;
      const b = parseInt(hex.substring(4, 6), 16) / 255;
      annot.setColor([r, g, b]);
    }
    
    annot.update();
  }

  /**
   * Add redaction annotation to a page
   * Redactions permanently remove content from the PDF
   */
  async addRedactionAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    const mupdfDoc = document.getMupdfDocument();
    const pdfDoc = mupdfDoc.asPDF();
    
    if (!pdfDoc) {
      throw new Error("Document is not a PDF");
    }

    let page = pdfDoc.loadPage(annotation.pageNumber);
    
    // Get page dimensions FIRST (needed for clamping)
    const pageBounds = page.getBounds();
    const pageWidth = pageBounds[2] - pageBounds[0];
    const pageHeight = pageBounds[3] - pageBounds[1];
    
    // Create redaction annotation
    // 
    // CRITICAL COORDINATE SYSTEM REFERENCE (DO NOT MODIFY WITHOUT UNDERSTANDING):
    // ============================================================================
    // PDF coordinate system: Y=0 at BOTTOM, Y increases UPWARD
    // - Smaller Y values = lower on page (closer to bottom)
    // - Larger Y values = higher on page (closer to top)
    // 
    // Rect format: [x0, y0, x1, y1] where:
    // - (x0, y0) is BOTTOM-LEFT corner (smallest X, smallest Y)
    // - (x1, y1) is TOP-RIGHT corner (largest X, largest Y)
    // 
    // annotation format:
    // - annotation.x, annotation.y = BOTTOM-LEFT corner (smallest Y)
    // - annotation.x + width, annotation.y + height = TOP-RIGHT corner (largest Y)
    // 
    // VALIDATION: y0 (bottom) MUST be < y1 (top) in PDF coordinates
    // If y0 >= y1, the coordinates are flipped and will cause incorrect redaction placement
    // ============================================================================
    
    // CRITICAL: Clamp rect to page bounds - rects outside page bounds are ignored by mupdf!
    const x0 = Math.max(0, Math.min(annotation.x, pageWidth));
    const y0 = Math.max(0, Math.min(annotation.y, pageHeight)); // Bottom edge (smaller Y)
    const x1 = Math.max(0, Math.min(annotation.x + (annotation.width || 100), pageWidth));
    const y1 = Math.max(0, Math.min(annotation.y + (annotation.height || 50), pageHeight)); // Top edge (larger Y)
    
    // Safety check: ensure y0 < y1 (bottom < top in PDF coordinates)
    let finalY0 = y0;
    let finalY1 = y1;
    if (y0 >= y1) {
      console.error(`Invalid redaction coordinates: y0 (${y0}) >= y1 (${y1}). Annotation:`, annotation);
      // Fix by swapping if needed
      finalY0 = Math.min(y0, y1);
      finalY1 = Math.max(y0, y1);
    }
    
    const rect: [number, number, number, number] = [x0, finalY0, x1, finalY1];
    
    const annot = page.createAnnotation("Redact");
    annot.setRect(rect);
    
    // Note: Redaction annotations don't support setInteriorColor - that's applied during applyRedactions
    // We can only set the appearance before redaction is applied
    
    annot.update();
    
    // CRITICAL: Apply the redaction to actually remove content
    // This processes ALL redaction annotations on the page and permanently removes the underlying content
    let success = false;
    
    try {
      if (typeof page.applyRedactions === 'function') {
        // Try different parameter combinations based on mupdf version
        
        // Method 1: Try with 4 parameters (newest mupdf.js API)
        // applyRedactions(blackBoxes, imageMethod, lineArtMethod, textMethod)
        // imageMethod: 1 = remove entire images, 2 = remove pixels
        // lineArtMethod: 1 = remove if covered, 2 = remove if touched
        // textMethod: 0 = remove text
        try {
          page.applyRedactions(false, 2, 2, 0);  // White fill, remove image pixels, remove line art if touched, remove text
          success = true;
        } catch (e1) {
          // Method 2: Try with 2 parameters (older API)
          // applyRedactions(blackBoxes, imageMethod)
          try {
            page.applyRedactions(false, 0);  // White fill, remove images
            success = true;
          } catch (e2) {
            // Method 3: Try with boolean only
            try {
              page.applyRedactions(false);  // White fill
              success = true;
            } catch (e3) {
              // Method 4: Try with no parameters (oldest API)
              try {
                page.applyRedactions();
                success = true;
              } catch (e4) {
                console.error("All applyRedactions methods failed:", {
                  method1: e1,
                  method2: e2,
                  method3: e3,
                  method4: e4
                });
                throw new Error("Could not apply redactions with any known method");
              }
            }
          }
        }
        
        if (success) {
          // CRITICAL: Reload the page to get fresh content with redactions applied
          // This clears mupdf's internal page cache and forces it to re-parse the content stream
          page = pdfDoc.loadPage(annotation.pageNumber);
          
          // Verify redaction was applied by checking if Redact annotations remain
          // After applyRedactions(), the Redact annotations should be removed
          const remainingAnnots = page.getAnnotations();
          const redactAnnotsAfter = remainingAnnots.filter((a: any) => {
            try {
              return a.getType() === "Redact";
            } catch {
              return false;
            }
          });
          const hasRedactAnnots = redactAnnotsAfter.length > 0;
          
          if (hasRedactAnnots) {
            console.warn("Warning: Redact annotations still present after applyRedactions()");
            console.warn("This may indicate the content was not fully removed");
          }
          
          // Force document metadata refresh to update cached page info
          document.refreshPageMetadata();
        }
      } else {
        throw new Error("applyRedactions method not available in this mupdf version");
      }
    } catch (err) {
      console.error("Error applying redactions:", err);
      console.error("Rect that failed:", rect);
      console.error("Page number:", annotation.pageNumber);
      throw err; // Re-throw so user knows it failed
    }
  }

  /**
   * Load annotations from a PDF page
   */
  async loadAnnotationsFromPage(
    document: PDFDocument,
    pageNumber: number
  ): Promise<Annotation[]> {
    try {
      const mupdfDoc = document.getMupdfDocument();
      const pdfDoc = mupdfDoc.asPDF();
      
      if (!pdfDoc) {
        return [];
      }

      const page = pdfDoc.loadPage(pageNumber);
      const pdfAnnotations = page.getAnnotations();
      
      const annotations: Annotation[] = [];
      
      for (const pdfAnnot of pdfAnnotations) {
        try {
          const type = pdfAnnot.getType();
          const rect = pdfAnnot.getRect();
          const contents = pdfAnnot.getContents() || "";
          
          // Generate a stable ID from annotation properties
          const id = `pdf_${pageNumber}_${rect[0]}_${rect[1]}_${Math.random().toString(36).substr(2, 9)}`;
          
          if (type === "Highlight") {
            // Get quad points for highlight
            let quadPoints: number[][] = [];
            try {
              const quads = pdfAnnot.getQuadPoints();
              if (quads && Array.isArray(quads)) {
                quadPoints = quads.map((q: any) => {
                  if (Array.isArray(q) && q.length >= 8) {
                    return q;
                  }
                  return [0, 0, 0, 0, 0, 0, 0, 0];
                });
              }
            } catch (err) {
              console.error("Error getting quad points:", err);
            }
            
            annotations.push({
              id,
              type: "highlight",
              pageNumber,
              x: rect[0],
              y: rect[1],
              width: rect[2] - rect[0],
              height: rect[3] - rect[1],
              quads: quadPoints,
              content: contents,
              color: "#FFFF00",
            });
          } else if (type === "Redact") {
            // Load redaction annotation
            annotations.push({
              id,
              type: "redact",
              pageNumber,
              x: rect[0],
              y: rect[1],
              width: rect[2] - rect[0],
              height: rect[3] - rect[1],
            });
          } else if (type === "FreeText") {
            // Determine if it's a callout or text annotation
            // For now, treat all FreeText as text annotations
            // Could enhance this by checking custom properties
            annotations.push({
              id,
              type: "text",
              pageNumber,
              x: rect[0],
              y: rect[1],
              width: rect[2] - rect[0],
              height: rect[3] - rect[1],
              content: contents,
              fontSize: 12,
              fontFamily: "Arial",
              color: "#000000",
            });
          }
        } catch (err) {
          console.error("Error processing annotation:", err);
        }
      }
      
      return annotations;
    } catch (error) {
      console.error(`Error loading annotations from page ${pageNumber}:`, error);
      return [];
    }
  }

  /**
   * Update an existing annotation in the PDF
   */
  async updateAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    // For now, delete and recreate
    // TODO: Implement proper update by finding the annotation in PDF
    // This is a simplified approach
    if (annotation.type === "highlight") {
      await this.addHighlightAnnotation(document, annotation);
    } else if (annotation.type === "text") {
      await this.addTextAnnotation(document, annotation);
    } else if (annotation.type === "callout") {
      await this.addCalloutAnnotation(document, annotation);
    }
  }

  /**
   * Update an existing PDF annotation object directly
   */
  async updateAnnotationInPdf(
    _document: PDFDocument, // Not used but kept for API consistency
    pdfAnnotation: any, // The actual mupdf annotation object
    updates: Partial<Annotation>
  ): Promise<void> {
    if (!pdfAnnotation) return;

    if (updates.content !== undefined) {
      pdfAnnotation.setContents(updates.content);
    }
    if (updates.x !== undefined && updates.y !== undefined && updates.width !== undefined && updates.height !== undefined) {
      pdfAnnotation.setRect([updates.x, updates.y, updates.x + updates.width, updates.y + updates.height]);
    }
    if (updates.color !== undefined) {
      const hex = updates.color.replace("#", "");
      const r = parseInt(hex.substring(0, 2), 16) / 255;
      const g = parseInt(hex.substring(2, 4), 16) / 255;
      const b = parseInt(hex.substring(4, 6), 16) / 255;
      pdfAnnotation.setColor([r, g, b]);
    }
    // TODO: Handle other updates like font, bold, italic, underline, quads for highlights
    pdfAnnotation.update();
  }

  /**
   * Delete an annotation from the PDF
   */
  async deleteAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    const mupdfDoc = document.getMupdfDocument();
    const pdfDoc = mupdfDoc.asPDF();
    
    if (!pdfDoc) {
      throw new Error("Document is not a PDF");
    }

    const page = pdfDoc.loadPage(annotation.pageNumber);
    
    // If we have the pdfAnnotation reference, use it directly (most reliable)
    if (annotation.pdfAnnotation) {
      try {
        page.deleteAnnotation(annotation.pdfAnnotation);
        return;
      } catch (error) {
        console.warn("Could not delete annotation using pdfAnnotation reference:", error);
        // Fall through to try matching by properties
      }
    }
    
    // Fallback: Find the annotation by matching properties
    const annotations = page.getAnnotations();
    
    for (let i = 0; i < annotations.length; i++) {
      const annot = annotations[i];
      const annotType = annot.getType();
      
      // Match text annotations
      if (annotation.type === "text" && annotType === "FreeText") {
        const rect = annot.getRect();
        const contents = annot.getContents() || "";
        
        // Match by position and content (or just position if content is empty)
        const matchesPosition = Math.abs(rect[0] - annotation.x) < 1 && 
                                Math.abs(rect[1] - annotation.y) < 1;
        const matchesContent = !annotation.content || contents === annotation.content;
        
        if (matchesPosition && matchesContent) {
          page.deleteAnnotation(annot);
          return;
        }
      }
      
      // Match highlight annotations
      if (annotation.type === "highlight" && annotType === "Highlight") {
        // For highlights, try to match by quads if available
        if (annotation.quads && annotation.quads.length > 0) {
          const annotQuads = annot.getQuadPoints();
          if (annotQuads && annotQuads.length === annotation.quads.length) {
            // Compare quads - if they match, it's the same annotation
            let quadsMatch = true;
            for (let j = 0; j < annotQuads.length; j++) {
              const annotQuad = annotQuads[j];
              const annotationQuad = annotation.quads[j];
              if (annotQuad.length >= 8 && annotationQuad.length >= 8) {
                // Compare all 8 coordinates
                for (let k = 0; k < 8; k++) {
                  if (Math.abs(annotQuad[k] - annotationQuad[k]) > 0.1) {
                    quadsMatch = false;
                    break;
                  }
                }
                if (!quadsMatch) break;
              }
            }
            if (quadsMatch) {
              page.deleteAnnotation(annot);
              return;
            }
          }
        }
        
        // Fallback: try to match by approximate position
        const rect = annot.getRect();
        const matchesPosition = Math.abs(rect[0] - (annotation.x || 0)) < 10 && 
                                Math.abs(rect[1] - (annotation.y || 0)) < 10;
        
        if (matchesPosition) {
          page.deleteAnnotation(annot);
          return;
        }
      }
    }
    
    console.warn("Could not find annotation to delete in PDF - it may have already been deleted");
  }

  /**
   * Sync all annotations from the store to the PDF document.
   * This ensures all annotations are embedded in the PDF before saving.
   */
  async syncAllAnnotations(
    document: PDFDocument,
    annotations: Annotation[]
  ): Promise<void> {
    // Group annotations by page for efficiency
    const annotationsByPage = new Map<number, Annotation[]>();
    for (const annot of annotations) {
      if (!annotationsByPage.has(annot.pageNumber)) {
        annotationsByPage.set(annot.pageNumber, []);
      }
      annotationsByPage.get(annot.pageNumber)!.push(annot);
    }

    // Process each page
    for (const [pageNumber, pageAnnotations] of annotationsByPage) {
      const mupdfDoc = document.getMupdfDocument();
      const pdfDoc = mupdfDoc.asPDF();
      
      if (!pdfDoc) {
        throw new Error("Document is not a PDF");
      }

      // Load the page (we need it for adding annotations)
      pdfDoc.loadPage(pageNumber);
      
      // Process annotations for this page
      // Note: We add all annotations - duplicates will be handled by mupdf
      
      for (const annot of pageAnnotations) {
        try {
          // Skip if annotation already has a PDF annotation object (already synced)
          if (annot.pdfAnnotation) {
            continue;
          }

          // Add annotation based on type
          if (annot.type === "text") {
            await this.addTextAnnotation(document, annot);
          } else if (annot.type === "highlight") {
            await this.addHighlightAnnotation(document, annot);
          } else if (annot.type === "callout") {
            await this.addCalloutAnnotation(document, annot);
          } else if (annot.type === "redact") {
            await this.addRedactionAnnotation(document, annot);
          }
        } catch (error) {
          console.error(`Error syncing annotation ${annot.id}:`, error);
        }
      }
    }
  }

  /**
   * Save document to binary data
   * Optionally sync annotations before saving
   */
  async saveDocument(
    document: PDFDocument,
    annotations?: Annotation[]
  ): Promise<Uint8Array> {
    // Sync annotations if provided
    if (annotations && annotations.length > 0) {
      await this.syncAllAnnotations(document, annotations);
      
      // Apply redactions on all pages that have redaction annotations
      const mupdfDoc = document.getMupdfDocument();
      const pdfDoc = mupdfDoc.asPDF();
      
      if (pdfDoc) {
        // Group redactions by page
        const redactionsByPage = new Map<number, Annotation[]>();
        for (const annot of annotations) {
          if (annot.type === "redact") {
            if (!redactionsByPage.has(annot.pageNumber)) {
              redactionsByPage.set(annot.pageNumber, []);
            }
            redactionsByPage.get(annot.pageNumber)!.push(annot);
          }
        }
        
        // Apply redactions on each page that has them
        for (const pageNumber of redactionsByPage.keys()) {
          try {
            const page = pdfDoc.loadPage(pageNumber);
            if (typeof page.applyRedactions === 'function') {
              try {
                // Try with parameters first (0 = white fill, 0 = remove images)
                page.applyRedactions(0, 0);
              } catch (e) {
                // Fallback to no parameters
                page.applyRedactions();
              }
            }
          } catch (err) {
            console.error(`Error applying redactions on page ${pageNumber}:`, err);
          }
        }
      }
    }

    const mupdfDoc = document.getMupdfDocument();
    const pdfDoc = mupdfDoc.asPDF();
    
    if (!pdfDoc) {
      throw new Error("Document is not a PDF");
    }

    const buffer = pdfDoc.saveToBuffer();
    return buffer.asUint8Array();
  }

  /**
   * Create a new empty PDF document
   */
  createNewDocument(): any {
    return new this.mupdf.PDFDocument();
  }
}

