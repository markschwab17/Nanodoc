/**
 * Undo Helpers
 * 
 * Helper functions to wrap pdfStore actions with undo/redo support.
 */

import { usePDFStore } from "./pdfStore";
import { useUndoRedoStore } from "./undoRedoStore";
import type { Annotation } from "@/core/pdf/PDFEditor";

/**
 * Wrap annotation update with undo/redo
 */
export function wrapAnnotationUpdate(
  documentId: string,
  annotationId: string,
  updates: Partial<Annotation>
) {
  const pdfStore = usePDFStore.getState();
  const undoStore = useUndoRedoStore.getState();

  // Get current annotation state
  const currentAnnotations = pdfStore.getAnnotations(documentId);
  const currentAnnotation = currentAnnotations.find((a) => a.id === annotationId);
  
  if (!currentAnnotation) {
    // Annotation not found, just update without undo
    usePDFStore.getState().updateAnnotation(documentId, annotationId, updates);
    return;
  }

  // Capture before state
  const beforeState = {
    annotations: new Map(pdfStore.annotations),
    currentPage: pdfStore.currentPage,
    currentDocumentId: pdfStore.currentDocumentId,
  };

  // Store previous annotation state for undo
  const previousAnnotation = { ...currentAnnotation };

  // Execute update
  usePDFStore.getState().updateAnnotation(documentId, annotationId, updates);

  // Capture after state
  const afterState = {
    annotations: new Map(usePDFStore.getState().annotations),
    currentPage: usePDFStore.getState().currentPage,
    currentDocumentId: usePDFStore.getState().currentDocumentId,
  };

  // Create undo/redo functions
  const undo = () => {
    // Restore previous annotation state - need to restore all properties
    const currentAnnotations = usePDFStore.getState().getAnnotations(documentId);
    const currentAnnot = currentAnnotations.find((a) => a.id === annotationId);
    if (currentAnnot) {
      // Restore all previous properties
      usePDFStore.getState().updateAnnotation(documentId, annotationId, {
        ...previousAnnotation,
      });
    }
  };

  const redo = () => {
    // Re-apply updates
    usePDFStore.getState().updateAnnotation(documentId, annotationId, updates);
  };

  // Record action
  undoStore.pushAction({
    type: "updateAnnotation",
    documentId,
    beforeState,
    afterState,
    actionData: {
      annotationId,
      annotation: { ...currentAnnotation, ...updates },
    },
    undo,
    redo,
  });
}

/**
 * Wrap annotation operations with undo/redo
 */
export function wrapAnnotationOperation(
  operation: () => void,
  type: "addAnnotation" | "removeAnnotation" | "updateAnnotation",
  documentId: string,
  annotationId?: string,
  annotation?: Annotation,
  previousAnnotation?: Annotation
) {
  const undoStore = useUndoRedoStore.getState();

  // Capture before state (for the action record)
  const before = usePDFStore.getState();
  const beforeState = {
    annotations: new Map(before.annotations),
    currentPage: before.currentPage,
    currentDocumentId: before.currentDocumentId,
  };

  // Execute operation
  operation();

  // Capture after state — must RE-READ the store: zustand replaces the state
  // object on set(), so the pre-operation reference above is stale.
  const after = usePDFStore.getState();
  const afterState = {
    annotations: new Map(after.annotations),
    currentPage: after.currentPage,
    currentDocumentId: after.currentDocumentId,
  };

  // Undo applies the surgical INVERSE of the operation (and redo re-runs the
  // operation) through the normal store actions. Earlier versions restored a
  // whole-map snapshot AND re-applied the annotation, which both duplicated
  // the annotation on undo-of-delete and clobbered unrelated changes made
  // after the snapshot. Going through the store actions also keeps the tab's
  // modified flag accurate.
  const undo = () => {
    if (type === "addAnnotation" && annotation) {
      usePDFStore.getState().removeAnnotation(documentId, annotation.id);
    } else if (type === "removeAnnotation") {
      const restored = previousAnnotation ?? annotation;
      if (restored) usePDFStore.getState().addAnnotation(documentId, restored);
    } else if (type === "updateAnnotation" && previousAnnotation) {
      usePDFStore.getState().updateAnnotation(
        documentId,
        annotationId!,
        previousAnnotation
      );
    }
  };

  const redo = () => {
    operation();
  };

  // Record action
  undoStore.pushAction({
    type,
    documentId,
    beforeState,
    afterState,
    actionData: {
      annotationId,
      annotation,
    },
    undo,
    redo,
  });
}

/**
 * Wrap page operations with undo/redo
 */
export async function wrapPageOperation(
  operation: () => Promise<void>,
  type: "deletePages" | "insertPages" | "pastePages" | "rotatePages" | "reorderPages",
  documentId: string,
  pageIndices: number[],
  targetIndex?: number,
  sourceDocumentId?: string
) {
  const pdfStore = usePDFStore.getState();
  const undoStore = useUndoRedoStore.getState();
  const currentDocument = pdfStore.getCurrentDocument();

  if (!currentDocument) return;

  // Capture before state
  const beforeState = {
    annotations: new Map(pdfStore.annotations),
    currentPage: pdfStore.currentPage,
    currentDocumentId: pdfStore.currentDocumentId,
  };

  // For delete operations, save annotations that will be deleted
  const annotationsToDelete: Annotation[] = [];
  if (type === "deletePages") {
    const docAnnotations = pdfStore.getAnnotations(documentId);
    pageIndices.forEach((pageIndex) => {
      annotationsToDelete.push(
        ...docAnnotations.filter((ann) => ann.pageNumber === pageIndex)
      );
    });
  }

  // Execute operation
  await operation();

  // Refresh document metadata
  if (typeof (currentDocument as any).refreshPageMetadata === "function") {
    (currentDocument as any).refreshPageMetadata();
  }

  // Capture after state
  const afterState = {
    annotations: new Map(usePDFStore.getState().annotations),
    currentPage: usePDFStore.getState().currentPage,
    currentDocumentId: usePDFStore.getState().currentDocumentId,
  };

  // Create undo/redo functions
  const undo = async () => {
    const currentState = usePDFStore.getState();
    const doc = currentState.getCurrentDocument();
    if (!doc) return;

    // For delete: restore pages (this is complex - would need to restore from backup)
    // For insert/paste: remove inserted pages
    // This is a simplified approach - in a full implementation, we'd need to
    // store page data for proper undo
    usePDFStore.setState({ annotations: new Map(beforeState.annotations) });
    usePDFStore.setState({ currentPage: beforeState.currentPage || 0 });
  };

  const redo = async () => {
    await operation();
    if (typeof (currentDocument as any).refreshPageMetadata === "function") {
      (currentDocument as any).refreshPageMetadata();
    }
    usePDFStore.setState({ annotations: new Map(afterState.annotations) });
    usePDFStore.setState({ currentPage: afterState.currentPage || 0 });
  };

  // Record action
  undoStore.pushAction({
    type,
    documentId,
    beforeState,
    afterState,
    actionData: {
      pageIndices,
      targetIndex,
      sourceDocumentId,
    },
    undo,
    redo,
  });
}




















