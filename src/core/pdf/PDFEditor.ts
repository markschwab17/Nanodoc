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
  locked?: boolean; // Lock position and size
  
  // For drawing annotations
  drawingStyle?: "marker" | "pencil" | "pen";
  strokeOpacity?: number; // Opacity for drawing strokes (0-1)
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
  backgroundOpacity?: number; // 0-100
  borderEnabled?: boolean;
  borderStyle?: "rounded" | "square";
  borderThickness?: number;
  borderColor?: string;
  borderOffset?: number; // Distance from text in pixels
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
    
    // Store plain text in PDF contents (for PDF viewer compatibility)
    // But also store HTML in a custom field so we can restore it
    const plainText = (annotation.content || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"');
    annot.setContents(plainText);
    
    // Mark this as a custom annotation and store HTML content separately
    try {
      const annotObj = annot.getObject();
      if (annotObj) {
        annotObj.put("CustomAnnotation", this.mupdf.newString("true"));
        // Store HTML content in a custom field
        if (annotation.content) {
          annotObj.put("HTMLContent", this.mupdf.newString(annotation.content));
        }
      }
    } catch (e) {
      // Ignore if we can't set the marker
    }
    
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
      
      // Store the PDF annotation object for future updates
      annotation.pdfAnnotation = annot;
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
      
      // Store the PDF annotation object for future updates
      annotation.pdfAnnotation = annot;
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
    
    // Store the PDF annotation object for future updates
    annotation.pdfAnnotation = annot;
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
    const pageBounds = page.getBounds();
    const pageHeight = pageBounds[3] - pageBounds[1];
    
    // Create FreeText annotation for callout
    const boxPos = annotation.boxPosition || { x: annotation.x + 50, y: annotation.y - 50 };
    
    // Convert to PDF coordinates for storage
    const pdfBoxY = pageHeight - boxPos.y;
    const pdfArrowY = annotation.arrowPoint ? (pageHeight - annotation.arrowPoint.y) : undefined;
    
    // Store callout data in JSON format in contents
    const calloutData = {
      type: "callout",
      content: annotation.content || "",
      boxPosition: { x: boxPos.x, y: pdfBoxY },
      arrowPoint: annotation.arrowPoint ? { x: annotation.arrowPoint.x, y: pdfArrowY! } : undefined,
      width: annotation.width || 150,
      height: annotation.height || 80,
      fontSize: annotation.fontSize || 12,
      fontFamily: annotation.fontFamily || "Arial",
      color: annotation.color || "#000000",
    };
    
    const rect: [number, number, number, number] = [
      boxPos.x,
      pdfBoxY - (annotation.height || 80),
      boxPos.x + (annotation.width || 150),
      pdfBoxY,
    ];
    
    const annot = page.createAnnotation("FreeText");
    annot.setRect(rect);
    annot.setContents(JSON.stringify(calloutData));
    
    if (annotation.color) {
      const hex = annotation.color.replace("#", "");
      const r = parseInt(hex.substring(0, 2), 16) / 255;
      const g = parseInt(hex.substring(2, 4), 16) / 255;
      const b = parseInt(hex.substring(4, 6), 16) / 255;
      annot.setColor([r, g, b]);
    }
    
    annot.update();
    
    // Store the PDF annotation object for future updates
    annotation.pdfAnnotation = annot;
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
          
          // Line annotations don't have a Rect property - skip it
          let rect: number[] | null = null;
          if (type !== "Line") {
            try {
              rect = pdfAnnot.getRect();
            } catch (e) {
              // Some annotation types don't have rect
              console.warn(`Annotation type ${type} has no rect:`, e);
            }
          }
          
          const contents = pdfAnnot.getContents() || "";
          
          // Generate a stable ID from annotation properties
          // For Line annotations, use a different ID generation method
          const id = type === "Line" 
            ? `pdf_${pageNumber}_line_${Math.random().toString(36).substr(2, 9)}`
            : `pdf_${pageNumber}_${rect ? `${rect[0]}_${rect[1]}_` : ''}${Math.random().toString(36).substr(2, 9)}`;
          
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
            
            // Calculate bounding box from quads for proper positioning
            if (!rect) {
              console.warn("Highlight annotation has no rect, skipping");
              continue;
            }
            let minX = rect[0], minY = rect[1], maxX = rect[2], maxY = rect[3];
            if (quadPoints.length > 0) {
              // Find min/max from all quad points
              for (const quad of quadPoints) {
                if (quad.length >= 8) {
                  for (let i = 0; i < 8; i += 2) {
                    minX = Math.min(minX, quad[i]);
                    maxX = Math.max(maxX, quad[i]);
                    minY = Math.min(minY, quad[i + 1]);
                    maxY = Math.max(maxY, quad[i + 1]);
                  }
                }
              }
            }
            
            // Get highlight color if available
            let highlightColor = "#FFFF00";
            try {
              const color = pdfAnnot.getColor();
              if (color && color.length >= 3) {
                const r = Math.round(color[0] * 255);
                const g = Math.round(color[1] * 255);
                const b = Math.round(color[2] * 255);
                highlightColor = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
              }
            } catch (e) {
              // Use default color
            }
            
            // Get opacity if available
            let opacity = 0.5;
            try {
              const opacityObj = pdfAnnot.getOpacity ? pdfAnnot.getOpacity() : null;
              if (opacityObj !== null && opacityObj !== undefined) {
                opacity = typeof opacityObj === 'number' ? opacityObj : opacityObj.valueOf();
              }
            } catch (e) {
              // Use default opacity
            }
            
            annotations.push({
              id,
              type: "highlight",
              pageNumber,
              x: minX,
              y: minY,
              width: maxX - minX,
              height: maxY - minY,
              quads: quadPoints,
              content: contents,
              color: highlightColor,
              opacity,
              highlightMode: "text", // Assume text highlight if it has quads
              pdfAnnotation: pdfAnnot,
            });
          } else if (type === "Redact") {
            // Load redaction annotation
            if (!rect) {
              console.warn("Redact annotation has no rect, skipping");
              continue;
            }
            annotations.push({
              id,
              type: "redact",
              pageNumber,
              x: rect[0],
              y: rect[1],
              width: rect[2] - rect[0],
              height: rect[3] - rect[1],
              pdfAnnotation: pdfAnnot,
            });
          } else if (type === "Widget") {
            // This is a form field - process it directly
            const rect = pdfAnnot.getRect();
            const annotObj = pdfAnnot.getObject();
            const pageBounds = page.getBounds();
            const pageHeight = pageBounds[3] - pageBounds[1];
            
            let fieldType: "text" | "checkbox" | "radio" | "dropdown" | "date" = "text";
            let fieldName = "";
            let fieldValue: string | boolean = "";
            let options: string[] = [];
            let readOnly = false;
            let required = false;
            let multiline = false;
            let radioGroup = "";
            
            if (annotObj) {
              const ftObj = annotObj.get("FT");
              const ftName = ftObj && ftObj.getName ? ftObj.getName() : (ftObj ? ftObj.toString() : "");
              
              if (ftName === "Tx") {
                fieldType = "text";
                const ff = annotObj.get("Ff");
                if (ff && typeof ff.valueOf === "function") {
                  const flags = ff.valueOf();
                  multiline = (flags & 4096) !== 0; // Multiline flag
                  readOnly = (flags & 1) !== 0; // Read-only flag
                  required = (flags & 2) !== 0; // Required flag
                }
              } else if (ftName === "Btn") {
                const ff = annotObj.get("Ff");
                if (ff && typeof ff.valueOf === "function") {
                  const flags = ff.valueOf();
                  if ((flags & 32768) !== 0) {
                    fieldType = "radio";
                  } else {
                    fieldType = "checkbox";
                  }
                  readOnly = (flags & 1) !== 0;
                  required = (flags & 2) !== 0;
                } else {
                  fieldType = "checkbox";
                }
              } else if (ftName === "Ch") {
                fieldType = "dropdown";
                const ff = annotObj.get("Ff");
                if (ff && typeof ff.valueOf === "function") {
                  const flags = ff.valueOf();
                  readOnly = (flags & 1) !== 0;
                  required = (flags & 2) !== 0;
                }
                const optObj = annotObj.get("Opt");
                if (optObj) {
                  if (Array.isArray(optObj)) {
                    options = optObj.map((o: any) => o.toString ? o.toString() : String(o));
                  } else {
                    // Opt might be an array of arrays for export values
                    try {
                      const optArray = optObj;
                      if (optArray && optArray.length) {
                        options = optArray.map((o: any) => {
                          if (Array.isArray(o) && o.length > 0) {
                            return o[0].toString ? o[0].toString() : String(o[0]);
                          }
                          return o.toString ? o.toString() : String(o);
                        });
                      }
                    } catch (e) {
                      console.warn("Error parsing dropdown options:", e);
                    }
                  }
                }
              }
              
              const tObj = annotObj.get("T");
              if (tObj) {
                fieldName = tObj.toString ? tObj.toString() : String(tObj);
              }
              
              const vObj = annotObj.get("V");
              if (vObj) {
                if (fieldType === "checkbox" || fieldType === "radio") {
                  const vName = vObj.getName ? vObj.getName() : vObj.toString();
                  fieldValue = vName === "Yes" || vName === "On";
                } else {
                  fieldValue = vObj.toString ? vObj.toString() : String(vObj);
                }
              }
              
              // Get radio group name
              if (fieldType === "radio" && tObj) {
                radioGroup = tObj.toString ? tObj.toString() : String(tObj);
              }
            }
            
            annotations.push({
              id: `form_${pageNumber}_${rect[0]}_${rect[1]}_${Math.random().toString(36).substr(2, 9)}`,
              type: "formField",
              pageNumber,
              x: rect[0],
              y: pageHeight - rect[3], // Convert to display coordinates
              width: rect[2] - rect[0],
              height: rect[3] - rect[1],
              fieldType,
              fieldName,
              fieldValue,
              options: options.length > 0 ? options : undefined,
              readOnly,
              required,
              multiline,
              radioGroup: radioGroup || undefined,
              pdfAnnotation: pdfAnnot, // Store reference for updates
            });
            continue; // Skip to next annotation
          } else if (type === "FreeText") {
            // First check if this is a stamp annotation stored as FreeText
            const annotObj = pdfAnnot.getObject();
            let isStampAnnotation = false;
            
            try {
              if (annotObj) {
                const stampFlag = annotObj.get("StampAnnotation");
                if (stampFlag && stampFlag.toString() === "true") {
                  isStampAnnotation = true;
                }
              }
            } catch (e) {
              // Ignore errors
            }
            
            // If it's a stamp annotation, load it as stamp
            if (isStampAnnotation && contents) {
              try {
                const parsed = JSON.parse(contents);
                if (parsed.type === "stamp" && parsed.stampData) {
                  const stampData = parsed.stampData as StampData;
                  if (stampData.id && stampData.name && stampData.type) {
                    if (!rect) {
                      console.warn("Stamp annotation has no rect, skipping");
                      continue;
                    }
                    const pageBounds = page.getBounds();
                    const pageHeight = pageBounds[3] - pageBounds[1];
                    
                    annotations.push({
                      id,
                      type: "stamp",
                      pageNumber,
                      x: rect[0],
                      y: pageHeight - rect[3], // Convert to display coordinates
                      width: rect[2] - rect[0],
                      height: rect[3] - rect[1],
                      stampId: stampData.id,
                      stampData,
                      stampType: stampData.type,
                      pdfAnnotation: pdfAnnot,
                    });
                    continue; // Skip normal FreeText handling
                  }
                }
              } catch (e) {
                console.warn("Could not parse stamp data from FreeText:", e);
                // Fall through to check if it's an image or callout
              }
            }
            
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
                  
                  if (!rect) {
                    console.warn("Image annotation has no rect, skipping");
                    continue;
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
                } else if (parsed.type === "callout") {
                  // This is a callout annotation
                  if (!rect) {
                    console.warn("Callout annotation has no rect, skipping");
                    continue;
                  }
                  const pageBounds = page.getBounds();
                  const pageHeight = pageBounds[3] - pageBounds[1];
                  
                  annotations.push({
                    id,
                    type: "callout",
                    pageNumber,
                    x: parsed.boxPosition?.x || rect[0],
                    y: parsed.boxPosition ? (pageHeight - parsed.boxPosition.y) : rect[1],
                    width: parsed.width || (rect[2] - rect[0]),
                    height: parsed.height || (rect[3] - rect[1]),
                    content: parsed.content || contents,
                    arrowPoint: parsed.arrowPoint ? {
                      x: parsed.arrowPoint.x,
                      y: pageHeight - parsed.arrowPoint.y
                    } : undefined,
                    boxPosition: parsed.boxPosition ? {
                      x: parsed.boxPosition.x,
                      y: pageHeight - parsed.boxPosition.y
                    } : undefined,
                    fontSize: parsed.fontSize || 12,
                    fontFamily: parsed.fontFamily || "Arial",
                    color: parsed.color || "#000000",
                    pdfAnnotation: pdfAnnot,
                  });
                  continue; // Skip normal FreeText handling
                }
              } catch (e) {
                // Not JSON, continue with normal FreeText handling
              }
            }
            
            // Only load FreeText as text annotation if it's one of our custom annotations
            // We mark our custom annotations with a "CustomAnnotation" flag
            // Skip loading native PDF FreeText annotations to avoid duplication
            // (annotObj already declared above for stamp check)
            let isCustomAnnotation = false;
            let htmlContent = contents; // Default to plain text contents
            
            // Check if this is a custom annotation by looking for our marker
            try {
              if (annotObj) {
                const customFlag = annotObj.get("CustomAnnotation");
                if (customFlag && customFlag.toString() === "true") {
                  isCustomAnnotation = true;
                  // Try to get HTML content if stored
                  const htmlContentObj = annotObj.get("HTMLContent");
                  if (htmlContentObj) {
                    htmlContent = htmlContentObj.toString();
                  }
                }
              }
            } catch (e) {
              // Ignore errors
            }
            
            // Only load if it's a custom annotation
            // Skip native PDF FreeText annotations to prevent duplication
            if (isCustomAnnotation) {
              if (!rect) {
                console.warn("Custom text annotation has no rect, skipping");
                continue;
              }
              const pageBounds = page.getBounds();
              const pageHeight = pageBounds[3] - pageBounds[1];
              
              annotations.push({
                id,
                type: "text",
                pageNumber,
                x: rect[0],
                y: pageHeight - rect[3], // Convert to display coordinates
                width: rect[2] - rect[0],
                height: rect[3] - rect[1],
                content: htmlContent, // Use HTML content if available, otherwise plain text
                fontSize: 12,
                fontFamily: "Arial",
                color: "#000000",
                pdfAnnotation: pdfAnnot,
              });
            }
            // Otherwise, skip this FreeText annotation - it's a native PDF annotation
          } else if (type === "FreeText") {
            // Check if this is a stamp annotation stored as FreeText
            const annotObj = pdfAnnot.getObject();
            let isStampAnnotation = false;
            
            try {
              if (annotObj) {
                const stampFlag = annotObj.get("StampAnnotation");
                if (stampFlag && stampFlag.toString() === "true") {
                  isStampAnnotation = true;
                }
              }
            } catch (e) {
              // Ignore errors
            }
            
            // If it's a stamp annotation, load it as stamp
            if (isStampAnnotation && contents) {
              try {
                const parsed = JSON.parse(contents);
                if (parsed.type === "stamp" && parsed.stampData) {
                  const stampData = parsed.stampData as StampData;
                  if (stampData.id && stampData.name && stampData.type) {
                    if (!rect) {
                      console.warn("Stamp annotation has no rect, skipping");
                      continue;
                    }
                    const pageBounds = page.getBounds();
                    const pageHeight = pageBounds[3] - pageBounds[1];
                    
                    annotations.push({
                      id,
                      type: "stamp",
                      pageNumber,
                      x: rect[0],
                      y: pageHeight - rect[3], // Convert to display coordinates
                      width: rect[2] - rect[0],
                      height: rect[3] - rect[1],
                      stampId: stampData.id,
                      stampData,
                      stampType: stampData.type,
                      pdfAnnotation: pdfAnnot,
                    });
                    continue; // Skip normal FreeText handling
                  }
                }
              } catch (e) {
                console.warn("Could not parse stamp data from FreeText:", e);
                // Fall through to check if it's a callout or image
              }
            }
            
            // Check for image annotations (stored as FreeText with JSON in contents)
            if (contents) {
              try {
                const parsed = JSON.parse(contents);
                if (parsed.type === "image" && parsed.imageData) {
                  // This is an image annotation - handled above, skip
                  continue;
                } else if (parsed.type === "callout") {
                  // This is a callout annotation - handled above, skip
                  continue;
                }
              } catch (e) {
                // Not JSON, continue with normal FreeText handling
              }
            }
            
            // Only load FreeText as text annotation if it's one of our custom annotations
            // We mark our custom annotations with a "CustomAnnotation" flag
            // Skip loading native PDF FreeText annotations to avoid duplication
            let isCustomAnnotation = false;
            let htmlContent = contents; // Default to plain text contents
            
            // Check if this is a custom annotation by looking for our marker
            try {
              if (annotObj) {
                const customFlag = annotObj.get("CustomAnnotation");
                if (customFlag && customFlag.toString() === "true") {
                  isCustomAnnotation = true;
                  // Try to get HTML content if stored
                  const htmlContentObj = annotObj.get("HTMLContent");
                  if (htmlContentObj) {
                    htmlContent = htmlContentObj.toString();
                  }
                }
              }
            } catch (e) {
              // Ignore errors
            }
            
            // Only load if it's a custom annotation
            // Skip native PDF FreeText annotations to prevent duplication
            if (isCustomAnnotation) {
              if (!rect) {
                console.warn("Custom text annotation has no rect, skipping");
                continue;
              }
              const pageBounds = page.getBounds();
              const pageHeight = pageBounds[3] - pageBounds[1];
              
              annotations.push({
                id,
                type: "text",
                pageNumber,
                x: rect[0],
                y: pageHeight - rect[3], // Convert to display coordinates
                width: rect[2] - rect[0],
                height: rect[3] - rect[1],
                content: htmlContent, // Use HTML content if available, otherwise plain text
                fontSize: 12,
                fontFamily: "Arial",
                color: "#000000",
                pdfAnnotation: pdfAnnot,
              });
            }
            // Otherwise, skip this FreeText annotation - it's a native PDF annotation
          } else if (type === "Line") {
            // Load arrow/shape annotation (Line is used for arrows)
            // Keep points in PDF coordinates (Y=0 at bottom) - pdfToCanvas will convert them
            let points: Array<{ x: number; y: number }> = [];
            try {
              const line = pdfAnnot.getLine();
              console.log("🔵 [ARROW LOAD] getLine() returned:", line, "for page", pageNumber);
              
              // getLine() can return either [x1, y1, x2, y2] or [[x1, y1], [x2, y2]]
              if (line && Array.isArray(line)) {
                if (line.length >= 4 && typeof line[0] === 'number') {
                  // Flat array format: [x1, y1, x2, y2]
                  points = [
                    { x: line[0], y: line[1] },
                    { x: line[2], y: line[3] }
                  ];
                  console.log("🔵 [ARROW LOAD] Parsed points (flat format):", points);
                } else if (line.length >= 2 && Array.isArray(line[0])) {
                  // Nested array format: [[x1, y1], [x2, y2]]
                  points = [
                    { x: line[0][0], y: line[0][1] },
                    { x: line[1][0], y: line[1][1] }
                  ];
                  console.log("🔵 [ARROW LOAD] Parsed points (nested format):", points);
                } else {
                  console.warn("🔵 [ARROW LOAD] Invalid line format:", line);
                }
              } else {
                console.warn("🔵 [ARROW LOAD] Invalid line format:", line);
              }
            } catch (e) {
              console.warn("Could not get line points:", e);
            }
            
            // Get color
            let strokeColor = "#000000";
            try {
              const color = pdfAnnot.getColor();
              if (color && color.length >= 3) {
                const r = Math.round(color[0] * 255);
                const g = Math.round(color[1] * 255);
                const b = Math.round(color[2] * 255);
                strokeColor = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
              }
            } catch (e) {
              // Use default color
            }
            
            // Get stroke width
            let strokeWidth = 2;
            try {
              const borderWidth = pdfAnnot.getBorderWidth();
              if (borderWidth) {
                strokeWidth = borderWidth;
              }
            } catch (e) {
              // Use default width
            }
            
            // Get arrow head size if stored
            let arrowHeadSize = 10; // Default
            try {
              const annotObj = pdfAnnot.getObject();
              if (annotObj) {
                const arrowSizeObj = annotObj.get("ArrowHeadSize");
                if (arrowSizeObj && typeof arrowSizeObj.valueOf === 'function') {
                  arrowHeadSize = arrowSizeObj.valueOf();
                }
              }
            } catch (e) {
              // Use default size
            }
            
            if (points.length >= 2) {
              // Validate points are reasonable (not 0,0 or NaN)
              const isValid = points.every(p => 
                typeof p.x === 'number' && typeof p.y === 'number' &&
                !isNaN(p.x) && !isNaN(p.y) &&
                Math.abs(p.x) < 100000 && Math.abs(p.y) < 100000 // Reasonable bounds
              );
              
              if (!isValid) {
                console.warn("🔵 [ARROW LOAD] Invalid points detected, skipping arrow:", points);
              } else {
                // CRITICAL FIX: getLine() returns coordinates in canvas space (Y=0 at top), not PDF space (Y=0 at bottom)
                // We need to flip Y coordinates to convert from canvas to PDF coordinates
                const pageBounds = page.getBounds();
                const pageHeight = pageBounds[3] - pageBounds[1];
                const pdfPoints = points.map(p => ({
                  x: p.x,
                  y: pageHeight - p.y  // Flip Y: convert from canvas (Y=0 at top) to PDF (Y=0 at bottom)
                }));
                
                
                const minX = Math.min(pdfPoints[0].x, pdfPoints[1].x);
                const maxX = Math.max(pdfPoints[0].x, pdfPoints[1].x);
                const minY = Math.min(pdfPoints[0].y, pdfPoints[1].y);
                const maxY = Math.max(pdfPoints[0].y, pdfPoints[1].y);
                
                // Filter out artifact arrows with suspiciously small coordinates (top-left corner artifacts)
                // These are typically failed save attempts that left broken annotations
                const isArtifact = (minX < 200 && minY < 200 && maxX < 200 && maxY < 200) && 
                                 (maxX - minX < 150 && maxY - minY < 150); // Small arrow in top-left corner
                
                if (isArtifact) {
                  console.warn("🔵 [ARROW LOAD] Skipping artifact arrow (suspicious coordinates):", pdfPoints);
                } else {
                    annotations.push({
                    id,
                    type: "shape",
                    pageNumber,
                    x: minX,
                    y: minY,
                    width: maxX - minX,
                    height: maxY - minY,
                    shapeType: "arrow",
                    points: pdfPoints,  // Use converted PDF coordinates
                    strokeColor,
                    strokeWidth,
                    arrowHeadSize,
                    pdfAnnotation: pdfAnnot,
                  });
                }
              }
            } else {
              console.warn("🔵 [ARROW LOAD] Not enough points for arrow:", points);
            }
          } else if (type === "Square" || type === "Circle") {
            // Load rectangle or circle annotation
            const pageBounds = page.getBounds();
            const pageHeight = pageBounds[3] - pageBounds[1];
            
            // Get color
            let strokeColor = "#000000";
            let fillColor: string | undefined;
            try {
              const color = pdfAnnot.getColor();
              if (color && color.length >= 3) {
                const r = Math.round(color[0] * 255);
                const g = Math.round(color[1] * 255);
                const b = Math.round(color[2] * 255);
                strokeColor = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
              }
            } catch (e) {
              // Use default color
            }
            
            // Get fill color if available
            try {
              const fillColorObj = pdfAnnot.getFillColor ? pdfAnnot.getFillColor() : null;
              if (fillColorObj && fillColorObj.length >= 3) {
                const r = Math.round(fillColorObj[0] * 255);
                const g = Math.round(fillColorObj[1] * 255);
                const b = Math.round(fillColorObj[2] * 255);
                fillColor = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
              }
            } catch (e) {
              // No fill color
            }
            
            // Get stroke width
            let strokeWidth = 2;
            try {
              const borderWidth = pdfAnnot.getBorderWidth();
              if (borderWidth) {
                strokeWidth = borderWidth;
              }
            } catch (e) {
              // Use default width
            }
            
            if (!rect) {
              console.warn("Shape annotation has no rect, skipping");
              continue;
            }
            annotations.push({
              id,
              type: "shape",
              pageNumber,
              x: rect[0],
              y: pageHeight - rect[3], // Convert to display coordinates
              width: rect[2] - rect[0],
              height: rect[3] - rect[1],
              shapeType: type === "Square" ? "rectangle" : "circle",
              strokeColor,
              strokeWidth,
              fillColor,
              fillOpacity: fillColor ? 0.5 : undefined, // Default fill opacity if fill color exists
              pdfAnnotation: pdfAnnot,
            });
          } else if (type === "Ink") {
            // Load drawing annotation
            const pageBounds = page.getBounds();
            const pageHeight = pageBounds[3] - pageBounds[1];
            
            let path: Array<{ x: number; y: number }> = [];
            try {
              const inkList = pdfAnnot.getInkList();
              if (inkList && inkList.length > 0) {
                // Ink list is an array of strokes, each stroke is an array of [x, y, x, y, ...]
                for (const stroke of inkList) {
                  if (Array.isArray(stroke)) {
                    for (let i = 0; i < stroke.length; i += 2) {
                      if (i + 1 < stroke.length) {
                        path.push({
                          x: stroke[i],
                          y: pageHeight - stroke[i + 1] // Convert to display coordinates
                        });
                      }
                    }
                  }
                }
              }
            } catch (e) {
              console.warn("Could not get ink list:", e);
            }
            
            // Get color
            let color = "#000000";
            try {
              const annotColor = pdfAnnot.getColor();
              if (annotColor && annotColor.length >= 3) {
                const r = Math.round(annotColor[0] * 255);
                const g = Math.round(annotColor[1] * 255);
                const b = Math.round(annotColor[2] * 255);
                color = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
              }
            } catch (e) {
              // Use default color
            }
            
            // Get stroke width
            let strokeWidth = 3;
            try {
              const borderWidth = pdfAnnot.getBorderWidth();
              if (borderWidth) {
                strokeWidth = borderWidth;
              }
            } catch (e) {
              // Use default width
            }
            
            if (path.length >= 2) {
              const minX = Math.min(...path.map(p => p.x));
              const maxX = Math.max(...path.map(p => p.x));
              const minY = Math.min(...path.map(p => p.y));
              const maxY = Math.max(...path.map(p => p.y));
              
              annotations.push({
                id,
                type: "draw",
                pageNumber,
                x: minX,
                y: minY,
                width: maxX - minX,
                height: maxY - minY,
                path,
                color,
                strokeWidth,
                drawingStyle: "pencil",
                pdfAnnotation: pdfAnnot,
              });
            }
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
  /**
   * Update form field value and properties in PDF
   * This ensures form fields are properly synced before saving
   */
  async updateFormFieldValue(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    if (annotation.type !== "formField" || !annotation.pdfAnnotation) {
      return;
    }

    try {
      const mupdfDoc = document.getMupdfDocument();
      const pdfDoc = mupdfDoc.asPDF();
      if (!pdfDoc) return;

      const page = pdfDoc.loadPage(annotation.pageNumber);
      const pageBounds = page.getBounds();
      const pageHeight = pageBounds[3] - pageBounds[1];
      
      const annotObj = annotation.pdfAnnotation.getObject();
      if (!annotObj) return;

      // Update position and size if changed
      if (annotation.x !== undefined && annotation.y !== undefined && 
          annotation.width !== undefined && annotation.height !== undefined) {
        const y = pageHeight - annotation.y - annotation.height;
        const rect: [number, number, number, number] = [
          annotation.x,
          y,
          annotation.x + annotation.width,
          y + annotation.height,
        ];
        annotation.pdfAnnotation.setRect(rect);
      }

      // Update field value based on type
      if (annotation.fieldType === "text" || annotation.fieldType === "date") {
        if (annotation.fieldValue !== undefined) {
          if (typeof annotation.fieldValue === "string") {
            annotObj.put("V", this.mupdf.newString(annotation.fieldValue));
            annotObj.put("DV", this.mupdf.newString(annotation.fieldValue)); // Default value
          } else {
            annotObj.put("V", this.mupdf.newString(""));
            annotObj.put("DV", this.mupdf.newString(""));
          }
        }
      } else if (annotation.fieldType === "checkbox" || annotation.fieldType === "radio") {
        if (annotation.fieldValue === true) {
          annotObj.put("V", this.mupdf.newName("Yes"));
          annotObj.put("AS", this.mupdf.newName("Yes"));
        } else {
          annotObj.put("V", this.mupdf.newName("Off"));
          annotObj.put("AS", this.mupdf.newName("Off"));
        }
      } else if (annotation.fieldType === "dropdown") {
        // Update options if changed
        if (annotation.options && annotation.options.length > 0) {
          const optArray = this.mupdf.newArray();
          for (const opt of annotation.options) {
            optArray.push(this.mupdf.newString(opt));
          }
          annotObj.put("Opt", optArray);
        }
        
        // Update value if provided
        if (annotation.fieldValue !== undefined && typeof annotation.fieldValue === "string") {
          annotObj.put("V", this.mupdf.newString(annotation.fieldValue));
        }
      }

      // Update field flags (readOnly, required)
      let fieldFlags = 0;
      const currentFlags = annotObj.get("Ff");
      if (currentFlags && typeof currentFlags.valueOf === "function") {
        fieldFlags = currentFlags.valueOf();
      }
      
      if (annotation.readOnly) {
        fieldFlags |= 1; // Read-only flag
      } else {
        fieldFlags &= ~1; // Clear read-only flag
      }
      
      if (annotation.required) {
        fieldFlags |= 2; // Required flag
      } else {
        fieldFlags &= ~2; // Clear required flag
      }
      
      annotObj.put("Ff", fieldFlags);
      
      // Update field name if changed
      if (annotation.fieldName) {
        annotObj.put("T", this.mupdf.newString(annotation.fieldName));
      }

      annotObj.update();
      annotation.pdfAnnotation.update();
    } catch (error) {
      console.warn("Could not update form field:", error);
    }
  }

  async updateAnnotationInPdf(
    _document: PDFDocument, // Not used but kept for API consistency
    pdfAnnotation: any, // The actual mupdf annotation object
    updates: Partial<Annotation>
  ): Promise<void> {
    if (!pdfAnnotation) return;

    // Handle form field updates
    if (updates.type === "formField" || (updates.fieldValue !== undefined && pdfAnnotation.getType() === "Widget")) {
      // For form fields, update the value
      const annotObj = pdfAnnotation.getObject();
      if (annotObj) {
        const fieldType = annotObj.get("FT");
        if (fieldType) {
          const ftName = fieldType.getName ? fieldType.getName() : null;
          
          if (ftName === "Tx" && updates.fieldValue && typeof updates.fieldValue === "string") {
            // Text or date field
            annotObj.put("V", this.mupdf.newString(updates.fieldValue));
            annotObj.update();
            pdfAnnotation.update();
          } else if (ftName === "Btn") {
            // Checkbox or radio
            if (updates.fieldValue === true) {
              annotObj.put("V", this.mupdf.newName("Yes"));
              annotObj.put("AS", this.mupdf.newName("Yes"));
            } else {
              annotObj.put("V", this.mupdf.newName("Off"));
              annotObj.put("AS", this.mupdf.newName("Off"));
            }
            annotObj.update();
            pdfAnnotation.update();
          } else if (ftName === "Ch" && updates.fieldValue && typeof updates.fieldValue === "string") {
            // Dropdown
            annotObj.put("V", this.mupdf.newString(updates.fieldValue));
            annotObj.update();
            pdfAnnotation.update();
          }
        }
      }
      return;
    }

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
    const mupdfDoc = document.getMupdfDocument();
    const pdfDoc = mupdfDoc.asPDF();
    
    if (!pdfDoc) {
      throw new Error("Document is not a PDF");
    }

    // Sync annotations if provided - this embeds them IN the PDF
    if (annotations && annotations.length > 0) {
      
      await this.syncAllAnnotationsExtended(document, annotations);
      
      
      // CRITICAL: After syncing, ensure all annotations are updated on their pages
      // This forces mupdf to write the annotations to the PDF structure
      const pagesWithAnnotations = new Set<number>();
      for (const annot of annotations) {
        pagesWithAnnotations.add(annot.pageNumber);
      }
      
      // Update all pages that have annotations to ensure they're written to PDF
      for (const pageNumber of pagesWithAnnotations) {
        try {
          const page = pdfDoc.loadPage(pageNumber);
          const pageAnnotations = page.getAnnotations();
          
          
          // Update all annotations on this page to ensure they're embedded
          for (const pdfAnnot of pageAnnotations) {
            try {
              pdfAnnot.update();
            } catch (e) {
              console.warn(`Could not update annotation on page ${pageNumber}:`, e);
            }
          }
          
        } catch (err) {
          console.error(`Error updating annotations on page ${pageNumber}:`, err);
        }
      }
      
      // Apply redactions on all pages that have redaction annotations
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

    // Save the PDF with all annotations embedded
    // saveToBuffer() writes the entire PDF including all annotations to a binary buffer
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
   * Export a single page as a new PDF document with all annotations
   */
  async exportPageAsPDF(
    document: PDFDocument,
    pageNumber: number,
    annotations?: Annotation[]
  ): Promise<Uint8Array> {
    const mupdfDoc = document.getMupdfDocument();
    const sourcePdf = mupdfDoc.asPDF();
    
    if (!sourcePdf) {
      throw new Error("Document is not a PDF");
    }

    // Create a new PDF document
    const newPdf = new this.mupdf.PDFDocument();
    
    // Graft the page from source to new document
    newPdf.graftPage(0, sourcePdf, pageNumber);

    // If annotations are provided, add them to the new document
    if (annotations && annotations.length > 0) {
      // Filter annotations for this page
      const pageAnnotations = annotations.filter(ann => ann.pageNumber === pageNumber);
      
      if (pageAnnotations.length > 0) {
        // Create a temporary PDFDocument wrapper for the new PDF
        // We need to add annotations, so we'll work directly with the mupdf document
        const page = newPdf.loadPage(0);
        
        // Add each annotation to the page
        for (const annot of pageAnnotations) {
          try {
            // Create annotation based on type
            if (annot.type === "text") {
              await this.addTextAnnotationToPage(page, annot, 0);
            } else if (annot.type === "highlight") {
              await this.addHighlightAnnotationToPage(page, annot, 0);
            } else if (annot.type === "callout") {
              await this.addCalloutAnnotationToPage(page, annot, 0);
            } else if (annot.type === "image") {
              await this.addImageAnnotationToPage(page, annot, 0);
            } else if (annot.type === "draw") {
              await this.addDrawingAnnotationToPage(page, annot, 0);
            } else if (annot.type === "shape") {
              await this.addShapeAnnotationToPage(page, annot, 0);
            }
            // Note: form fields and stamps are handled differently
          } catch (error) {
            console.error(`Error adding annotation ${annot.id} to exported page:`, error);
          }
        }
      }
    }

    // Save the new document to buffer
    const buffer = newPdf.saveToBuffer();
    return buffer.asUint8Array();
  }

  /**
   * Helper methods to add annotations directly to a page (for export)
   */
  private async addTextAnnotationToPage(page: any, annotation: Annotation, newPageNumber: number): Promise<void> {
    // Similar to addTextAnnotation but works with a page object directly
    const pageBounds = page.getBounds();
    const pageHeight = pageBounds[3] - pageBounds[1];
    
    const annot = page.createAnnotation("FreeText");
    annot.setRect([annotation.x, pageHeight - annotation.y - (annotation.height || 20), 
                   annotation.x + (annotation.width || 200), pageHeight - annotation.y]);
    
    if (annotation.content) {
      annot.setContents(annotation.content);
    }
    
    if (annotation.color) {
      const color = this.parseColor(annotation.color);
      annot.setColor(color);
    }
    
    annot.update();
  }

  private async addHighlightAnnotationToPage(page: any, annotation: Annotation, newPageNumber: number): Promise<void> {
    if (!annotation.quads || annotation.quads.length === 0) return;
    
    const annot = page.createAnnotation("Highlight");
    
    // Convert quads to mupdf format
    const quadList: number[] = [];
    for (const quad of annotation.quads) {
      quadList.push(...quad);
    }
    
    annot.setQuadPoints(quadList);
    
    if (annotation.color) {
      const color = this.parseColor(annotation.color);
      annot.setColor(color);
    }
    
    if (annotation.opacity !== undefined) {
      annot.setOpacity(annotation.opacity);
    }
    
    annot.update();
  }

  private async addCalloutAnnotationToPage(page: any, annotation: Annotation, newPageNumber: number): Promise<void> {
    // Callouts are typically FreeText annotations with callout lines
    // This is a simplified version - full implementation would need callout line handling
    const pageBounds = page.getBounds();
    const pageHeight = pageBounds[3] - pageBounds[1];
    
    const annot = page.createAnnotation("FreeText");
    annot.setRect([annotation.x, pageHeight - annotation.y - (annotation.height || 20), 
                   annotation.x + (annotation.width || 200), pageHeight - annotation.y]);
    
    if (annotation.content) {
      annot.setContents(annotation.content);
    }
    
    annot.update();
  }

  private async addImageAnnotationToPage(page: any, annotation: Annotation, newPageNumber: number): Promise<void> {
    if (!annotation.imageData) return;
    
    const pageBounds = page.getBounds();
    const pageHeight = pageBounds[3] - pageBounds[1];
    
    // Convert base64 data URL to image
    const base64Data = annotation.imageData.split(',')[1] || annotation.imageData;
    const imageBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
    
    try {
      const image = this.mupdf.Image.fromBuffer(imageBytes);
      const annot = page.createAnnotation("Stamp");
      
      const width = annotation.width || annotation.imageWidth || 100;
      const height = annotation.height || annotation.imageHeight || 100;
      
      annot.setRect([annotation.x, pageHeight - annotation.y - height, 
                     annotation.x + width, pageHeight - annotation.y]);
      
      // Set appearance stream with image
      annot.setAppearance(image);
      annot.update();
    } catch (error) {
      console.error("Error adding image annotation to exported page:", error);
    }
  }

  private async addDrawingAnnotationToPage(page: any, annotation: Annotation, newPageNumber: number): Promise<void> {
    if (!annotation.path || annotation.path.length < 2) return;
    
    const pageBounds = page.getBounds();
    const pageHeight = pageBounds[3] - pageBounds[1];
    
    const annot = page.createAnnotation("Ink");
    
    const inkPath: number[] = [];
    for (const point of annotation.path) {
      inkPath.push(point.x, pageHeight - point.y);
    }
    
    annot.setInkList([inkPath]);
    
    if (annotation.color) {
      const color = this.parseColor(annotation.color);
      annot.setColor(color);
    }
    
    if (annotation.strokeWidth) {
      annot.setBorder(annotation.strokeWidth);
    }
    
    annot.update();
  }

  private async addShapeAnnotationToPage(page: any, annotation: Annotation, newPageNumber: number): Promise<void> {
    const pageBounds = page.getBounds();
    const pageHeight = pageBounds[3] - pageBounds[1];
    
    let annot;
    if (annotation.shapeType === "rectangle") {
      annot = page.createAnnotation("Square");
    } else if (annotation.shapeType === "circle") {
      annot = page.createAnnotation("Circle");
    } else {
      // Arrow or other - use Line annotation
      annot = page.createAnnotation("Line");
    }
    
    if (annotation.width && annotation.height) {
      annot.setRect([annotation.x, pageHeight - annotation.y - annotation.height, 
                     annotation.x + annotation.width, pageHeight - annotation.y]);
    }
    
    if (annotation.color) {
      const color = this.parseColor(annotation.color);
      annot.setColor(color);
    }
    
    annot.update();
  }

  private parseColor(color: string): number[] {
    // Convert hex color to RGB array [r, g, b] where values are 0-1
    const hex = color.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;
    return [r, g, b];
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
    
    // Store the PDF annotation object for future updates
    annotation.pdfAnnotation = annot;
  }

  /**
   * Add shape annotation to a page
   */
  async addShapeAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<any> {
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
      
      // Test Hypothesis C: Need to set Rect before setLine
      try {
        const minX = Math.min(annotation.points[0].x, annotation.points[1].x);
        const maxX = Math.max(annotation.points[0].x, annotation.points[1].x);
        const minY = Math.min(annotation.points[0].y, annotation.points[1].y);
        const maxY = Math.max(annotation.points[0].y, annotation.points[1].y);
        const rect: [number, number, number, number] = [minX, minY, maxX, maxY];
        annot.setRect(rect);
      } catch (rectError) {
        // Line annotations might not support setRect - that's okay
      }
      
      const start = annotation.points[0];
      const end = annotation.points[1];
      
      // Validate points are valid numbers
      if (typeof start.x !== 'number' || typeof start.y !== 'number' ||
          typeof end.x !== 'number' || typeof end.y !== 'number' ||
          isNaN(start.x) || isNaN(start.y) || isNaN(end.x) || isNaN(end.y)) {
        console.warn("🟠 [ARROW SAVE] Invalid arrow points:", { start, end });
        return;
      }
      
      // CRITICAL: The load code confirms getLine() returns canvas coordinates (Y=0 at top)
      // So we must convert PDF coordinates to canvas coordinates before calling setLine()
      const canvasStart = { x: start.x, y: pageHeight - start.y };
      const canvasEnd = { x: end.x, y: pageHeight - end.y };
      
      // Test Hypothesis A: setLine() expects flat array [x1, y1, x2, y2] not nested
      const flatArray = [canvasStart.x, canvasStart.y, canvasEnd.x, canvasEnd.y];
      // Test Hypothesis B: setLine() expects nested array [[x1, y1], [x2, y2]]
      const nestedArray = [[canvasStart.x, canvasStart.y], [canvasEnd.x, canvasEnd.y]];
      
      
      // Try flat array format first (Hypothesis A)
      try {
        annot.setLine(flatArray);
        console.log("🟢 [ARROW SAVE] Successfully set line with flat array");
      } catch (flatError) {
        
        // Try nested array format (Hypothesis B)
        try {
          annot.setLine(nestedArray);
          console.log("🟢 [ARROW SAVE] Successfully set line with nested array");
        } catch (nestedError) {
          
          // Test Hypothesis E: setLine() needs to be set via annotation object's "L" property
          try {
            const annotObj = annot.getObject();
            if (!annotObj) {
              throw new Error("Could not get annotation object");
            }
            
            // Try multiple sources for mupdf instance (pdfDoc has newNumber, might have newArray too)
            let mupdfInstance = this.mupdf;
            if (!mupdfInstance || !mupdfInstance.newArray) {
              // Try pdfDoc (as used in line 391 for newNumber)
              if (pdfDoc && pdfDoc.newArray) {
                mupdfInstance = pdfDoc;
              }
            }
            
            if (mupdfInstance && mupdfInstance.newArray && mupdfInstance.newNumber) {
              // Create mupdf array with 4 numbers: [x1, y1, x2, y2] in CANVAS coordinates
              const lineArray = mupdfInstance.newArray();
              lineArray.push(mupdfInstance.newNumber(canvasStart.x));
              lineArray.push(mupdfInstance.newNumber(canvasStart.y));
              lineArray.push(mupdfInstance.newNumber(canvasEnd.x));
              lineArray.push(mupdfInstance.newNumber(canvasEnd.y));
              annotObj.put("L", lineArray);
              annot.update();
              console.log("🟢 [ARROW SAVE] Successfully set line via annotation object");
            } else {
              // Fallback: Try setting with plain array directly - mupdf might accept it (in CANVAS coordinates)
              const lineArray = [canvasStart.x, canvasStart.y, canvasEnd.x, canvasEnd.y];
              try {
                annotObj.put("L", lineArray);
                annot.update();
                console.log("🟢 [ARROW SAVE] Successfully set line via plain array fallback");
              } catch (putError) {
                // If put() fails, maybe we need to use a different approach
                // Try using the annotation's internal methods
                throw putError;
              }
            }
          } catch (objError) {
            console.warn("🟠 [ARROW SAVE] Could not set line with any method, deleting broken annotation:", { flatError, nestedError, objError, start, end });
            // CRITICAL: If we can't set the line, delete the annotation to prevent a broken annotation from being saved
            try {
              const page = pdfDoc.loadPage(annotation.pageNumber);
              page.deleteAnnotation(annot);
            } catch (deleteError) {
              console.warn("Could not delete broken annotation:", deleteError);
            }
            return null;
          }
        }
      }
      
      // Set line ending style for arrow head
      try {
        annot.setLineEndingStyles("None", "OpenArrow");
      } catch {
        // Line ending styles might not be available
      }
      
      // Store arrow head size in annotation object for later retrieval
      try {
        const annotObj = annot.getObject();
        if (annotObj && annotation.arrowHeadSize) {
          annotObj.put("ArrowHeadSize", this.mupdf.newNumber(annotation.arrowHeadSize));
        }
      } catch (e) {
        // Ignore if we can't store it
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
      } else {
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
      
      
      return annot;
    }
    
    return null;
  }

  /**
   * Add form field annotation to a page
   * Creates proper AcroForm fields that are compatible across PDF platforms
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
    
    // Convert to display coordinates (PDF uses bottom-left origin)
    const y = pageHeight - annotation.y - (annotation.height || 0);
    const rect: [number, number, number, number] = [
      annotation.x,
      y,
      annotation.x + (annotation.width || 0),
      y + (annotation.height || 0),
    ];
    
    // Create Widget annotation (this creates the form field)
    const annot = page.createAnnotation("Widget");
    annot.setRect(rect);
    
    // Set field properties using annotation object
    try {
      const annotObj = annot.getObject();
      if (annotObj) {
        // Set field name (required for form fields)
        const fieldName = annotation.fieldName || `field_${annotation.id}`;
        annotObj.put("T", this.mupdf.newString(fieldName));
        
        // Set field type and properties
        let fieldFlags = 0;
        
        if (annotation.fieldType === "text") {
          annotObj.put("FT", this.mupdf.newName("Tx"));
          
          // Set multiline flag
          if (annotation.multiline) {
            fieldFlags |= 4096; // Multiline flag (bit 13)
          }
          
          // Set field value if provided
          if (annotation.fieldValue && typeof annotation.fieldValue === "string") {
            annotObj.put("V", this.mupdf.newString(annotation.fieldValue));
            annotObj.put("DV", this.mupdf.newString(annotation.fieldValue)); // Default value
          }
          
        } else if (annotation.fieldType === "checkbox") {
          annotObj.put("FT", this.mupdf.newName("Btn"));
          
          // Set checkbox value
          if (annotation.fieldValue === true) {
            annotObj.put("V", this.mupdf.newName("Yes"));
            annotObj.put("AS", this.mupdf.newName("Yes"));
          } else {
            annotObj.put("V", this.mupdf.newName("Off"));
            annotObj.put("AS", this.mupdf.newName("Off"));
          }
          
          // Set appearance dictionary for checkbox
          const apDict = this.mupdf.newDictionary();
          const nDict = this.mupdf.newDictionary();
          nDict.put("Off", this.mupdf.newDictionary());
          nDict.put("Yes", this.mupdf.newDictionary());
          apDict.put("N", nDict);
          annotObj.put("AP", apDict);
          
        } else if (annotation.fieldType === "radio") {
          annotObj.put("FT", this.mupdf.newName("Btn"));
          fieldFlags |= 32768; // Radio flag (bit 16)
          
          // Set radio group name
          if (annotation.radioGroup) {
            annotObj.put("T", this.mupdf.newString(annotation.radioGroup));
          }
          
          // Set radio value
          if (annotation.fieldValue === true) {
            annotObj.put("V", this.mupdf.newName("Yes"));
            annotObj.put("AS", this.mupdf.newName("Yes"));
          } else {
            annotObj.put("V", this.mupdf.newName("Off"));
            annotObj.put("AS", this.mupdf.newName("Off"));
          }
          
        } else if (annotation.fieldType === "dropdown") {
          annotObj.put("FT", this.mupdf.newName("Ch"));
          fieldFlags |= 131072; // Combo box flag (bit 18) - makes it a dropdown, not listbox
          
          // Set options
          if (annotation.options && annotation.options.length > 0) {
            const optArray = this.mupdf.newArray();
            for (const opt of annotation.options) {
              optArray.push(this.mupdf.newString(opt));
            }
            annotObj.put("Opt", optArray);
            
            // Set default value if provided
            if (annotation.fieldValue && typeof annotation.fieldValue === "string") {
              annotObj.put("V", this.mupdf.newString(annotation.fieldValue));
            }
          }
          
        } else if (annotation.fieldType === "date") {
          // Date fields are text fields with special formatting
          annotObj.put("FT", this.mupdf.newName("Tx"));
          fieldFlags |= 4096; // Multiline flag (for date picker compatibility)
          
          // Set date value if provided
          if (annotation.fieldValue && typeof annotation.fieldValue === "string") {
            annotObj.put("V", this.mupdf.newString(annotation.fieldValue));
            annotObj.put("DV", this.mupdf.newString(annotation.fieldValue));
          }
        }
        
        // Set field flags (readOnly, required, etc.)
        if (annotation.readOnly) {
          fieldFlags |= 1; // Read-only flag (bit 1)
        }
        if (annotation.required) {
          fieldFlags |= 2; // Required flag (bit 2) - though this is more of a validation hint
        }
        
        if (fieldFlags > 0) {
          annotObj.put("Ff", fieldFlags);
        }
        
        // Set appearance characteristics for better compatibility
        const mkDict = this.mupdf.newDictionary();
        annotObj.put("MK", mkDict);
        
        // Ensure the field is added to the AcroForm
        annotObj.update();
      }
    } catch (error) {
      console.warn("Could not set form field properties:", error);
    }
    
    annot.update();
    
    // Store the PDF annotation object for future updates
    annotation.pdfAnnotation = annot;
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
          
          if (!rect) {
            console.warn("Form field has no rect, skipping");
            continue;
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
    
    // Use FreeText annotation instead of Stamp to avoid default "DRAFT" appearance
    // Store stamp data in JSON format in contents, marked with a special type
    const annot = page.createAnnotation("FreeText");
    annot.setRect(rect);
    
    // Store stamp data in contents as JSON with a marker
    if (annotation.stampData) {
      const stampDataJson = JSON.stringify({
        type: "stamp",
        stampData: annotation.stampData
      });
      annot.setContents(stampDataJson);
      
      // Mark this as a stamp annotation in the object
      try {
        const annotObj = annot.getObject();
        if (annotObj) {
          annotObj.put("StampAnnotation", this.mupdf.newString("true"));
        }
      } catch (e) {
        // Ignore if we can't set the marker
      }
    }
    
    // Make it invisible (no border, transparent)
    try {
      annot.setBorderWidth(0);
      annot.setInteriorColor([]);
    } catch (e) {
      // Ignore if these methods aren't available
    }
    
    annot.update();
    
    // Store the PDF annotation object for future updates
    annotation.pdfAnnotation = annot;
  }

  /**
   * Flatten all annotations in the document
   * This permanently merges annotations into page content by rendering them onto the page
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

    // First, ensure all annotations are synced to the PDF
    // Get annotations from the store
    const { usePDFStore } = await import("@/shared/stores/pdfStore");
    const annotations = usePDFStore.getState().getAnnotations(document.getId());
    
    // Sync all annotations to ensure they exist in the PDF
    await this.syncAllAnnotationsExtended(document, annotations);

    const pageCount = document.getPageCount();
    const pagesToFlatten = currentPageOnly && pageNumber !== undefined 
      ? [pageNumber] 
      : Array.from({ length: pageCount }, (_, i) => i);
    
    for (const pgNum of pagesToFlatten) {
      try {
        const page = pdfDoc.loadPage(pgNum);
        
        // Get all annotations on the page
        const pageAnnotations = page.getAnnotations();
        
        if (pageAnnotations.length === 0) continue;
        
        // Update all annotations to generate appearance streams
        for (const annot of pageAnnotations) {
          try {
            annot.update();
          } catch (e) {
            console.warn(`Could not update annotation:`, e);
          }
        }
        
        // Flatten by rendering page with annotations, then replacing page content
        // Method: Render to pixmap (includes annotations), then insert as image on page
        try {
          const pageBounds = page.getBounds();
          const pageWidth = pageBounds[2] - pageBounds[0];
          const pageHeight = pageBounds[3] - pageBounds[1];
          
          // Render at high resolution for quality (2x scale)
          const scale = 2.0;
          const transform = this.mupdf.Matrix.scale(scale, scale);
          
          // Render page WITH annotations to pixmap
          const pixmap = page.toPixmap(
            transform,
            this.mupdf.ColorSpace.DeviceRGB,
            false,
            true // CRITICAL: Include annotations in rendering
          );
          
          // Create image from pixmap
          const image = this.mupdf.Image.fromPixmap(pixmap);
          
          // Insert the image onto the page to replace content
          // This embeds the rendered annotations as part of the page
          const rect: [number, number, number, number] = [
            pageBounds[0],
            pageBounds[1],
            pageBounds[2],
            pageBounds[3]
          ];
          
          // Use page.insertImage if available, otherwise manipulate content stream directly
          if (typeof page.insertImage === 'function') {
            page.insertImage(image, rect);
          } else {
            // Manual approach: Add image to page content stream
            const pageObj = page.getObject();
            
            // Get or create Resources dictionary
            let resources = pageObj.get("Resources");
            if (!resources || !resources.isDictionary()) {
              resources = this.mupdf.newDictionary();
              pageObj.put("Resources", resources);
            }
            
            // Get or create XObject dictionary
            let xObjects = resources.get("XObject");
            if (!xObjects || !xObjects.isDictionary()) {
              xObjects = this.mupdf.newDictionary();
              resources.put("XObject", xObjects);
            }
            
            // Add image as XObject
            xObjects.put("FlattenedPage", image.getObject());
            
            // Create content stream to draw the image
            const contentCommands = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/FlattenedPage Do\nQ\n`;
            const contentBuffer = this.mupdf.newBufferFromString(contentCommands);
            
            // Replace page contents
            pageObj.put("Contents", contentBuffer);
          }
          
          // Now delete all annotation objects - content is baked into the page
          const annotationsToDelete = [...pageAnnotations];
          for (const annot of annotationsToDelete) {
            try {
              page.deleteAnnotation(annot);
            } catch (e) {
              console.warn(`Could not delete annotation after flattening:`, e);
            }
          }
          
        } catch (e) {
          console.error(`Error flattening page ${pgNum}:`, e);
          // If flattening fails, don't delete annotations - keep them visible
          throw new Error(`Failed to flatten page ${pgNum + 1}: ${e}`);
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
          // For form fields, update existing ones or create new ones
          if (annot.type === "formField") {
            if (annot.pdfAnnotation) {
              // Update existing form field value and properties
              await this.updateFormFieldValue(document, annot);
              // Also update position/size if changed
              if (annot.x !== undefined && annot.y !== undefined && annot.width !== undefined && annot.height !== undefined) {
                const page = pdfDoc.loadPage(pageNumber);
                const pageBounds = page.getBounds();
                const pageHeight = pageBounds[3] - pageBounds[1];
                const y = pageHeight - annot.y - annot.height;
                const rect: [number, number, number, number] = [
                  annot.x,
                  y,
                  annot.x + annot.width,
                  y + annot.height,
                ];
                annot.pdfAnnotation.setRect(rect);
                annot.pdfAnnotation.update();
              }
            } else {
              // Create new form field
              await this.addFormFieldAnnotation(document, annot);
            }
            continue;
          }

          // If annotation already has a PDF annotation object, update it instead of skipping
          if (annot.pdfAnnotation) {
            try {
              const page = pdfDoc.loadPage(pageNumber);
              const pageBounds = page.getBounds();
              const pageHeight = pageBounds[3] - pageBounds[1];
              
              // Update position and size if changed
              if (annot.x !== undefined && annot.y !== undefined && annot.width !== undefined && annot.height !== undefined) {
                const y = pageHeight - annot.y - annot.height;
                const rect: [number, number, number, number] = [
                  annot.x,
                  y,
                  annot.x + annot.width,
                  y + annot.height,
                ];
                annot.pdfAnnotation.setRect(rect);
              }
              
              // Update content if it's a text annotation
              if (annot.type === "text" && annot.content !== undefined) {
                annot.pdfAnnotation.setContents(annot.content);
              }
              
              // Update color if changed
              if (annot.color) {
                const hex = annot.color.replace("#", "");
                const r = parseInt(hex.substring(0, 2), 16) / 255;
                const g = parseInt(hex.substring(2, 4), 16) / 255;
                const b = parseInt(hex.substring(4, 6), 16) / 255;
                annot.pdfAnnotation.setColor([r, g, b]);
              }
              
              // Update stamp data if it's a stamp annotation
              if (annot.type === "stamp" && annot.stampData) {
                annot.pdfAnnotation.setContents(JSON.stringify(annot.stampData));
              }
              
              // Update callout data if it's a callout annotation
              if (annot.type === "callout") {
                const pageBounds = page.getBounds();
                const pageHeight = pageBounds[3] - pageBounds[1];
                const boxPos = annot.boxPosition || { x: annot.x, y: annot.y };
                const pdfBoxY = pageHeight - boxPos.y;
                const pdfArrowY = annot.arrowPoint ? (pageHeight - annot.arrowPoint.y) : undefined;
                const calloutData = {
                  type: "callout",
                  content: annot.content || "",
                  boxPosition: { x: boxPos.x, y: pdfBoxY },
                  arrowPoint: annot.arrowPoint ? { x: annot.arrowPoint.x, y: pdfArrowY! } : undefined,
                  width: annot.width || 150,
                  height: annot.height || 80,
                  fontSize: annot.fontSize || 12,
                  fontFamily: annot.fontFamily || "Arial",
                  color: annot.color || "#000000",
                };
                annot.pdfAnnotation.setContents(JSON.stringify(calloutData));
              }
              
              // Update shape annotations (arrows, rectangles, circles)
              if (annot.type === "shape") {
                if (annot.shapeType === "arrow" && annot.points && annot.points.length >= 2) {
                  const start = annot.points[0];
                  const end = annot.points[1];
                  
                  // Validate points are valid numbers
                  if (typeof start.x !== 'number' || typeof start.y !== 'number' ||
                      typeof end.x !== 'number' || typeof end.y !== 'number' ||
                      isNaN(start.x) || isNaN(start.y) || isNaN(end.x) || isNaN(end.y)) {
                    console.warn("🟠 [ARROW UPDATE] Invalid arrow points for update:", { start, end });
                  } else {
                    // Convert PDF coordinates to canvas coordinates for setLine()
                    const canvasStart = { x: start.x, y: pageHeight - start.y };
                    const canvasEnd = { x: end.x, y: pageHeight - end.y };
                    const lineArray = [[canvasStart.x, canvasStart.y], [canvasEnd.x, canvasEnd.y]];
                    console.log("🟡 [ARROW UPDATE] Updating arrow with points:", { pdfStart: start, pdfEnd: end, canvasStart, canvasEnd }, "to setLine(", lineArray, ")");
                    try {
                      annot.pdfAnnotation.setLine(lineArray);
                      console.log("🟡 [ARROW UPDATE] Successfully updated line");
                    } catch (e) {
                      console.warn("🟠 [ARROW UPDATE] Could not update arrow line:", e, { start, end, lineArray });
                    }
                  }
                  
                  // Update arrow head size if stored
                  if (annot.arrowHeadSize !== undefined) {
                    try {
                      const annotObj = annot.pdfAnnotation.getObject();
                      if (annotObj) {
                        annotObj.put("ArrowHeadSize", this.mupdf.newNumber(annot.arrowHeadSize));
                        annot.pdfAnnotation.update();
                      }
                    } catch (e) {
                      // Ignore if we can't store it
                    }
                  }
                }
                // Update stroke color for shapes
                if (annot.strokeColor) {
                  const hex = annot.strokeColor.replace("#", "");
                  const r = parseInt(hex.substring(0, 2), 16) / 255;
                  const g = parseInt(hex.substring(2, 4), 16) / 255;
                  const b = parseInt(hex.substring(4, 6), 16) / 255;
                  annot.pdfAnnotation.setColor([r, g, b]);
                }
                // Update stroke width
                if (annot.strokeWidth !== undefined) {
                  try {
                    annot.pdfAnnotation.setBorderWidth(annot.strokeWidth);
                  } catch (e) {
                    // Border width might not be available
                  }
                }
              }
              
              // Update draw annotations (ink paths)
              if (annot.type === "draw" && annot.path && annot.path.length >= 2) {
                const inkPath: number[] = [];
                for (const point of annot.path) {
                  inkPath.push(point.x, pageHeight - point.y);
                }
                try {
                  annot.pdfAnnotation.setInkList([inkPath]);
                } catch {
                  try {
                    (annot.pdfAnnotation as any).setInkList(inkPath);
                  } catch (e) {
                    console.warn("Could not update ink list:", e);
                  }
                }
                // Update color
                if (annot.color) {
                  const hex = annot.color.replace("#", "");
                  const r = parseInt(hex.substring(0, 2), 16) / 255;
                  const g = parseInt(hex.substring(2, 4), 16) / 255;
                  const b = parseInt(hex.substring(4, 6), 16) / 255;
                  annot.pdfAnnotation.setColor([r, g, b]);
                }
                // Update stroke width
                if (annot.strokeWidth !== undefined) {
                  try {
                    annot.pdfAnnotation.setBorderWidth(annot.strokeWidth);
                  } catch (e) {
                    // Border width might not apply to ink
                  }
                }
              }
              
              // Update highlight annotations
              if (annot.type === "highlight") {
                if (annot.quads && annot.quads.length > 0) {
                  const quadList = annot.quads.map((quad) => {
                    if (Array.isArray(quad) && quad.length >= 8) {
                      return [
                        quad[0], pageHeight - quad[1],
                        quad[2], pageHeight - quad[3],
                        quad[4], pageHeight - quad[5],
                        quad[6], pageHeight - quad[7],
                      ] as any;
                    }
                    return [0, 0, 0, 0, 0, 0, 0, 0];
                  });
                  try {
                    annot.pdfAnnotation.setQuadPoints(quadList);
                  } catch (e) {
                    console.warn("Could not update highlight quads:", e);
                  }
                }
                // Update opacity
                if (annot.opacity !== undefined) {
                  try {
                    if (typeof annot.pdfAnnotation.setOpacity === 'function') {
                      annot.pdfAnnotation.setOpacity(annot.opacity);
                    }
                  } catch (e) {
                    // Opacity might not be available
                  }
                }
              }
              
              // Update image annotations
              if (annot.type === "image" && annot.imageData) {
                const imageMetadata = {
                  type: "image",
                  imageData: annot.imageData,
                  imageWidth: annot.imageWidth,
                  imageHeight: annot.imageHeight,
                  preserveAspectRatio: annot.preserveAspectRatio !== false,
                  rotation: annot.rotation || 0,
                };
                annot.pdfAnnotation.setContents(JSON.stringify(imageMetadata));
              }
              
              // CRITICAL: Call update() to ensure annotation is written to PDF
              annot.pdfAnnotation.update();
              continue; // Skip creating new annotation
            } catch (error) {
              console.warn(`Error updating existing annotation ${annot.id}, will try to find existing or recreate:`, error);
              
              // CRITICAL FIX: If annotation is stale (not bound to page), try to find an existing one with same coordinates first
              // This prevents creating duplicates when the pdfAnnotation reference is invalid but the annotation already exists in PDF
              if (error instanceof Error && error.message && error.message.includes("not bound to any page")) {
                try {
                  const page = pdfDoc.loadPage(pageNumber);
                  const pageAnnotations = page.getAnnotations();
                  let foundExisting = false;
                  
                  // For arrows, try to find existing annotation by matching coordinates
                  if (annot.type === "shape" && annot.shapeType === "arrow" && annot.points && annot.points.length === 2) {
                    const tolerance = 1;
                    for (const pdfAnnot of pageAnnotations) {
                      try {
                        const pdfType = pdfAnnot.getType();
                        if (pdfType === "Line") {
                          const line = pdfAnnot.getLine();
                          if (line && Array.isArray(line) && line.length >= 4) {
                            const pdfStart = { x: line[0], y: line[1] };
                            const pdfEnd = { x: line[2], y: line[3] };
                            const annotStart = annot.points[0];
                            const annotEnd = annot.points[1];
                            
                            const startMatch = Math.abs(pdfStart.x - annotStart.x) < tolerance && 
                                              Math.abs(pdfStart.y - annotStart.y) < tolerance;
                            const endMatch = Math.abs(pdfEnd.x - annotEnd.x) < tolerance && 
                                            Math.abs(pdfEnd.y - annotEnd.y) < tolerance;
                            const reverseMatch = Math.abs(pdfStart.x - annotEnd.x) < tolerance && 
                                               Math.abs(pdfStart.y - annotEnd.y) < tolerance &&
                                               Math.abs(pdfEnd.x - annotStart.x) < tolerance && 
                                               Math.abs(pdfEnd.y - annotStart.y) < tolerance;
                            
                            if ((startMatch && endMatch) || reverseMatch) {
                              // Found existing annotation! Update it and reuse it
                              foundExisting = true;
                              annot.pdfAnnotation = pdfAnnot;
                              
                              // Update the existing annotation with current properties
                              try {
                                // Get page height for coordinate conversion
                                const pageBounds = page.getBounds();
                                const pageHeight = pageBounds[3] - pageBounds[1];
                                // Convert PDF coordinates to canvas coordinates for setLine()
                                const canvasStart = { x: annotStart.x, y: pageHeight - annotStart.y };
                                const canvasEnd = { x: annotEnd.x, y: pageHeight - annotEnd.y };
                                const lineArray = [[canvasStart.x, canvasStart.y], [canvasEnd.x, canvasEnd.y]];
                                pdfAnnot.setLine(lineArray);
                                
                                if (annot.strokeColor) {
                                  const hex = annot.strokeColor.replace("#", "");
                                  const r = parseInt(hex.substring(0, 2), 16) / 255;
                                  const g = parseInt(hex.substring(2, 4), 16) / 255;
                                  const b = parseInt(hex.substring(4, 6), 16) / 255;
                                  pdfAnnot.setColor([r, g, b]);
                                }
                                if (annot.strokeWidth !== undefined) {
                                  try {
                                    pdfAnnot.setBorderWidth(annot.strokeWidth);
                                  } catch (e) {
                                    // Border width might not be available
                                  }
                                }
                                if (annot.arrowHeadSize !== undefined) {
                                  try {
                                    const annotObj = pdfAnnot.getObject();
                                    if (annotObj) {
                                      annotObj.put("ArrowHeadSize", this.mupdf.newNumber(annot.arrowHeadSize));
                                    }
                                  } catch (e) {
                                    // Ignore
                                  }
                                }
                                pdfAnnot.update();
                              } catch (updateError) {
                                console.warn(`Could not update found annotation ${annot.id}:`, updateError);
                                foundExisting = false; // Fall through to create new one
                              }
                              break;
                            }
                          }
                        }
                      } catch (matchError) {
                        // Continue searching
                      }
                    }
                  }
                  
                  if (!foundExisting) {
                    // No existing annotation found, delete stale one and create new
                    if (annot.pdfAnnotation) {
                      try {
                        page.deleteAnnotation(annot.pdfAnnotation);
                      } catch (deleteError) {
                        // If delete fails, try to find and delete by matching properties
                        for (const pdfAnnot of pageAnnotations) {
                          try {
                            const pdfType = pdfAnnot.getType();
                            if (annot.type === "shape" && annot.shapeType === "arrow" && pdfType === "Line") {
                              const line = pdfAnnot.getLine();
                              if (line && annot.points && annot.points.length === 2) {
                                const tolerance = 1;
                                if (Array.isArray(line) && line.length >= 4) {
                                  const pdfStart = { x: line[0], y: line[1] };
                                  const pdfEnd = { x: line[2], y: line[3] };
                                  const annotStart = annot.points[0];
                                  const annotEnd = annot.points[1];
                                  
                                  const startMatch = Math.abs(pdfStart.x - annotStart.x) < tolerance && 
                                                    Math.abs(pdfStart.y - annotStart.y) < tolerance;
                                  const endMatch = Math.abs(pdfEnd.x - annotEnd.x) < tolerance && 
                                                  Math.abs(pdfEnd.y - annotEnd.y) < tolerance;
                                  const reverseMatch = Math.abs(pdfStart.x - annotEnd.x) < tolerance && 
                                                     Math.abs(pdfStart.y - annotEnd.y) < tolerance &&
                                                     Math.abs(pdfEnd.x - annotStart.x) < tolerance && 
                                                     Math.abs(pdfEnd.y - annotStart.y) < tolerance;
                                  
                                  if ((startMatch && endMatch) || reverseMatch) {
                                    page.deleteAnnotation(pdfAnnot);
                                    break;
                                  }
                                }
                              }
                            }
                          } catch (matchError) {
                            // Continue searching
                          }
                        }
                      }
                    }
                    // Clear the stale pdfAnnotation reference so we create a new one
                    annot.pdfAnnotation = undefined;
                  } else {
                    // Found existing annotation, skip creating new one
                    continue;
                  }
                } catch (findPageError) {
                  console.warn(`Could not find existing annotation for ${annot.id}:`, findPageError);
                  // Clear the stale pdfAnnotation reference so we create a new one
                  annot.pdfAnnotation = undefined;
                }
              } else {
                // Error is not "not bound to any page", clear reference and create new one
                annot.pdfAnnotation = undefined;
              }
              
              // Fall through to create new annotation if update fails and no existing one found
            }
          }

          // Handle all other annotation types (create new annotations)
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
            // CRITICAL FIX: Before creating a new annotation, check if one with the same coordinates already exists
            // This prevents creating duplicates when stale annotations are deleted
            let existingPdfAnnot: any = null;
            if (annot.shapeType === "arrow" && annot.points && annot.points.length === 2) {
              try {
                const page = pdfDoc.loadPage(pageNumber);
                const pageAnnotations = page.getAnnotations();
                const tolerance = 1; // Small tolerance for floating point differences
                
                
                for (const pdfAnnot of pageAnnotations) {
                  try {
                    const pdfType = pdfAnnot.getType();
                    if (pdfType === "Line") {
                      const line = pdfAnnot.getLine();
                      // getLine() returns coordinates in canvas space (Y=0 at top)
                      // We need to convert them to PDF space for comparison with annot.points (which are in PDF space)
                      const pageBounds = page.getBounds();
                      const pageHeight = pageBounds[3] - pageBounds[1];
                      if (line && Array.isArray(line)) {
                        let canvasPoints: Array<{ x: number; y: number }> = [];
                        if (line.length >= 4 && typeof line[0] === 'number') {
                          canvasPoints = [
                            { x: line[0], y: line[1] },
                            { x: line[2], y: line[3] }
                          ];
                        } else if (line.length >= 2 && Array.isArray(line[0])) {
                          canvasPoints = [
                            { x: line[0][0], y: line[0][1] },
                            { x: line[1][0], y: line[1][1] }
                          ];
                        }
                        // Convert canvas coordinates to PDF coordinates for comparison
                        const pdfStart = { x: canvasPoints[0].x, y: pageHeight - canvasPoints[0].y };
                        const pdfEnd = { x: canvasPoints[1].x, y: pageHeight - canvasPoints[1].y };
                        const annotStart = annot.points[0];
                        const annotEnd = annot.points[1];
                        
                        const startMatch = Math.abs(pdfStart.x - annotStart.x) < tolerance && 
                                          Math.abs(pdfStart.y - annotStart.y) < tolerance;
                        const endMatch = Math.abs(pdfEnd.x - annotEnd.x) < tolerance && 
                                        Math.abs(pdfEnd.y - annotEnd.y) < tolerance;
                        const reverseMatch = Math.abs(pdfStart.x - annotEnd.x) < tolerance && 
                                           Math.abs(pdfStart.y - annotEnd.y) < tolerance &&
                                           Math.abs(pdfEnd.x - annotStart.x) < tolerance && 
                                           Math.abs(pdfEnd.y - annotStart.y) < tolerance;
                        
                        if ((startMatch && endMatch) || reverseMatch) {
                          existingPdfAnnot = pdfAnnot;
                          break;
                        } else {
                        }
                      }
                    }
                  } catch (e) {
                    // Continue searching
                  }
                }
              } catch (e) {
                // If check fails, proceed to create new annotation
              }
            }
            
            if (existingPdfAnnot) {
              // Use existing annotation instead of creating a new one
              annot.pdfAnnotation = existingPdfAnnot;
              // Update the existing annotation with current properties
              try {
                const page = pdfDoc.loadPage(pageNumber);
                const pageBounds = page.getBounds();
                const pageHeight = pageBounds[3] - pageBounds[1];
                const start = annot.points![0];
                const end = annot.points![1];
                // Convert PDF coordinates to canvas coordinates for setLine()
                const canvasStart = { x: start.x, y: pageHeight - start.y };
                const canvasEnd = { x: end.x, y: pageHeight - end.y };
                const lineArray = [[canvasStart.x, canvasStart.y], [canvasEnd.x, canvasEnd.y]];
                existingPdfAnnot.setLine(lineArray);
                
                // Update other properties
                if (annot.strokeColor) {
                  const hex = annot.strokeColor.replace("#", "");
                  const r = parseInt(hex.substring(0, 2), 16) / 255;
                  const g = parseInt(hex.substring(2, 4), 16) / 255;
                  const b = parseInt(hex.substring(4, 6), 16) / 255;
                  existingPdfAnnot.setColor([r, g, b]);
                }
                if (annot.strokeWidth !== undefined) {
                  try {
                    existingPdfAnnot.setBorderWidth(annot.strokeWidth);
                  } catch (e) {
                    // Border width might not be available
                  }
                }
                if (annot.arrowHeadSize !== undefined) {
                  try {
                    const annotObj = existingPdfAnnot.getObject();
                    if (annotObj) {
                      annotObj.put("ArrowHeadSize", this.mupdf.newNumber(annot.arrowHeadSize));
                    }
                  } catch (e) {
                    // Ignore
                  }
                }
                existingPdfAnnot.update();
              } catch (updateError) {
                console.warn(`Could not update existing annotation ${annot.id}:`, updateError);
              }
            } else {
              // No existing annotation found, create a new one
              const pdfAnnot = await this.addShapeAnnotation(document, annot);
              // Update the annotation object with the PDF annotation reference
              // Note: This updates the local copy, but we need to update the store
              if (pdfAnnot) {
                annot.pdfAnnotation = pdfAnnot;
              }
            }
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

