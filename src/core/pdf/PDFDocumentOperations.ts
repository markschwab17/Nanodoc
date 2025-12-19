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


  const inkPath: number[] = [];

  for (const point of annotation.path) {

  inkPath.push(point.x, pageHeight - point.y);

  }


  annot.setInkList([inkPath]);


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

  await this.annotationOps.addFormFieldAnnotation(document, annot);

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