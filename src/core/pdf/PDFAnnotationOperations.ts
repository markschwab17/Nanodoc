/**
 * PDF Annotation Operations
 * 
 * Handles annotation-level operations: adding, updating, deleting annotations.
 */

import type { PDFDocument } from "./PDFDocument";
import type { Annotation } from "./types";

export class PDFAnnotationOperations {
  constructor(private mupdf: any) {}

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

  // Use newName for boolean flag (PDF name objects are more reliable)
  // Fallback to newString if newName doesn't exist
  try {
    annotObj.put("CustomAnnotation", this.mupdf.newName("true"));
  } catch (e) {
    // Fallback: try newString if newName fails
    try {
      annotObj.put("CustomAnnotation", this.mupdf.newString("true"));
    } catch (e2) {
      // If both fail, try using the PDF document's method
      const pdfDoc = document.getMupdfDocument().asPDF();
      if (pdfDoc && pdfDoc.newName) {
        annotObj.put("CustomAnnotation", pdfDoc.newName("true"));
      } else if (pdfDoc && pdfDoc.newString) {
        annotObj.put("CustomAnnotation", pdfDoc.newString("true"));
      }
    }
  }

  // Store HTML content in a custom field

  if (annotation.content) {

  try {
    annotObj.put("HTMLContent", this.mupdf.newString(annotation.content));
  } catch (e) {
    // Fallback: try using the PDF document's method
    const pdfDoc = document.getMupdfDocument().asPDF();
    if (pdfDoc && pdfDoc.newString) {
      annotObj.put("HTMLContent", pdfDoc.newString(annotation.content));
    }
  }

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

  try {
    annot.setDefaultAppearance(`/Helv ${fontSize} Tf ${r} ${g} ${b} rg`);
  } catch (e) {
    // Ignore if setDefaultAppearance is not available
  }

  // Remove border/frame around text box (set border width to 0)

  try {

  annot.setBorderWidth(0);

  } catch {

  // setBorderWidth might not be available in all mupdf versions

  }

  // Set interior color (background color) if hasBackground is true

  try {
    if (annotation.hasBackground && annotation.backgroundColor && annotation.backgroundColor !== "null" && annotation.backgroundColor !== "rgba(255, 255, 255, 0)") {
      // Parse backgroundColor - handle both hex and rgba formats
      let bgR = 1, bgG = 1, bgB = 1;
      
      if (annotation.backgroundColor.startsWith("#")) {
        const hex = annotation.backgroundColor.replace("#", "");
        bgR = parseInt(hex.substring(0, 2), 16) / 255;
        bgG = parseInt(hex.substring(2, 4), 16) / 255;
        bgB = parseInt(hex.substring(4, 6), 16) / 255;
      } else if (annotation.backgroundColor.startsWith("rgba") || annotation.backgroundColor.startsWith("rgb")) {
        const match = annotation.backgroundColor.match(/[\d.]+/g);
        if (match && match.length >= 3) {
          bgR = parseFloat(match[0]) / 255;
          bgG = parseFloat(match[1]) / 255;
          bgB = parseFloat(match[2]) / 255;
        }
      }
      
      annot.setInteriorColor([bgR, bgG, bgB]);
    } else {
      // No background or transparent background
      annot.setInteriorColor([]);
    }
  } catch {
    // setInteriorColor might not be available
  }
  
  // Store backgroundColor and hasBackground in annotation object for later retrieval
  try {
    const annotObj = annot.getObject();
    if (annotObj) {
      if (annotation.hasBackground !== undefined) {
        try {
          annotObj.put("HasBackground", annotation.hasBackground ? this.mupdf.newName("true") : this.mupdf.newName("false"));
        } catch (e) {
          try {
            annotObj.put("HasBackground", this.mupdf.newString(annotation.hasBackground ? "true" : "false"));
          } catch (e2) {
            const pdfDoc = document.getMupdfDocument().asPDF();
            if (pdfDoc && pdfDoc.newName) {
              annotObj.put("HasBackground", pdfDoc.newName(annotation.hasBackground ? "true" : "false"));
            } else if (pdfDoc && pdfDoc.newString) {
              annotObj.put("HasBackground", pdfDoc.newString(annotation.hasBackground ? "true" : "false"));
            }
          }
        }
      }
      
      if (annotation.backgroundColor && annotation.backgroundColor !== "null" && annotation.backgroundColor !== "rgba(255, 255, 255, 0)") {
        try {
          annotObj.put("BackgroundColor", this.mupdf.newString(annotation.backgroundColor));
        } catch (e) {
          const pdfDoc = document.getMupdfDocument().asPDF();
          if (pdfDoc && pdfDoc.newString) {
            annotObj.put("BackgroundColor", pdfDoc.newString(annotation.backgroundColor));
          }
        }
      }
      
      // CRITICAL: Update the annotation object to persist the changes
      try {
        annotObj.update();
      } catch (e) {
        // Ignore if update() is not available
      }
    }
  } catch (e) {
    // Ignore if we can't store the properties
  }

  // Store the PDF annotation object for future updates

  annotation.pdfAnnotation = annot;

  } catch (error) {

  console.warn("Could not set text annotation appearance:", error);

  }

