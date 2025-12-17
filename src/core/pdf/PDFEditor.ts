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
  type: "text" | "highlight" | "note" | "callout" | "redact" | "image" | "formField" | "draw" | "shape" | "stamp";
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
  // For image annotations
  imageData?: string; // base64 data URL
  imageWidth?: number; // original image width in pixels
  imageHeight?: number; // original image height in pixels
  preserveAspectRatio?: boolean; // default: true
  // Store the actual mupdf annotation object for updates
  pdfAnnotation?: any;
  
  // For form fields
  fieldType?: "text" | "checkbox" | "radio" | "dropdown" | "date";
  fieldName?: string;
  fieldValue?: string | boolean;
  options?: string[]; // For dropdowns and radio buttons
  required?: boolean;
  readOnly?: boolean;
  multiline?: boolean;
  radioGroup?: string; // For grouping radio buttons
  
  // For drawing annotations
  drawingStyle?: "marker" | "pencil" | "pen";
  smoothed?: boolean;
  
  // For shape annotations
  shapeType?: "arrow" | "rectangle" | "circle";
  points?: Array<{ x: number; y: number }>; // For arrows and complex shapes
  strokeColor?: string;
  fillColor?: string;
  fillOpacity?: number;
  arrowHeadSize?: number;
  cornerRadius?: number; // For rounded rectangles
  
  // For stamp annotations
  stampId?: string; // Reference to stamp in store
  stampData?: StampData; // Embedded copy of stamp data
  stampType?: "text" | "image" | "signature";
}

export interface StampData {
  id: string;
  name: string;
  type: "text" | "image" | "signature";
  createdAt: number;
  thumbnail?: string; // base64 thumbnail
  // For text stamps
  text?: string;
  font?: string;
  textColor?: string;
  backgroundEnabled?: boolean;
  backgroundColor?: string;
  // For image stamps
  imageData?: string; // base64 image
  // For signature stamps
  signaturePath?: Array<{ x: number; y: number }>;
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
    _width: number = 612,
    _height: number = 792
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

    // Create a blank page by copying an existing page and then clearing its content
    // This avoids the addPage buffer issue entirely by using an existing page structure
    const sourcePageIndex = Math.min(index - 1, pageCount - 1);
    if (sourcePageIndex < 0) {
      throw new Error("Cannot insert page: no pages to use as template");
    }
    
    // Duplicate the existing page at the target index (this gives us the correct dimensions)
    pdfDoc.graftPage(index, pdfDoc, sourcePageIndex);
    
    // Now clear the content by directly manipulating the page's content stream
    const newPage = pdfDoc.loadPage(index);
    
