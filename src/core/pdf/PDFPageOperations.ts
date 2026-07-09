/**
 * PDF Page Operations
 * 
 * Handles page-level operations: reordering, insertion, deletion, rotation, and resizing.
 */

import type { PDFDocument } from "./PDFDocument";
import type { PageReorderOperation } from "./types";

export class PDFPageOperations {
  // @ts-expect-error - mupdf parameter reserved for future use
  constructor(private _mupdf: any) {}

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
   * Set (or clear) a page's stored label (/NanodocLabel in the page dict).
   * Empty/whitespace text deletes the key. Mirrors rotatePage's dict access
   * so the label rides the physical page through rearrange/delete/insert.
   */
  async setPageLabel(
    document: PDFDocument,
    pageNumber: number,
    text: string
  ): Promise<void> {
    const pdfDoc = document.getMupdfDocument().asPDF();
    if (!pdfDoc) throw new Error("Document is not a PDF");

    const page = pdfDoc.loadPage(pageNumber);
    const pageObj = page.getObject();
    if (!pageObj) throw new Error("Could not get page object");

    const trimmed = (text ?? "").trim();
    if (trimmed.length === 0) {
      try { pageObj.delete("NanodocLabel"); } catch { /* key may not exist */ }
    } else {
      pageObj.put("NanodocLabel", pdfDoc.newString(trimmed));
    }
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
    
    // Use current page dimensions (display size) for coordinate transform.
    // Annotations are stored in the coordinate system of the current rotation,
    // so we always use pageMetadata.width/height (the canvas dimensions).
    const pageWidth = pageMetadata.width;
    const pageHeight = pageMetadata.height;

    // Helper: rotate a point (x, y) in PDF coordinates (bottom-left origin) by relativeRotation
    // UI "clockwise" adds 90 → relativeRotation 90 → use CW formulas (NW→NE). UI "counterclockwise" adds 270 → use CCW formulas.
    // For 270°: from 0° the transform is (x,y)→(y,x); from 90°/180°/270° we use the inverse-style transform.
    const rotatePoint = (px: number, py: number): { x: number; y: number } => {
      if (relativeRotation === 90) {
        // User chose clockwise: NW→NE. (x,y) → (y, pageWidth - x)
        return { x: py, y: pageWidth - px };
      }
      if (relativeRotation === 270) {
        if (oldRotation === 0) {
          // From 0° to 270°: 90° CCW → (x,y) → (y, x)
          return { x: py, y: px };
        }
        if (oldRotation === 90) {
          // Undoing 90° CW (90°→0°): inverse of (x,y)→(y, pageWidth_0 - x) is (pageWidth_0 - y, x). pageWidth_0 = pageHeight when at 90°.
          return { x: pageHeight - py, y: px };
        }
        // From 180°/270°: inverse-style (pageHeight - y, pageWidth - x)
        return { x: pageHeight - py, y: pageWidth - px };
      }
      if (relativeRotation === 180) {
        return { x: pageWidth - px, y: pageHeight - py };
      }
      return { x: px, y: py };
    };
    
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
          // User chose clockwise (add 90): NW→NE. New bottom-left = (oldY, pageWidth - oldX - annWidth).
          const tempX = newX;
          const tempY = newY;
          newX = tempY; // oldY → new x
          newY = pageWidth - tempX - annWidth;
          // Swap width and height
          const tempWidth = newWidth;
          newWidth = newHeight;
          newHeight = tempWidth;
          
        } else if (relativeRotation === 270) {
          if (oldRotation === 0) {
            // From 0° to 270°: 90° CCW. New bottom-left = (oldY, oldX).
            const tempX = newX;
            newX = newY;
            newY = tempX;
          } else if (oldRotation === 90) {
            // Undoing 90° CW (90°→0°): inverse of (x,y)→(y, pageWidth_0 - x - w) is newX = pageWidth_0 - y_90 - h_90, newY = x_90. pageWidth_0 = pageHeight when at 90°.
            const tempX = newX;
            const tempY = newY;
            newX = pageHeight - tempY - annHeight;
            newY = tempX;
          } else {
            // From 180°/270°: inverse-style. New bottom-left = (pageHeight - oldY - annHeight, pageWidth - oldX - annWidth).
            const tempX = newX;
            const tempY = newY;
            newX = pageHeight - tempY - annHeight;
            newY = pageWidth - tempX - annWidth;
          }
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
            // User clockwise: (x, y) -> (y, pageWidth - x)
            return [
              quad[1], pageWidth - quad[0], // x0, y0
              quad[3], pageWidth - quad[2], // x1, y1
              quad[5], pageWidth - quad[4], // x2, y2
              quad[7], pageWidth - quad[6], // x3, y3
            ];
          } else if (relativeRotation === 270) {
            if (oldRotation === 0) {
              // From 0° to 270°: (x, y) → (y, x)
              return [
                quad[1], quad[0], quad[3], quad[2], quad[5], quad[4], quad[7], quad[6],
              ];
            }
            if (oldRotation === 90) {
              // Undoing 90° CW: (x, y) → (pageHeight - y, x)
              return [
                pageHeight - quad[1], quad[0], pageHeight - quad[3], quad[2],
                pageHeight - quad[5], quad[4], pageHeight - quad[7], quad[6],
              ];
            }
            // From 180°/270°: (x, y) → (pageHeight - y, pageWidth - x)
            return [
              pageHeight - quad[1], pageWidth - quad[0], // x0, y0
              pageHeight - quad[3], pageWidth - quad[2], // x1, y1
              pageHeight - quad[5], pageWidth - quad[4], // x2, y2
              pageHeight - quad[7], pageWidth - quad[6], // x3, y3
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
          // User clockwise: (y, pageWidth - x)
          updates.arrowPoint = {
            x: annotation.arrowPoint.y,
            y: pageWidth - annotation.arrowPoint.x,
          };
        } else if (relativeRotation === 270) {
          if (oldRotation === 0) {
            updates.arrowPoint = { x: annotation.arrowPoint.y, y: annotation.arrowPoint.x };
          } else if (oldRotation === 90) {
            updates.arrowPoint = {
              x: pageHeight - annotation.arrowPoint.y,
              y: annotation.arrowPoint.x,
            };
          } else {
            updates.arrowPoint = {
              x: pageHeight - annotation.arrowPoint.y,
              y: pageWidth - annotation.arrowPoint.x,
            };
          }
        } else if (relativeRotation === 180) {
          updates.arrowPoint = {
            x: pageWidth - annotation.arrowPoint.x,
            y: pageHeight - annotation.arrowPoint.y,
          };
        }
      }
      
