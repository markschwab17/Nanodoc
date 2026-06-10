/**
 * StampTool placement tests — drives handleMouseDown the way PageCanvas does
 * and asserts a stamp annotation lands in the store with undo support.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { StampTool, setSelectedStamp } from "./StampTool";
import type { ToolContext } from "./types";
import { useStampStore } from "@/shared/stores/stampStore";
import { usePDFStore } from "@/shared/stores/pdfStore";
import { useUndoRedoStore } from "@/shared/stores/undoRedoStore";

const DOC_ID = "doc_stamp_test";

function makeContext(): ToolContext {
  return {
    document: { getId: () => DOC_ID } as any,
    pageNumber: 0,
    currentDocument: { getId: () => DOC_ID } as any,
    annotations: [],
    activeTool: "stamp",
    readMode: false,
    getPDFCoordinates: () => ({ x: 120, y: 340 }),
    pdfToCanvas: (x: number, y: number) => ({ x, y }),
    pdfToContainer: (x: number, y: number) => ({ x, y }),
    addAnnotation: (docId, annotation) => usePDFStore.getState().addAnnotation(docId, annotation),
    removeAnnotation: (docId, id) => usePDFStore.getState().removeAnnotation(docId, id),
    setEditingAnnotation: () => {},
    setAnnotationText: () => {},
    setIsEditingMode: () => {},
    setIsSelecting: () => {},
    setSelectionStart: () => {},
    setSelectionEnd: () => {},
    isSelecting: false,
    selectionStart: null,
    setIsCreatingTextBox: () => {},
    setTextBoxStart: () => {},
    editor: null,
    renderer: null,
    canvasRef: { current: null } as any,
    containerRef: { current: null } as any,
    BASE_SCALE: 1,
    zoomLevelRef: { current: 1 } as any,
    fitMode: "custom",
    panOffset: { x: 0, y: 0 },
    panOffsetRef: { current: { x: 0, y: 0 } } as any,
  } as ToolContext;
}

function makeMouseEvent(): any {
  return {
    button: 0,
    clientX: 100,
    clientY: 100,
    preventDefault: () => {},
    stopPropagation: () => {},
  };
}

beforeEach(() => {
  usePDFStore.setState({ annotations: new Map() });
  useUndoRedoStore.getState().clearHistory();
  useStampStore.setState({ stamps: [] } as any);
});

describe("StampTool.handleMouseDown", () => {
  it("places a stamp annotation when a stamp is selected", async () => {
    useStampStore.getState().addStamp({
      id: "s1",
      name: "Logo",
      type: "image",
      createdAt: 1,
      thumbnail: "data:image/png;base64,abc",
      imageData: "data:image/png;base64,abc",
      thumbnailWidthPoints: 100,
      thumbnailHeightPoints: 60,
    } as any);
    setSelectedStamp("s1");

    await StampTool.handleMouseDown(makeMouseEvent(), makeContext());

    const annots = usePDFStore.getState().getAnnotations(DOC_ID);
    expect(annots).toHaveLength(1);
    expect(annots[0].type).toBe("stamp");
    expect(annots[0].stampId).toBe("s1");
    expect(useUndoRedoStore.getState().canUndo()).toBe(true);
  });

  it("does nothing when no stamp is selected", async () => {
    setSelectedStamp(null);
    await StampTool.handleMouseDown(makeMouseEvent(), makeContext());
    expect(usePDFStore.getState().getAnnotations(DOC_ID)).toHaveLength(0);
  });
});