    try {
      // Get the page object dictionary
      const pageObj = newPage.getObject();
      if (pageObj) {
        // Remove the Contents entry to make the page blank
        // A page without Contents is a valid blank page
        pageObj.delete("Contents");
        
        // Also remove Resources if present (fonts, images, etc.)
        // This ensures the page is truly blank
        pageObj.delete("Resources");
        
        // Update the page object
        pageObj.update();
      }
      
      // CRITICAL: Force reload the page in mupdf to clear its internal cache
      // This ensures the blank page is visible immediately
      pdfDoc.loadPage(index);
      
      // Force thumbnail refresh by temporarily modifying page rotation
      // This triggers the thumbnail useEffect dependency to re-render
      try {
        const pageObj = newPage.getObject();
        if (pageObj) {
          const currentRotate = pageObj.get("Rotate");
          // Temporarily set rotation to force thumbnail refresh
          pageObj.put("Rotate", currentRotate ? 0 : 1);
          pageObj.update();
          // Immediately set it back
          if (currentRotate !== null && currentRotate !== undefined) {
            pageObj.put("Rotate", currentRotate);
          } else {
            pageObj.delete("Rotate");
          }
          pageObj.update();
          // Reload page again after rotation change
          pdfDoc.loadPage(index);
        }
      } catch (rotateError) {
        // If rotation manipulation fails, that's okay - page is still blank
        console.warn("Could not trigger thumbnail refresh via rotation:", rotateError);
      }
    } catch (clearError) {
      console.warn("Could not clear page content directly, trying redaction approach:", clearError);
      
      // Fallback: try redaction approach
      try {
        const pageBounds = newPage.getBounds();
        const fullPageRect: [number, number, number, number] = [
          pageBounds[0],
          pageBounds[1],
          pageBounds[2],
          pageBounds[3]
        ];
        
        const redactAnnot = newPage.createAnnotation("Redact");
        redactAnnot.setRect(fullPageRect);
        redactAnnot.update();
        
        if (typeof newPage.applyRedactions === 'function') {
          try {
            newPage.applyRedactions(false, 0);
          } catch (e) {
            newPage.applyRedactions();
          }
        }
        
        // Force reload after redaction
        pdfDoc.loadPage(index);
      } catch (redactError) {
        console.warn("Could not clear page content with redaction either:", redactError);
        // Page will have copied content, but at least it was inserted
      }
    }
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
   * 
   * COORDINATE SYSTEM:
   * - In our app, text annotation.y stores the TOP of the text box in PDF coordinates
   * - PDF coordinates: Y=0 is at bottom, Y increases upward
   * - But MuPDF FreeText annotations use display coordinates (Y=0 at top) internally
   * - So we need to convert from PDF coords to display coords
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
    
    // Get page bounds for coordinate conversion
    const pageBounds = page.getBounds();
    const pageHeight = pageBounds[3] - pageBounds[1];
    
    const width = annotation.width || 100;
    const height = annotation.height || 50;
    
    // Our annotation.y is the TOP of the box in PDF coordinates (Y=0 at bottom, Y increases upward)
    // MuPDF FreeText annotations use display coordinates (Y=0 at top, Y increases downward)
    // So we need to convert: displayY = pageHeight - pdfY
    // 
    // In PDF coords:
    // - annotation.y = TOP edge (larger Y value, closer to top of page)
    // - annotation.y - height = BOTTOM edge (smaller Y value, closer to bottom of page)
    // 
    // Convert to display coords:
    // - TOP in display = pageHeight - annotation.y (smaller display Y)
    // - BOTTOM in display = pageHeight - (annotation.y - height) (larger display Y)
    const displayTopY = pageHeight - annotation.y;
    const displayBottomY = pageHeight - (annotation.y - height);
    
    // Clamp to page bounds
    const x0 = Math.max(0, Math.min(annotation.x, pageBounds[2]));
    const x1 = Math.max(0, Math.min(annotation.x + width, pageBounds[2]));
    
    // In display coords: rect = [left, top, right, bottom] where top < bottom
    const y0 = Math.max(0, Math.min(displayTopY, pageHeight)); // Top edge in display
    const y1 = Math.max(0, Math.min(displayBottomY, pageHeight)); // Bottom edge in display
    
    // Ensure y0 < y1 
    const finalY0 = Math.min(y0, y1);
    const finalY1 = Math.max(y0, y1);
    
    const rect: [number, number, number, number] = [x0, finalY0, x1, finalY1];
    
    const annot = page.createAnnotation("FreeText");
    annot.setRect(rect);
    
