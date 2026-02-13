/**
 * Modal to add PDF pages to the stitch canvas: file picker, page selector, Add to canvas.
 */

import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useFileSystem } from "@/shared/hooks/useFileSystem";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { PDFRenderer } from "@/core/pdf/PDFRenderer";
import { makeWhiteTransparent } from "@/features/stitch/imageUtils";

const THUMB_SCALE = 0.3;
const TILE_RENDER_SCALE = 1.5;
const MARGIN = 20;
const GAP = 10;

/** Scale page dimensions so the tile fits within the canvas (with margin). Never scale up. */
function scaleToFitCanvas(
  widthPt: number,
  heightPt: number,
  canvasWidth: number,
  canvasHeight: number
): { width: number; height: number } {
  const maxW = canvasWidth - 2 * MARGIN;
  const maxH = canvasHeight - 2 * MARGIN;
  if (widthPt <= 0 || heightPt <= 0) return { width: widthPt, height: heightPt };
  const scale = Math.min(1, maxW / widthPt, maxH / heightPt);
  return {
    width: widthPt * scale,
    height: heightPt * scale,
  };
}

function imageDataToDataUrl(imageData: ImageData): string {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

export function AddPdfModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const fileSystem = useFileSystem();
  const { addTiles, canvasWidth, canvasHeight } = useStitchStore();
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [pdfFileName, setPdfFileName] = useState<string>("");
  const [mupdfDoc, setMupdfDoc] = useState<any>(null);
  const [pageCount, setPageCount] = useState(0);
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [thumbnails, setThumbnails] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removeWhiteBackground, setRemoveWhiteBackground] = useState(false);

  const togglePage = useCallback((i: number) => {
    setSelectedPages((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedPages(new Set(Array.from({ length: pageCount }, (_, i) => i)));
  }, [pageCount]);

  const selectNone = useCallback(() => {
    setSelectedPages(new Set());
  }, []);

  useEffect(() => {
    if (!open) {
      setPdfBytes(null);
      setPdfFileName("");
      setMupdfDoc(null);
      setPageCount(0);
      setSelectedPages(new Set());
      setThumbnails({});
      return;
    }
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const result = await fileSystem.openFile();
        if (!result || cancelled) return;
        const mupdf = await import("mupdf").then((m) => m.default);
        const doc = mupdf.Document.openDocument(result.data, "application/pdf");
        const count = doc.countPages();
        if (cancelled) return;
        setPdfBytes(result.data);
        setPdfFileName(result.name ?? "");
        setMupdfDoc(doc);
        setPageCount(count);
        setSelectedPages(new Set());
        const renderer = new PDFRenderer(mupdf);
        const thumbs: Record<number, string> = {};
        for (let i = 0; i < count && !cancelled; i++) {
          const rendered = await renderer.renderPage(doc, i, {
            scale: THUMB_SCALE,
          });
          const id = (rendered.imageData as ImageData);
          if (id && id.data) thumbs[i] = imageDataToDataUrl(id);
        }
        if (!cancelled) setThumbnails(thumbs);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [open, fileSystem]);

  const handleAddToCanvas = useCallback(async () => {
    if (!mupdfDoc || !pdfBytes || selectedPages.size === 0) return;
    setAdding(true);
    try {
      const mupdf = await import("mupdf").then((m) => m.default);
      const renderer = new PDFRenderer(mupdf);
      const selected = Array.from(selectedPages).sort((a, b) => a - b);
      let y = MARGIN;
      const newTiles: Array<{
        sourcePdfBytes: Uint8Array;
        sourcePageIndex: number;
        sourceFileName?: string;
        x: number;
        y: number;
        width: number;
        height: number;
        imageDataUrl?: string;
      }> = [];
      for (const pageIndex of selected) {
        const page = mupdfDoc.loadPage(pageIndex);
        const bounds = page.getBounds();
        const widthPt = bounds[2] - bounds[0];
        const heightPt = bounds[3] - bounds[1];
        const { width: tileW, height: tileH } = scaleToFitCanvas(
          widthPt,
          heightPt,
          canvasWidth,
          canvasHeight
        );
        const rendered = await renderer.renderPage(mupdfDoc, pageIndex, {
          scale: TILE_RENDER_SCALE,
        });
        let imageData = rendered.imageData as ImageData;
        if (imageData && imageData.data && removeWhiteBackground)
          imageData = makeWhiteTransparent(imageData);
        const dataUrl = imageData && imageData.data ? imageDataToDataUrl(imageData) : undefined;
        let x = MARGIN;
        if (x + tileW > canvasWidth) x = Math.max(0, canvasWidth - tileW);
        if (y + tileH > canvasHeight) y = Math.max(0, canvasHeight - tileH);
        newTiles.push({
          sourcePdfBytes: pdfBytes,
          sourcePageIndex: pageIndex,
          sourceFileName: pdfFileName || undefined,
          x,
          y,
          width: tileW,
          height: tileH,
          imageDataUrl: dataUrl,
        });
        y += tileH + GAP;
      }
      addTiles(newTiles);
      onClose();
    } catch (e) {
      console.error(e);
    } finally {
      setAdding(false);
    }
  }, [mupdfDoc, pdfBytes, pdfFileName, selectedPages, addTiles, canvasWidth, canvasHeight, onClose, removeWhiteBackground]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Add PDF pages to canvas</DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="py-12 text-center text-muted-foreground">
            Loading PDF…
          </div>
        ) : pdfBytes && pageCount > 0 ? (
          <>
            <div className="flex flex-wrap items-center gap-3 py-2">
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={selectAll}>
                  Select all
                </Button>
                <Button variant="outline" size="sm" onClick={selectNone}>
                  Select none
                </Button>
              </div>
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={removeWhiteBackground}
                  onChange={(e) => setRemoveWhiteBackground(e.target.checked)}
                  className="rounded border-input"
                />
                Remove white background (import content only)
              </label>
            </div>
            <div className="flex-1 overflow-auto grid grid-cols-4 gap-2 py-2 min-h-[200px]">
              {Array.from({ length: pageCount }, (_, i) => (
                <label
                  key={i}
                  className={`flex flex-col items-center p-2 border rounded cursor-pointer ${
                    selectedPages.has(i) ? "border-primary bg-primary/5" : "border-border"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedPages.has(i)}
                    onChange={() => togglePage(i)}
                    className="sr-only"
                  />
                  {thumbnails[i] ? (
                    <img
                      src={thumbnails[i]}
                      alt={`Page ${i + 1}`}
                      className="w-full h-auto object-contain max-h-32"
                    />
                  ) : (
                    <div className="w-full h-24 bg-muted rounded flex items-center justify-center text-xs text-muted-foreground">
                      Page {i + 1}
                    </div>
                  )}
                  <span className="text-xs mt-1">Page {i + 1}</span>
                </label>
              ))}
            </div>
          </>
        ) : !loading && !pdfBytes ? (
          <p className="text-muted-foreground py-4">Open a PDF to select pages.</p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleAddToCanvas}
            disabled={!pdfBytes || selectedPages.size === 0 || adding}
          >
            {adding ? "Adding…" : `Add ${selectedPages.size} page(s) to canvas`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