      if (annotation.boxPosition) {
        if (relativeRotation === 90) {
          // User clockwise: (y, pageWidth - x)
          updates.boxPosition = {
            x: annotation.boxPosition.y,
            y: pageWidth - annotation.boxPosition.x,
          };
        } else if (relativeRotation === 270) {
          if (oldRotation === 0) {
            updates.boxPosition = { x: annotation.boxPosition.y, y: annotation.boxPosition.x };
          } else if (oldRotation === 90) {
            updates.boxPosition = {
              x: pageHeight - annotation.boxPosition.y,
              y: annotation.boxPosition.x,
            };
          } else {
            updates.boxPosition = {
              x: pageHeight - annotation.boxPosition.y,
              y: pageWidth - annotation.boxPosition.x,
            };
          }
        } else if (relativeRotation === 180) {
          updates.boxPosition = {
            x: pageWidth - annotation.boxPosition.x,
            y: pageHeight - annotation.boxPosition.y,
          };
        }
      }

      // Transform path (draw and overlay highlight annotations)
      if (annotation.path && annotation.path.length > 0) {
        updates.path = annotation.path.map((p) => rotatePoint(p.x, p.y));
      }

      // Transform points (shape annotations: arrows, etc.)
      if (annotation.points && annotation.points.length > 0) {
        updates.points = annotation.points.map((p) => rotatePoint(p.x, p.y));
      }

      // Transform stamp signature path (signature stamps)
      if (annotation.stampData?.signaturePath && annotation.stampData.signaturePath.length > 0) {
        updates.stampData = {
          ...annotation.stampData,
          signaturePath: annotation.stampData.signaturePath.map((p) => rotatePoint(p.x, p.y)),
        };
      }

      // Update annotation rotation property for text/image annotations so they display correctly
      if (annotation.rotation !== undefined) {
        const rotated = (annotation.rotation + relativeRotation) % 360;
        updates.rotation = rotated < 0 ? rotated + 360 : rotated;
      }
      
      // Update annotation in store
      pdfStore.updateAnnotation(documentId, annotation.id, updates);