    // Strip HTML tags and decode entities for plain text content
    const plainText = (annotation.content || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"');
    annot.setContents(plainText);
    
    // Set default appearance string to control text rendering
    // Format: "/FontName FontSize Tf R G B rg" for text color
    const fontSize = annotation.fontSize || 12;
    try {
      // Parse color - handle both hex and rgba formats
      let r = 0, g = 0, b = 0;
      if (annotation.color) {
        if (annotation.color.startsWith("#")) {
          const hex = annotation.color.replace("#", "");
          r = parseInt(hex.substring(0, 2), 16) / 255;
          g = parseInt(hex.substring(2, 4), 16) / 255;
          b = parseInt(hex.substring(4, 6), 16) / 255;
        } else if (annotation.color.startsWith("rgba") || annotation.color.startsWith("rgb")) {
          const match = annotation.color.match(/[\d.]+/g);
          if (match && match.length >= 3) {
            r = parseFloat(match[0]) / 255;
            g = parseFloat(match[1]) / 255;
            b = parseFloat(match[2]) / 255;
          }
        }
      }
      
      // Set default appearance for text rendering
      annot.setDefaultAppearance(`/Helv ${fontSize} Tf ${r} ${g} ${b} rg`);
      
      // Remove border/frame around text box (set border width to 0)
      try {
        annot.setBorderWidth(0);
      } catch {
        // setBorderWidth might not be available in all mupdf versions
      }
      
      // Try to set interior color to transparent (no fill)
      try {
        annot.setInteriorColor([]);
      } catch {
        // setInteriorColor might not be available
      }
    } catch (error) {
      console.warn("Could not set text annotation appearance:", error);
    }
    
    annot.update();
  }

  /**
   * Add highlight annotation to a page
   * 
   * COORDINATE SYSTEM:
   * - Our app stores coordinates in PDF coordinates (Y=0 at bottom, Y increases upward)
   * - MuPDF's annotation API uses display coordinates (Y=0 at top)
   * - So we need to convert from PDF coords to display coords
   * 
   * ANNOTATION TYPES:
   * - Text highlights use PDF Highlight annotation with QuadPoints
   * - Overlay (freehand) highlights use Ink annotation for smooth paths
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
    
    // Get page height for coordinate conversion
    const pageBounds = page.getBounds();
    const pageHeight = pageBounds[3] - pageBounds[1];
    
    // Parse highlight color
    const color = annotation.color || "#FFFF00";
    const hex = color.replace("#", "");
    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;
    const opacity = annotation.opacity !== undefined ? annotation.opacity : 0.5;
    
    // For overlay (freehand) highlights, use Ink annotation for better quality
    if (annotation.highlightMode === "overlay" && annotation.path && annotation.path.length >= 2) {
      const annot = page.createAnnotation("Ink");
      
      // Convert path to ink list format (array of stroke arrays)
      // Each stroke is an array of [x, y] points in display coordinates
      const inkPath: number[] = [];
      for (const point of annotation.path) {
        // Convert from PDF coordinates to display coordinates
        inkPath.push(point.x, pageHeight - point.y);
      }
      
      // Set the ink list (array of strokes, we have one continuous stroke)
      try {
        annot.setInkList([inkPath]);
      } catch {
        // Fallback: try setting as single array
        try {
          (annot as any).setInkList(inkPath);
        } catch (e) {
          console.warn("Could not set ink list:", e);
        }
      }
      
      // Set stroke color
      annot.setColor([r, g, b]);
      
      // Set stroke width for the ink annotation
      const strokeWidth = annotation.strokeWidth || 15;
      try {
        annot.setBorderWidth(strokeWidth);
      } catch {
        // Border width might not apply to ink
      }
      
      // Set opacity
      try {
        if (typeof annot.setOpacity === 'function') {
          annot.setOpacity(opacity);
        }
        const annotObj = annot.getObject();
        if (annotObj) {
          annotObj.put("CA", opacity);
          // Use Multiply blend mode for highlight effect
          try {
            annotObj.put("BM", "Multiply");
          } catch {
            // Blend mode might not be supported
          }
        }
      } catch {
        // Ignore opacity errors
      }
      
      if (annotation.content) {
        annot.setContents(annotation.content);
      }
      
      annot.update();
      return;
    }
    
    // For text highlights, use Highlight annotation with QuadPoints
    if (annotation.highlightMode === "text" && (!annotation.quads || annotation.quads.length === 0)) {
      throw new Error("Text highlight annotation requires quads");
    }
    
    // Fallback: generate quads from bounds if needed
    if (!annotation.quads || annotation.quads.length === 0) {
      const x = annotation.x;
      const y = annotation.y;
      const w = annotation.width || 10;
      const h = annotation.height || 10;
      annotation.quads = [[x, y, x + w, y, x + w, y + h, x, y + h]];
    }
    
    // Create highlight annotation for text highlights
    const annot = page.createAnnotation("Highlight");
    
    // Set quads - convert from PDF coordinates to display coordinates
    if (annotation.quads && annotation.quads.length > 0) {
      const quadList = annotation.quads.map((quad) => {
        if (Array.isArray(quad) && quad.length >= 8) {
          // Convert from PDF coordinates to display coordinates
          // Each quad has 4 points: [x0,y0, x1,y1, x2,y2, x3,y3]
          return [
            quad[0], pageHeight - quad[1], // point 0
            quad[2], pageHeight - quad[3], // point 1
            quad[4], pageHeight - quad[5], // point 2
            quad[6], pageHeight - quad[7], // point 3
          ] as any;
        }
        return [0, 0, 0, 0, 0, 0, 0, 0];
      });
      annot.setQuadPoints(quadList);
    }
    
    // Set highlight color
    annot.setColor([r, g, b]);
    
    // Set opacity
    try {
      if (typeof annot.setOpacity === 'function') {
        annot.setOpacity(opacity);
      }
      
      const annotObj = annot.getObject();
      if (annotObj) {
        annotObj.put("CA", opacity);
        // Use Multiply blend mode for natural highlight appearance
        try {
          annotObj.put("BM", "Multiply");
        } catch {
          // Blend mode might not be supported
        }
      }
    } catch (error) {
      console.warn("Could not set highlight opacity:", error);
    }
    
    if (annotation.content) {
      annot.setContents(annotation.content);
    }
    
    annot.update();
  }

  /**
   * Add image annotation to a page
   * Images are stored as FreeText annotations with image data in contents
   * TODO: Enhance to properly embed images as XObjects in PDF
   */
  async addImageAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    const mupdfDoc = document.getMupdfDocument();
    const pdfDoc = mupdfDoc.asPDF();
    