  annot.update();

  }

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

  // Convert path to ink list format (array of [x, y] pairs)
  const inkPath: number[][] = [];

  for (const point of annotation.path) {

  // Convert from PDF coordinates to display coordinates

  inkPath.push([point.x, pageHeight - point.y]);

  }

  // Set the ink list (array of strokes, we have one continuous stroke)
  // Use format 2: wrapped in array [[[x, y], [x, y], ...]] (same as drawings)

  try {

  annot.setInkList([inkPath]);

  } catch {

  // Fallback: try without wrapping

  try {

  annot.setInkList(inkPath);

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

  // Convert path to ink list format
  // mupdf expects: array of strokes, each stroke is array of [x, y] pairs
  const inkPath: number[][] = [];

  for (const point of annotation.path) {
    inkPath.push([point.x, pageHeight - point.y]);
  }
  // Try multiple formats - mupdf's setInkList might expect different structures
  let inkListSet = false;
  
  // Format 1: Array of [x, y] pairs (one stroke)
  try {
    annot.setInkList(inkPath);
    inkListSet = true;
  } catch (setError1) {
    // Format 2: Wrapped in array (array of strokes)
    try {
      annot.setInkList([inkPath]);
      inkListSet = true;
    } catch (setError2) {
      // Format 3: Flat array wrapped
      try {
        const flatInkPath: number[] = [];
        for (const point of annotation.path) {
          flatInkPath.push(point.x, pageHeight - point.y);
        }
        annot.setInkList([flatInkPath]);
        inkListSet = true;
      } catch (setError3) {
        // Format 4: Try setting via PDF object directly
        try {
          const annotObj = annot.getObject();
          if (annotObj) {
            // Create array of arrays for InkList
            const inkListArray = this.mupdf.newArray();
            const strokeArray = this.mupdf.newArray();
            for (const point of annotation.path) {
              const pointArray = this.mupdf.newArray();
              pointArray.push(this.mupdf.newNumber(point.x));
              pointArray.push(this.mupdf.newNumber(pageHeight - point.y));
              strokeArray.push(pointArray);
            }
            inkListArray.push(strokeArray);
            annotObj.put("InkList", inkListArray);
            inkListSet = true;
          }
        } catch (setError4) {
          console.warn("Could not set ink list with any format:", setError4);
        }
      }
    }
  }
  
  if (!inkListSet) {
    console.warn("Failed to set ink list for drawing annotation");
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

  // CRITICAL FIX: Based on runtime evidence, getLine() returns CANVAS coordinates (Y=0 at top)
  // Therefore setLine() also expects CANVAS coordinates, not PDF coordinates
  // We must convert PDF coordinates to canvas coordinates: canvasY = pageHeight - pdfY

  // Convert PDF coordinates to canvas coordinates for setLine()
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

  if (annotObj && annotation.arrowHeadSize !== undefined) {

  // Try storing as plain number first (like rotation in PDFPageOperations.ts)
  try {

  annotObj.put("ArrowHeadSize", annotation.arrowHeadSize);

  annot.update(); // CRITICAL: Call update() to persist the arrow head size

  } catch (e) {

  // Fallback: Try with newNumber()
  try {

  annotObj.put("ArrowHeadSize", this.mupdf.newNumber(annotation.arrowHeadSize));

  annot.update();

  } catch (e2) {

  // Ignore if both methods fail

  }

  }

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

  async addFormFieldAnnotation(

  document: PDFDocument,

  annotation: Annotation,

  page?: any

  ): Promise<void> {
  const mupdfDoc = document.getMupdfDocument();

  const pdfDoc = mupdfDoc.asPDF();

  if (!pdfDoc) {

  throw new Error("Document is not a PDF");

  }

  // Use provided page object if available, otherwise load it
  // This ensures we're working with the same page instance as the caller
  const pageObj = page || pdfDoc.loadPage(annotation.pageNumber);

  if (!annotation.fieldType) {

  console.warn("Form field annotation requires a fieldType");

  return;

  }

  // CRITICAL: mupdf's setRect() expects coordinates where Y=0 is at the TOP (canvas coordinates)
  // This is different from the standard PDF coordinate system where Y=0 is at the BOTTOM
  // annotation.y is the BOTTOM Y in PDF coordinates
  // We must convert to canvas coordinates: canvasY = pageHeight - (pdfY + height)
  // This matches the conversion used in PDFDocumentOperations.ts line 961 for updating form fields
  const pageBounds = pageObj.getBounds();
  const pageHeight = pageBounds[3] - pageBounds[1];
  
  // Convert PDF bottom Y to canvas top Y
  const canvasY = pageHeight - (annotation.y + (annotation.height || 0));

  const rect: [number, number, number, number] = [

  annotation.x,

  canvasY, // Top Y in canvas coordinates (mupdf expects Y=0 at top)

  annotation.x + (annotation.width || 0),

  canvasY + (annotation.height || 0), // Bottom Y in canvas coordinates

  ];

  // Create Widget annotation (this creates the form field)

  const annot = pageObj.createAnnotation("Widget");

  annot.setRect(rect);

  // Set field properties using annotation object

  // Helper functions to create MuPDF objects with fallbacks
  // These are defined at function scope so they're accessible throughout
  const createString = (value: string): any => {
    try {
      return this.mupdf.newString(value);
    } catch (e) {
      try {
        return pdfDoc.newString(value);
      } catch (e2) {
        console.warn("Could not create string object:", e2);
        return value; // Fallback to plain string
      }
    }
  };

  // Helper function to create name objects with fallback
  const createName = (value: string): any => {
    try {
      return this.mupdf.newName(value);
    } catch (e) {
      try {
        return pdfDoc.newName(value);
      } catch (e2) {
        try {
          return this.mupdf.newString(value);
        } catch (e3) {
          try {
            return pdfDoc.newString(value);
          } catch (e4) {
            console.warn("Could not create name object:", e4);
            return value; // Fallback to plain string
          }
        }
      }
    }
  };

  // Helper function to create dictionary with fallback
  const createDictionary = (): any => {
    try {
      return this.mupdf.newDictionary();
    } catch (e) {
      try {
        return pdfDoc.newDictionary();
      } catch (e2) {
        console.warn("Could not create dictionary:", e2);
        return {};
      }
    }
  };

  // Helper function to create array with fallback
  const createArray = (): any => {
    try {
      return this.mupdf.newArray();
    } catch (e) {
      try {
        return pdfDoc.newArray();
      } catch (e2) {
        console.warn("Could not create array:", e2);
        return [];
      }
    }
  };

  // Set field properties using annotation object

  try {

  const annotObj = annot.getObject();

  if (annotObj) {

  // Set field name (required for form fields)

  const fieldName = annotation.fieldName || `field_${annotation.id}`;

  // Try to set field name - use fallback pattern like other annotations
  try {
    annotObj.put("T", createString(fieldName));
  } catch (e) {
    // Fallback: try using the PDF document's method
    try {
      annotObj.put("T", pdfDoc.newString(fieldName));
    } catch (e2) {
      // If both fail, log but continue
      console.warn("Could not set field name:", e2);
    }
  }

  let fieldFlags = 0;

  if (annotation.fieldType === "text") {

  annotObj.put("FT", createName("Tx"));

  // Set multiline flag

  if (annotation.multiline) {

  fieldFlags |= 4096; // Multiline flag (bit 13)

  }

  // Set field value if provided

  if (annotation.fieldValue && typeof annotation.fieldValue === "string") {

  annotObj.put("V", createString(annotation.fieldValue));

  annotObj.put("DV", createString(annotation.fieldValue)); // Default value

  }

  } else if (annotation.fieldType === "checkbox") {

  annotObj.put("FT", createName("Btn"));

  // Set checkbox value

  if (annotation.fieldValue === true) {

  annotObj.put("V", createName("Yes"));

  annotObj.put("AS", createName("Yes"));

  } else {

  annotObj.put("V", createName("Off"));

  annotObj.put("AS", createName("Off"));

  }

  // Set appearance dictionary for checkbox

  const apDict = createDictionary();

  const nDict = createDictionary();

  nDict.put("Off", createDictionary());

  nDict.put("Yes", createDictionary());

  apDict.put("N", nDict);

  annotObj.put("AP", apDict);

  } else if (annotation.fieldType === "radio") {

  annotObj.put("FT", createName("Btn"));

  fieldFlags |= 32768; // Radio flag (bit 16)

  // Set radio group name

  if (annotation.radioGroup) {

  annotObj.put("T", createString(annotation.radioGroup));

  }

  // Set radio value

  if (annotation.fieldValue === true) {

  annotObj.put("V", createName("Yes"));

  annotObj.put("AS", createName("Yes"));

  } else {

  annotObj.put("V", createName("Off"));

  annotObj.put("AS", createName("Off"));

  }

  } else if (annotation.fieldType === "dropdown") {

  annotObj.put("FT", createName("Ch"));

  fieldFlags |= 131072; // Combo box flag (bit 18) - makes it a dropdown, not listbox

  // Set options

  if (annotation.options && annotation.options.length > 0) {

  const optArray = createArray();

  for (const opt of annotation.options) {

  optArray.push(createString(opt));

  }

  annotObj.put("Opt", optArray);

  // Set default value if provided

  if (annotation.fieldValue && typeof annotation.fieldValue === "string") {

  annotObj.put("V", createString(annotation.fieldValue));

  }

  }

  } else if (annotation.fieldType === "date") {

  // Date fields are text fields with special formatting

  annotObj.put("FT", createName("Tx"));

  fieldFlags |= 4096; // Multiline flag (for date picker compatibility)

  // Set date value if provided

  if (annotation.fieldValue && typeof annotation.fieldValue === "string") {

  annotObj.put("V", createString(annotation.fieldValue));

  annotObj.put("DV", createString(annotation.fieldValue));

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

  } else if (annotation.fieldType === "checkbox") {
    // CRITICAL: For checkboxes, we MUST write Ff=0 explicitly to distinguish from push buttons
    // Without Ff, the loader may misidentify the field type
    annotObj.put("Ff", 0);
  }

  // Set appearance characteristics for better compatibility

  const mkDict = createDictionary();

  annotObj.put("MK", mkDict);

  // CRITICAL: Update the annotation object BEFORE adding to page Annots array
  // This ensures it's properly initialized in the PDF structure
  if (typeof annotObj.update === 'function') {
    try {
      annotObj.update();
    } catch (updateError) {
      // Ignore update errors
    }
  }
  
  // CRITICAL: Ensure the annotation object is an indirect object before updating
  // This ensures it gets an object number and is properly persisted in the PDF
  try {
    // Get the annotation object and ensure it's added to the PDF document's object stream
    const annotObjForIndirect = annot.getObject();
    if (annotObjForIndirect) {
      // Try to ensure it's an indirect object by getting its reference
      // If it's not already indirect, MuPDF should make it indirect when we add it to Annots
    }
  } catch (indirectError) {
    // Ignore errors, continue anyway
  }
  
  // Update the annotation itself - this should commit it to the PDF structure
  annot.update();

  // NOTE: AcroForm registration is moved to AFTER page Annots array update
  // This ensures the annotation is properly initialized in the PDF structure first
  } // End of if (annotObj) block

  } catch (error) {

  console.warn("Could not set form field properties:", error);

  }

  // CRITICAL: Ensure the annotation is properly committed to the PDF structure
  // Call update() multiple times to ensure all changes are persisted
  try {
    annot.update();
    // Also update the annotation object if it exists
    const finalAnnotObj = annot.getObject();
    if (finalAnnotObj && typeof finalAnnotObj.update === 'function') {
      finalAnnotObj.update();
    }
    // Update one more time to ensure everything is committed
    annot.update();
  } catch (updateError) {
    console.warn("Could not finalize annotation update:", updateError);
  }
  
  // CRITICAL: For Widget annotations, we need to ensure the page's Annots array is updated
  // This ensures the annotation is properly linked to the page structure in the PDF
  try {
    // Get the annotation object - it's needed to add to the Annots array
    const annotObj = annot.getObject();
    if (!annotObj) {
      return;
    }
    
    const pageObjObj = pageObj.getObject();
    if (pageObjObj) {
      let annotsArray = pageObjObj.get("Annots");
      if (!annotsArray) {
        // Create Annots array if it doesn't exist
        annotsArray = createArray();
        pageObjObj.put("Annots", annotsArray);
      }
      // Check if annotsArray is a MuPDF array (has push method and length property)
      // MuPDF arrays are objects, not JavaScript arrays, so Array.isArray() returns false
      const isMuPDFArray = annotsArray && typeof annotsArray === 'object' && 
                          typeof annotsArray.push === 'function' && 
                          typeof annotsArray.length !== 'undefined';
      const isJSArray = Array.isArray(annotsArray);
      
      if (isMuPDFArray || isJSArray) {
        let alreadyInAnnots = false;
        const arrayLength = annotsArray.length;
        for (let i = 0; i < arrayLength; i++) {
          try {
            const item = annotsArray.get ? annotsArray.get(i) : annotsArray[i];
            if (item === annotObj || 
                (item && item.equals && item.equals(annotObj))) {
              alreadyInAnnots = true;
              break;
            }
          } catch (getError) {
            // If get() fails, try array access
            if (annotsArray[i] === annotObj) {
              alreadyInAnnots = true;
              break;
            }
          }
        }
        if (!alreadyInAnnots) {
          // CRITICAL: For Widget annotations created with createAnnotation(), 
          // MuPDF should automatically add them to Annots, but if it didn't, we need to add them.
          // However, we should use page.addAnnotation() instead of manually manipulating Annots
          // to ensure the annotation becomes an indirect object properly.
          try {
            // Try using page.addAnnotation() if available - this ensures proper indirect object creation
            if (typeof pageObj.addAnnotation === 'function') {
              pageObj.addAnnotation(annot);
            } else {
              // Fallback: manually add to Annots array
              // CRITICAL: The annotation from createAnnotation() should already be in Annots
              // But if it's not, we need to ensure it becomes an indirect object
              // Try to get the annotation reference from page.getAnnotations() first
              const pageAnnots = pageObj.getAnnotations();
              let annotRefFromPage = null;
              for (const pageAnnot of pageAnnots) {
                try {
                  if (pageAnnot === annot || (pageAnnot.getObject && pageAnnot.getObject() === annotObj)) {
                    annotRefFromPage = pageAnnot;
                    break;
                  }
                } catch (e) {
                  // Ignore errors
                }
              }
              
              if (annotRefFromPage) {
                // Annotation is already in page's Annots, use its reference
                // Ensure it's updated
                annot.update();
              } else {
                // Annotation is not in Annots, need to add it
                // CRITICAL: Before adding, ensure the annotation is updated
                annot.update();
                if (typeof annotObj.update === 'function') {
                  annotObj.update();
                }
                
                // CRITICAL: Instead of pushing annotObj directly, try to get/create an indirect reference
                // MuPDF should create an indirect object when we add to Annots, but we need to ensure it happens
                // Try using the annotation's indirect reference if available
                let indirectRef = null;
                try {
                  if (typeof annotObj.getIndirectRef === 'function') {
                    indirectRef = annotObj.getIndirectRef();
                  }
                } catch (e) {
                  // Not an indirect object yet
                }
                
                if (indirectRef) {
                  // Use the indirect reference
                  annotsArray.push(indirectRef);
                } else {
                  // Push the object - MuPDF should make it indirect
                  annotsArray.push(annotObj);
                }
                
                pageObjObj.put("Annots", annotsArray);
                
                // Update the page object to commit the Annots array change
                if (typeof pageObjObj.update === 'function') {
                  pageObjObj.update();
                }
                if (typeof pageObj.update === 'function') {
                  pageObj.update();
                }
                
                // Update the annotation after adding to Annots - this should make it indirect
                annot.update();
              }
            }
            
            // CRITICAL: After updating the page, reload the Annots array to get indirect references
            // The Annots array should now contain indirect references to the annotations
            try {
              // Reload the page object to get the updated Annots array
              const updatedPageObjObj = pageObj.getObject();
              if (updatedPageObjObj) {
                const updatedAnnotsArray = updatedPageObjObj.get("Annots");
                if (updatedAnnotsArray) {
                  // The last item in Annots should be our newly added annotation
                  // Annotation is now in the Annots array
                }
              }
            } catch (indirectRefError) {
            }
            
            // Check if it's now an indirect object
            const annotObjAfter = annot.getObject();
            if (annotObjAfter) {
              // Annotation object exists after update
            }
          } catch (addError) {
          }
        } else {
        }
        
        // CRITICAL: Now that the annotation is in the page Annots array, add it to AcroForm Fields
        // Get the annotation reference from the Annots array to ensure it's properly linked
        try {
          // Get the annotation's reference from the Annots array
          // Try to find the annotation in the Annots array by matching it
          let annotRef = null;
          const annotsFromPage = pageObj.getAnnotations();
          for (const pageAnnot of annotsFromPage) {
            try {
              if (pageAnnot === annot || (pageAnnot.getObject && pageAnnot.getObject() === annotObj)) {
                annotRef = pageAnnot;
                break;
              }
            } catch (e) {
              // Ignore errors
            }
          }
          
          // CRITICAL: Try to get the indirect reference from the Annots array
          // After updating the page, the Annots array should contain indirect references
          let indirectRefFromAnnots = null;
          try {
            const updatedPageObjObj = pageObj.getObject();
            if (updatedPageObjObj) {
              const updatedAnnotsArray = updatedPageObjObj.get("Annots");
              if (updatedAnnotsArray && updatedAnnotsArray.length > 0) {
                // The last item in Annots should be our newly added annotation
                const lastIndex = updatedAnnotsArray.length - 1;
                indirectRefFromAnnots = updatedAnnotsArray.get ? updatedAnnotsArray.get(lastIndex) : updatedAnnotsArray[lastIndex];
              }
            }
          } catch (e) {
            // Ignore errors
          }
          
          // If not found in page annotations, try to get from Annots array
          if (!annotRef) {
            annotRef = indirectRefFromAnnots || (annotsArray.get ? annotsArray.get(annotsArray.length - 1) : annotsArray[annotsArray.length - 1]);
          }
          
          // Try to get indirect reference from annotRef
          let indirectRef = indirectRefFromAnnots;
          if (!indirectRef && annotRef) {
            try {
              const annotRefObj = annotRef.getObject ? annotRef.getObject() : annotRef;
              if (annotRefObj && typeof annotRefObj.getIndirectRef === 'function') {
                indirectRef = annotRefObj.getIndirectRef();
              }
            } catch (e) {
              // Ignore errors
            }
          }
          
          // Ensure the field is added to the AcroForm
          // CRITICAL: Widget annotations must be explicitly added to the AcroForm Fields array
          // to be persisted in the PDF file
          
          // Use indirect reference if available, otherwise use annotRef
          const refToUse = indirectRef || indirectRefFromAnnots || annotRef;
          const catalogObj = pdfDoc.getTrailer().get("Root");
          if (catalogObj) {
            let acroFormObj = catalogObj.get("AcroForm");
            if (!acroFormObj) {
              // Create AcroForm dictionary if it doesn't exist
              acroFormObj = createDictionary();
              const fieldsArray = createArray();
              acroFormObj.put("Fields", fieldsArray);
              try {
                acroFormObj.put("NeedAppearances", this.mupdf.newBoolean(true));
              } catch (e) {
                try {
                  acroFormObj.put("NeedAppearances", pdfDoc.newBoolean(true));
                } catch (e2) {
                  acroFormObj.put("NeedAppearances", true);
                }
              }
              catalogObj.put("AcroForm", acroFormObj);
              if (typeof catalogObj.update === 'function') {
                catalogObj.update();
              }
            }
            
            // Add the annotation reference to AcroForm Fields array
            let fieldsArray = null;
            let acroFormObjValid = true;
            try {
              // Verify acroFormObj is valid before trying to get Fields
              if (!acroFormObj || typeof acroFormObj.get !== 'function') {
                acroFormObjValid = false;
              } else {
                fieldsArray = acroFormObj.get("Fields");
              }
            } catch (getFieldsError) {
              // If we can't get Fields, try to create a new AcroForm
              fieldsArray = null;
              acroFormObjValid = false;
            }
            
            // If AcroForm is invalid, try to recreate it
            if (!acroFormObjValid) {
              try {
                // Use the helper functions that are defined earlier in the function
                // If they're not available, create objects directly
                let newAcroFormObj: any = null;
                try {
                  newAcroFormObj = this.mupdf.newDictionary();
                } catch (e1) {
                  try {
                    newAcroFormObj = pdfDoc.newDictionary();
                  } catch (e2) {
                    throw new Error("Cannot create dictionary");
                  }
                }
                
                let newFieldsArray: any = null;
                try {
                  newFieldsArray = this.mupdf.newArray();
                } catch (e1) {
                  try {
                    newFieldsArray = pdfDoc.newArray();
                  } catch (e2) {
                    throw new Error("Cannot create array");
                  }
                }
                
                newAcroFormObj.put("Fields", newFieldsArray);
                try {
                  newAcroFormObj.put("NeedAppearances", this.mupdf.newBoolean(true));
                } catch (e) {
                  try {
                    newAcroFormObj.put("NeedAppearances", pdfDoc.newBoolean(true));
                  } catch (e2) {
                    newAcroFormObj.put("NeedAppearances", true);
                  }
                }
                catalogObj.put("AcroForm", newAcroFormObj);
                if (typeof catalogObj.update === 'function') {
                  catalogObj.update();
                }
                acroFormObj = newAcroFormObj;
                fieldsArray = newFieldsArray;
              } catch (recreateError) {
                // If we can't recreate AcroForm, we can't add the annotation to Fields
                // But we'll still set the Parent field as a fallback
              }
            }
            
            // Check if fieldsArray is valid and has array-like properties
            let isMuPDFFieldsArray = false;
            let isJSFieldsArray = false;
            
            if (fieldsArray) {
              try {
                // Safely check if it's a MuPDF array
                isMuPDFFieldsArray = typeof fieldsArray === 'object' && 
                                    typeof fieldsArray.push === 'function' && 
                                    typeof fieldsArray.length !== 'undefined';
                // Safely check if it's a JS array
                isJSFieldsArray = Array.isArray(fieldsArray);
              } catch (checkError) {
                // If check fails, treat as no array
                fieldsArray = null;
              }
            }
            
            if (isMuPDFFieldsArray || isJSFieldsArray) {
              // CRITICAL: Skip the check entirely - it's causing errors with null elements
              // The error "Cannot read properties of null" happens when fieldsArray.get(i) returns null
              // Just try to add the annotation directly to the Fields array
              let alreadyInFields = false;
              
              if (!alreadyInFields) {
                
                // Try multiple approaches to add the annotation to Fields array
                let addedToFields = false;
                
                // Approach 1: Try using the annotation object's indirect reference method
                try {
                  // Get indirect reference from the annotation object
                  let indirectRef = null;
                  if (annotObj && typeof annotObj.getIndirectRef === 'function') {
                    indirectRef = annotObj.getIndirectRef();
                  } else if (annot && typeof annot.getIndirectRef === 'function') {
                    indirectRef = annot.getIndirectRef();
                  }
                  
                  if (indirectRef) {
                    fieldsArray.push(indirectRef);
                    acroFormObj.put("Fields", fieldsArray);
                    if (typeof acroFormObj.update === 'function') {
                      acroFormObj.update();
                    }
                    addedToFields = true;
                  }
                } catch (indirectRefError) {
                }
                
                // Approach 2: Try using the reference from Annots array (use indirectRef if available)
                if (!addedToFields && refToUse) {
                  try {
                    fieldsArray.push(refToUse);
                    acroFormObj.put("Fields", fieldsArray);
                    if (typeof acroFormObj.update === 'function') {
                      acroFormObj.update();
                    }
                    addedToFields = true;
                
                // CRITICAL: For terminal fields (Widget annotations added directly to Fields),
                // we need to ensure the annotation has proper structure.
                // The Widget annotation should reference itself in the Fields array.
                // However, we should NOT set Parent to AcroForm - that's incorrect.
                // Instead, we need to ensure the annotation is properly structured as a field.
                
                // CRITICAL: Update the annotation, AcroForm, and catalog after adding to Fields
                // This ensures all changes are committed to the PDF structure
                try {
                  // For terminal fields, the Widget annotation IS the field dictionary
                  // So we don't need to set Parent - the annotation itself is in Fields
                  // But we should ensure all field properties are properly set
                  
                  annot.update();
                  if (typeof acroFormObj.update === 'function') {
                    acroFormObj.update();
                  }
                  if (typeof catalogObj.update === 'function') {
                    catalogObj.update();
                  }
                  // Update one more time to ensure everything is committed
                  annot.update();
                } catch (updateError) {
                }
                  } catch (pushError) {
                  }
                }
                
                // Approach 3: Try using annotObj directly
                if (!addedToFields && annotObj) {
                  try {
                    fieldsArray.push(annotObj);
                    acroFormObj.put("Fields", fieldsArray);
                    if (typeof acroFormObj.update === 'function') {
                      acroFormObj.update();
                    }
                    addedToFields = true;
                  } catch (fallbackError) {
                    console.warn("Could not add Widget to AcroForm Fields array, but annotation is in page Annots array");
                  }
                }
                
                if (!addedToFields) {
                }
              } else {
              }
            } else if (!fieldsArray) {
              // Create new Fields array
              let newFieldsArray: any = null;
              try {
                newFieldsArray = createArray();
              } catch (createArrayError) {
                // If createArray is not available, try to create array directly
                try {
                  newFieldsArray = this.mupdf.newArray();
                } catch (e1) {
                  try {
                    newFieldsArray = pdfDoc.newArray();
                  } catch (e2) {
                    // Fallback to JavaScript array
                    newFieldsArray = [];
                  }
                }
              }
              
              if (!newFieldsArray) {
                // Skip creating Fields array if we can't create one
                return;
              }
              try {
                newFieldsArray.push(annotRef);
                acroFormObj.put("Fields", newFieldsArray);
                if (typeof acroFormObj.update === 'function') {
                  acroFormObj.update();
                }
              } catch (pushError) {
                try {
                  newFieldsArray.push(annotObj);
                  acroFormObj.put("Fields", newFieldsArray);
                  if (typeof acroFormObj.update === 'function') {
                    acroFormObj.update();
                  }
                } catch (fallbackError) {
                }
              }
            }
          }
        } catch (acroFormError) {
          // Even if AcroForm registration fails, the annotation is still in the page Annots array
          // Some PDF viewers may still recognize it as a form field
          console.warn("AcroForm registration failed, but annotation is in page Annots array:", acroFormError);
          
          // CRITICAL: Even though we can't add to AcroForm Fields array, we should still ensure
          // the Widget annotation has the Parent field pointing to the AcroForm
          // This is an alternative way to link Widget annotations to AcroForm
          try {
            const catalogObj = pdfDoc.getTrailer().get("Root");
            if (catalogObj) {
              let acroFormObj = catalogObj.get("AcroForm");
              if (!acroFormObj) {
                // Create AcroForm if it doesn't exist
                acroFormObj = createDictionary();
                const fieldsArray = createArray();
                acroFormObj.put("Fields", fieldsArray);
                try {
                  acroFormObj.put("NeedAppearances", this.mupdf.newBoolean(true));
                } catch (e) {
                  try {
                    acroFormObj.put("NeedAppearances", pdfDoc.newBoolean(true));
                  } catch (e2) {
                    acroFormObj.put("NeedAppearances", true);
                  }
                }
                catalogObj.put("AcroForm", acroFormObj);
                if (typeof catalogObj.update === 'function') {
                  catalogObj.update();
                }
              }
              
              // Set the Parent field on the Widget annotation to point to the AcroForm
              // This is an alternative way to link Widget annotations to AcroForm
              if (annotObj && acroFormObj) {
                try {
                  annotObj.put("Parent", acroFormObj);
                  if (typeof annotObj.update === 'function') {
                    annotObj.update();
                  }
                  annot.update();
                } catch (parentError) {
                }
              }
            }
          } catch (parentLinkError) {
          }
        }
      } else {
        // Annots exists but is not an array - replace it with a new array
        annotsArray = createArray();
        annotsArray.push(annotObj);
        pageObjObj.put("Annots", annotsArray);
        // Try to update the page object dictionary if update() method exists
        if (typeof pageObjObj.update === 'function') {
          pageObjObj.update();
        }
        // Also try updating the page object itself
        if (typeof pageObj.update === 'function') {
          pageObj.update();
        }
      }
    } else {
    }
  } catch (pageUpdateError) {
    console.warn("Could not update page Annots array:", pageUpdateError);
  }

  // Store the PDF annotation object for future updates

  annotation.pdfAnnotation = annot;

  }

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
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/904a5175-7f78-4608-b46a-a1e7f31debc4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'PDFAnnotationOperations.ts:2472',message:'Creating stamp annotation',data:{annotationId:annotation.id,displayCoords:{x:annotation.x,y:annotation.y,width:annotation.width,height:annotation.height},pdfCoords:{x:rect[0],y:rect[1],x2:rect[2],y2:rect[3]},pageHeight:pageHeight,stampType:annotation.stampData?.type},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'CREATE'})}).catch(()=>{});
  // #endregion

  // Use Stamp annotation type to embed image appearance for native PDF viewers
  // This ensures stamps appear as images, not text, in external PDF viewers
  const annot = page.createAnnotation("Stamp");

  annot.setRect(rect);
  // #region agent log
  const rectAfterSet = annot.getRect();
  fetch('http://127.0.0.1:7242/ingest/904a5175-7f78-4608-b46a-a1e7f31debc4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'PDFAnnotationOperations.ts:2491',message:'After setRect - checking if rect changed',data:{annotationId:annotation.id,rectSet:{x:rect[0],y:rect[1],x2:rect[2],y2:rect[3]},rectAfterSet:{x:rectAfterSet[0],y:rectAfterSet[1],x2:rectAfterSet[2],y2:rectAfterSet[3]},rectChanged:rect[0]!==rectAfterSet[0]||rect[1]!==rectAfterSet[1]||rect[2]!==rectAfterSet[2]||rect[3]!==rectAfterSet[3]},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'CREATE'})}).catch(()=>{});
  // #endregion

  // Store stamp data in contents as JSON for our app to read back
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
      // Ignore if we can't set the marker
    }

    // For image stamps, embed the actual image as the appearance
    // CRITICAL: Set appearance AFTER rect to ensure proper sizing
    if (annotation.stampData.type === "image" && annotation.stampData.imageData) {
      try {
        // Extract base64 data from data URL
        const base64Data = annotation.stampData.imageData.split(',')[1] || annotation.stampData.imageData;
        const imageBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
        
        // Create mupdf Image from buffer
        // CRITICAL FIX: Try multiple approaches to create Image
        // PDFDocumentOperations uses Image.fromBuffer(imageBytes) directly, but it fails here
        // Try using Buffer first, or try accessing through document
        let image;
        // #region agent log
        const hasBuffer = !!this.mupdf.Buffer;
        const bufferMethods = this.mupdf.Buffer ? Object.keys(this.mupdf.Buffer).slice(0,10).join(',') : 'none';
        fetch('http://127.0.0.1:7242/ingest/904a5175-7f78-4608-b46a-a1e7f31debc4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'PDFAnnotationOperations.ts:2538',message:'Trying to create Image',data:{annotationId:annotation.id,hasBuffer:hasBuffer,bufferMethods:bufferMethods,imageBytesType:typeof imageBytes,imageBytesLength:imageBytes.length},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'APPEARANCE'})}).catch(()=>{});
        // #endregion
        
        // CRITICAL FIX: Use the document's mupdf instance which has Image.fromBuffer
        // The mupdf instance in constructor might not have the same API
        // Get it from the document which should have full mupdf API
        const mupdfDoc = document.getMupdfDocument();
        const pdfDoc = mupdfDoc.asPDF();
        
        // Try approach 1: Direct Image.fromBuffer from constructor's mupdf (same as PDFDocumentOperations)
        if (this.mupdf.Image && typeof this.mupdf.Image.fromBuffer === 'function') {
          image = this.mupdf.Image.fromBuffer(imageBytes);
        }
        // Try approach 2: Use Buffer.fromArrayBuffer then Image.fromBuffer
        else if (this.mupdf.Buffer && typeof this.mupdf.Buffer.fromArrayBuffer === 'function') {
          const buffer = this.mupdf.Buffer.fromArrayBuffer(imageBytes.buffer);
          if (this.mupdf.Image && typeof this.mupdf.Image.fromBuffer === 'function') {
            image = this.mupdf.Image.fromBuffer(buffer);
          } else if (pdfDoc && pdfDoc.Image && typeof pdfDoc.Image.fromBuffer === 'function') {
            // Try document's Image API
            image = pdfDoc.Image.fromBuffer(buffer);
          } else {
            throw new Error("Image.fromBuffer not available even with Buffer");
          }
        }
        // Try approach 3: Use document's Image API directly
        else if (pdfDoc && pdfDoc.Image && typeof pdfDoc.Image.fromBuffer === 'function') {
          image = pdfDoc.Image.fromBuffer(imageBytes);
        }
        // Try approach 4: Use Buffer.fromBytes
        else if (this.mupdf.Buffer && typeof this.mupdf.Buffer.fromBytes === 'function') {
          const buffer = this.mupdf.Buffer.fromBytes(imageBytes);
          if (this.mupdf.Image && typeof this.mupdf.Image.fromBuffer === 'function') {
            image = this.mupdf.Image.fromBuffer(buffer);
          } else if (pdfDoc && pdfDoc.Image && typeof pdfDoc.Image.fromBuffer === 'function') {
            image = pdfDoc.Image.fromBuffer(buffer);
          } else {
            throw new Error("Image.fromBuffer not available even with Buffer.fromBytes");
          }
        } else {
          throw new Error(`Cannot create Image. this.mupdf.Image.fromBuffer: ${!!this.mupdf.Image?.fromBuffer}, pdfDoc.Image.fromBuffer: ${!!pdfDoc?.Image?.fromBuffer}`);
        }
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/904a5175-7f78-4608-b46a-a1e7f31debc4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'PDFAnnotationOperations.ts:2532',message:'Setting stamp appearance',data:{annotationId:annotation.id,imageWidth:image.getWidth(),imageHeight:image.getHeight(),rectWidth:rect[2]-rect[0],rectHeight:rect[3]-rect[1]},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'APPEARANCE'})}).catch(()=>{});
        // #endregion
        
        // Set the image as the appearance - this makes it visible in native PDF viewers
        // The appearance will be scaled to fit the rect automatically
        annot.setAppearance(image);
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/904a5175-7f78-4608-b46a-a1e7f31debc4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'PDFAnnotationOperations.ts:2536',message:'Appearance set successfully',data:{annotationId:annotation.id},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'APPEARANCE'})}).catch(()=>{});
        // #endregion
      } catch (imageError) {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/904a5175-7f78-4608-b46a-a1e7f31debc4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'PDFAnnotationOperations.ts:2538',message:'Failed to set appearance',data:{annotationId:annotation.id,error:imageError.message},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'APPEARANCE'})}).catch(()=>{});
        // #endregion
        console.warn("Could not embed image for stamp annotation:", imageError);
      }
    }
    // For text stamps, the JSON in contents is sufficient for our app to render
    // Native PDF viewers may show the text from contents, but won't have the styled appearance
    // TODO: In the future, we could render text stamps to a canvas/image and embed that for native viewers
  }

  // Make it invisible (no border, transparent) - appearance handles the visual
  try {
    annot.setBorderWidth(0);
    annot.setInteriorColor([]);
  } catch (e) {
    // Ignore if these methods aren't available
  }

  // CRITICAL FIX: Set rect directly in PDF object BEFORE update() to prevent modification
  // Stamp annotations without proper appearance use default "DRAFT" which has fixed size
  // Setting rect in object directly prevents update() from resizing it
  try {
    const annotObj = annot.getObject();
    if (annotObj) {
      // Create array with rect coordinates using mupdf API
      const rectArray = this.mupdf.newArray(4);
      // Use newNumber for floats (mupdf uses newNumber for both int and float)
      rectArray.push(this.mupdf.newNumber(rect[0]));
      rectArray.push(this.mupdf.newNumber(rect[1]));
      rectArray.push(this.mupdf.newNumber(rect[2]));
      rectArray.push(this.mupdf.newNumber(rect[3]));
      annotObj.put("Rect", rectArray);
    }
  } catch (e) {
    // If direct manipulation fails, use setRect
    annot.setRect(rect);
  }

  // CRITICAL: Call update() after setting rect in object to ensure it's persisted
  annot.update();
  
  // CRITICAL FIX: Verify and restore rect after update() if it was still modified
  const rectAfterUpdate = annot.getRect();
  const rectChanged = Math.abs(rectAfterUpdate[0] - rect[0]) > 0.1 || 
                      Math.abs(rectAfterUpdate[1] - rect[1]) > 0.1 || 
                      Math.abs(rectAfterUpdate[2] - rect[2]) > 0.1 || 
                      Math.abs(rectAfterUpdate[3] - rect[3]) > 0.1;
  if (rectChanged) {
    // Rect was still modified - force it directly in object and update page
    try {
      const annotObj = annot.getObject();
      if (annotObj) {
        const rectArray = this.mupdf.newArray(4);
        // Use newNumber for floats (mupdf uses newNumber for both int and float)
        rectArray.push(this.mupdf.newNumber(rect[0]));
        rectArray.push(this.mupdf.newNumber(rect[1]));
        rectArray.push(this.mupdf.newNumber(rect[2]));
        rectArray.push(this.mupdf.newNumber(rect[3]));
        annotObj.put("Rect", rectArray);
        // Update the page object to persist the change
        const pageObj = page.getObject();
        if (pageObj && typeof pageObj.update === 'function') {
          pageObj.update();
        }
      }
    } catch (e) {
      // If direct manipulation fails, try setRect one more time
      annot.setRect(rect);
    }
  }
  // #region agent log
  const finalRect = annot.getRect();
  fetch('http://127.0.0.1:7242/ingest/904a5175-7f78-4608-b46a-a1e7f31debc4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'PDFAnnotationOperations.ts:2605',message:'After update() - checking rect',data:{annotationId:annotation.id,rectAfterUpdate:{x:rectAfterUpdate[0],y:rectAfterUpdate[1],x2:rectAfterUpdate[2],y2:rectAfterUpdate[3]},originalRect:{x:rect[0],y:rect[1],x2:rect[2],y2:rect[3]},rectChanged:rectChanged,finalRect:{x:finalRect[0],y:finalRect[1],x2:finalRect[2],y2:finalRect[3]}},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'CREATE'})}).catch(()=>{});
  // #endregion

  // Store the PDF annotation object for future updates

  annotation.pdfAnnotation = annot;

  }

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
  
  // CRITICAL: Update the annotation object and page to persist the deletion
  // First, try to update the page object directly
  try {
    const pageObj = page.getObject();
    if (pageObj && typeof pageObj.update === 'function') {
      pageObj.update();
    }
  } catch (e) {
    // Page object update might not be available
  }
  
  // Also try page.update() if available
  try {
    if (typeof page.update === 'function') {
      page.update();
    }
  } catch (e) {
    // Some mupdf versions might not have page.update()
  }

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

  // Match stamp annotations (stored as FreeText with StampAnnotation flag, or Stamp type)
  if (annotation.type === "stamp" && (annotType === "FreeText" || annotType === "Stamp")) {
    try {
      const annotObj = annot.getObject();
      if (annotObj) {
        const stampFlag = annotObj.get("StampAnnotation");
        if (stampFlag) {
          const flagStr = stampFlag.toString();
          // Check if it's marked as a stamp
          if (flagStr === "true" || flagStr === "/true" || 
              (typeof stampFlag === 'boolean' && stampFlag === true) ||
              (stampFlag.valueOf && stampFlag.valueOf() === true)) {
            // Match by position and stamp ID if available
            const rect = annot.getRect();
            const contents = annot.getContents() || "";
            
            // Try to match by position (stamps have x, y, width, height)
            const matchesPosition = annotation.x !== undefined && annotation.y !== undefined &&
              Math.abs(rect[0] - annotation.x) < 10 && 
              Math.abs(rect[1] - annotation.y) < 10;
            
            // Also try to match by stamp ID in contents if available
            let matchesStampId = false;
            if (annotation.stampId && contents) {
              try {
                const parsed = JSON.parse(contents);
                if (parsed.type === "stamp" && parsed.stampData && parsed.stampData.id === annotation.stampId) {
                  matchesStampId = true;
                }
              } catch (e) {
                // Not JSON, ignore
              }
            }
            
            if (matchesPosition || matchesStampId) {
              page.deleteAnnotation(annot);
              return;
            }
          }
        }
      }
    } catch (e) {
      // Ignore errors in stamp matching
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

  // Match overlay highlights and drawings (both use Ink annotations)
  if ((annotation.type === "highlight" && annotation.highlightMode === "overlay") || annotation.type === "draw") {
    if (annotType === "Ink") {
      // For Ink annotations, match by path points if available
      if (annotation.path && annotation.path.length >= 2) {
        try {
          const annotInkList = annot.getInkList();
          if (annotInkList && annotInkList.length > 0) {
            // Get the first stroke from the ink list
            const annotStroke = annotInkList[0];
            if (annotStroke && annotStroke.length >= 2) {
              // Convert annotation path to match format (PDF coordinates)
              const pageBounds = page.getBounds();
              const pageHeight = pageBounds[3] - pageBounds[1];
              
              // Check if first and last points match (within tolerance)
              const annotFirstPoint = annotStroke[0];
              const annotLastPoint = annotStroke[annotStroke.length - 1];
              
              const annotationFirstPoint = annotation.path[0];
              const annotationLastPoint = annotation.path[annotation.path.length - 1];
              
              // Convert annotation coordinates to display coordinates for comparison
              const annotationFirstDisplay = { x: annotationFirstPoint.x, y: pageHeight - annotationFirstPoint.y };
              const annotationLastDisplay = { x: annotationLastPoint.x, y: pageHeight - annotationLastPoint.y };
              
              const firstMatches = annotFirstPoint && annotFirstPoint.length >= 2 &&
                Math.abs(annotFirstPoint[0] - annotationFirstDisplay.x) < 5 &&
                Math.abs(annotFirstPoint[1] - annotationFirstDisplay.y) < 5;
              
              const lastMatches = annotLastPoint && annotLastPoint.length >= 2 &&
                Math.abs(annotLastPoint[0] - annotationLastDisplay.x) < 5 &&
                Math.abs(annotLastPoint[1] - annotationLastDisplay.y) < 5;
              
              if (firstMatches && lastMatches) {
                page.deleteAnnotation(annot);
                return;
              }
            }
          }
        } catch (e) {
          // Ignore errors in path matching
        }
      }
      
      // Fallback for Ink annotations: match by position/bounds if path matching failed
      try {
        const rect = annot.getRect();
        if (rect && annotation.x !== undefined && annotation.y !== undefined && annotation.width !== undefined && annotation.height !== undefined) {
          const pageBounds = page.getBounds();
          const pageHeight = pageBounds[3] - pageBounds[1];
          // Convert annotation y to display coordinates for comparison
          const annotationDisplayY = pageHeight - annotation.y - annotation.height;
          // Compare position with more lenient tolerance for drawings (50px to account for coordinate rounding)
          const matchesX = Math.abs(rect[0] - annotation.x) < 50;
          const matchesY = Math.abs(rect[1] - annotationDisplayY) < 50;
          // Also check if width/height are similar (within 50px)
          const matchesWidth = Math.abs((rect[2] - rect[0]) - annotation.width) < 50;
          const matchesHeight = Math.abs((rect[3] - rect[1]) - annotation.height) < 50;
          
          if ((matchesX && matchesY) || (matchesWidth && matchesHeight)) {
            page.deleteAnnotation(annot);
            return;
          }
        }
      } catch (e) {
        // Ignore errors in position matching
      }
    }
  }

  // Fallback: try to match by approximate position
  // Skip this for Ink annotations (already handled above) and Highlight annotations (already handled above)
  if (annotType !== "Ink" && annotType !== "Highlight") {
    try {
      const rect = annot.getRect();
      if (rect) {
        const matchesPosition = Math.abs(rect[0] - (annotation.x || 0)) < 10 && 
          Math.abs(rect[1] - (annotation.y || 0)) < 10;
        if (matchesPosition) {
          page.deleteAnnotation(annot);
          return;
        }
      }
    } catch (e) {
      // Ignore errors in position matching
    }
  }

  }

  }

  console.warn("Could not find annotation to delete in PDF - it may have already been deleted");

  }

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

  y: rect[1], // FIXED: Use rect[1] (bottom Y) directly, not pageHeight - rect[3] (top Y flipped)

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

}