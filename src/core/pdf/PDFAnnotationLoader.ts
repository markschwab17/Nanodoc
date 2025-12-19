/**
 * PDF Annotation Loader
 * 
 * Handles loading and parsing annotations from PDF pages.
 */

import type { PDFDocument } from "./PDFDocument";
import type { Annotation, StampData } from "./types";

export class PDFAnnotationLoader {
  // @ts-expect-error - mupdf parameter reserved for future use
  constructor(private _mupdf: any) {}

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

  if (arrowSizeObj) {

  // Try multiple methods to extract the numeric value
  // Method 1: Direct number
  if (typeof arrowSizeObj === 'number') {

  arrowHeadSize = arrowSizeObj;

  } else if (arrowSizeObj.valueOf && typeof arrowSizeObj.valueOf === 'function') {

  // Method 2: valueOf() method - but check if result is valid
  try {

  const value = arrowSizeObj.valueOf();

  if (typeof value === 'number' && !isNaN(value) && value !== null && value !== undefined) {

  arrowHeadSize = value;

  }

  } catch (e) {

  // valueOf() might throw, try other methods

  }

  }

  // If valueOf() didn't work, try other methods
  if (arrowHeadSize === 10) { // Still default, try other methods

  if (typeof arrowSizeObj === 'object') {

  // Method 3: Check for direct value property
  if ('value' in arrowSizeObj && typeof arrowSizeObj.value === 'number') {

  arrowHeadSize = arrowSizeObj.value;

  } else if ('getNumber' in arrowSizeObj && typeof arrowSizeObj.getNumber === 'function') {

  // Method 4: Try getNumber() method if available
  try {

  arrowHeadSize = arrowSizeObj.getNumber();

  } catch (e) {

  // Ignore

  }

  } else if ('toNumber' in arrowSizeObj && typeof arrowSizeObj.toNumber === 'function') {

  // Method 5: Try toNumber() method if available
  try {

  arrowHeadSize = arrowSizeObj.toNumber();

  } catch (e) {

  // Ignore

  }

  } else if (typeof arrowSizeObj.toString === 'function') {

  // Method 6: Try parsing from string representation (but skip "null")
  try {

  const str = arrowSizeObj.toString();

  if (str && str !== 'null' && str !== 'undefined' && str !== '[object Object]') {

  const parsed = parseFloat(str);

  if (!isNaN(parsed)) {

  arrowHeadSize = parsed;

  }

  }

  } catch (e) {

  // Ignore

  }

  }

  }

  }

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

  // CRITICAL FIX: Based on runtime evidence, getLine() returns CANVAS coordinates (Y=0 at top), NOT PDF coordinates
  // The logs show getLine() returns different Y values than what we saved
  // (e.g., saved y:561.37, getLine() returns y:230.63, and 792-561.37=230.63, confirming canvas)
  // We must convert from canvas to PDF coordinates: pdfY = pageHeight - canvasY
  // Also, getLine() may return points in reverse order, so we need to check and potentially reverse

  const pageBounds = page.getBounds();
  const pageHeight = pageBounds[3] - pageBounds[1];

  // Convert canvas coordinates to PDF coordinates
  let pdfPoints = points.map(p => ({
    x: p.x,
    y: pageHeight - p.y  // Flip Y: convert from canvas (Y=0 at top) to PDF (Y=0 at bottom)
  }));

  // CRITICAL: Check if points are in reverse order
  // If getLine() returns points in reverse order (end→start instead of start→end),
  // we need to reverse them to preserve arrow direction
  // REVERSE THE POINTS to fix arrow direction
  pdfPoints = [pdfPoints[1], pdfPoints[0]];



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

}