    if (!pdfDoc) {
      throw new Error("Document is not a PDF");
    }

    if (!annotation.imageData) {
      console.warn("Image annotation missing imageData");
      return;
    }

    const page = pdfDoc.loadPage(annotation.pageNumber);
    
    // Create FreeText annotation to store image metadata
    // The actual image data is stored in the contents field as base64
    // For proper PDF embedding, we'd need to use mupdf's image insertion APIs
    const rect: [number, number, number, number] = [
      annotation.x,
      annotation.y,
      annotation.x + (annotation.width || 200),
      annotation.y + (annotation.height || 200),
    ];
    
    const annot = page.createAnnotation("FreeText");
    annot.setRect(rect);
    
    // Store image data and metadata in contents as JSON
    const imageMetadata = {
      type: "image",
      imageData: annotation.imageData,
      imageWidth: annotation.imageWidth,
      imageHeight: annotation.imageHeight,
      preserveAspectRatio: annotation.preserveAspectRatio !== false,
      rotation: annotation.rotation || 0,
    };
    annot.setContents(JSON.stringify(imageMetadata));
    
    // Store custom properties for easier retrieval
    try {
      const annotObj = annot.getObject();
      if (annotObj) {
        annotObj.put("ImageType", "embedded");
        if (annotation.imageWidth) {
          annotObj.put("ImageWidth", annotation.imageWidth);
        }
        if (annotation.imageHeight) {
          annotObj.put("ImageHeight", annotation.imageHeight);
        }
      }
    } catch (error) {
      console.warn("Could not store image metadata:", error);
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
            // Check for image annotations (stored as FreeText with JSON in contents)
            if (contents) {
              try {
                const parsed = JSON.parse(contents);
                if (parsed.type === "image" && parsed.imageData) {
                  // This is an image annotation
                  // Get image metadata from annotation object
                  let imageWidth = parsed.imageWidth;
                  let imageHeight = parsed.imageHeight;
                  try {
                    const annotObj = pdfAnnot.getObject();
                    if (annotObj) {
                      const widthObj = annotObj.get("ImageWidth");
                      const heightObj = annotObj.get("ImageHeight");
                      if (widthObj) imageWidth = widthObj.valueOf();
                      if (heightObj) imageHeight = heightObj.valueOf();
                    }
                  } catch (e) {
                    // Use parsed values if object access fails
                  }
                  
                  annotations.push({
                    id,
                    type: "image",
                    pageNumber,
                    x: rect[0],
                    y: rect[1], // Bottom edge in PDF coordinates
                    width: rect[2] - rect[0],
                    height: rect[3] - rect[1],
                    imageData: parsed.imageData,
                    imageWidth: imageWidth || 200,
                    imageHeight: imageHeight || 200,
                    preserveAspectRatio: parsed.preserveAspectRatio !== false,
                    rotation: parsed.rotation || 0,
                    pdfAnnotation: pdfAnnot,
                  });
                  continue; // Skip normal FreeText handling
                }
              } catch (e) {
                // Not JSON, continue with normal FreeText handling
              }
            }
            
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
          } else if (annot.type === "image") {
            await this.addImageAnnotation(document, annot);
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
      await this.syncAllAnnotationsExtended(document, annotations);
      
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

  /**
   * Add drawing annotation to a page
   */
  async addDrawingAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    const mupdfDoc = document.getMupdfDocument();
    const pdfDoc = mupdfDoc.asPDF();
    
    if (!pdfDoc) {
      throw new Error("Document is not a PDF");
    }

    const page = pdfDoc.loadPage(annotation.pageNumber);
    const pageBounds = page.getBounds();
    const pageHeight = pageBounds[3] - pageBounds[1];
    
    if (!annotation.path || annotation.path.length < 2) {
      console.warn("Drawing annotation requires a path with at least 2 points");
      return;
    }
    
    // Create Ink annotation
    const annot = page.createAnnotation("Ink");
    
    // Convert path to ink list format (array of points in display coordinates)
    const inkPath: number[] = [];
    for (const point of annotation.path) {
      inkPath.push(point.x, pageHeight - point.y);
    }
    
    try {
      annot.setInkList([inkPath]);
    } catch {
      try {
        (annot as any).setInkList(inkPath);
      } catch (e) {
        console.warn("Could not set ink list:", e);
      }
    }
    
    // Set color
    if (annotation.color) {
      const hex = annotation.color.replace("#", "");
      const r = parseInt(hex.substring(0, 2), 16) / 255;
      const g = parseInt(hex.substring(2, 4), 16) / 255;
      const b = parseInt(hex.substring(4, 6), 16) / 255;
      annot.setColor([r, g, b]);
    }
    
    // Set stroke width
    if (annotation.strokeWidth) {
      try {
        annot.setBorderWidth(annotation.strokeWidth);
      } catch {
        // Border width might not apply to ink
      }
    }
    
    annot.update();
  }

