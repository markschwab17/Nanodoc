/**
 * PDF Editor Types
 * 
 * Type definitions for PDF editing operations and annotations.
 */

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


