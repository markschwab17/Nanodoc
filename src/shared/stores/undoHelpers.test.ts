/**
 * Tests for the undo/redo wrapping helpers — the mechanism every annotation
 * tool relies on for Cmd+Z. Covers add/remove/update round-trips against the
 * real zustand stores.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { usePDFStore } from "./pdfStore";
import { useUndoRedoStore } from "./undoRedoStore";
import { useTabStore } from "./tabStore";
import { wrapAnnotationOperation, wrapAnnotationUpdate } from "./undoHelpers";
import type { Annotation } from "@/core/pdf/PDFEditor";

const DOC_ID = "doc_test";

function makeAnnotation(id: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id,
    type: "shape",
    pageNumber: 0,
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    ...overrides,
  } as Annotation;
}

function annotations(): Annotation[] {
  return usePDFStore.getState().getAnnotations(DOC_ID);
}

beforeEach(() => {
  usePDFStore.setState({
    annotations: new Map(),
    bookmarks: new Map(),
    currentDocumentId: null,
    currentPage: 0,
  });
  useUndoRedoStore.getState().clearHistory();
  useTabStore.setState({ tabs: [], activeTabId: null });
});

describe("wrapAnnotationOperation(addAnnotation)", () => {
  it("adds the annotation and records an undoable action", () => {
    const annot = makeAnnotation("a1");
    wrapAnnotationOperation(
      () => usePDFStore.getState().addAnnotation(DOC_ID, annot),
      "addAnnotation",
      DOC_ID,
      annot.id,
      annot
    );

    expect(annotations().map((a) => a.id)).toEqual(["a1"]);
    expect(useUndoRedoStore.getState().canUndo()).toBe(true);
    expect(useUndoRedoStore.getState().getUndoLabel()).toBe("Undo: Add annotation");
  });

  it("undo removes the added annotation; redo restores it", async () => {
    const annot = makeAnnotation("a1");
    wrapAnnotationOperation(
      () => usePDFStore.getState().addAnnotation(DOC_ID, annot),
      "addAnnotation",
      DOC_ID,
      annot.id,
      annot
    );

    await useUndoRedoStore.getState().undo();
    expect(annotations()).toHaveLength(0);
    expect(useUndoRedoStore.getState().canRedo()).toBe(true);

    await useUndoRedoStore.getState().redo();
    expect(annotations().map((a) => a.id)).toEqual(["a1"]);
  });

  it("supports multiple adds undone in LIFO order", async () => {
    for (const id of ["a1", "a2", "a3"]) {
      const annot = makeAnnotation(id);
      wrapAnnotationOperation(
        () => usePDFStore.getState().addAnnotation(DOC_ID, annot),
        "addAnnotation",
        DOC_ID,
        annot.id,
        annot
      );
    }
    expect(annotations()).toHaveLength(3);

    await useUndoRedoStore.getState().undo();
    expect(annotations().map((a) => a.id)).toEqual(["a1", "a2"]);
    await useUndoRedoStore.getState().undo();
    expect(annotations().map((a) => a.id)).toEqual(["a1"]);
  });

  it("marks the document's tab as modified", () => {
    useTabStore.setState({
      tabs: [
        { id: "t1", documentId: DOC_ID, name: "x.pdf", isModified: false, lastSaved: null, order: 0 },
      ],
      activeTabId: "t1",
    });
    const annot = makeAnnotation("a1");
    wrapAnnotationOperation(
      () => usePDFStore.getState().addAnnotation(DOC_ID, annot),
      "addAnnotation",
      DOC_ID,
      annot.id,
      annot
    );
    expect(useTabStore.getState().tabs[0].isModified).toBe(true);
  });
});

describe("wrapAnnotationOperation(removeAnnotation)", () => {
  it("undo restores a removed annotation", async () => {
    const annot = makeAnnotation("a1");
    usePDFStore.getState().addAnnotation(DOC_ID, annot);

    wrapAnnotationOperation(
      () => usePDFStore.getState().removeAnnotation(DOC_ID, annot.id),
      "removeAnnotation",
      DOC_ID,
      annot.id,
      annot,
      annot
    );
    expect(annotations()).toHaveLength(0);

    await useUndoRedoStore.getState().undo();
    expect(annotations().map((a) => a.id)).toEqual(["a1"]);
  });
});

describe("wrapAnnotationUpdate", () => {
  it("applies the update and undo restores the previous values", async () => {
    const annot = makeAnnotation("a1", { x: 10, y: 20 });
    usePDFStore.getState().addAnnotation(DOC_ID, annot);

    wrapAnnotationUpdate(DOC_ID, "a1", { x: 99, y: 88 });
    expect(annotations()[0]).toMatchObject({ x: 99, y: 88 });

    await useUndoRedoStore.getState().undo();
    expect(annotations()[0]).toMatchObject({ x: 10, y: 20 });

    await useUndoRedoStore.getState().redo();
    expect(annotations()[0]).toMatchObject({ x: 99, y: 88 });
  });

  it("falls through to a plain update when the annotation does not exist", () => {
    wrapAnnotationUpdate(DOC_ID, "missing", { x: 1 });
    expect(useUndoRedoStore.getState().canUndo()).toBe(false);
  });
});

describe("history bounds", () => {
  it("caps history at maxHistorySize", () => {
    const max = useUndoRedoStore.getState().maxHistorySize;
    for (let i = 0; i < max + 10; i++) {
      const annot = makeAnnotation(`a${i}`);
      wrapAnnotationOperation(
        () => usePDFStore.getState().addAnnotation(DOC_ID, annot),
        "addAnnotation",
        DOC_ID,
        annot.id,
        annot
      );
    }
    expect(useUndoRedoStore.getState().history.length).toBe(max);
  });
});