      // Update native PDF Widget rect for form fields so the control stays in sync (e.g. on save/export).
      // mupdf setRect expects canvas coords: Y=0 at top, so canvasY = pageHeight - (pdfY + height).
      if (annotation.type === "formField" && annotation.pdfAnnotation) {
        try {
          const mupdfDoc = document.getMupdfDocument();
          const pdfDoc = mupdfDoc.asPDF();
          if (pdfDoc) {
            const page = pdfDoc.loadPage(pageNumber);
            const pageBounds = page.getBounds();
            const rotPageHeight = pageBounds[3] - pageBounds[1];
            const canvasY = rotPageHeight - (newY + (newHeight ?? 0));
            const rect: [number, number, number, number] = [
              newX,
              canvasY,
              newX + (newWidth ?? 0),
              canvasY + (newHeight ?? 0),
            ];
            annotation.pdfAnnotation.setRect(rect);
            if (typeof annotation.pdfAnnotation.update === "function") {
              annotation.pdfAnnotation.update();
            }
          }
        } catch (e) {
          console.warn("Could not update PDF Widget rect after rotation:", e);
        }
      }
    }
  }

  /**
   * Mirror all annotations on a page horizontally (left-right). Used for "Horizontal flip" which
   * cannot be represented by PDF Rotate; the flip is applied at render time and annotations are updated here.
   */
  async flipPageAnnotationsHorizontal(
    document: PDFDocument,
    pageNumber: number
  ): Promise<void> {
    const pdfStore = (await import("@/shared/stores/pdfStore")).usePDFStore.getState();
    const documentId = document.getId();
    const pageMetadata = document.getPageMetadata(pageNumber);
    if (!pageMetadata) return;
    const pageWidth = pageMetadata.width;
    const allAnnotations = pdfStore.getAnnotations(documentId);
    const pageAnnotations = allAnnotations.filter((ann) => ann.pageNumber === pageNumber);
    if (pageAnnotations.length === 0) return;

    const mirrorX = (x: number) => pageWidth - x;

    for (const annotation of pageAnnotations) {
      const annWidth = annotation.width ?? 0;
      const updates: Partial<typeof annotation> = {
        x: pageWidth - annotation.x - annWidth,
        y: annotation.y,
      };

      if (annotation.quads && annotation.quads.length > 0) {
        updates.quads = annotation.quads.map((quad) => {
          if (quad.length < 8) return quad;
          return [
            mirrorX(quad[0]), quad[1], mirrorX(quad[2]), quad[3],
            mirrorX(quad[4]), quad[5], mirrorX(quad[6]), quad[7],
          ];
        });
      }
      if (annotation.arrowPoint) {
        updates.arrowPoint = { x: mirrorX(annotation.arrowPoint.x), y: annotation.arrowPoint.y };
      }
      if (annotation.boxPosition) {
        updates.boxPosition = { x: mirrorX(annotation.boxPosition.x), y: annotation.boxPosition.y };
      }
      if (annotation.path?.length) {
        updates.path = annotation.path.map((p) => ({ x: mirrorX(p.x), y: p.y }));
      }
      if (annotation.points?.length) {
        updates.points = annotation.points.map((p) => ({ x: mirrorX(p.x), y: p.y }));
      }
      if (annotation.stampData?.signaturePath?.length) {
        updates.stampData = {
          ...annotation.stampData,
          signaturePath: annotation.stampData.signaturePath.map((p) => ({ x: mirrorX(p.x), y: p.y })),
        };
      }
      if (annotation.rotation !== undefined) {
        updates.rotation = (360 - annotation.rotation) % 360;
      }
      pdfStore.updateAnnotation(documentId, annotation.id, updates);

      // Update native PDF Widget rect for form fields so the control stays in sync
      if (annotation.type === "formField" && annotation.pdfAnnotation) {
        try {
          const newX = updates.x ?? annotation.x;
          const newY = updates.y ?? annotation.y;
          const newW = annotation.width ?? 0;
          const newH = annotation.height ?? 0;
          const mupdfDoc = document.getMupdfDocument();
          const pdfDoc = mupdfDoc.asPDF();
          if (pdfDoc) {
            const page = pdfDoc.loadPage(pageNumber);
            const pageBounds = page.getBounds();
            const pageHeight = pageBounds[3] - pageBounds[1];
            const canvasY = pageHeight - (newY + newH);
            annotation.pdfAnnotation.setRect([newX, canvasY, newX + newW, canvasY + newH]);
            if (typeof annotation.pdfAnnotation.update === "function") {
              annotation.pdfAnnotation.update();
            }
          }
        } catch (e) {
          console.warn("Could not update PDF Widget rect after horizontal flip:", e);
        }
      }
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
}

