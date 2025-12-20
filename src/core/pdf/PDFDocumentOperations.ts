/**
 * PDF Document Operations
 * 
 * Handles document-level operations: syncing annotations, saving, exporting.
 */

import type { PDFDocument } from "./PDFDocument";
import type { Annotation } from "./types";
import { PDFAnnotationOperations } from "./PDFAnnotationOperations";
import { PDFPageOperations } from "./PDFPageOperations";
import { parseColor } from "./utils/colorUtils";

export class PDFDocumentOperations {
  constructor(
    private mupdf: any,
    private annotationOps: PDFAnnotationOperations,
    // @ts-expect-error - pageOps parameter reserved for future use
    private _pageOps: PDFPageOperations
  ) {}

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

  await this.annotationOps.addTextAnnotation(document, annot);

  } else if (annot.type === "highlight") {

  await this.annotationOps.addHighlightAnnotation(document, annot);

  } else if (annot.type === "callout") {

  await this.annotationOps.addCalloutAnnotation(document, annot);

  } else if (annot.type === "redact") {

  await this.annotationOps.addRedactionAnnotation(document, annot);

  } else if (annot.type === "image") {

  await this.annotationOps.addImageAnnotation(document, annot);

  }

  } catch (error) {

  console.error(`Error syncing annotation ${annot.id}:`, error);

  }

  }

  }

  }


  async saveDocument(

  document: PDFDocument,

  annotations?: Annotation[]

  ): Promise<Uint8Array> {
  const mupdfDoc = document.getMupdfDocument();

  const pdfDoc = mupdfDoc.asPDF();


  if (!pdfDoc) {

  throw new Error("Document is not a PDF");

  }

  // CRITICAL FIX: Before syncing, delete ALL custom annotations from ALL pages
  // This ensures deleted annotations are removed even if they're not in the store
  // We need to do this for ALL pages, not just pages with annotations in the store
  const pageCount = document.getPageCount();
  const pageInstances = new Map<number, any>();
  
  for (let pageNumber = 0; pageNumber < pageCount; pageNumber++) {
    try {
      const page = pdfDoc.loadPage(pageNumber);
      pageInstances.set(pageNumber, page);
      
      const currentPageAnnots = page.getAnnotations();
      const annotationsToDelete: any[] = [];
      
      for (const pdfAnnot of currentPageAnnots) {
        try {
          const pdfType = pdfAnnot.getType();
          // Delete Ink annotations (used by overlay highlights and drawings)
          if (pdfType === "Ink") {
            annotationsToDelete.push(pdfAnnot);
          }
          // Delete Highlight annotations (used by text highlights)
          if (pdfType === "Highlight") {
            annotationsToDelete.push(pdfAnnot);
          }
          // Delete shape annotations (Line, Square, Circle)
          if (pdfType === "Line" || pdfType === "Square" || pdfType === "Circle") {
            annotationsToDelete.push(pdfAnnot);
          }
          // Delete custom text annotations (FreeText with CustomAnnotation flag)
          // Also delete stamp annotations (FreeText with StampAnnotation flag, or Stamp type)
          if (pdfType === "FreeText" || pdfType === "Stamp") {
            try {
              const annotObj = pdfAnnot.getObject();
              if (annotObj) {
                const customFlag = annotObj.get("CustomAnnotation");
                const stampFlag = annotObj.get("StampAnnotation");
                // Check for custom text annotation (only for FreeText)
                if (pdfType === "FreeText" && customFlag) {
                  const flagStr = customFlag.toString();
                  if (flagStr === "true" || flagStr === "/true" || 
                      (typeof customFlag === 'boolean' && customFlag === true) ||
                      (customFlag.valueOf && customFlag.valueOf() === true)) {
                    annotationsToDelete.push(pdfAnnot);
                  }
                }
                // Check for stamp annotation (FreeText with StampAnnotation flag, or Stamp type)
                if (stampFlag) {
                  const flagStr = stampFlag.toString();
                  if (flagStr === "true" || flagStr === "/true" || 
                      (typeof stampFlag === 'boolean' && stampFlag === true) ||
                      (stampFlag.valueOf && stampFlag.valueOf() === true)) {
                    annotationsToDelete.push(pdfAnnot);
                  }
                } else if (pdfType === "Stamp") {
                  // For Stamp type, also check contents format as fallback
                  const contents = pdfAnnot.getContents() || "";
                  if (contents) {
                    try {
                      const parsed = JSON.parse(contents);
                      if (parsed.type === "stamp" && parsed.stampData) {
                        annotationsToDelete.push(pdfAnnot);
                      }
                    } catch (e) {
                      // Not JSON, might be a regular Stamp annotation - skip
                    }
                  }
                }
              }
            } catch (e) {
              // Skip if we can't check the flag
            }
          }
        } catch (e) {
          // Skip if we can't determine type
        }
      }
      
      // Also delete Widget annotations (form fields) - they don't appear in getAnnotations()
      // so we need to iterate the Annots array directly
      try {
        const pageObj = page.getObject();
        if (pageObj) {
          const annotsArray = pageObj.get("Annots");
          if (annotsArray && typeof annotsArray.length !== 'undefined') {
            let hasWidgets = false;
            // Iterate backwards to safely delete while iterating
            for (let i = annotsArray.length - 1; i >= 0; i--) {
              try {
                const annotRef = annotsArray.get ? annotsArray.get(i) : annotsArray[i];
                if (annotRef) {
                  const annotObj = annotRef.getObject ? annotRef.getObject() : annotRef;
                  if (annotObj) {
                    const subtype = annotObj.get("Subtype");
                    if (subtype) {
                      const subtypeStr = subtype.getName ? subtype.getName() : subtype.toString();
                      if (subtypeStr === "Widget" || subtypeStr === "/Widget") {
                        // Delete from Annots array
                        try {
                          annotsArray.delete(i);
                          hasWidgets = true;
                        } catch (deleteError) {
                          console.warn(`Could not delete Widget annotation from Annots array:`, deleteError);
                        }
                      }
                    }
                  }
                }
              } catch (e) {
                // Skip if we can't process this annotation
              }
            }
            // Update the page's Annots array
            if (hasWidgets) {
              pageObj.put("Annots", annotsArray);
            }
          }
        }
      } catch (e) {
        console.warn(`Could not delete Widget annotations:`, e);
      }
      
      // Also clear AcroForm Fields array for form fields
      try {
        const catalogObj = pdfDoc.getTrailer().get("Root");
        if (catalogObj) {
          let acroFormObj = catalogObj.get("AcroForm");
          if (acroFormObj) {
            const fieldsArray = acroFormObj.get("Fields");
            if (fieldsArray && typeof fieldsArray.length !== 'undefined') {
              // Clear the Fields array by deleting all elements
              const fieldsLength = fieldsArray.length;
              for (let i = fieldsLength - 1; i >= 0; i--) {
                try {
                  fieldsArray.delete(i);
                } catch (e) {
                  // Skip if deletion fails
                }
              }
              acroFormObj.put("Fields", fieldsArray);
            }
          }
        }
      } catch (e) {
        // Skip if we can't update AcroForm
      }
      
      if (annotationsToDelete.length > 0) {
        // Delete all matching annotations
        for (const pdfAnnot of annotationsToDelete) {
          try {
            page.deleteAnnotation(pdfAnnot);
          } catch (deleteError) {
            console.warn(`Could not delete annotation:`, deleteError);
          }
        }
        
        // CRITICAL: Update the page to persist deletions
        try {
          const pageObj = page.getObject();
          if (pageObj && typeof pageObj.update === 'function') {
            pageObj.update();
          }
          if (typeof page.update === 'function') {
            page.update();
          }
        } catch (e) {
          // Some mupdf versions might not have these methods
        }
      }
    } catch (e) {
      console.warn(`Error cleaning up annotations on page ${pageNumber}:`, e);
    }
  }

  // Sync annotations if provided - this embeds them IN the PDF
  // CRITICAL: Store page instances during sync to reuse them later
  // This prevents losing annotations when reloading pages

  if (annotations && annotations.length > 0) {
  
  await this.syncAllAnnotationsExtended(document, annotations, pageInstances);



  // CRITICAL: After syncing, ensure all annotations are updated on their pages

  // This forces mupdf to write the annotations to the PDF structure

  const pagesWithAnnotations = new Set<number>();

  for (const annot of annotations) {

  pagesWithAnnotations.add(annot.pageNumber);

  }


  // Update all pages that have annotations to ensure they're written to PDF
  // CRITICAL: Reuse page instances from syncAllAnnotationsExtended to avoid losing annotations
  
  for (const pageNumber of pagesWithAnnotations) {

  try {

  // Reuse the same page instance from sync to preserve annotations
  const page = pageInstances.get(pageNumber) || pdfDoc.loadPage(pageNumber);

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

  // CRITICAL: Ensure AcroForm is properly written for form fields
  // This ensures form fields persist after save/reopen
  try {
    const catalogObj = pdfDoc.getTrailer().get("Root");
    if (catalogObj) {
      const acroFormObj = catalogObj.get("AcroForm");
      if (acroFormObj) {
        // Ensure AcroForm is updated to persist form fields
        acroFormObj.update();
        catalogObj.update();
      }
    }
  } catch (acroFormError) {
    // Non-critical - mupdf should handle AcroForm automatically
    console.warn("Could not update AcroForm during save:", acroFormError);
  }

  // Save the PDF with all annotations embedded

  // CRITICAL: Before saving, verify Widget annotations are still present on pages
  // and ensure pages are properly updated
  const pagesWithAnnotationsForCheck = new Set<number>();
  if (annotations && annotations.length > 0) {
    for (const annot of annotations) {
      pagesWithAnnotationsForCheck.add(annot.pageNumber);
    }
  }
  for (const pageNumber of pagesWithAnnotationsForCheck) {
    try {
      // Use pageInstances if available (from syncAllAnnotationsExtended), otherwise load page
      const page = (pageInstances && pageInstances.get(pageNumber)) || pdfDoc.loadPage(pageNumber);
      const finalAnnots = page.getAnnotations();
      const finalWidgetCount = Array.from(finalAnnots).filter((a: any) => a.getType() === 'Widget').length;
      
      // CRITICAL: For Widget annotations, verify they're in AcroForm Fields array
      if (finalWidgetCount > 0) {
        try {
          const catalogObj = pdfDoc.getTrailer().get("Root");
          if (catalogObj) {
            const acroFormObj = catalogObj.get("AcroForm");
            if (acroFormObj) {
              // Ensure AcroForm is updated
              if (typeof acroFormObj.update === 'function') {
                acroFormObj.update();
              }
              if (typeof catalogObj.update === 'function') {
                catalogObj.update();
              }
            }
          }
        } catch (acroFormCheckError) {
        }
      }
      
      // Ensure all annotations on this page are updated one more time
      for (const pdfAnnot of finalAnnots) {
        try {
          pdfAnnot.update();
        } catch (e) {
          console.warn(`Could not update annotation before save:`, e);
        }
      }
    } catch (err) {
      console.error(`Error checking page ${pageNumber} before save:`, err);
    }
  }

  // saveToBuffer() writes the entire PDF including all annotations to a binary buffer

  const buffer = pdfDoc.saveToBuffer();

  return buffer.asUint8Array();

  }


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


  private async addTextAnnotationToPage(page: any, annotation: Annotation, _newPageNumber: number): Promise<void> {

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

  const color = parseColor(annotation.color);

  annot.setColor(color);

  }


  annot.update();

  }


  private async addHighlightAnnotationToPage(page: any, annotation: Annotation, _newPageNumber: number): Promise<void> {

  if (!annotation.quads || annotation.quads.length === 0) return;


  const annot = page.createAnnotation("Highlight");


  // Convert quads to mupdf format

  const quadList: number[] = [];

  for (const quad of annotation.quads) {

  quadList.push(...quad);

  }


  annot.setQuadPoints(quadList);


  if (annotation.color) {

  const color = parseColor(annotation.color);

  annot.setColor(color);

  }


  if (annotation.opacity !== undefined) {

  annot.setOpacity(annotation.opacity);

  }


  annot.update();

  }


  private async addCalloutAnnotationToPage(page: any, annotation: Annotation, _newPageNumber: number): Promise<void> {

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


  private async addImageAnnotationToPage(page: any, annotation: Annotation, _newPageNumber: number): Promise<void> {

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


  private async addDrawingAnnotationToPage(page: any, annotation: Annotation, _newPageNumber: number): Promise<void> {

  if (!annotation.path || annotation.path.length < 2) return;


  const pageBounds = page.getBounds();

  const pageHeight = pageBounds[3] - pageBounds[1];


  const annot = page.createAnnotation("Ink");


  // Convert to array of [x, y] pairs format
  const inkPath: number[][] = [];

  for (const point of annotation.path) {
    inkPath.push([point.x, pageHeight - point.y]);
  }

  annot.setInkList(inkPath);


  if (annotation.color) {

  const color = parseColor(annotation.color);

  annot.setColor(color);

  }


  if (annotation.strokeWidth) {

  annot.setBorder(annotation.strokeWidth);

  }


  annot.update();

  }


  private async addShapeAnnotationToPage(page: any, annotation: Annotation, _newPageNumber: number): Promise<void> {

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

  const color = parseColor(annotation.color);

  annot.setColor(color);

  }


  annot.update();

  }


  async syncAllAnnotationsExtended(

  document: PDFDocument,

  annotations: Annotation[],

  pageInstances?: Map<number, any>

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


  // Reuse page instance if provided, otherwise load it
  let page = pageInstances?.get(pageNumber);
  if (!page) {
    page = pdfDoc.loadPage(pageNumber);
    if (pageInstances) {
      pageInstances.set(pageNumber, page);
    }
  }

  // CRITICAL FIX: Before syncing annotations, delete ALL shape annotations from this page
  // This prevents duplicates when annotations have moved. We'll recreate them all from the store.
  const shapeTypesToDelete = new Set<string>();
  for (const annot of pageAnnotations) {
    if (annot.type === "shape" && annot.shapeType) {
      if (annot.shapeType === "arrow") shapeTypesToDelete.add("Line");
      else if (annot.shapeType === "rectangle") shapeTypesToDelete.add("Square");
      else if (annot.shapeType === "circle") shapeTypesToDelete.add("Circle");
    }
  }
  
  if (shapeTypesToDelete.size > 0) {
    // Get fresh list of annotations (they may have changed)
    const currentPageAnnots = page.getAnnotations();
    const annotationsToDelete: any[] = [];
    
    for (const pdfAnnot of currentPageAnnots) {
      try {
        const pdfType = pdfAnnot.getType();
        if (shapeTypesToDelete.has(pdfType)) {
          annotationsToDelete.push(pdfAnnot);
        }
      } catch (e) {
        // Skip if we can't determine type
      }
    }
    
    // Delete all matching annotations
    let deletedCount = 0;
    for (const pdfAnnot of annotationsToDelete) {
      try {
        page.deleteAnnotation(pdfAnnot);
        deletedCount++;
      } catch (deleteError) {
        console.warn(`Could not delete annotation:`, deleteError);
      }
    }
    
    // Clear pdfAnnotation references for all shape annotations we're about to sync
    // This forces them to be recreated
    for (const annot of pageAnnotations) {
      if (annot.type === "shape") {
        annot.pdfAnnotation = undefined;
      }
    }
  }
  
  // CRITICAL FIX: Before syncing text annotations, delete ALL custom text annotations from this page
  // This prevents duplicates when text annotations are moved and saved multiple times
  // Same approach as shapes - delete all, then recreate from store
  const hasTextAnnotations = pageAnnotations.some(annot => annot.type === "text");
  if (hasTextAnnotations) {
    // Get fresh list of annotations (they may have changed)
    const currentPageAnnots = page.getAnnotations();
    const textAnnotationsToDelete: any[] = [];
    
    for (const pdfAnnot of currentPageAnnots) {
      try {
        const pdfType = pdfAnnot.getType();
        if (pdfType === "FreeText") {
          // Only delete custom text annotations (marked with CustomAnnotation flag)
          try {
            const annotObj = pdfAnnot.getObject();
            if (annotObj) {
              const customFlag = annotObj.get("CustomAnnotation");
              if (customFlag) {
                const flagStr = customFlag.toString();
                // Check if it's marked as custom (PDF name objects return "/true", string objects return "true")
                if (flagStr === "true" || flagStr === "/true" || 
                    (typeof customFlag === 'boolean' && customFlag === true) ||
                    (customFlag.valueOf && customFlag.valueOf() === true)) {
                  textAnnotationsToDelete.push(pdfAnnot);
                }
              }
            }
          } catch (e) {
            // Skip if we can't check the flag
          }
        }
      } catch (e) {
        // Skip if we can't determine type
      }
    }
    
    // Delete all matching text annotations
    let deletedCount = 0;
    for (const pdfAnnot of textAnnotationsToDelete) {
      try {
        page.deleteAnnotation(pdfAnnot);
        deletedCount++;
      } catch (deleteError) {
        console.warn(`Could not delete text annotation:`, deleteError);
      }
    }
    
    // Clear pdfAnnotation references for all text annotations we're about to sync
    // This forces them to be recreated
    for (const annot of pageAnnotations) {
      if (annot.type === "text") {
        annot.pdfAnnotation = undefined;
      }
    }
  }
  
  // CRITICAL FIX: Before syncing highlights and drawings, delete ALL Ink and Highlight annotations from this page
  // This prevents duplicates when highlights/drawings are moved and saved multiple times
  // Same approach as text, shapes, and form fields - delete all, then recreate from store
  const hasHighlights = pageAnnotations.some(annot => annot.type === "highlight");
  const hasDrawings = pageAnnotations.some(annot => annot.type === "draw");
  if (hasHighlights || hasDrawings) {
    // Get fresh list of annotations (they may have changed)
    const currentPageAnnots = page.getAnnotations();
    const annotationsToDelete: any[] = [];
    
    for (const pdfAnnot of currentPageAnnots) {
      try {
        const pdfType = pdfAnnot.getType();
        // Delete Ink annotations (used by overlay highlights and drawings)
        if (pdfType === "Ink") {
          annotationsToDelete.push(pdfAnnot);
        }
        // Delete Highlight annotations (used by text highlights)
        if (pdfType === "Highlight") {
          annotationsToDelete.push(pdfAnnot);
        }
      } catch (e) {
        // Skip if we can't determine type
      }
    }
    
    // Delete all matching annotations
    let deletedCount = 0;
    for (const pdfAnnot of annotationsToDelete) {
      try {
        page.deleteAnnotation(pdfAnnot);
        deletedCount++;
      } catch (deleteError) {
        console.warn(`Could not delete Ink/Highlight annotation:`, deleteError);
      }
    }
    
    // CRITICAL: Update the page to persist deletions
    try {
      // Try updating the page object directly
      const pageObj = page.getObject();
      if (pageObj && typeof pageObj.update === 'function') {
        pageObj.update();
      }
      // Also try page.update() if available
      if (typeof page.update === 'function') {
        page.update();
      }
    } catch (e) {
      // Some mupdf versions might not have these methods
    }
    
    // Clear pdfAnnotation references for all highlight and draw annotations we're about to sync
    // This forces them to be recreated
    for (const annot of pageAnnotations) {
      if (annot.type === "highlight" || annot.type === "draw") {
        annot.pdfAnnotation = undefined;
      }
    }
  }
  
  // CRITICAL FIX: Before syncing form fields, delete ALL Widget annotations from this page
  // This prevents duplicates when form fields are moved and saved multiple times
  // Same approach as text and shapes - delete all, then recreate from store
  // NOTE: page.getAnnotations() doesn't return Widget annotations, so we must iterate Annots array directly
  const hasFormFields = pageAnnotations.some(annot => annot.type === "formField");
  if (hasFormFields) {
    // Delete Widget annotations by iterating the Annots array directly
    try {
      const pageObj = page.getObject();
      if (pageObj) {
        const annotsArray = pageObj.get("Annots");
        if (annotsArray && typeof annotsArray.length !== 'undefined') {
          // Iterate backwards to safely delete while iterating
          for (let i = annotsArray.length - 1; i >= 0; i--) {
            try {
              const annotRef = annotsArray.get ? annotsArray.get(i) : annotsArray[i];
              if (annotRef) {
                const annotObj = annotRef.getObject ? annotRef.getObject() : annotRef;
                if (annotObj) {
                  const subtype = annotObj.get("Subtype");
                  if (subtype) {
                    const subtypeStr = subtype.getName ? subtype.getName() : subtype.toString();
                    if (subtypeStr === "Widget" || subtypeStr === "/Widget") {
                      // Delete from Annots array
                      try {
                        annotsArray.delete(i);
                      } catch (deleteError) {
                        console.warn(`Could not delete Widget annotation from Annots array:`, deleteError);
                      }
                    }
                  }
                }
              }
            } catch (e) {
              // Skip if we can't process this annotation
            }
          }
          // Update the page's Annots array
          pageObj.put("Annots", annotsArray);
        }
      }
    } catch (e) {
      console.warn(`Could not delete Widget annotations:`, e);
    }
    
    // Also clear AcroForm Fields array
    try {
      const catalogObj = pdfDoc.getTrailer().get("Root");
      if (catalogObj) {
        let acroFormObj = catalogObj.get("AcroForm");
        if (acroFormObj) {
          const fieldsArray = acroFormObj.get("Fields");
          if (fieldsArray && typeof fieldsArray.length !== 'undefined') {
            // Clear the Fields array by deleting all elements
            const fieldsLength = fieldsArray.length;
            for (let i = fieldsLength - 1; i >= 0; i--) {
              try {
                fieldsArray.delete(i);
              } catch (e) {
                // Skip if deletion fails
              }
            }
            acroFormObj.put("Fields", fieldsArray);
          }
        }
      }
    } catch (e) {
      // Skip if we can't update AcroForm
    }
    
    // Clear pdfAnnotation references for all form fields we're about to sync
    // This forces them to be recreated
    for (const annot of pageAnnotations) {
      if (annot.type === "formField") {
        annot.pdfAnnotation = undefined;
      }
    }
  }
  
  // CRITICAL FIX: Before syncing stamps, delete ALL stamp annotations from this page
  // This prevents duplicates when stamps are deleted and saved multiple times
  // Same approach as text, shapes, highlights, and form fields - delete all, then recreate from store
  const hasStamps = pageAnnotations.some(annot => annot.type === "stamp");
  if (hasStamps) {
    // Get fresh list of annotations (they may have changed)
    const currentPageAnnots = page.getAnnotations();
    const stampAnnotationsToDelete: any[] = [];
    
    for (const pdfAnnot of currentPageAnnots) {
      try {
        const pdfType = pdfAnnot.getType();
        // Handle both FreeText (old format) and Stamp (new format) annotation types
        if (pdfType === "FreeText" || pdfType === "Stamp") {
          // Only delete stamp annotations (marked with StampAnnotation flag)
          try {
            const annotObj = pdfAnnot.getObject();
            if (annotObj) {
              const stampFlag = annotObj.get("StampAnnotation");
              if (stampFlag) {
                const flagStr = stampFlag.toString();
                // Check if it's marked as a stamp (PDF name objects return "/true", string objects return "true")
                if (flagStr === "true" || flagStr === "/true" || 
                    (typeof stampFlag === 'boolean' && stampFlag === true) ||
                    (stampFlag.valueOf && stampFlag.valueOf() === true)) {
                  stampAnnotationsToDelete.push(pdfAnnot);
                }
              } else if (pdfType === "Stamp") {
                // For Stamp type, also check contents format as fallback
                const contents = pdfAnnot.getContents() || "";
                if (contents) {
                  try {
                    const parsed = JSON.parse(contents);
                    if (parsed.type === "stamp" && parsed.stampData) {
                      stampAnnotationsToDelete.push(pdfAnnot);
                    }
                  } catch (e) {
                    // Not JSON, might be a regular Stamp annotation - skip
                  }
                }
              }
            }
          } catch (e) {
            // Skip if we can't check the flag
          }
        }
      } catch (e) {
        // Skip if we can't determine type
      }
    }
    
    // Delete all matching stamp annotations
    let deletedCount = 0;
    for (const pdfAnnot of stampAnnotationsToDelete) {
      try {
        page.deleteAnnotation(pdfAnnot);
        deletedCount++;
      } catch (deleteError) {
        console.warn(`Could not delete stamp annotation:`, deleteError);
      }
    }
    
    // CRITICAL: Update the page to persist deletions
    try {
      // Try updating the page object directly
      const pageObj = page.getObject();
      if (pageObj && typeof pageObj.update === 'function') {
        pageObj.update();
      }
      // Also try page.update() if available
      if (typeof page.update === 'function') {
        page.update();
      }
    } catch (e) {
      // Some mupdf versions might not have these methods
    }
    
    // Clear pdfAnnotation references for all stamp annotations we're about to sync
    // This forces them to be recreated
    for (const annot of pageAnnotations) {
      if (annot.type === "stamp") {
        annot.pdfAnnotation = undefined;
      }
    }
  }


  for (const annot of pageAnnotations) {

  try {

  // For form fields, update existing ones or create new ones

  if (annot.type === "formField") {

  if (annot.pdfAnnotation) {

  // Update existing form field value and properties

  await this.annotationOps.updateFormFieldValue(document, annot);

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

  // Pass the page object to ensure we're working with the same page instance
  await this.annotationOps.addFormFieldAnnotation(document, annot, page);

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
  annot.pdfAnnotation.update(); // CRITICAL: Call update() to persist changes

  }


  // Update content if it's a text annotation

  if (annot.type === "text" && annot.content !== undefined) {

  annot.pdfAnnotation.setContents(annot.content);

  // CRITICAL: Also update HTMLContent field and ensure CustomAnnotation flag is set
  try {
    const annotObj = annot.pdfAnnotation.getObject();
    if (annotObj) {
      // Ensure CustomAnnotation flag is set (use newName for boolean flag)
      try {
        annotObj.put("CustomAnnotation", this.mupdf.newName("true"));
      } catch (e) {
        // Fallback to newString if newName doesn't exist
        try {
          annotObj.put("CustomAnnotation", this.mupdf.newString("true"));
        } catch (e2) {
          // If both fail, log error but continue
          console.warn("Could not set CustomAnnotation flag:", e2);
        }
      }
      // Update HTMLContent field
      if (annot.content) {
        try {
          annotObj.put("HTMLContent", this.mupdf.newString(annot.content));
        } catch (e) {
          // If newString fails, log error but continue
          console.warn("Could not set HTMLContent:", e);
        }
      }
      
      // Update backgroundColor and hasBackground
      if (annot.hasBackground !== undefined) {
        try {
          annotObj.put("HasBackground", annot.hasBackground ? this.mupdf.newName("true") : this.mupdf.newName("false"));
        } catch (e) {
          try {
            annotObj.put("HasBackground", this.mupdf.newString(annot.hasBackground ? "true" : "false"));
          } catch (e2) {
            // Ignore
          }
        }
      }
      
      if (annot.backgroundColor) {
        try {
          annotObj.put("BackgroundColor", this.mupdf.newString(annot.backgroundColor));
        } catch (e) {
          // Ignore
        }
      }
    }
  } catch (e) {
    // Ignore errors
  }
  
  // Update interior color (background color) if hasBackground is true
  try {
    if (annot.hasBackground && annot.backgroundColor) {
      // Parse backgroundColor - handle both hex and rgba formats
      let bgR = 1, bgG = 1, bgB = 1;
      
      if (annot.backgroundColor.startsWith("#")) {
        const hex = annot.backgroundColor.replace("#", "");
        bgR = parseInt(hex.substring(0, 2), 16) / 255;
        bgG = parseInt(hex.substring(2, 4), 16) / 255;
        bgB = parseInt(hex.substring(4, 6), 16) / 255;
      } else if (annot.backgroundColor.startsWith("rgba") || annot.backgroundColor.startsWith("rgb")) {
        const match = annot.backgroundColor.match(/[\d.]+/g);
        if (match && match.length >= 3) {
          bgR = parseFloat(match[0]) / 255;
          bgG = parseFloat(match[1]) / 255;
          bgB = parseFloat(match[2]) / 255;
        }
      }
      
      annot.pdfAnnotation.setInteriorColor([bgR, bgG, bgB]);
    } else {
      // No background or transparent background
      annot.pdfAnnotation.setInteriorColor([]);
    }
  } catch (e) {
    // setInteriorColor might not be available
  }

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
  // CRITICAL FIX: Use the same format as when creating stamps: {"type":"stamp","stampData":{...}}
  // This ensures stamps can be loaded correctly when the PDF is reopened

  if (annot.type === "stamp" && annot.stampData) {
  const stampDataJson = JSON.stringify({
    type: "stamp",
    stampData: annot.stampData
  });
  annot.pdfAnnotation.setContents(stampDataJson);
  
  // CRITICAL FIX: Also set the StampAnnotation flag during updates
  // This ensures the loader can recognize stamps when the PDF is reopened
  try {
    const annotObj = annot.pdfAnnotation.getObject();
    if (annotObj) {
      // Use newName first (like CustomAnnotation flag), fallback to newString
      try {
        annotObj.put("StampAnnotation", this.mupdf.newName("true"));
      } catch (e) {
        try {
          annotObj.put("StampAnnotation", this.mupdf.newString("true"));
        } catch (e2) {
          // If both fail, try using the PDF document's method
          const pdfDoc = document.getMupdfDocument().asPDF();
          if (pdfDoc && pdfDoc.newName) {
            annotObj.put("StampAnnotation", pdfDoc.newName("true"));
          } else if (pdfDoc && pdfDoc.newString) {
            annotObj.put("StampAnnotation", pdfDoc.newString("true"));
          }
        }
      }
    }
  } catch (e) {
    // Ignore if we can't set the flag
  }

  // CRITICAL FIX: Update the rect to match current annotation dimensions and position
  // This ensures stamps maintain their size and position when reopened
  const pageBounds = page.getBounds();
  const pageHeight = pageBounds[3] - pageBounds[1];
  const pdfY = pageHeight - annot.y - (annot.height || 0);
  const newRect: [number, number, number, number] = [
    annot.x,
    pdfY,
    annot.x + (annot.width || 0),
    pdfY + (annot.height || 0)
  ];
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/904a5175-7f78-4608-b46a-a1e7f31debc4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'PDFDocumentOperations.ts:1491',message:'Updating stamp rect during sync',data:{annotationId:annot.id,displayCoords:{x:annot.x,y:annot.y,width:annot.width,height:annot.height},pdfCoords:{x:newRect[0],y:newRect[1],x2:newRect[2],y2:newRect[3]},pageHeight:pageHeight},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'SYNC'})}).catch(()=>{});
  // #endregion
  annot.pdfAnnotation.setRect(newRect);

  // CRITICAL FIX: Re-embed the image appearance during updates
  // This prevents "DRAFT" from showing in native PDF viewers
  // CRITICAL: Set appearance AFTER rect to ensure proper sizing
  if (annot.stampData.type === "image" && annot.stampData.imageData) {
    try {
      // Extract base64 data from data URL
      const base64Data = annot.stampData.imageData.split(',')[1] || annot.stampData.imageData;
      const imageBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
      
      // Create mupdf Image from buffer
      // Use the same method that works in addImageAnnotationToPage
      const image = this.mupdf.Image.fromBuffer(imageBytes);
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/904a5175-7f78-4608-b46a-a1e7f31debc4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'PDFDocumentOperations.ts:1506',message:'Updating stamp appearance during sync',data:{annotationId:annot.id,imageWidth:image.getWidth(),imageHeight:image.getHeight(),rectWidth:newRect[2]-newRect[0],rectHeight:newRect[3]-newRect[1]},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'APPEARANCE'})}).catch(()=>{});
      // #endregion
      
      // Set the image as the appearance - this makes it visible in native PDF viewers
      // The appearance will be scaled to fit the rect automatically
      annot.pdfAnnotation.setAppearance(image);
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/904a5175-7f78-4608-b46a-a1e7f31debc4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'PDFDocumentOperations.ts:1516',message:'Appearance updated successfully',data:{annotationId:annot.id},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'APPEARANCE'})}).catch(()=>{});
      // #endregion
    } catch (imageError: unknown) {
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/904a5175-7f78-4608-b46a-a1e7f31debc4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'PDFDocumentOperations.ts:1518',message:'Failed to update appearance',data:{annotationId:annot.id,error:imageError instanceof Error ? imageError.message : String(imageError)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'APPEARANCE'})}).catch(()=>{});
      // #endregion
      console.warn("Could not update image appearance for stamp annotation:", imageError);
    }
  }

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

  // Convert PDF coordinates to canvas coordinates for setLine() (getLine() returns canvas, so setLine() expects canvas)

  const pageBounds = page.getBounds();
  const pageHeight = pageBounds[3] - pageBounds[1];
  const canvasStart = { x: start.x, y: pageHeight - start.y };
  const canvasEnd = { x: end.x, y: pageHeight - end.y };

  const lineArray = [[canvasStart.x, canvasStart.y], [canvasEnd.x, canvasEnd.y]];

  console.log("🟡 [ARROW UPDATE] Updating arrow with points:", { start, end }, "to setLine(", lineArray, ")");

  try {

  annot.pdfAnnotation.setLine(lineArray);
  annot.pdfAnnotation.update(); // CRITICAL: Call update() to persist changes

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

  // Try storing as plain number first (like rotation in PDFPageOperations.ts)
  try {

  annotObj.put("ArrowHeadSize", annot.arrowHeadSize);

  annot.pdfAnnotation.update();

  } catch (e) {

  // Fallback: Try with newNumber()
  try {

  annotObj.put("ArrowHeadSize", this.mupdf.newNumber(annot.arrowHeadSize));

  annot.pdfAnnotation.update();

  } catch (e2) {

  // Ignore if both methods fail

  }

  }

  }

  } catch (e) {

  // Ignore if we can't store it

  }

  }

  }

  // Update position for rectangles and circles (arrows are handled above)
  if ((annot.shapeType === "rectangle" || annot.shapeType === "circle") && 
      annot.x !== undefined && annot.y !== undefined && 
      annot.width !== undefined && annot.height !== undefined) {

  const pageBounds = page.getBounds();
  const pageHeight = pageBounds[3] - pageBounds[1];

  const y = pageHeight - annot.y - annot.height;

  const rect: [number, number, number, number] = [
    annot.x,
    y,
    annot.x + annot.width,
    y + annot.height,
  ];

  try {

  annot.pdfAnnotation.setRect(rect);
  annot.pdfAnnotation.update(); // CRITICAL: Call update() to persist changes

  } catch (e) {

  console.warn("🟠 [SHAPE UPDATE] Could not update rectangle/circle position:", e, { rect });

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

  // Update fill color and opacity for shapes (rectangles and circles)

  if (annot.type === "shape" && (annot.shapeType === "rectangle" || annot.shapeType === "circle")) {

  if (annot.fillColor && annot.fillOpacity !== undefined && annot.fillOpacity > 0) {

  const hex = annot.fillColor.replace("#", "");

  const r = parseInt(hex.substring(0, 2), 16) / 255;

  const g = parseInt(hex.substring(2, 4), 16) / 255;

  const b = parseInt(hex.substring(4, 6), 16) / 255;

  try {

  annot.pdfAnnotation.setInteriorColor([r, g, b]);

  if (typeof annot.pdfAnnotation.setOpacity === 'function') {

  annot.pdfAnnotation.setOpacity(annot.fillOpacity);

  }

  } catch (e) {

  console.warn("🟠 [SHAPE UPDATE] Could not update fill color/opacity:", e);

  }

  } else if (annot.fillColor === undefined || annot.fillOpacity === 0 || annot.fillOpacity === undefined) {

  // Clear fill if no fill color or opacity is 0

  try {

  annot.pdfAnnotation.setInteriorColor([]);

  } catch (e) {

  // Interior color might not be available

  }

  }

  }

  }


  // Update draw annotations (ink paths)

  if (annot.type === "draw" && annot.path && annot.path.length >= 2) {

  // Convert to array of [x, y] pairs format
  const inkPath: number[][] = [];

  for (const point of annot.path) {
    inkPath.push([point.x, pageHeight - point.y]);
  }

  try {

  annot.pdfAnnotation.setInkList(inkPath);

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
    
    // Handle overlay highlights (saved as Ink annotations)
    if (annot.highlightMode === "overlay" && annot.path && annot.path.length >= 2) {
      // Convert to array of [x, y] pairs format
      const inkPath: number[][] = [];
      for (const point of annot.path) {
        inkPath.push([point.x, pageHeight - point.y]);
      }
      try {
        annot.pdfAnnotation.setInkList(inkPath);
      } catch {
        try {
          // Fallback: try flat array format
          const flatInkPath: number[] = [];
          for (const point of annot.path) {
            flatInkPath.push(point.x, pageHeight - point.y);
          }
          (annot.pdfAnnotation as any).setInkList([flatInkPath]);
        } catch (e) {
          console.warn("Could not update overlay highlight ink list:", e);
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
    } else if (annot.quads && annot.quads.length > 0) {
      // Handle text highlights (with quads)
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

  // Convert PDF coordinates to canvas coordinates for setLine() (getLine() returns canvas, so setLine() expects canvas)

  const pageBounds = page.getBounds();
  const pageHeight = pageBounds[3] - pageBounds[1];
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
  // CRITICAL FIX: When pdfAnnotation is stale, delete ALL shape annotations of this type
  // on this page. This is safe because we're about to create a new one with the correct position.
  // The old annotations are at their old positions and need to be removed.

  if (annot.type === "shape") {

  // Delete ALL shape annotations of the same type on this page
  // This prevents duplicates when annotations have moved
  const annotationsToDelete: any[] = [];
  
  for (const pdfAnnot of pageAnnotations) {
    try {
      const pdfType = pdfAnnot.getType();
      
      if (annot.shapeType === "arrow" && pdfType === "Line") {
        annotationsToDelete.push(pdfAnnot);
      } else if (annot.shapeType === "rectangle" && pdfType === "Square") {
        annotationsToDelete.push(pdfAnnot);
      } else if (annot.shapeType === "circle" && pdfType === "Circle") {
        annotationsToDelete.push(pdfAnnot);
      }
    } catch (e) {
      // Skip if we can't determine type
    }
  }
  
  // Delete all matching annotations
  let deletedCount = 0;
  for (const pdfAnnot of annotationsToDelete) {
    try {
      page.deleteAnnotation(pdfAnnot);
      deletedCount++;
    } catch (deleteError) {
      console.warn(`Could not delete stale annotation:`, deleteError);
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

  await this.annotationOps.addTextAnnotation(document, annot);

  } else if (annot.type === "highlight") {
  await this.annotationOps.addHighlightAnnotation(document, annot);

  } else if (annot.type === "callout") {

  await this.annotationOps.addCalloutAnnotation(document, annot);

  } else if (annot.type === "redact") {

  await this.annotationOps.addRedactionAnnotation(document, annot);

  } else if (annot.type === "image") {

  await this.annotationOps.addImageAnnotation(document, annot);

  } else if (annot.type === "draw") {
  await this.annotationOps.addDrawingAnnotation(document, annot);

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

  // getLine() returns coordinates in CANVAS space (Y=0 at top) - convert to PDF for comparison

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

  // Update position based on shape type
  if (annot.shapeType === "arrow" && annot.points && annot.points.length >= 2) {

  const start = annot.points[0];

  const end = annot.points[1];

  // Convert PDF coordinates to canvas coordinates for setLine()

  const canvasStart = { x: start.x, y: pageHeight - start.y };

  const canvasEnd = { x: end.x, y: pageHeight - end.y };

  const lineArray = [[canvasStart.x, canvasStart.y], [canvasEnd.x, canvasEnd.y]];

  existingPdfAnnot.setLine(lineArray);

  } else if ((annot.shapeType === "rectangle" || annot.shapeType === "circle") && 
             annot.x !== undefined && annot.y !== undefined && 
             annot.width !== undefined && annot.height !== undefined) {

  // Update position for rectangles and circles
  const y = pageHeight - annot.y - annot.height;

  const rect: [number, number, number, number] = [
    annot.x,
    y,
    annot.x + annot.width,
    y + annot.height,
  ];

  existingPdfAnnot.setRect(rect);

  }

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

  // Update fill color and opacity for rectangles and circles

  if ((annot.shapeType === "rectangle" || annot.shapeType === "circle")) {

  if (annot.fillColor && annot.fillOpacity !== undefined && annot.fillOpacity > 0) {

  const hex = annot.fillColor.replace("#", "");

  const r = parseInt(hex.substring(0, 2), 16) / 255;

  const g = parseInt(hex.substring(2, 4), 16) / 255;

  const b = parseInt(hex.substring(4, 6), 16) / 255;

  try {

  existingPdfAnnot.setInteriorColor([r, g, b]);

  if (typeof existingPdfAnnot.setOpacity === 'function') {

  existingPdfAnnot.setOpacity(annot.fillOpacity);

  }

  } catch (e) {

  console.warn("🟠 [SHAPE UPDATE] Could not update fill color/opacity:", e);

  }

  } else if (annot.fillColor === undefined || annot.fillOpacity === 0 || annot.fillOpacity === undefined) {

  // Clear fill if no fill color or opacity is 0

  try {

  existingPdfAnnot.setInteriorColor([]);

  } catch (e) {

  // Interior color might not be available

  }

  }

  }

  if (annot.arrowHeadSize !== undefined) {

  try {

  const annotObj = existingPdfAnnot.getObject();

  if (annotObj) {

  // Try storing as plain number first (like rotation in PDFPageOperations.ts)
  try {

  annotObj.put("ArrowHeadSize", annot.arrowHeadSize);

  } catch (e) {

  // Fallback: Try with newNumber()
  try {

  annotObj.put("ArrowHeadSize", this.mupdf.newNumber(annot.arrowHeadSize));

  } catch (e2) {

  // Ignore if both methods fail

  }

  }

  }

  } catch (e) {

  // Ignore

  }

  }

  existingPdfAnnot.update(); // CRITICAL: Call update() to persist all changes

  } catch (updateError) {

  console.warn(`Could not update existing annotation ${annot.id}:`, updateError);

  }

  } else {

  // No existing annotation found, create a new one

  const pdfAnnot = await this.annotationOps.addShapeAnnotation(document, annot);

  // Update the annotation object with the PDF annotation reference

  // Note: This updates the local copy, but we need to update the store

  if (pdfAnnot) {

  annot.pdfAnnotation = pdfAnnot;

  }

  }

  } else if (annot.type === "stamp") {

  await this.annotationOps.addStampAnnotation(document, annot);

  }

  } catch (error) {

  console.error(`Error syncing annotation ${annot.id}:`, error);

  }

  }

  }

  }



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

}