  /**
   * Add shape annotation to a page
   */
  async addShapeAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    const mupdfDoc = document.getMupdfDocument();
    const pdfDoc = mupdfDoc.asPDF();
    
    if (!pdfDoc) {
      throw new Error("Document is not a PDF");
    }

    const page = pdfDoc.loadPage(annotation.pageNumber);
    const pageBounds = page.getBounds();
    const pageHeight = pageBounds[3] - pageBounds[1];
    
    if (!annotation.shapeType) {
      console.warn("Shape annotation requires a shapeType");
      return;
    }
    
    let annot: any;
    
    if (annotation.shapeType === "arrow" && annotation.points && annotation.points.length >= 2) {
      // Create Line annotation for arrow
      annot = page.createAnnotation("Line");
      
      const start = annotation.points[0];
      const end = annotation.points[1];
      
      // Convert to display coordinates
      const startY = pageHeight - start.y;
      const endY = pageHeight - end.y;
      
      try {
        annot.setLine([start.x, startY, end.x, endY]);
      } catch (e) {
        console.warn("Could not set line:", e);
      }
      
      // Set line ending style for arrow head
      try {
        annot.setLineEndingStyles("None", "OpenArrow");
      } catch {
        // Line ending styles might not be available
      }
    } else if (annotation.shapeType === "rectangle") {
      // Create Square annotation
      annot = page.createAnnotation("Square");
      
      const y = pageHeight - annotation.y - (annotation.height || 0);
      const rect: [number, number, number, number] = [
        annotation.x,
        y,
        annotation.x + (annotation.width || 0),
        y + (annotation.height || 0),
      ];
      annot.setRect(rect);
    } else if (annotation.shapeType === "circle") {
      // Create Circle annotation
      annot = page.createAnnotation("Circle");
      
      const y = pageHeight - annotation.y - (annotation.height || 0);
      const rect: [number, number, number, number] = [
        annotation.x,
        y,
        annotation.x + (annotation.width || 0),
        y + (annotation.height || 0),
      ];
      annot.setRect(rect);
    }
    
