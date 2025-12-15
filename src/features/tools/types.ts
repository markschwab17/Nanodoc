/**
 * Tool Types and Interfaces
 * 
 * Shared types for PDF editing tools
 */

import type { Annotation } from "@/core/pdf/PDFEditor";
import type { PDFDocument } from "@/core/pdf/PDFDocument";

export interface ToolContext {
  document: PDFDocument;
  pageNumber: number;
  currentDocument: PDFDocument | null;
  annotations: Annotation[];
  activeTool: string;
  getPDFCoordinates: (e: React.MouseEvent) => { x: number; y: number } | null;
  pdfToCanvas: (pdfX: number, pdfY: number) => { x: number; y: number };
  pdfToContainer: (pdfX: number, pdfY: number) => { x: number; y: number };
  addAnnotation: (documentId: string, annotation: Annotation) => void;
  setEditingAnnotation: (annotation: Annotation | null) => void;
  setAnnotationText: (text: string) => void;
  setIsEditingMode: (isEditing: boolean) => void;
  setIsSelecting: (isSelecting: boolean) => void;
  setSelectionStart: (coords: { x: number; y: number } | null) => void;
  setSelectionEnd: (coords: { x: number; y: number } | null) => void;
  isSelecting: boolean;
  selectionStart: { x: number; y: number } | null;
  setSelectedTextSpans?: (spans: any[]) => void; // For live text selection preview
  setIsCreatingTextBox: (isCreating: boolean) => void;
  setTextBoxStart: (coords: { x: number; y: number } | null) => void;
  overlayHighlightPath?: Array<{ x: number; y: number }>; // Path for overlay highlights from PageCanvas
  editor: any; // PDFEditor instance
  renderer: any; // PDFRenderer instance
  canvasRef: React.RefObject<HTMLCanvasElement>;
  containerRef: React.RefObject<HTMLDivElement>;
  BASE_SCALE: number;
  zoomLevelRef: React.MutableRefObject<number>;
  fitMode: string;
  panOffset: { x: number; y: number };
  panOffsetRef: React.MutableRefObject<{ x: number; y: number }>;
}

export interface ToolHandler {
  handleMouseDown: (e: React.MouseEvent, context: ToolContext) => Promise<void> | void | boolean;
  handleMouseMove?: (e: React.MouseEvent, context: ToolContext) => void;
  handleMouseUp: (e: React.MouseEvent, context: ToolContext, selectionStart: { x: number; y: number } | null, selectionEnd: { x: number; y: number } | null, textBoxStart?: { x: number; y: number } | null) => Promise<void> | void;
  renderPreview?: (selectionStart: { x: number; y: number } | null, selectionEnd: { x: number; y: number } | null, context: ToolContext) => React.ReactNode;
  renderAnnotation?: (annotation: Annotation, context: ToolContext) => React.ReactNode;
}

