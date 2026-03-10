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
  type: "text" | "highlight" | "note" | "callout" | "redact" | "image" | "formField" | "draw" | "shape" | "stamp" | "signatureField";
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
  fieldType?: "text" | "checkbox" | "radio" | "dropdown" | "date" | "number" | "email" | "signature" | "listbox";
  fieldName?: string;
  fieldValue?: string | boolean;
  options?: string[]; // For dropdowns, radio buttons, and list boxes
  required?: boolean;
  readOnly?: boolean;
  multiline?: boolean;
  radioGroup?: string; // For grouping radio buttons
  locked?: boolean; // Lock position and size
  placeholder?: string; // Placeholder text for text/dropdown/number/email fields
  maxLength?: number; // Max character length for text fields
  validationType?: "none" | "email" | "number"; // Input validation type
  tabOrder?: number; // Tab order for form navigation
  fieldLabel?: string; // Visible label shown above/beside field
  tooltip?: string; // Tooltip text (maps to PDF TU field)
  defaultValue?: string | boolean; // Default/reset value (maps to PDF DV field)
  textAlignment?: "left" | "center" | "right"; // Text alignment within field
  fontColor?: string; // Text color within the field
  
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

  // For e-signature fields (prepare mode: sender places these; sign mode: recipient fills them)
  signerEmail?: string;
  signatureFieldType?: "signature" | "initials" | "date" | "name" | "text";
  signatureFieldRequired?: boolean;
  signatureFieldLabel?: string;
  signatureFieldStatus?: "empty" | "filled";
  /** Base64 PNG of the signature image after the recipient signs. */
  signatureImageData?: string;
}

export interface StampData {
  id: string;
  name: string;
  type: "text" | "image" | "signature";
  createdAt: number;
  thumbnail?: string; // base64 thumbnail
  /** Width/height in PDF points (at scale 1). Used so preview and placement size match without loading the thumbnail. */
  thumbnailWidthPoints?: number;
  thumbnailHeightPoints?: number;
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













