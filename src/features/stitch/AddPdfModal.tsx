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
import { Loader2 } from "lucide-react";
import { useFileSystem } from "@/shared/hooks/useFileSystem";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { PDFRenderer } from "@/core/pdf/PDFRenderer";
import { makeWhiteTransparent } from "@/features/stitch/imageUtils";

const THUMB_SCALE = 0.3;
const TILE_RENDER_SCALE = 1.5;
const MARGIN = 20;
const GAP = 10;
const TILES_PER_ROW = 3;

/** Yield to the event loop so the tab stays responsive during long PDF work. */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
  const { addTiles, canvasWidth, canvasHeight, setReferenceScaleFeetPerInch } = useStitchStore();
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [pdfFileName, setPdfFileName] = useState<string>("");
  const [mupdfDoc, setMupdfDoc] = useState<any>(null);
  const [pageCount, setPageCount] = useState(0);
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [thumbnails, setThumbnails] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removeWhiteBackground, setRemoveWhiteBackground] = useState(true);
  /** Scale when adding: feet per inch (e.g. 20 for 1"=20'). Empty = do not set. */
  const [scaleFeetPerInch, setScaleFeetPerInch] = useState<string>("");

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
          await yieldToMain();
          if (cancelled) return;
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
      type TileData = {
        sourcePdfBytes: Uint8Array;
        sourcePageIndex: number;
        sourceFileName?: string;
        width: number;
        height: number;
        imageDataUrl?: string;
      };
      const newTiles: Array<TileData & { x: number; y: number }> = [];
      let rowY = MARGIN;
      const rowBuffer: Array<{ tile: TileData; w: number; h: number }> = [];

      const flushRow = () => {
        if (rowBuffer.length === 0) return;
        let x = MARGIN;
        const maxH = Math.max(...rowBuffer.map((b) => b.h));
        for (const { tile, w } of rowBuffer) {
          newTiles.push({ ...tile, x, y: rowY });
          x += w + GAP;
        }
        rowY += maxH + GAP;
        rowBuffer.length = 0;
      };

      for (const pageIndex of selected) {
        await yieldToMain();
        const page = mupdfDoc.loadPage(pageIndex);
        const bounds = page.getBounds();
        const widthPt = bounds[2] - bounds[0];
        const heightPt = bounds[3] - bounds[1];
        // Use original PDF page size in pt (e.g. 8.5"×11" = 612×792 pt) so scale is correct.
        const tileW = widthPt;
        const tileH = heightPt;
        const rendered = await renderer.renderPage(mupdfDoc, pageIndex, {
          scale: TILE_RENDER_SCALE,
        });
        let imageData = rendered.imageData as ImageData;
        if (imageData && imageData.data && removeWhiteBackground)
          imageData = makeWhiteTransparent(imageData);
        const dataUrl = imageData && imageData.data ? imageDataToDataUrl(imageData) : undefined;
        const tileData: TileData = {
          sourcePdfBytes: pdfBytes,
          sourcePageIndex: pageIndex,
          sourceFileName: pdfFileName || undefined,
          width: tileW,
          height: tileH,
          imageDataUrl: dataUrl,
        };
        rowBuffer.push({ tile: tileData, w: tileW, h: tileH });
        if (rowBuffer.length === TILES_PER_ROW) flushRow();
      }
      flushRow();
      const scaleNum = scaleFeetPerInch.trim() ? parseFloat(scaleFeetPerInch.trim()) : NaN;
      if (Number.isFinite(scaleNum) && scaleNum > 0) {
        setReferenceScaleFeetPerInch(scaleNum);
      }
      addTiles(newTiles);
      onClose();
    } catch (e) {
      console.error(e);
    } finally {
      setAdding(false);
    }
  }, [mupdfDoc, pdfBytes, pdfFileName, selectedPages, addTiles, canvasWidth, canvasHeight, onClose, removeWhiteBackground, scaleFeetPerInch, setReferenceScaleFeetPerInch]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Add PDF pages to canvas</DialogTitle>
        </DialogHeader>
        {adding ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
            <Loader2 className="h-10 w-10 animate-spin" />
            <p>Adding pages to canvas…</p>
          </div>
        ) : loading ? (
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
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground whitespace-nowrap">Scale (e.g. 1"=20'):</span>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="20"
                  value={scaleFeetPerInch}
                  onChange={(e) => setScaleFeetPerInch(e.target.value)}
                  className="w-20 rounded border border-input bg-background px-2 py-1 text-sm"
                />
                <span className="text-muted-foreground text-xs">feet per inch</span>
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
        ) : !loading && !pdfBytes && !adding ? (
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
