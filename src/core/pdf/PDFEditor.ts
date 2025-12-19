/**
 * PDF Editor
 * 
 * Provides PDF manipulation operations using mupdf-js:
 * - Page reordering
 * - Page insertion/deletion
 * - Annotation management
 * - Document saving
 */

import type { PDFDocument } from "./PDFDocument";
import type { PageReorderOperation, Annotation } from "./types";
import { PDFPageOperations } from "./PDFPageOperations";
import { PDFAnnotationOperations } from "./PDFAnnotationOperations";
import { PDFAnnotationLoader } from "./PDFAnnotationLoader";
import { PDFDocumentOperations } from "./PDFDocumentOperations";

// Re-export types for backward compatibility
export type { PageReorderOperation, Annotation, StampData } from "./types";

export class PDFEditor {
  private mupdf: any;
  private pageOps: PDFPageOperations;
  private annotationOps: PDFAnnotationOperations;
  private annotationLoader: PDFAnnotationLoader;
  private documentOps: PDFDocumentOperations;

  constructor(mupdf: any) {
    this.mupdf = mupdf;
    this.pageOps = new PDFPageOperations(mupdf);
    this.annotationOps = new PDFAnnotationOperations(mupdf);
    this.annotationLoader = new PDFAnnotationLoader(mupdf);
    this.documentOps = new PDFDocumentOperations(mupdf, this.annotationOps, this.pageOps);
  }

  // Page Operations
  async reorderPages(
    document: PDFDocument,
    operations: PageReorderOperation[]
  ): Promise<void> {
    return this.pageOps.reorderPages(document, operations);
  }

  async insertBlankPage(
    document: PDFDocument,
    index: number,
    _width: number = 612,
    _height: number = 792
  ): Promise<void> {
    return this.pageOps.insertBlankPage(document, index, _width, _height);
  }

  async insertPagesFromDocument(
    targetDoc: PDFDocument,
    sourceDoc: PDFDocument,
    targetIndex: number,
    sourcePageIndices: number[] = []
  ): Promise<void> {
    return this.pageOps.insertPagesFromDocument(targetDoc, sourceDoc, targetIndex, sourcePageIndices);
  }

  async deletePages(
    document: PDFDocument,
    pageIndices: number[]
  ): Promise<void> {
    return this.pageOps.deletePages(document, pageIndices);
  }

  async rotatePage(
    document: PDFDocument,
    pageNumber: number,
    degrees: number
  ): Promise<void> {
    return this.pageOps.rotatePage(document, pageNumber, degrees);
  }

  async resizePage(
    document: PDFDocument,
    pageNumber: number,
    width: number,
    height: number
  ): Promise<void> {
    return this.pageOps.resizePage(document, pageNumber, width, height);
  }

  async resizeAllPages(
    document: PDFDocument,
    width: number,
    height: number
  ): Promise<void> {
    return this.pageOps.resizeAllPages(document, width, height);
  }

  // Annotation Operations
  async addTextAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    return this.annotationOps.addTextAnnotation(document, annotation);
  }

  async addHighlightAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    return this.annotationOps.addHighlightAnnotation(document, annotation);
  }

  async addImageAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    return this.annotationOps.addImageAnnotation(document, annotation);
  }

  async addCalloutAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    return this.annotationOps.addCalloutAnnotation(document, annotation);
  }

  async addRedactionAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    return this.annotationOps.addRedactionAnnotation(document, annotation);
  }

  async addDrawingAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    return this.annotationOps.addDrawingAnnotation(document, annotation);
  }

  async addShapeAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<any> {
    return this.annotationOps.addShapeAnnotation(document, annotation);
  }

  async addFormFieldAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    return this.annotationOps.addFormFieldAnnotation(document, annotation);
  }

  async addStampAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    return this.annotationOps.addStampAnnotation(document, annotation);
  }

  async updateAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    return this.annotationOps.updateAnnotation(document, annotation);
  }

  async updateFormFieldValue(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    return this.annotationOps.updateFormFieldValue(document, annotation);
  }

  async updateAnnotationInPdf(
    document: PDFDocument,
    pdfAnnotation: any,
    updates: Partial<Annotation>
  ): Promise<void> {
    return this.annotationOps.updateAnnotationInPdf(document, pdfAnnotation, updates);
  }

  async deleteAnnotation(
    document: PDFDocument,
    annotation: Annotation
  ): Promise<void> {
    return this.annotationOps.deleteAnnotation(document, annotation);
  }

  async detectFormFields(
    document: PDFDocument,
    pageNumber: number
  ): Promise<Annotation[]> {
    return this.annotationOps.detectFormFields(document, pageNumber);
  }

  // Annotation Loading
  async loadAnnotationsFromPage(
    document: PDFDocument,
    pageNumber: number
  ): Promise<Annotation[]> {
    return this.annotationLoader.loadAnnotationsFromPage(document, pageNumber);
  }

  // Document Operations
  async syncAllAnnotations(
    document: PDFDocument,
    annotations: Annotation[]
  ): Promise<void> {
    return this.documentOps.syncAllAnnotations(document, annotations);
  }

  async syncAllAnnotationsExtended(
    document: PDFDocument,
    annotations: Annotation[]
  ): Promise<void> {
    return this.documentOps.syncAllAnnotationsExtended(document, annotations);
  }

  async saveDocument(
    document: PDFDocument,
    annotations?: Annotation[]
  ): Promise<Uint8Array> {
    return this.documentOps.saveDocument(document, annotations);
  }

  async exportPageAsPDF(
    document: PDFDocument,
    pageNumber: number,
    annotations?: Annotation[]
  ): Promise<Uint8Array> {
    return this.documentOps.exportPageAsPDF(document, pageNumber, annotations);
  }

  async flattenAllAnnotations(
    document: PDFDocument,
    currentPageOnly: boolean = false,
    pageNumber?: number
  ): Promise<void> {
    return this.documentOps.flattenAllAnnotations(document, currentPageOnly, pageNumber);
  }

  // Utility
  createNewDocument(): any {
    return new this.mupdf.PDFDocument();
  }
}