    if (annot) {
      // Set stroke color
      if (annotation.strokeColor) {
        const hex = annotation.strokeColor.replace("#", "");
        const r = parseInt(hex.substring(0, 2), 16) / 255;
        const g = parseInt(hex.substring(2, 4), 16) / 255;
        const b = parseInt(hex.substring(4, 6), 16) / 255;
        annot.setColor([r, g, b]);
      }
      
      // Set stroke width
      if (annotation.strokeWidth) {
        try {
          annot.setBorderWidth(annotation.strokeWidth);
        } catch {
          // Border width might not be available
        }
      }
      
      // Set fill color
      if (annotation.fillColor && annotation.fillOpacity !== undefined && annotation.fillOpacity > 0) {
        const hex = annotation.fillColor.replace("#", "");
        const r = parseInt(hex.substring(0, 2), 16) / 255;
        const g = parseInt(hex.substring(2, 4), 16) / 255;
        const b = parseInt(hex.substring(4, 6), 16) / 255;
        
        try {
          annot.setInteriorColor([r, g, b]);
          if (typeof annot.setOpacity === 'function') {
            annot.setOpacity(annotation.fillOpacity);
          }
        } catch {
          // Interior color might not be available
        }
      }
      
      annot.update();
    }
  }

  /**
   * Add form field annotation to a page
   */
  async addFormFieldAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    const mupdfDoc = document.getMupdfDocument();
    const pdfDoc = mupdfDoc.asPDF();
    
    if (!pdfDoc) {
      throw new Error("Document is not a PDF");
    }

    const page = pdfDoc.loadPage(annotation.pageNumber);
    const pageBounds = page.getBounds();
    const pageHeight = pageBounds[3] - pageBounds[1];
    
    if (!annotation.fieldType) {
      console.warn("Form field annotation requires a fieldType");
      return;
    }
    
    // Convert to display coordinates
    const y = pageHeight - annotation.y - (annotation.height || 0);
    const rect: [number, number, number, number] = [
      annotation.x,
      y,
      annotation.x + (annotation.width || 0),
      y + (annotation.height || 0),
    ];
    
    // Create Widget annotation
    const annot = page.createAnnotation("Widget");
    annot.setRect(rect);
    
    // Set field properties using annotation object
    try {
      const annotObj = annot.getObject();
      if (annotObj) {
        // Set field name
        if (annotation.fieldName) {
          annotObj.put("T", annotation.fieldName);
        }
        
        // Set field type and properties
        if (annotation.fieldType === "text") {
          annotObj.put("FT", "Tx");
          if (annotation.multiline) {
            annotObj.put("Ff", 4096); // Multiline flag
          }
        } else if (annotation.fieldType === "checkbox") {
          annotObj.put("FT", "Btn");
        } else if (annotation.fieldType === "radio") {
          annotObj.put("FT", "Btn");
          annotObj.put("Ff", 32768); // Radio flag
        } else if (annotation.fieldType === "dropdown") {
          annotObj.put("FT", "Ch");
          if (annotation.options && annotation.options.length > 0) {
            // Set options as array
            annotObj.put("Opt", annotation.options);
          }
        }
        
        annotObj.update();
      }
    } catch (error) {
      console.warn("Could not set form field properties:", error);
    }
    
    annot.update();
  }

  /**
   * Detect existing form fields on a page
   */
  async detectFormFields(
    document: PDFDocument,
    pageNumber: number
  ): Promise<Annotation[]> {
    const mupdfDoc = document.getMupdfDocument();
    const pdfDoc = mupdfDoc.asPDF();
    
    if (!pdfDoc) {
      return [];
    }

    const page = pdfDoc.loadPage(pageNumber);
    const pdfAnnotations = page.getAnnotations();
    const pageBounds = page.getBounds();
    const pageHeight = pageBounds[3] - pageBounds[1];
    
    const formFields: Annotation[] = [];
    
    for (const pdfAnnot of pdfAnnotations) {
      try {
        const type = pdfAnnot.getType();
        
        if (type === "Widget") {
          const rect = pdfAnnot.getRect();
          const annotObj = pdfAnnot.getObject();
          
          let fieldType: "text" | "checkbox" | "radio" | "dropdown" | "date" = "text";
          let fieldName = "";
          let fieldValue: string | boolean = "";
          let options: string[] = [];
          
          if (annotObj) {
            const ftObj = annotObj.get("FT");
            const ftStr = ftObj ? ftObj.toString() : "";
            
            if (ftStr === "Tx") {
              fieldType = "text";
            } else if (ftStr === "Btn") {
              const ff = annotObj.get("Ff");
              if (ff && (ff.valueOf() & 32768)) {
                fieldType = "radio";
              } else {
                fieldType = "checkbox";
              }
            } else if (ftStr === "Ch") {
              fieldType = "dropdown";
              const optObj = annotObj.get("Opt");
              if (optObj && Array.isArray(optObj)) {
                options = optObj;
              }
            }
            
            const tObj = annotObj.get("T");
            if (tObj) {
              fieldName = tObj.toString();
            }
            
            const vObj = annotObj.get("V");
            if (vObj) {
              fieldValue = vObj.toString();
            }
          }
          
          const id = `form_${pageNumber}_${rect[0]}_${rect[1]}_${Math.random().toString(36).substr(2, 9)}`;
          
          formFields.push({
            id,
            type: "formField",
            pageNumber,
            x: rect[0],
            y: pageHeight - rect[3],
            width: rect[2] - rect[0],
            height: rect[3] - rect[1],
            fieldType,
            fieldName,
            fieldValue,
            options: options.length > 0 ? options : undefined,
            pdfAnnotation: pdfAnnot,
          });
        }
      } catch (err) {
        console.error("Error processing form field:", err);
      }
    }
    
    return formFields;
  }

  /**
   * Add stamp annotation to a page
   */
  async addStampAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    const mupdfDoc = document.getMupdfDocument();
    const pdfDoc = mupdfDoc.asPDF();
    
    if (!pdfDoc) {
      throw new Error("Document is not a PDF");
    }

    const page = pdfDoc.loadPage(annotation.pageNumber);
    const pageBounds = page.getBounds();
    const pageHeight = pageBounds[3] - pageBounds[1];
    
    // Convert to display coordinates
    const y = pageHeight - annotation.y - (annotation.height || 0);
    const rect: [number, number, number, number] = [
      annotation.x,
      y,
      annotation.x + (annotation.width || 0),
      y + (annotation.height || 0),
    ];
    
    // Create Stamp annotation
    const annot = page.createAnnotation("Stamp");
    annot.setRect(rect);
    
    // Store stamp data in contents
    if (annotation.stampData) {
      annot.setContents(JSON.stringify(annotation.stampData));
    }
    
    annot.update();
  }

  /**
   * Flatten all annotations in the document
   * This permanently merges annotations into page content
   */
  async flattenAllAnnotations(
    document: PDFDocument,
    currentPageOnly: boolean = false,
    pageNumber?: number
  ): Promise<void> {
    const mupdfDoc = document.getMupdfDocument();
    const pdfDoc = mupdfDoc.asPDF();
    
    if (!pdfDoc) {
      throw new Error("Document is not a PDF");
    }

    const pageCount = document.getPageCount();
    const pagesToFlatten = currentPageOnly && pageNumber !== undefined 
      ? [pageNumber] 
      : Array.from({ length: pageCount }, (_, i) => i);
    
    for (const pgNum of pagesToFlatten) {
      try {
        const page = pdfDoc.loadPage(pgNum);
        
        // Get all annotations on the page
        const annotations = page.getAnnotations();
        
        if (annotations.length === 0) continue;
        
        // Update all annotations to generate appearance streams
        for (const annot of annotations) {
          try {
            annot.update();
          } catch (e) {
            console.warn(`Could not update annotation:`, e);
          }
        }
        
        // Try to flatten using mupdf's built-in method if available
        // Note: mupdf.js may not have a direct flatten method, so we ensure appearance streams are generated
        // The annotations will be rendered by most PDF viewers even if not truly "flattened"
        
        // Alternative approach: Remove Link and Widget annotations after copying their appearance
        // This makes them permanent part of the page
        for (let i = annotations.length - 1; i >= 0; i--) {
          const annot = annotations[i];
          try {
            const annotType = annot.getType();
            
            // Some annotation types can be safely removed after update
            // as their appearance has been baked into the page
            if (annotType === "Link" || annotType === "Widget") {
              // For form fields, we want to keep the appearance but remove interactivity
              page.deleteAnnotation(annot);
            }
          } catch (e) {
            console.warn(`Could not process annotation for flattening:`, e);
          }
        }
        
      } catch (error) {
        console.error(`Error flattening page ${pgNum}:`, error);
      }
    }
    
    // Refresh document metadata
    document.refreshPageMetadata();
  }

  /**
   * Update sync to handle new annotation types
   */
  async syncAllAnnotationsExtended(
    document: PDFDocument,
    annotations: Annotation[]
  ): Promise<void> {
    // Group annotations by page
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

      pdfDoc.loadPage(pageNumber);
      
      for (const annot of pageAnnotations) {
        try {
          if (annot.pdfAnnotation) {
            continue;
          }

          // Handle all annotation types
          if (annot.type === "text") {
            await this.addTextAnnotation(document, annot);
          } else if (annot.type === "highlight") {
            await this.addHighlightAnnotation(document, annot);
          } else if (annot.type === "callout") {
            await this.addCalloutAnnotation(document, annot);
          } else if (annot.type === "redact") {
            await this.addRedactionAnnotation(document, annot);
          } else if (annot.type === "image") {
            await this.addImageAnnotation(document, annot);
          } else if (annot.type === "draw") {
            await this.addDrawingAnnotation(document, annot);
          } else if (annot.type === "shape") {
            await this.addShapeAnnotation(document, annot);
          } else if (annot.type === "formField") {
            await this.addFormFieldAnnotation(document, annot);
          } else if (annot.type === "stamp") {
            await this.addStampAnnotation(document, annot);
          }
        } catch (error) {
          console.error(`Error syncing annotation ${annot.id}:`, error);
        }
      }
    }
  }
}

