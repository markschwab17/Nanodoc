/**
 * Modal to add PDF pages to the stitch canvas: file picker, page selector, Add to canvas.
 *
 * Thumbnails are generated progressively — the page grid appears immediately
 * with placeholders, and each thumbnail streams in as it renders.  A progress
 * bar shows how many pages have been processed.
 */

import { useState, useEffect, useCallback, useRef } from "react";
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
import { useCiviltakeoffContextStore } from "@/shared/stores/civiltakeoffContextStore";
import { PDFRenderer } from "@/core/pdf/PDFRenderer";
import { makeWhiteTransparentInPlace } from "@/features/stitch/imageUtils";

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

type SourceTab = "device" | "cto";

export function AddPdfModal({
  open,
  onClose,
  initialPdf,
  onInitialConsumed,
}: {
  open: boolean;
  onClose: () => void;
  initialPdf?: { pdfBytes: Uint8Array; fileName: string } | null;
  onInitialConsumed?: () => void;
}) {
  const fileSystem = useFileSystem();
  const { addTiles, setReferenceScaleFeetPerInch } = useStitchStore();
  const ctoContext = useCiviltakeoffContextStore((s) => s.context);
  const [sourceTab, setSourceTab] = useState<SourceTab>("device");
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [pdfFileName, setPdfFileName] = useState<string>("");
  const [mupdfDoc, setMupdfDoc] = useState<any>(null);
  const [pageCount, setPageCount] = useState(0);
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [thumbnails, setThumbnails] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);
  /** How many thumbnail pages have been rendered so far (for progress). */
  const [thumbProgress, setThumbProgress] = useState(0);
  const [adding, setAdding] = useState(false);
  /** Progress while adding pages to canvas. */
  const [addingProgress, setAddingProgress] = useState({ done: 0, total: 0 });
  const [removeWhiteBackground, setRemoveWhiteBackground] = useState(true);
  /** Scale when adding: feet per inch (e.g. 20 for 1"=20'). Empty = do not set. */
  const [scaleFeetPerInch, setScaleFeetPerInch] = useState<string>("");
  const [_ctoListening, setCtoListening] = useState(false);
  /** User-visible error for failed loads/adds (corrupt file, password, etc). */
  const [loadError, setLoadError] = useState<string | null>(null);
  type CtoDoc = { type: string; displayName: string; token: string; fileId?: string; doc?: string };
  const [ctoDocuments, setCtoDocuments] = useState<CtoDoc[]>([]);
  const [ctoDocumentsLoading, setCtoDocumentsLoading] = useState(false);
  const [ctoDocumentsError, setCtoDocumentsError] = useState<string | null>(null);
  const ctoDocumentsRespondedRef = useRef(false);
  /** Prevents the file-picker / initial-PDF effect from re-triggering after
   *  the first run within a single modal session (open→close cycle). */
  const hasTriggeredFileOpenRef = useRef(false);
  /** Generation counter for thumbnail streaming. A stale loop sees a newer
   *  generation and stops — unlike a shared boolean, this can't race when an
   *  old loop is parked inside an await while a new one starts. */
  const thumbGenRef = useRef(0);
  /** One renderer per modal session (no worker — main-thread renders only). */
  const rendererRef = useRef<PDFRenderer | null>(null);
  /** Mirror of mupdfDoc for cleanup — destroy frees its WASM memory. */
  const mupdfDocRef = useRef<any>(null);

  const releaseDoc = useCallback(() => {
    try {
      mupdfDocRef.current?.destroy?.();
    } catch {
      // already freed
    }
    mupdfDocRef.current = null;
  }, []);

  // Free WASM resources if the component unmounts while open
  useEffect(
    () => () => {
      thumbGenRef.current++;
      releaseDoc();
      rendererRef.current?.dispose();
      rendererRef.current = null;
    },
    [releaseDoc]
  );

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

  /** Load PDF from bytes + name into modal state.
   *  Shows the page grid immediately, then streams thumbnails progressively. */
  const loadPdfFromResult = useCallback(
    async (data: Uint8Array, name: string) => {
      // New generation — any in-flight thumbnail loop stops at its next check
      const gen = ++thumbGenRef.current;

      setLoading(true);
      setLoadError(null);
      setThumbnails({});
      setThumbProgress(0);
      try {
        const mupdf = await import("mupdf").then((m) => m.default);
        const doc = mupdf.Document.openDocument(data, "application/pdf");
        if (doc.needsPassword?.()) {
          doc.destroy?.();
          setLoadError(
            "This PDF is password-protected and can't be added here. Remove the password and try again."
          );
          setLoading(false);
          return;
        }
        const count = doc.countPages();
        // Replace the previous document and drop renders cached for it
        releaseDoc();
        mupdfDocRef.current = doc;
        rendererRef.current?.clearCache();
        setPdfBytes(data);
        setPdfFileName(name);
        setMupdfDoc(doc);
        setPageCount(count);
        setSelectedPages(new Set());
        // Show the page grid right away (loading = false), then generate thumbs in background
        setLoading(false);

        // Stream thumbnails progressively
        if (!rendererRef.current) rendererRef.current = new PDFRenderer(mupdf);
        const renderer = rendererRef.current;
        for (let i = 0; i < count; i++) {
          if (thumbGenRef.current !== gen) return;
          await yieldToMain();
          if (thumbGenRef.current !== gen) return;
          try {
            const rendered = await renderer.renderPage(doc, i, { scale: THUMB_SCALE });
            if (thumbGenRef.current !== gen) return;
            const id = rendered.imageData as ImageData;
            if (id?.data) {
              const url = imageDataToDataUrl(id);
              setThumbnails((prev) => ({ ...prev, [i]: url }));
            }
          } catch {
            // Skip failed thumbnails silently
          }
          setThumbProgress(i + 1);
        }
      } catch (e) {
        console.error(e);
        setLoadError("Could not open this PDF. The file may be corrupt or unsupported.");
        setLoading(false);
      }
    },
    [releaseDoc]
  );

  const handleChooseFile = useCallback(async () => {
    const result = await fileSystem.openFile();
    if (result) await loadPdfFromResult(result.data, result.name ?? "");
  }, [fileSystem, loadPdfFromResult]);

  useEffect(() => {
    if (!open) {
      thumbGenRef.current++;
      releaseDoc();
      rendererRef.current?.dispose();
      rendererRef.current = null;
      setPdfBytes(null);
      setPdfFileName("");
      setMupdfDoc(null);
      setPageCount(0);
      setSelectedPages(new Set());
      setThumbnails({});
      setThumbProgress(0);
      setCtoListening(false);
      setLoadError(null);
      // Reset the guard so the next open triggers the file picker
      hasTriggeredFileOpenRef.current = false;
      return;
    }
    // Only trigger file-picker / initial-PDF once per modal session.
    if (hasTriggeredFileOpenRef.current) return;
    hasTriggeredFileOpenRef.current = true;

    // When opened from CTO stitch with initial PDF, load it into page selection instead of auto-adding all.
    if (initialPdf?.pdfBytes && initialPdf?.fileName) {
      loadPdfFromResult(initialPdf.pdfBytes, initialPdf.fileName);
      onInitialConsumed?.();
      return;
    }
    if (ctoContext) {
      setSourceTab("device");
      return;
    }
    // Don't auto-open file picker — let the user see the modal first
    // and click "Choose file" themselves for a clearer flow.
  }, [open, ctoContext, fileSystem, loadPdfFromResult, initialPdf, onInitialConsumed, releaseDoc]);

  // From Civiltakeoff: request document list from opener and listen for nanodoc-cto-documents
  useEffect(() => {
    if (!open || !ctoContext || sourceTab !== "cto") {
      setCtoDocuments([]);
      setCtoDocumentsLoading(false);
      setCtoDocumentsError(null);
      return;
    }
    const projectId = ctoContext.project;
    if (!projectId) {
      setCtoDocumentsError("Project not set.");
      return;
    }
    const opener = window.opener;
    if (!opener) {
      setCtoDocumentsError("Open stitch from Civiltakeoff to see project documents.");
      return;
    }
    setCtoDocumentsLoading(true);
    setCtoDocumentsError(null);
    setCtoDocuments([]);
    ctoDocumentsRespondedRef.current = false;
    opener.postMessage({ type: "nanodoc-request-cto-documents", projectId }, ctoContext.api_origin);

    const timeoutId = window.setTimeout(() => {
      if (!ctoDocumentsRespondedRef.current) {
        setCtoDocumentsError("Request timed out. Open stitch from Civiltakeoff project documents.");
        setCtoDocumentsLoading(false);
      }
    }, 12000);

    // Only accept document lists from the CTO origin we asked — any window
    // can post to this one otherwise.
    const allowedOrigin = ctoContext.api_origin?.replace(/\/+$/, "") ?? "";
    const handleMessage = (event: MessageEvent) => {
      if (allowedOrigin && event.origin !== allowedOrigin) return;
      if (event.data?.type !== "nanodoc-cto-documents") return;
      ctoDocumentsRespondedRef.current = true;
      const list = Array.isArray(event.data?.documents) ? event.data.documents : [];
      setCtoDocuments(
        list.filter(
          (d: unknown) =>
            d &&
            typeof d === "object" &&
            typeof (d as { displayName?: unknown }).displayName === "string" &&
            typeof (d as { token?: unknown }).token === "string"
        ) as CtoDoc[]
      );
      setCtoDocumentsLoading(false);
      setCtoDocumentsError(null);
    };
    window.addEventListener("message", handleMessage);
    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener("message", handleMessage);
      setCtoDocumentsLoading(false);
    };
  }, [open, ctoContext, sourceTab]);

  const loadCtoDocument = useCallback(
    async (doc: CtoDoc) => {
      if (!ctoContext) return;
      setCtoDocumentsError(null);
      setLoading(true);
      try {
        const url = `${ctoContext.api_origin}/api/nanodoc/pdf?token=${encodeURIComponent(doc.token)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to load document (${res.status})`);
        const json = await res.json();
        const pdfUrl = json?.pdfUrl;
        if (!pdfUrl || typeof pdfUrl !== "string") throw new Error("Invalid response");
        const pdfRes = await fetch(pdfUrl);
        if (!pdfRes.ok) throw new Error("Failed to fetch PDF");
        const ab = await pdfRes.arrayBuffer();
        await loadPdfFromResult(new Uint8Array(ab), doc.displayName);
      } catch (e) {
        console.error("CTO load document failed", e);
        setCtoDocumentsError(e instanceof Error ? e.message : "Failed to load document");
      } finally {
        setLoading(false);
      }
    },
    [ctoContext, loadPdfFromResult]
  );

  // From Civiltakeoff: postMessage listener for nanodoc-add-cto-doc (legacy: CTO pushes one doc)
  useEffect(() => {
    if (!open || !ctoContext || sourceTab !== "cto") return;
    setCtoListening(true);
    const ctx = ctoContext;
    const allowedOrigin = ctx.api_origin?.replace(/\/+$/, "") ?? "";

    const handleMessage = async (event: MessageEvent) => {
      if (allowedOrigin && event.origin !== allowedOrigin) return;
      const data = event.data;
      if (data?.type !== "nanodoc-add-cto-doc") return;
      const name = typeof data.name === "string" ? data.name : "document.pdf";
      try {
        if (typeof data.pdfUrl === "string" && data.pdfUrl) {
          const res = await fetch(data.pdfUrl);
          if (!res.ok) throw new Error(`Failed to fetch PDF (${res.status})`);
          const ab = await res.arrayBuffer();
          await loadPdfFromResult(new Uint8Array(ab), name);
          return;
        }
        if (typeof data.token === "string" && data.token) {
          const url = `${ctx.api_origin}/api/nanodoc/pdf?token=${encodeURIComponent(data.token)}`;
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Failed to load document (${res.status})`);
          const json = await res.json();
          const pdfUrl = json?.pdfUrl;
          if (!pdfUrl || typeof pdfUrl !== "string") throw new Error("Invalid response");
          const pdfRes = await fetch(pdfUrl);
          if (!pdfRes.ok) throw new Error("Failed to fetch PDF");
          const ab = await pdfRes.arrayBuffer();
          await loadPdfFromResult(new Uint8Array(ab), name);
        }
      } catch (e) {
        console.error("CTO add doc failed", e);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      setCtoListening(false);
    };
  }, [open, ctoContext, sourceTab, loadPdfFromResult]);

  const handleAddToCanvas = useCallback(async () => {
    if (!mupdfDoc || !pdfBytes || selectedPages.size === 0) return;
    setAdding(true);
    setLoadError(null);
    const selected = Array.from(selectedPages).sort((a, b) => a - b);
    setAddingProgress({ done: 0, total: selected.length });
    try {
      const mupdf = await import("mupdf").then((m) => m.default);
      if (!rendererRef.current) rendererRef.current = new PDFRenderer(mupdf);
      const renderer = rendererRef.current;
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

      for (let idx = 0; idx < selected.length; idx++) {
        const pageIndex = selected[idx];
        await yieldToMain();
        const page = mupdfDoc.loadPage(pageIndex);
        const bounds = page.getBounds();
        page.destroy?.();
        const widthPt = bounds[2] - bounds[0];
        const heightPt = bounds[3] - bounds[1];
        // Use original PDF page size in pt (e.g. 8.5"×11" = 612×792 pt) so scale is correct.
        const tileW = widthPt;
        const tileH = heightPt;
        const rendered = await renderer.renderPage(mupdfDoc, pageIndex, {
          scale: TILE_RENDER_SCALE,
        });
        const imageData = rendered.imageData as ImageData;
        if (imageData && imageData.data && removeWhiteBackground)
          makeWhiteTransparentInPlace(imageData);
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
        setAddingProgress({ done: idx + 1, total: selected.length });
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
      setLoadError("Could not add the selected pages to the canvas. Please try again.");
    } finally {
      setAdding(false);
    }
  }, [mupdfDoc, pdfBytes, pdfFileName, selectedPages, addTiles, onClose, removeWhiteBackground, scaleFeetPerInch, setReferenceScaleFeetPerInch]);

  const thumbsStillLoading = pageCount > 0 && thumbProgress < pageCount;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Add PDF pages to canvas</DialogTitle>
        </DialogHeader>
        {ctoContext && (
          <div className="flex gap-2 border-b pb-2">
            <Button
              variant={sourceTab === "device" ? "secondary" : "outline"}
              size="sm"
              onClick={() => {
                setSourceTab("device");
                thumbGenRef.current++;
                releaseDoc();
                setPdfBytes(null);
                setPdfFileName("");
                setMupdfDoc(null);
                setPageCount(0);
                setSelectedPages(new Set());
                setThumbnails({});
                setLoadError(null);
              }}
            >
              From device
            </Button>
            <Button
              variant={sourceTab === "cto" ? "secondary" : "outline"}
              size="sm"
              onClick={() => {
                setSourceTab("cto");
                thumbGenRef.current++;
                releaseDoc();
                setPdfBytes(null);
                setPdfFileName("");
                setMupdfDoc(null);
                setPageCount(0);
                setSelectedPages(new Set());
                setThumbnails({});
                setLoadError(null);
              }}
            >
              From Civiltakeoff
            </Button>
          </div>
        )}
        {loadError && (
          <p className="text-sm text-destructive border border-destructive/30 bg-destructive/5 rounded px-3 py-2">
            {loadError}
          </p>
        )}
        {adding ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
            <Loader2 className="h-10 w-10 animate-spin" />
            <p>Rendering page {addingProgress.done} of {addingProgress.total}…</p>
            {addingProgress.total > 0 && (
              <div className="w-48 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-200"
                  style={{ width: `${(addingProgress.done / addingProgress.total) * 100}%` }}
                />
              </div>
            )}
          </div>
        ) : loading ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p>Loading PDF…</p>
          </div>
        ) : ctoContext && sourceTab === "device" && !pdfBytes && !loading ? (
          <div className="py-12 flex flex-col items-center gap-3 text-muted-foreground">
            <p>Choose a PDF file from your device.</p>
            <Button onClick={handleChooseFile}>Choose file</Button>
          </div>
        ) : ctoContext && sourceTab === "cto" && !pdfBytes ? (
          <div className="py-8 flex flex-col items-stretch gap-4 text-muted-foreground">
            {ctoDocumentsLoading ? (
              <div className="flex items-center justify-center gap-2 py-8">
                <Loader2 className="h-6 w-6 animate-spin" />
                <span>Loading project documents…</span>
              </div>
            ) : ctoDocumentsError ? (
              <p className="text-destructive text-center py-4">{ctoDocumentsError}</p>
            ) : ctoDocuments.length > 0 ? (
              <>
                <p className="text-sm text-center">Choose a document to add pages from:</p>
                <ul className="space-y-2 max-h-64 overflow-auto">
                  {ctoDocuments.map((doc, idx) => (
                    <li key={idx}>
                      <Button
                        variant="outline"
                        className="w-full justify-start font-normal"
                        onClick={() => loadCtoDocument(doc)}
                        disabled={loading}
                      >
                        {doc.displayName}
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-center py-4">No project PDFs found.</p>
            )}
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
                <Button variant="outline" size="sm" onClick={handleChooseFile}>
                  Change file
                </Button>
              </div>
              <span className="text-xs text-muted-foreground">
                {pageCount} page{pageCount !== 1 ? "s" : ""}
                {pdfFileName ? ` — ${pdfFileName}` : ""}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3 pb-2">
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={removeWhiteBackground}
                  onChange={(e) => setRemoveWhiteBackground(e.target.checked)}
                  className="rounded border-input"
                />
                Remove white background
              </label>
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground whitespace-nowrap">Scale 1&quot;=</span>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="20"
                  value={scaleFeetPerInch}
                  onChange={(e) => setScaleFeetPerInch(e.target.value)}
                  className="w-14 rounded border border-input bg-background px-2 py-1 text-sm"
                />
                <span className="text-muted-foreground text-xs">ft</span>
              </label>
            </div>
            {/* Thumbnail progress bar */}
            {thumbsStillLoading && (
              <div className="flex items-center gap-2 pb-1">
                <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary/60 rounded-full transition-all duration-150"
                    style={{ width: `${(thumbProgress / pageCount) * 100}%` }}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                  {thumbProgress}/{pageCount}
                </span>
              </div>
            )}
            <div className="flex-1 overflow-auto grid grid-cols-4 gap-2 py-2 min-h-[200px]">
              {Array.from({ length: pageCount }, (_, i) => (
                <label
                  key={i}
                  className={`flex flex-col items-center p-2 border rounded cursor-pointer transition-colors ${
                    selectedPages.has(i)
                      ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                      : "border-border hover:border-muted-foreground/40"
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
                      {thumbProgress <= i ? (
                        <Loader2 className="h-4 w-4 animate-spin opacity-40" />
                      ) : (
                        `Page ${i + 1}`
                      )}
                    </div>
                  )}
                  <span className="text-xs mt-1">Page {i + 1}</span>
                </label>
              ))}
            </div>
          </>
        ) : !loading && !pdfBytes && !adding && !ctoContext ? (
          <div className="py-12 flex flex-col items-center gap-3 text-muted-foreground">
            <p>Choose a PDF file to select pages from.</p>
            <Button onClick={handleChooseFile}>Choose file</Button>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleAddToCanvas}
            disabled={!pdfBytes || selectedPages.size === 0 || adding}
          >
            {adding ? "Adding…" : `Add ${selectedPages.size} page${selectedPages.size !== 1 ? "s" : ""} to canvas`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
