/**
 * Thumbnail Item Component
 *
 * Individual thumbnail in the carousel. Reads the shared tile renderer's
 * cached LOD-0 tile (one bitmap per page that the main page view already
 * needs anyway) and draws it onto a small canvas. No separate mupdf worker,
 * no per-thumbnail render — thumbnails are effectively free once the doc's
 * LOD-0 prefetch completes.
 */

import { cn } from "@/lib/utils";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PDFDocument } from "@/core/pdf/PDFDocument";
import type { TiledPageRenderer } from "@/core/pdf/tiles/TiledPageRenderer";
import { Trash2, RotateCw } from "lucide-react";
import { PDFEditor } from "@/core/pdf/PDFEditor";
import { usePDFStore } from "@/shared/stores/pdfStore";

interface ThumbnailItemProps {
  document: PDFDocument;
  pageNumber: number;
  /** Shared tile renderer for the document. Source of LOD-0 bitmaps. */
  renderer: TiledPageRenderer | null;
  isActive: boolean;
  /** Bumped by the carousel after destructive edits to force re-fetch. */
  version?: number;
  onClick: (e: React.MouseEvent) => void;
  onDelete?: (e: React.MouseEvent) => void;
  onRotate?: (e: React.MouseEvent) => void;
  onDragStart?: () => void;
}

