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

}