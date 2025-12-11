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
  type: "text" | "highlight" | "note" | "callout";
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

    // Create mediabox rect [x0, y0, x1, y1]
    const mediabox: [number, number, number, number] = [0, 0, width, height];
    const pageObj = pdfDoc.addPage(mediabox, 0, null, null);
    pdfDoc.insertPage(index, pageObj);
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
    
    console.log(`Rotation: current=${currentRotation}°, add=${degrees}°, new=${newRotation}°, final=${finalRotation}°`);
    
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
          console.log(`Set rotation to ${finalRotation}° using Method 1`);
        } catch (e) {
          console.warn("Method 1 (put with newNumber) failed:", e);
        }
      }
      
      // Method 2: Use put with plain number
      if (!rotationSet && pageObj.put) {
        try {
          pageObj.put("Rotate", finalRotation);
          rotationSet = true;
          console.log(`Set rotation to ${finalRotation}° using Method 2`);
        } catch (e) {
          console.warn("Method 2 (put with number) failed:", e);
        }
      }
      
      // Method 3: Use set method
      if (!rotationSet && pageObj.set) {
        try {
          pageObj.set("Rotate", finalRotation);
          rotationSet = true;
          console.log(`Set rotation to ${finalRotation}° using Method 3`);
        } catch (e) {
          console.warn("Method 3 (set) failed:", e);
        }
      }
      
      if (!rotationSet) {
        throw new Error("All rotation setting methods failed");
      }
    } catch (e) {
      console.error("Error setting page rotation:", e);
      throw new Error(`Failed to rotate page: ${e}`);
    }
    
    // Update page metadata to reflect new rotation
    // This is important because rotation affects page bounds (width/height swap at 90/270)
    // We need to reload the page to get updated bounds
    const updatedPage = pdfDoc.loadPage(pageNumber);
    const updatedBounds = updatedPage.getBounds();
    const updatedWidth = updatedBounds[2] - updatedBounds[0];
    const updatedHeight = updatedBounds[3] - updatedBounds[1];
    console.log(`After rotation: bounds width=${updatedWidth}, height=${updatedHeight}, rotation=${finalRotation}°`);
    
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
    const mupdfDoc = document.getMupdfDocument();
    const pdfDoc = mupdfDoc.asPDF();
    const page = pdfDoc.loadPage(pageNumber);
    const bounds = page.getBounds();
    const pageWidth = bounds[2] - bounds[0];
    const pageHeight = bounds[3] - bounds[1];
    
      // Transform each annotation's coordinates based on rotation
      // Note: PDF coordinates use bottom-left origin, but our annotations use top-left
      // We need to account for this when transforming
      for (const annotation of pageAnnotations) {
        let newX = annotation.x;
        let newY = annotation.y;
        let newWidth = annotation.width;
        let newHeight = annotation.height;
        let newAnnotationRotation = annotation.rotation || 0;
        
        // Apply rotation transformation
        // For 90° rotation (counter-clockwise): (x, y) -> (pageHeight - y - height, x), swap width/height
        // For 270° rotation (clockwise): (x, y) -> (y, pageWidth - x - width), swap width/height
        // For 180° rotation: (x, y) -> (pageWidth - x - width, pageHeight - y - height)
        
        const annWidth = newWidth || 0;
        const annHeight = newHeight || 0;
        
        if (relativeRotation === 90) {
          // Rotate 90° counter-clockwise
          // Top-left corner: (x, y) -> (pageHeight - y - height, x)
          const tempX = newX;
          newX = pageHeight - newY - annHeight;
          newY = tempX;
          // Swap width and height
          const tempWidth = newWidth;
          newWidth = newHeight;
          newHeight = tempWidth;
          // Adjust annotation rotation (add 90°)
          newAnnotationRotation = ((newAnnotationRotation + 90) % 360);
        } else if (relativeRotation === 270) {
          // Rotate 270° counter-clockwise (90° clockwise)
          // Top-left corner: (x, y) -> (y, pageWidth - x - width)
          const tempX = newX;
          newX = newY;
          newY = pageWidth - tempX - annWidth;
          // Swap width and height
          const tempWidth = newWidth;
          newWidth = newHeight;
          newHeight = tempWidth;
          // Adjust annotation rotation (subtract 90°)
          newAnnotationRotation = ((newAnnotationRotation - 90 + 360) % 360);
        } else if (relativeRotation === 180) {
          // Rotate 180°
          // Top-left corner: (x, y) -> (pageWidth - x - width, pageHeight - y - height)
          newX = pageWidth - newX - annWidth;
          newY = pageHeight - newY - annHeight;
          // Adjust annotation rotation (add 180°)
          newAnnotationRotation = ((newAnnotationRotation + 180) % 360);
        }
        
        // Update annotation coordinates
      const updates: Partial<typeof annotation> = {
        x: newX,
        y: newY,
      };
      
      if (newWidth !== undefined) updates.width = newWidth;
      if (newHeight !== undefined) updates.height = newHeight;
      if (newAnnotationRotation !== (annotation.rotation || 0)) {
        updates.rotation = newAnnotationRotation;
      }
      
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
    
    // Get current mediabox
    const mediabox = page.getMediabox();
    
    // Create new mediabox with new dimensions
    const newMediabox: [number, number, number, number] = [
      mediabox[0], // x0 (usually 0)
      mediabox[1], // y0 (usually 0)
      mediabox[0] + width,  // x1
      mediabox[1] + height   // y1
    ];
    
    // Set new mediabox
    page.setMediabox(newMediabox);
    
    // Update page metadata
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
    
    if (!annotation.quads || annotation.quads.length === 0) {
      throw new Error("Highlight annotation requires quads");
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