export function ThumbnailItem({
  document,
  pageNumber,
  renderer,
  isActive,
  version = 0,
  onClick,
  onDelete,
  onRotate,
  onDragStart: _onDragStart,
}: ThumbnailItemProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [painted, setPainted] = useState(false);
  // Bumps every time a LOD-0 tile arrives for our page. Drives the paint
  // useLayoutEffect to re-run and pick up the fresh bitmap. Using a counter
  // (rather than toggling a boolean) means re-fetches after invalidate also
  // trigger a re-paint cleanly: any new arrival increments and re-runs.
  const [paintKey, setPaintKey] = useState(0);
  const [isLandscape, setIsLandscape] = useState<boolean>(false);
  const { getAnnotations } = usePDFStore();
  const horizontalFlip = usePDFStore((state) =>
    state.getPageHorizontalFlip(document?.getId?.() ?? "", pageNumber),
  );

  // Determine landscape vs portrait from page metadata.
  useEffect(() => {
    const meta = document.getPageMetadata(pageNumber);
    if (meta) setIsLandscape(meta.width > meta.height);
  }, [document, pageNumber, version]);

  // Paint the LOD-0 bitmap onto our canvas. Re-runs when:
  // - the renderer instance changes
  // - the page number changes
  // - the carousel bumps `version` after a destructive edit
  // - paintKey bumps because a fresh tile arrived for this page
  useLayoutEffect(() => {
    if (!renderer) return;
    const tile = renderer.getLod0Tile(pageNumber);
    const canvas = canvasRef.current;
    if (!tile || !canvas) {
      // No tile yet — kick off a request so it lands when the worker pool
      // gets to it. ensureLod0 is a no-op if already cached or in flight.
      renderer.ensureLod0(pageNumber);
      setPainted(false);
      return;
    }
    // Match the canvas backing buffer to the tile's pixel size; CSS scales
    // it to thumbnail dimensions via width:100%/height:100%.
    if (canvas.width !== tile.pixelWidth) canvas.width = tile.pixelWidth;
    if (canvas.height !== tile.pixelHeight) canvas.height = tile.pixelHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    try {
      ctx.drawImage(tile.bitmap, 0, 0);
      setPainted(true);
    } catch (err) {
      // ImageBitmap can be in a "detached" state if it was closed by
      // aggressive cache eviction. Treat as not-yet-rendered.
      if (err instanceof DOMException && err.name === "InvalidStateError") {
        setPainted(false);
        return;
      }
      throw err;
    }
  }, [renderer, pageNumber, version, paintKey]);

  // Subscribe to tile arrivals. Bump paintKey for any LOD-0 arrival for our
  // page; the paint useLayoutEffect picks it up. The renderer's RAF
  // coalescing on tile arrivals keeps the cost bounded even with hundreds
  // of mounted thumbnails.
  useEffect(() => {
    if (!renderer) return;
    return renderer.onTileReady((tile) => {
      if (tile.key.page !== pageNumber) return;
      if (tile.key.lod !== 0) return;
      setPaintKey((k) => k + 1);
    });
  }, [renderer, pageNumber]);

  // Use fixed aspect ratios: landscape (4:3) or portrait (3:4)
  const aspectRatio = isLandscape ? 4 / 3 : 3 / 4;

  const handleDragStart = async (e: React.DragEvent) => {
    // Don't stop propagation - let the parent handle reordering
    // The parent will set draggedPage for reordering, which won't interfere with export
    // We prepare for export in the background - if user drags outside, export works
    // If user drags within carousel, parent's reordering takes precedence

    // Prepare the page as PDF file for export (async, runs in background)
    preparePageExport(e);
  };

  const preparePageExport = async (e: React.DragEvent) => {
    try {
      // Get all annotations for this page
      const documentId = document.getId();
      const allAnnotations = getAnnotations(documentId);
      const pageAnnotations = allAnnotations.filter(
        (ann) => ann.pageNumber === pageNumber,
      );

      // Initialize mupdf and editor
      const mupdfModule = await import("mupdf");
      const editor = new PDFEditor(mupdfModule.default);

      // Export the page as PDF
      const pdfData = await editor.exportPageAsPDF(
        document,
        pageNumber,
        pageAnnotations,
      );

      // Create a File object from the PDF data
      const fileName = `${document.getName().replace(".pdf", "")}_page_${pageNumber + 1}.pdf`;
      const file = new File([pdfData as BlobPart], fileName, {
        type: "application/pdf",
      });

      // Set the file in the data transfer
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData("application/pdf", "");
      e.dataTransfer.setData("text/plain", fileName);
      e.dataTransfer.setData("application/x-page-export", "true"); // Mark as page export

      // Use the items API to add the file (for dragging out of browser)
      if (e.dataTransfer.items) {
        // Don't clear items - we want to add the file
        try {
          e.dataTransfer.items.add(file);
        } catch (err) {
          // If items can't be modified, try fallback
          console.warn(
            "Could not add file to dataTransfer.items, using fallback:",
            err,
          );
          const blobUrl = URL.createObjectURL(file);
          e.dataTransfer.setData(
            "DownloadURL",
            `application/pdf:${fileName}:${blobUrl}`,
          );
        }
      } else {
        // Fallback for older browsers
        const blobUrl = URL.createObjectURL(file);
        e.dataTransfer.setData(
          "DownloadURL",
          `application/pdf:${fileName}:${blobUrl}`,
        );
      }

      // Tauri handles file drags via its own event system;
      // the browser DataTransfer API above still works in the webview.
    } catch (error) {
      console.error("Error preparing page for drag-out:", error);
      // Don't prevent the drag, just log the error
    }
  };

  return (
    <div
      className={cn(
        "relative flex-shrink-0 border-2 rounded cursor-pointer transition-all bg-background group",
        isActive
          ? "border-primary shadow-lg ring-2 ring-primary/20"
          : "border-border hover:border-primary/50 hover:shadow-md",
      )}
      style={{
        aspectRatio: aspectRatio,
        width: "120px",
        height: "auto",
      }}
      onClick={onClick}
      draggable
      onDragStart={handleDragStart}
    >
      <canvas
        ref={canvasRef}
        className="w-full h-full object-contain rounded"
        style={{
          // Hide the canvas until it has actual pixels so the loading
          // placeholder shows through. Canvas can't show a placeholder of
          // its own until painted.
          display: painted ? "block" : "none",
          ...(horizontalFlip ? { transform: "scaleX(-1)" } : {}),
        }}
      />
      {!painted && (
        <div className="absolute inset-0 w-full h-full flex items-center justify-center bg-muted rounded">
          <div className="text-xs text-muted-foreground animate-pulse">
            Loading…
          </div>
        </div>
      )}
      {/* Action buttons in top right */}
      <div className="absolute top-1 right-1 flex gap-1 z-20">
        {onRotate && (
          <button
            type="button"
            className="h-6 w-6 bg-primary hover:bg-primary/90 text-primary-foreground rounded flex items-center justify-center shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onRotate(e);
            }}
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
            title="Rotate Page"
          >
            <RotateCw className="h-3 w-3" />
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            className="h-6 w-6 bg-destructive hover:bg-destructive/90 text-destructive-foreground rounded flex items-center justify-center shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onDelete(e);
            }}
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
            title="Delete Page"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-sm font-medium text-center py-1.5 rounded-b">
        {pageNumber + 1}
      </div>
    </div>
  );
}
