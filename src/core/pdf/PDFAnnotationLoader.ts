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
    // getQuadPoints() returns quads in display coordinates (Y=0 at top)
    // We need to convert them to PDF coordinates (Y=0 at bottom) for storage
    const pageBounds = page.getBounds();
    const pageHeight = pageBounds[3] - pageBounds[1];

  quadPoints = quads.map((q: any) => {

  if (Array.isArray(q) && q.length >= 8) {
      // Convert from display coordinates to PDF coordinates
      // For each Y coordinate: pdfY = pageHeight - displayY
      return [
        q[0], pageHeight - q[1], // point 0
        q[2], pageHeight - q[3], // point 1
        q[4], pageHeight - q[5], // point 2
        q[6], pageHeight - q[7], // point 3
      ];
  }

  return [0, 0, 0, 0, 0, 0, 0, 0];

  });

  }

  } catch (err) {

  console.error("Error getting quad points:", err);

  }


  // Calculate bounding box from quads for proper positioning
  // If rect is missing, calculate it from quads
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

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

  } else if (rect) {
    // Fallback to rect if no quads
    minX = rect[0];
    minY = rect[1];
    maxX = rect[2];
    maxY = rect[3];
  } else {
    // No rect and no quads - skip this highlight
    console.warn("Highlight annotation has no rect and no quads, skipping");
    continue;
  }
  
  // Validate that we have valid bounds
  if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY) || minX >= maxX || minY >= maxY) {
    console.warn("Highlight annotation has invalid bounds, skipping");
    continue;
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

  let ftName = ftObj && ftObj.getName ? ftObj.getName() : (ftObj ? ftObj.toString() : "");
  // CRITICAL FIX: Strip leading slash from PDF name objects (e.g., "/Btn" -> "Btn")
  // PDF name objects return "/Name" from toString(), but we need "Name" for comparison
  if (ftName.startsWith("/")) {
    ftName = ftName.substring(1);
  }


  if (ftName === "Tx") {
  // Check if this is a date field by field name pattern (date fields are created with names like "date_1234567890")
  // We'll check the field name later after we get it from the T field
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
  
  // Detect date fields by field name pattern (date fields are created with names like "date_1234567890")
  if (fieldName.startsWith("date_") && ftName === "Tx") {
    fieldType = "date";
  }

  }


  const vObj = annotObj.get("V");

  if (vObj) {

  if (fieldType === "checkbox" || fieldType === "radio") {

  const vName = vObj.getName ? vObj.getName() : vObj.toString();
  // Strip leading slash if present (PDF name objects)
  const normalizedName = vName.startsWith("/") ? vName.substring(1) : vName;

  fieldValue = normalizedName === "Yes" || normalizedName === "On";

  } else {

  fieldValue = vObj.toString ? vObj.toString() : String(vObj);

  }

  }
  
  // Also check AS (appearance state) for radio buttons and checkboxes if V wasn't set
  if ((fieldType === "checkbox" || fieldType === "radio") && fieldValue === undefined) {
    const asObj = annotObj.get("AS");
    if (asObj) {
      const asName = asObj.getName ? asObj.getName() : asObj.toString();
      const normalizedAsName = asName.startsWith("/") ? asName.substring(1) : asName;
      fieldValue = normalizedAsName === "Yes" || normalizedAsName === "On";
    } else {
      // Default to unchecked if no V or AS
      fieldValue = false;
    }
  }


  // Get radio group name

  if (fieldType === "radio" && tObj) {

  radioGroup = tObj.toString ? tObj.toString() : String(tObj);

  }

  }


  const formFieldAnnot = {
  id: `form_${pageNumber}_${rect[0]}_${rect[1]}_${Math.random().toString(36).substr(2, 9)}`,

  type: "formField" as const,

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

  };

  annotations.push(formFieldAnnot);

  continue; // Skip to next annotation

  } else if (type === "Stamp") {
  // Handle Stamp annotation type (new format with embedded image appearance)
  // Check if this is a stamp annotation by looking for StampAnnotation flag or contents format
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

  // Also check contents format as fallback
  if (!isStampAnnotation && contents) {
    try {
      const testParsed = JSON.parse(contents);
      if (testParsed.type === "stamp" && testParsed.stampData) {
        isStampAnnotation = true;
      }
    } catch (e) {
      // Not JSON, ignore
    }
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
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/904a5175-7f78-4608-b46a-a1e7f31debc4',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'PDFAnnotationLoader.ts:570',message:'Loading stamp annotation',data:{annotationId:id,pageNumber:pageNumber,pdfRect:{x:rect[0],y:rect[1],x2:rect[2],y2:rect[3]},pageHeight:pageHeight,calculatedDisplay:{x:rect[0],y:pageHeight-rect[3],width:rect[2]-rect[0],height:rect[3]-rect[1]},stampType:stampData.type},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'LOAD'})}).catch(()=>{});
          // #endregion

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
          continue; // Skip normal Stamp handling
        }
      }
    } catch (e) {
      console.warn("Could not parse stamp data from Stamp annotation:", e);
      // Fall through - might be a regular Stamp annotation
    }
  }
  // If not a stamp annotation, continue to other handlers
  // Regular Stamp annotations (without our metadata) will be skipped

  } else if (type === "FreeText") {
  // First check if this is a stamp annotation stored as FreeText (old format)

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

  // CRITICAL FIX: If flag check failed but contents format indicates it's a stamp, treat it as a stamp
  // This handles cases where the flag value is "null" or incorrectly set
  if (!isStampAnnotation && contents) {
    try {
      const testParsed = JSON.parse(contents);
      if (testParsed.type === "stamp" && testParsed.stampData) {
        isStampAnnotation = true;
      }
    } catch (e) {
      // Not JSON, ignore
    }
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

  // Check if this is a custom annotation
  // Handle both PDF name objects (/true) and string objects ("true")
  if (customFlag) {
    const flagStr = customFlag.toString();
    // PDF name objects return "/true", string objects return "true"
    // Also check for boolean true values
    if (flagStr === "true" || flagStr === "/true" || 
        (typeof customFlag === 'boolean' && customFlag === true) ||
        (customFlag.valueOf && customFlag.valueOf() === true)) {
      isCustomAnnotation = true;
    }
  }

  if (isCustomAnnotation) {

  // Try to get HTML content if stored

  const htmlContentObj = annotObj.get("HTMLContent");

  if (htmlContentObj) {

  let rawContent = htmlContentObj.toString();

  // PDF string objects may return content wrapped in parentheses, strip them if present

  // Check if content starts with '(' and ends with ')' (PDF literal string format)

  if (rawContent.startsWith('(') && rawContent.endsWith(')')) {

  rawContent = rawContent.slice(1, -1);

  }

  htmlContent = rawContent;

  }

  } else {

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

  // Load backgroundColor and hasBackground from annotation object
  let loadedHasBackground = true; // Default to true
  let loadedBackgroundColor = "rgba(255, 255, 255, 0)"; // Default transparent
  
  try {
    const annotObj = pdfAnnot.getObject();
    if (annotObj) {
      // Load hasBackground flag
      const hasBackgroundObj = annotObj.get("HasBackground");
      if (hasBackgroundObj) {
        const hasBackgroundStr = hasBackgroundObj.toString();
        loadedHasBackground = hasBackgroundStr === "true" || hasBackgroundStr === "/true" || 
                             (typeof hasBackgroundObj === 'boolean' && hasBackgroundObj === true) ||
                             (hasBackgroundObj.valueOf && hasBackgroundObj.valueOf() === true);
      }
      
      // Load backgroundColor
      const backgroundColorObj = annotObj.get("BackgroundColor");
      if (backgroundColorObj) {
        let rawBgColor = backgroundColorObj.toString();
        // Check if it's actually null (not just the string "null")
        // Also check if the value itself is null/undefined
        const isNullValue = rawBgColor === "null" || rawBgColor === "undefined" || 
                           rawBgColor.trim() === "" || 
                           (backgroundColorObj.valueOf && backgroundColorObj.valueOf() === null);
        if (!isNullValue) {
          // PDF string objects may return content wrapped in parentheses, strip them if present
          if (rawBgColor.startsWith('(') && rawBgColor.endsWith(')')) {
            rawBgColor = rawBgColor.slice(1, -1);
          }
          // Unescape any escaped characters (e.g., \\( -> (, \\\\) -> \)
          // MuPDF may escape parentheses and backslashes when storing strings
          rawBgColor = rawBgColor.replace(/\\([()\\])/g, '$1');
          loadedBackgroundColor = rawBgColor;
        }
      }
    }
  } catch (e) {
    // Use defaults if we can't load the properties
  }

  const loadedAnnotation = {

  id,

  type: "text" as const,

  pageNumber,

  x: rect[0],

  y: pageHeight - rect[1], // Convert from display top to PDF top coordinates (rect[1] is top in display, rect[3] is bottom)

  width: rect[2] - rect[0],

  height: rect[3] - rect[1],

  content: htmlContent, // Use HTML content if available, otherwise plain text

  fontSize: 12,

  fontFamily: "Arial",

  color: "#000000",

  hasBackground: loadedHasBackground,

  backgroundColor: loadedBackgroundColor,

  pdfAnnotation: pdfAnnot,

  };

  annotations.push(loadedAnnotation);

  } else {

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

  let rawContent = htmlContentObj.toString();

  // PDF string objects may return content wrapped in parentheses, strip them if present

  // Check if content starts with '(' and ends with ')' (PDF literal string format)

  if (rawContent.startsWith('(') && rawContent.endsWith(')')) {

  rawContent = rawContent.slice(1, -1);

  }

  htmlContent = rawContent;

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

  const loadedY = pageHeight - rect[1]; // Use rect[1] (top) not rect[3] (bottom) to get PDF top coordinate

  // Load backgroundColor and hasBackground from annotation object
  let loadedHasBackground2 = true; // Default to true
  let loadedBackgroundColor2 = "rgba(255, 255, 255, 0)"; // Default transparent
  
  try {
    const annotObj = pdfAnnot.getObject();
    if (annotObj) {
      // Load hasBackground flag
      const hasBackgroundObj = annotObj.get("HasBackground");
      if (hasBackgroundObj) {
        const hasBackgroundStr = hasBackgroundObj.toString();
        loadedHasBackground2 = hasBackgroundStr === "true" || hasBackgroundStr === "/true" || 
                             (typeof hasBackgroundObj === 'boolean' && hasBackgroundObj === true) ||
                             (hasBackgroundObj.valueOf && hasBackgroundObj.valueOf() === true);
      }
      
      // Load backgroundColor
      const backgroundColorObj = annotObj.get("BackgroundColor");
      if (backgroundColorObj) {
        let rawBgColor = backgroundColorObj.toString();
        // Check if it's actually null (not just the string "null")
        // Also check if the value itself is null/undefined
        const isNullValue = rawBgColor === "null" || rawBgColor === "undefined" || 
                           rawBgColor.trim() === "" || 
                           (backgroundColorObj.valueOf && backgroundColorObj.valueOf() === null);
        if (!isNullValue) {
          // PDF string objects may return content wrapped in parentheses, strip them if present
          if (rawBgColor.startsWith('(') && rawBgColor.endsWith(')')) {
            rawBgColor = rawBgColor.slice(1, -1);
          }
          loadedBackgroundColor2 = rawBgColor;
        }
      }
    }
  } catch (e) {
    // Use defaults if we can't load the properties
  }

  annotations.push({

  id,

  type: "text",

  pageNumber,

  x: rect[0],

  y: loadedY, // Convert from display top to PDF top coordinates

  width: rect[2] - rect[0],

  height: rect[3] - rect[1],

  content: htmlContent, // Use HTML content if available, otherwise plain text

  fontSize: 12,

  fontFamily: "Arial",

  color: "#000000",

  hasBackground: loadedHasBackground2,

  backgroundColor: loadedBackgroundColor2,

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

  // CRITICAL FIX: Based on runtime evidence, getLine() returns PDF coordinates (Y=0 at bottom), NOT canvas coordinates
  // The logs show getLine() returns the same Y values as what we saved in PDF coordinates
  // (e.g., saved y:535.72, getLine() returns y:535.72, confirming PDF coordinates)
  // Therefore, we should NOT convert - getLine() already returns PDF coordinates
  // Also, getLine() may return points in reverse order, so we need to check and potentially reverse

  // getLine() returns PDF coordinates directly, no conversion needed
  // getLine() also returns points in the correct order (start, end), so no reversal needed
  const pdfPoints = points.map(p => ({
    x: p.x,
    y: p.y  // Already in PDF coordinates, no conversion needed
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


  // Get fill color if available (use getInteriorColor since we set it with setInteriorColor)

  try {

  const fillColorObj = pdfAnnot.getInteriorColor ? pdfAnnot.getInteriorColor() : null;

  if (fillColorObj && fillColorObj.length >= 3) {

  const r = Math.round(fillColorObj[0] * 255);

  const g = Math.round(fillColorObj[1] * 255);

  const b = Math.round(fillColorObj[2] * 255);

  fillColor = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;

  }

  } catch (e) {

  // No fill color

  }

  // Get fill opacity if available

  let fillOpacity: number | undefined = undefined;

  if (fillColor) {

  try {

  const opacityObj = pdfAnnot.getOpacity ? pdfAnnot.getOpacity() : null;

  if (opacityObj !== null && opacityObj !== undefined) {

  // Try multiple methods to extract the numeric value

  if (typeof opacityObj === 'number') {

  fillOpacity = opacityObj;

  } else if (typeof opacityObj.valueOf === 'function') {

  const value = opacityObj.valueOf();

  if (typeof value === 'number') {

  fillOpacity = value;

  }

  } else if (opacityObj.value !== undefined) {

  fillOpacity = typeof opacityObj.value === 'number' ? opacityObj.value : parseFloat(String(opacityObj.value));

  } else if (typeof opacityObj.getNumber === 'function') {

  fillOpacity = opacityObj.getNumber();

  } else if (typeof opacityObj.toNumber === 'function') {

  fillOpacity = opacityObj.toNumber();

  } else {

  fillOpacity = parseFloat(String(opacityObj));

  }

  } else {

  // Default to 0.5 if fill color exists but no opacity is set

  fillOpacity = 0.5;

  }

  } catch (e) {

  // Default to 0.5 if fill color exists but opacity can't be read

  fillOpacity = fillColor ? 0.5 : undefined;

  }

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

  fillOpacity,

  pdfAnnotation: pdfAnnot,

  });

  } else if (type === "Ink") {
    // Check if this is an overlay highlight (saved as Ink with Multiply blend mode)
    let isOverlayHighlight = false;
    try {
      const annotObj = pdfAnnot.getObject();
      if (annotObj) {
        const blendMode = annotObj.get("BM");
        if (blendMode) {
          const blendModeStr = blendMode.getName ? blendMode.getName() : blendMode.toString();
          // Overlay highlights are saved as Ink annotations with Multiply blend mode
          if (blendModeStr === "Multiply" || blendModeStr === "/Multiply") {
            isOverlayHighlight = true;
          }
        }
      }
    } catch (e) {
      // Not an overlay highlight, treat as regular draw
    }
    
    // Load drawing annotation (or overlay highlight)

  const pageBounds = page.getBounds();

  const pageHeight = pageBounds[3] - pageBounds[1];


  let path: Array<{ x: number; y: number }> = [];

  try {

  const inkList = pdfAnnot.getInkList();

  if (inkList && inkList.length > 0) {

  // Ink list is an array of strokes, each stroke is an array of [x, y, x, y, ...]

  // Try to iterate inkList - it might be an array-like object or actual array
  try {
    // Convert to array if needed
    const strokesArray = Array.isArray(inkList) ? inkList : Array.from(inkList);
    
    for (let strokeIdx = 0; strokeIdx < strokesArray.length; strokeIdx++) {
      const stroke = strokesArray[strokeIdx];
      
      // Try to convert stroke to array if it's not already
      let strokeArray: number[] = [];
      if (Array.isArray(stroke)) {
        strokeArray = stroke;
      } else if (stroke && typeof stroke.length === 'number') {
        // It's array-like, convert it
        try {
          strokeArray = Array.from(stroke);
        } catch (convError) {
          continue;
        }
      } else {
        continue;
      }
      
      // Extract points from stroke array
      // Handle both formats: flat array [x, y, x, y, ...] or array of pairs [[x, y], [x, y], ...]
      if (strokeArray.length > 0 && Array.isArray(strokeArray[0])) {
        // Format: [[x, y], [x, y], ...]
        for (const point of strokeArray) {
          if (Array.isArray(point) && point.length >= 2) {
            const x = point[0];
            const y = point[1];
            if (typeof x === 'number' && typeof y === 'number' && !isNaN(x) && !isNaN(y)) {
              path.push({
                x: x,
                y: pageHeight - y // Convert to display coordinates
              });
            }
          }
        }
      } else {
        // Format: [x, y, x, y, ...]
        for (let i = 0; i < strokeArray.length; i += 2) {
          if (i + 1 < strokeArray.length) {
            const x = strokeArray[i];
            const y = strokeArray[i + 1];
            if (typeof x === 'number' && typeof y === 'number' && !isNaN(x) && !isNaN(y)) {
              path.push({
                x: x,
                y: pageHeight - y // Convert to display coordinates
              });
            }
          }
        }
      }
    }
  } catch (iterError) {
    console.warn("Error extracting ink path:", iterError);
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

  // Get opacity for highlights
  let opacity = 0.5;
  if (isOverlayHighlight) {
    try {
      const opacityObj = pdfAnnot.getOpacity ? pdfAnnot.getOpacity() : null;
      if (opacityObj !== null && opacityObj !== undefined) {
        opacity = typeof opacityObj === 'number' ? opacityObj : opacityObj.valueOf();
      } else {
        // Try to get from CA field
        try {
          const annotObj = pdfAnnot.getObject();
          if (annotObj) {
            const ca = annotObj.get("CA");
            if (ca !== null && ca !== undefined) {
              opacity = typeof ca === 'number' ? ca : ca.valueOf();
            }
          }
        } catch (e) {
          // Use default
        }
      }
    } catch (e) {
      // Use default opacity
    }
  }

  if (isOverlayHighlight) {
    // Create overlay highlight annotation
    annotations.push({

    id,

    type: "highlight",

    pageNumber,

    x: minX,

    y: minY,

    width: maxX - minX,

    height: maxY - minY,

    path,

    color,

    strokeWidth,

    opacity,

    highlightMode: "overlay",

    pdfAnnotation: pdfAnnot,

    });
  } else {
    // Create draw annotation
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

  }

  } catch (err) {

  console.error("Error processing annotation:", err);

  }

  }


  // CRITICAL: page.getAnnotations() doesn't return Widget annotations even though they're in the Annots array
  // We need to iterate through the Annots array directly to find Widget annotations
  try {
    const pageObj = page.getObject();
    if (pageObj) {
      const annotsArray = pageObj.get("Annots");
      if (annotsArray && annotsArray.length > 0) {
        
        for (let i = 0; i < annotsArray.length; i++) {
          try {
            const annotRef = annotsArray.get ? annotsArray.get(i) : annotsArray[i];
            if (annotRef) {
              // Get the annotation object
              const annotObj = annotRef.getObject ? annotRef.getObject() : annotRef;
              if (annotObj) {
                // Check if it's a Widget annotation
                const subtype = annotObj.get("Subtype");
                if (subtype && subtype.toString() === "/Widget") {
                  
                  // Helper function to convert MuPDF number objects to JavaScript numbers
                  const convertMupdfNumber = (val: any): number | null => {
                    if (val === null || val === undefined) return null;
                    if (typeof val === 'number') return val;
                    if (typeof val === 'string') {
                      const parsed = parseFloat(val);
                      return isNaN(parsed) ? null : parsed;
                    }
                    // Try valueOf() method
                    if (typeof val.valueOf === 'function') {
                      try {
                        const value = val.valueOf();
                        if (typeof value === 'number' && !isNaN(value)) return value;
                      } catch (e) {
                        // valueOf() might throw
                      }
                    }
                    // Try getNumber() method
                    if (typeof val.getNumber === 'function') {
                      try {
                        const value = val.getNumber();
                        if (typeof value === 'number' && !isNaN(value)) return value;
                      } catch (e) {
                        // getNumber() might throw
                      }
                    }
                    // Try toNumber() method
                    if (typeof val.toNumber === 'function') {
                      try {
                        const value = val.toNumber();
                        if (typeof value === 'number' && !isNaN(value)) return value;
                      } catch (e) {
                        // toNumber() might throw
                      }
                    }
                    // Try value property
                    if (typeof val === 'object' && 'value' in val && typeof val.value === 'number') {
                      return val.value;
                    }
                    // Last resort: try Number() constructor
                    try {
                      const num = Number(val);
                      if (!isNaN(num) && isFinite(num)) return num;
                    } catch (e) {
                      // Number() might fail
                    }
                    return null;
                  };

                  // Try to get rect and other properties directly from the dictionary
                  const rectObj = annotObj.get("Rect");
                  if (rectObj) {
                    // Try to convert rectObj to array - MuPDF arrays need special handling
                    let rectArray: number[] = [];
                    if (Array.isArray(rectObj)) {
                      // Convert array elements to numbers
                      rectArray = rectObj.map(convertMupdfNumber).filter((v): v is number => v !== null);
                    } else {
                        // MuPDF array object - try to extract values using get() method or array access
                      try {
                        // Try using get() method if available (MuPDF arrays often have this)
                        if (typeof rectObj.get === 'function' && typeof rectObj.length !== 'undefined') {
                          const len = rectObj.length;
                          if (len >= 4) {
                            // Extract values and convert MuPDF number objects to actual numbers
                            const val0 = convertMupdfNumber(rectObj.get(0));
                            const val1 = convertMupdfNumber(rectObj.get(1));
                            const val2 = convertMupdfNumber(rectObj.get(2));
                            const val3 = convertMupdfNumber(rectObj.get(3));
                            
                            if (val0 !== null && val1 !== null && val2 !== null && val3 !== null) {
                              rectArray = [val0, val1, val2, val3];
                            }
                          }
                        } else if (typeof rectObj.valueOf === 'function') {
                          // Try valueOf
                          const value = rectObj.valueOf();
                          if (Array.isArray(value) && value.length >= 4) {
                            // Convert array elements to numbers
                            rectArray = value.map(convertMupdfNumber).filter((v): v is number => v !== null);
                          }
                        } else if (typeof rectObj.length !== 'undefined' && rectObj.length >= 4) {
                          // Try direct array access with get() fallback
                          try {
                            const val0 = convertMupdfNumber(rectObj.get ? rectObj.get(0) : rectObj[0]);
                            const val1 = convertMupdfNumber(rectObj.get ? rectObj.get(1) : rectObj[1]);
                            const val2 = convertMupdfNumber(rectObj.get ? rectObj.get(2) : rectObj[2]);
                            const val3 = convertMupdfNumber(rectObj.get ? rectObj.get(3) : rectObj[3]);
                            
                            if (val0 !== null && val1 !== null && val2 !== null && val3 !== null) {
                              rectArray = [val0, val1, val2, val3];
                            }
                          } catch (e) {
                            // If get() fails, try direct access
                            const val0 = convertMupdfNumber(rectObj[0]);
                            const val1 = convertMupdfNumber(rectObj[1]);
                            const val2 = convertMupdfNumber(rectObj[2]);
                            const val3 = convertMupdfNumber(rectObj[3]);
                            
                            if (val0 !== null && val1 !== null && val2 !== null && val3 !== null) {
                              rectArray = [val0, val1, val2, val3];
                            }
                          }
                        }
                      } catch (extractError) {
                      }
                    }
                    
                    if (rectArray.length >= 4 && rectArray.every(v => typeof v === 'number' && !isNaN(v))) {
                      const rect: [number, number, number, number] = [rectArray[0], rectArray[1], rectArray[2], rectArray[3]];
                      
                      // Process the Widget annotation using the existing logic
                    
                    let fieldType: "text" | "checkbox" | "radio" | "dropdown" | "date" = "text";
                    let fieldName = "";
                    let fieldValue: string | boolean = "";
                    let options: string[] = [];
                    let readOnly = false;
                    let required = false;
                    let multiline = false;
                    let radioGroup = "";
                    
                    const ftObj = annotObj.get("FT");
                    let ftName = ftObj && ftObj.getName ? ftObj.getName() : (ftObj ? ftObj.toString() : "");
                    // CRITICAL FIX: Strip leading slash from PDF name objects (e.g., "/Btn" -> "Btn")
                    // PDF name objects return "/Name" from toString(), but we need "Name" for comparison
                    if (ftName.startsWith("/")) {
                      ftName = ftName.substring(1);
                    }
                    
                    if (ftName === "Tx") {
                      fieldType = "text";
                      const ff = annotObj.get("Ff");
                      if (ff && typeof ff.valueOf === "function") {
                        const flags = ff.valueOf();
                        multiline = (flags & 4096) !== 0;
                        readOnly = (flags & 1) !== 0;
                        required = (flags & 2) !== 0;
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
                        try {
                          // Try to get length if it's a MuPDF array
                          const optLength = optObj.length !== undefined ? optObj.length : (Array.isArray(optObj) ? optObj.length : 0);
                          
                          if (Array.isArray(optObj)) {
                            // Direct array
                            options = optObj.map((o: any) => {
                              if (o && typeof o === 'object' && o.toString) {
                                return o.toString();
                              }
                              return String(o);
                            });
                          } else if (optLength > 0) {
                            // MuPDF array object - try to extract using get() method
                            options = [];
                            for (let i = 0; i < optLength; i++) {
                              try {
                                const optItem = optObj.get ? optObj.get(i) : optObj[i];
                                if (optItem) {
                                  if (Array.isArray(optItem) && optItem.length > 0) {
                                    // Array of arrays (export values) - take first element
                                    const firstItem = optItem[0];
                                    options.push(firstItem.toString ? firstItem.toString() : String(firstItem));
                                  } else {
                                    options.push(optItem.toString ? optItem.toString() : String(optItem));
                                  }
                                }
                              } catch (e) {
                                // Skip this option if we can't read it
                              }
                            }
                          }
                        } catch (optError) {
                          console.warn("Error parsing dropdown options:", optError);
                        }
                      }
                    }
                    
                    // Try to get field name from Widget annotation's T field, or from Parent field dictionary
                    const tObj = annotObj.get("T");
                    if (tObj && tObj !== null) {
                      let nameStr = tObj.toString();
                      // Remove parentheses if present (they're added when storing)
                      if (nameStr && nameStr.startsWith("(") && nameStr.endsWith(")")) {
                        nameStr = nameStr.slice(1, -1);
                      }
                      // Only use if it's not "null" as a string
                      if (nameStr && nameStr !== "null" && nameStr !== "undefined") {
                        fieldName = nameStr;
                        
                        // Detect date fields by field name pattern (date fields are created with names like "date_1234567890")
                        if (fieldName.startsWith("date_") && ftName === "Tx") {
                          fieldType = "date";
                        }
                      }
                    }
                    
                    // If no field name in Widget, try Parent field dictionary
                    if (!fieldName) {
                      const parentObj = annotObj.get("Parent");
                      if (parentObj) {
                        try {
                          const parentT = parentObj.get ? parentObj.get("T") : null;
                          if (parentT) {
                            let nameStr = parentT.toString();
                            // Remove parentheses if present
                            if (nameStr && nameStr.startsWith("(") && nameStr.endsWith(")")) {
                              nameStr = nameStr.slice(1, -1);
                            }
                            if (nameStr && nameStr !== "null" && nameStr !== "undefined") {
                              fieldName = nameStr;
                            }
                          }
                        } catch (e) {
                          // Parent might not be accessible
                        }
                      }
                    }
                    
                    const vObj = annotObj.get("V");
                    if (vObj && vObj !== null) {
                      // Handle checkbox and radio button values specially
                      if (fieldType === "checkbox" || fieldType === "radio") {
                        const vName = vObj.getName ? vObj.getName() : vObj.toString();
                        // Strip leading slash if present (PDF name objects)
                        const normalizedName = vName.startsWith("/") ? vName.substring(1) : vName;
                        fieldValue = normalizedName === "Yes" || normalizedName === "On";
                      } else {
                        let valueStr = vObj.toString();
                        // Remove parentheses if present
                        if (valueStr && valueStr.startsWith("(") && valueStr.endsWith(")")) {
                          valueStr = valueStr.slice(1, -1);
                        }
                        if (valueStr && valueStr !== "null" && valueStr !== "undefined") {
                          fieldValue = valueStr;
                        }
                      }
                    }
                    
                    // Also check AS (appearance state) for radio buttons and checkboxes
                    if ((fieldType === "checkbox" || fieldType === "radio") && fieldValue === undefined) {
                      const asObj = annotObj.get("AS");
                      if (asObj && asObj !== null) {
                        const asName = asObj.getName ? asObj.getName() : asObj.toString();
                        const normalizedAsName = asName.startsWith("/") ? asName.substring(1) : asName;
                        fieldValue = normalizedAsName === "Yes" || normalizedAsName === "On";
                      } else {
                        // Default to unchecked if no V or AS
                        fieldValue = false;
                      }
                    }
                    
                    // Store form fields in PDF coordinates
                    // PDF rect format: [x0, y0, x1, y1] where (x0,y0) is bottom-left and (x1,y1) is top-right
                    // annotation.y is the BOTTOM Y in PDF coordinates (rect[1]), matching FormTool convention
                    // FormField.tsx uses: pdfToCanvas(annotation.x, annotation.y + annotation.height)
                    // where annotation.y + height gives the top Y in PDF, which pdfToCanvas flips to top in canvas
                    const y = rect[1]; // Bottom Y in PDF coordinates (matches FormTool and FormField.tsx)
                    const id = `pdf_${pageNumber}_${rect[0]}_${rect[1]}_${Math.random().toString(36).substr(2, 9)}`;
                    
                    // Check if we already have this annotation (avoid duplicates)
                    const alreadyExists = annotations.some(a => 
                      a.type === 'formField' && 
                      Math.abs(a.x - rect[0]) < 1 && 
                      Math.abs(a.y - y) < 1
                    );
                    
                    if (!alreadyExists) {
                      annotations.push({
                        id,
                        type: "formField" as const,
                        pageNumber,
                        x: rect[0],
                        y: y, // Bottom Y in PDF coordinates (rect[1])
                        width: rect[2] - rect[0],
                        height: rect[3] - rect[1],
                        fieldType,
                        fieldName,
                        fieldValue,
                        options,
                        readOnly,
                        required,
                        multiline,
                        radioGroup,
                        // Note: pdfAnnotation might be null since we can't create it from the dictionary
                        // But the annotation is still valid and will be recreated when needed
                      });
                    }
                    }
                  }
                }
              }
            }
          } catch (annotError) {
            // Ignore errors for individual annotations
          }
        }
      }
    }
  } catch (annotsArrayError) {
  }

  return annotations;

  } catch (error) {

  console.error(`Error loading annotations from page ${pageNumber}:`, error);

  return [];

  }

  }

}