/**
 * Selection Box Tool Handler
 *
 * Lets the user draw a rectangle around PDF content, captures it as a PNG,
 * redacts (white-fills) the original area, and places a movable/resizable
 * image annotation at the same position.
 */

import type { ToolHandler, ToolContext } from "./types";
import type { Annotation } from "@/core/pdf/PDFEditor";
import { useNotificationStore } from "@/shared/stores/notificationStore";
import { normalizeSelectionToRect, validatePDFRect, capCaptureScale } from "./coordinateHelpers";
import { wrapAnnotationOperation } from "@/shared/stores/undoHelpers";
import { useUIStore } from "@/shared/stores/uiStore";
import { syncDocumentRenderers } from "@/shared/stores/undoHelpers";

export const SelectionBoxTool: ToolHandler = {
  handleMouseDown: (e: React.MouseEvent, context: ToolContext) => {
    const coords = context.getPDFCoordinates(e);
    if (coords) {
      context.setIsSelecting(true);
      context.setSelectionStart(coords);
      context.setSelectionEnd(coords);
    }
  },

  handleMouseUp: async (
    _e: React.MouseEvent,
    context: ToolContext,
    selectionStart,
    selectionEnd
  ) => {
    if (!selectionStart || !selectionEnd) return;

    const {
      document: currentDocument,
      pageNumber,
      addAnnotation,
      removeAnnotation,
      editor,
      renderer,
      canvasRef,
      BASE_SCALE,
    } = context;

    const rect = normalizeSelectionToRect(selectionStart, selectionEnd);

    // Only proceed if box is large enough
    if (rect.width <= 10 || rect.height <= 10) {
      context.setIsSelecting(false);
      context.setSelectionStart(null);
      context.setSelectionEnd(null);
      return;
    }

    const pageMetadata = currentDocument.getPageMetadata(pageNumber);
    if (!pageMetadata) {
      context.setIsSelecting(false);
      context.setSelectionStart(null);
      context.setSelectionEnd(null);
      return;
    }

    // Use original mediabox height (same as RedactTool)
    let mediaboxHeight: number;
    if (pageMetadata.rotation === 90 || pageMetadata.rotation === 270) {
      mediaboxHeight = pageMetadata.width;
    } else {
      mediaboxHeight = pageMetadata.height;
    }

    const validation = validatePDFRect(rect, mediaboxHeight);
    if (!validation.isValid) {
      useNotificationStore
        .getState()
        .showNotification("Invalid selection coordinates", "error");
      context.setIsSelecting(false);
      context.setSelectionStart(null);
      context.setSelectionEnd(null);
      return;
    }

    if (!editor) {
      useNotificationStore
        .getState()
        .showNotification("PDF editor not initialized", "error");
      context.setIsSelecting(false);
      context.setSelectionStart(null);
      context.setSelectionEnd(null);
      return;
    }

    try {
      // ── Step 1: Capture the selected region as PNG ──────────────────────
      // The capture renders the FULL page and crops the selection out of it.
      // Cap the scale by page + crop pixel budgets: an Arch-D sheet at the
      // uncapped 4x was a 70+ MP (~280 MB) render that timed out the worker
      // and froze the tab on putImageData/toDataURL.
      const idealScale = Math.min(2 * (window.devicePixelRatio || 1), 4);
      const captureScale = capCaptureScale(
        pageMetadata.width,
        pageMetadata.height,
        rect.width,
        rect.height,
        idealScale
      );

      // Surface progress before the heavy work; yield once so it paints.
      useNotificationStore
        .getState()
        .showNotification("Capturing selection…", "info");
      await new Promise((resolve) => setTimeout(resolve, 0));

      const rendered = await renderer.renderPage(
        currentDocument.getMupdfDocument(),
        pageNumber,
        { scale: captureScale, rotation: 0 }
      );

      // Convert PDF rect to pixmap pixel coordinates
      // PDF: Y=0 at bottom. Pixmap: Y=0 at top.
      const cropX = Math.round(rect.x * captureScale);
      const cropY = Math.round(
        (mediaboxHeight - (rect.y + rect.height)) * captureScale
      );
      const cropW = Math.round(rect.width * captureScale);
      const cropH = Math.round(rect.height * captureScale);

      // Clamp to pixmap bounds
      const clampedX = Math.max(0, Math.min(cropX, rendered.width - 1));
      const clampedY = Math.max(0, Math.min(cropY, rendered.height - 1));
      const clampedW = Math.min(cropW, rendered.width - clampedX);
      const clampedH = Math.min(cropH, rendered.height - clampedY);

      if (clampedW <= 0 || clampedH <= 0) {
        useNotificationStore
          .getState()
          .showNotification("Selection is outside page bounds", "error");
        context.setIsSelecting(false);
        context.setSelectionStart(null);
        context.setSelectionEnd(null);
        return;
      }

      // Render full page onto an offscreen canvas, then crop
      const fullCanvas = document.createElement("canvas");
      fullCanvas.width = rendered.width;
      fullCanvas.height = rendered.height;
      const fullCtx = fullCanvas.getContext("2d")!;
      if (rendered.imageData instanceof ImageData) {
        fullCtx.putImageData(rendered.imageData, 0, 0);
      }

      const cropCanvas = document.createElement("canvas");
      cropCanvas.width = clampedW;
      cropCanvas.height = clampedH;
      const cropCtx = cropCanvas.getContext("2d")!;
      cropCtx.drawImage(
        fullCanvas,
        clampedX,
        clampedY,
        clampedW,
        clampedH,
        0,
        0,
        clampedW,
        clampedH
      );

      const imageDataUrl = cropCanvas.toDataURL("image/png");

      // ── Step 2: Redact the original area ────────────────────────────────
      const flippedY = mediaboxHeight - (rect.y + rect.height);

      const redactAnnotation: Annotation = {
        id: `selbox_redact_${Date.now()}`,
        type: "redact",
        pageNumber,
        x: rect.x,
        y: flippedY,
        width: rect.width,
        height: rect.height,
      };

      // Temporarily add redaction to store, apply, then remove (same as RedactTool)
      addAnnotation(currentDocument.getId(), redactAnnotation);

      await editor.addRedactionAnnotation(currentDocument, redactAnnotation);

      // Clear caches and force re-render (legacy renderer + tile pyramid —
      // with tiles active the legacy canvas isn't mounted, so without the
      // tile refresh the user keeps seeing the un-redacted content). The
      // sync also re-serializes the doc so the tile workers render the
      // erased content instead of their stale load-time snapshot.
      renderer.clearCache();
      syncDocumentRenderers(currentDocument.getId());
      currentDocument.refreshPageMetadata();

      const mupdfDoc = currentDocument.getMupdfDocument();
      const pdfDoc = mupdfDoc.asPDF();
      if (pdfDoc) {
        pdfDoc.loadPage(pageNumber);
      }

      // Re-render the canvas to show redacted area
      const canvas = canvasRef.current;
      if (canvas) {
        const dpr = window.devicePixelRatio || 1;
        const renderScale = BASE_SCALE * dpr;
        const freshRendered = await renderer.renderPage(
          currentDocument.getMupdfDocument(),
          pageNumber,
          { scale: renderScale, rotation: 0 }
        );

        const freshMeta = currentDocument.getPageMetadata(pageNumber);
        const pdfDisplayWidth =
          freshMeta?.width || freshRendered.width / dpr;
        const pdfDisplayHeight =
          freshMeta?.height || freshRendered.height / dpr;

        canvas.width = freshRendered.width;
        canvas.height = freshRendered.height;
        canvas.style.width = `${pdfDisplayWidth}px`;
        canvas.style.height = `${pdfDisplayHeight}px`;

        const ctx = canvas.getContext("2d", {
          willReadFrequently: false,
          colorSpace: "srgb",
        });
        if (ctx && freshRendered.imageData instanceof ImageData) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.putImageData(freshRendered.imageData, 0, 0);
        }
      }

      // Remove the temporary redaction annotation from the store
      removeAnnotation(currentDocument.getId(), redactAnnotation.id);

      // ── Step 3: Create image annotation at same position ────────────────
      const imageAnnotation: Annotation = {
        id: `selbox_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: "image",
        pageNumber,
        x: rect.x,
        y: rect.y, // Bottom edge in PDF coords
        width: rect.width,
        height: rect.height,
        imageData: imageDataUrl,
        imageWidth: clampedW,
        imageHeight: clampedH,
        preserveAspectRatio: false,
      };

      wrapAnnotationOperation(
        () => {
          addAnnotation(currentDocument.getId(), imageAnnotation);
        },
        "addAnnotation",
        currentDocument.getId(),
        imageAnnotation.id,
        imageAnnotation
      );

      // ── Step 4: Switch to select tool and select the annotation ─────────
      context.setEditingAnnotation(imageAnnotation);
      useUIStore.getState().setActiveTool("select");

      useNotificationStore
        .getState()
        .showNotification(
          "Content captured — drag to move, resize with handles",
          "success"
        );
    } catch (err) {
      console.error("Selection box capture failed:", err);
      useNotificationStore
        .getState()
        .showNotification(
          `Selection failed: ${err instanceof Error ? err.message : "Unknown error"}`,
          "error"
        );
    }

    context.setIsSelecting(false);
    context.setSelectionStart(null);
    context.setSelectionEnd(null);
  },
};
