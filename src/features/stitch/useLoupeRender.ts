/**
 * On-demand crop rendering for the align loupe.
 *
 * Mark, 2026-09-04: the manual-align magnifier has to be "high enough quality for us to
 * see detailed lines for match alignment but … lightweight and fast."
 *
 * So nothing is kept: the loupe asks mupdf for ONE ~250 px crop of the page under the
 * cursor at 300 dpi, debounced 60 ms after the cursor settles, draws it into a single
 * reused canvas, and drops the pixels. There is never more than one crop bitmap alive,
 * the render cache is never touched (`renderPageCrop` does not cache), and a crop whose
 * cursor has already moved on is discarded rather than drawn.
 *
 * The hook also owns the captured line geometry used for snapping — captured lazily,
 * once per page, the first time the cursor sits on that sheet, and released with the
 * document when the mode exits.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { PDFRenderer } from "@/core/pdf/PDFRenderer";
import { capturePage } from "./autostitch/captureDevice";
import {
  buildSnapIndex,
  canvasToPagePoint,
  findSnapPoint,
  loupeCropRect,
  loupeDrawPlan,
  loupeMagnification,
  pagePointToCanvas,
  planCropRender,
  snapRadiusPagePt,
  type LoupeDrawPlan,
  type PageRect,
  type PageSize,
  type SnapHit,
  type SnapIndex,
} from "./loupeGeometry";
import type { CanvasPoint } from "./stitchGeometry";
import type { StitchTile } from "./stitchTypes";

const CROP_DEBOUNCE_MS = 60;

/** One opened source document, shared by every tile that came from those bytes. */
interface DocEntry {
  doc: any;
  renderer: PDFRenderer;
  pages: Map<number, PageSize>;
  /** null = captured and there was nothing to snap to; undefined = not captured yet. */
  snap: Map<number, SnapIndex | null>;
  capturing: Set<number>;
}

/** What the loupe should draw right now. */
export interface LoupeView {
  tileId: string;
  /** Cursor position, in screen (client) pixels. */
  screen: { x: number; y: number };
  /** Cursor position in canvas space (already snapped when snapping found something). */
  canvasPoint: CanvasPoint;
  /** The page rect the crop covers, once one has been rendered for this cursor. */
  crop: PageRect | null;
  /** The cursor the crop was rendered for — a crop that is one move stale is drawn
   *  shifted by the difference, so the linework stays registered with the page. */
  cropAt: CanvasPoint | null;
  drawPlan: LoupeDrawPlan | null;
  /** Bumped every time a fresh crop lands, so the painter knows to redraw. */
  version: number;
  /** Where the snap landed, in screen-relative loupe terms (canvas space). */
  snap: { point: CanvasPoint; kind: SnapHit["kind"] } | null;
  magnification: number;
  page: PageSize | null;
}

export interface LoupeRender {
  view: LoupeView | null;
  /** The single live crop bitmap. Read during paint; never held elsewhere. */
  cropCanvas: HTMLCanvasElement | null;
  /** Follow the cursor. Pass a null tile when the cursor is off every sheet. */
  track: (tile: StitchTile | null, canvasPoint: CanvasPoint | null, screen: { x: number; y: number }) => void;
  /** The point a click should record: snapped when snapping is on and found one. */
  resolveClick: (tile: StitchTile, canvasPoint: CanvasPoint) => CanvasPoint;
  /** Drop the view (cursor left the canvas). */
  clear: () => void;
}

export function useLoupeRender(opts: {
  active: boolean;
  zoom: number;
  snapEnabled: boolean;
}): LoupeRender {
  const { active, zoom, snapEnabled } = opts;
  const [view, setView] = useState<LoupeView | null>(null);

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const snapRef = useRef(snapEnabled);
  snapRef.current = snapEnabled;

  const mupdfRef = useRef<any>(null);
  const docsRef = useRef(new Map<Uint8Array, DocEntry>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Monotonic; a crop that finishes after the cursor moved is thrown away. */
  const tokenRef = useRef(0);
  const aliveRef = useRef(true);
  const cropCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const getCropCanvas = useCallback((): HTMLCanvasElement => {
    if (!cropCanvasRef.current) cropCanvasRef.current = document.createElement("canvas");
    return cropCanvasRef.current;
  }, []);

  /** Everything mupdf-side goes at mode exit — a document is megabytes of WASM heap. */
  const release = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    tokenRef.current++;
    for (const entry of docsRef.current.values()) {
      try {
        entry.renderer.dispose();
        entry.doc?.destroy?.();
      } catch {
        // already freed
      }
    }
    docsRef.current.clear();
    const canvas = cropCanvasRef.current;
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    cropCanvasRef.current = null;
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      release();
    };
  }, [release]);

  useEffect(() => {
    if (!active) {
      release();
      setView(null);
    }
  }, [active, release]);

  const ensureDoc = useCallback(async (tile: StitchTile): Promise<DocEntry | null> => {
    // Scale stamps and promoted clean-up crops have no page behind them (no bytes, or
    // sourcePageIndex -1) — the loupe falls back to their raster.
    if (!tile.sourcePdfBytes || tile.sourcePdfBytes.length === 0) return null;
    if (tile.sourcePageIndex < 0) return null;
    const existing = docsRef.current.get(tile.sourcePdfBytes);
    if (existing) return existing;
    if (!mupdfRef.current) mupdfRef.current = await import("mupdf").then((m) => m.default);
    const mupdf = mupdfRef.current;
    if (!aliveRef.current) return null;
    // Two tiles from the same file can race here; the later one reuses the winner.
    const already = docsRef.current.get(tile.sourcePdfBytes);
    if (already) return already;
    const doc = mupdf.Document.openDocument(tile.sourcePdfBytes, "application/pdf");
    const entry: DocEntry = {
      doc,
      renderer: new PDFRenderer(mupdf),
      pages: new Map(),
      snap: new Map(),
      capturing: new Set(),
    };
    docsRef.current.set(tile.sourcePdfBytes, entry);
    return entry;
  }, []);

  const pageSizeOf = useCallback((entry: DocEntry, pageIndex: number): PageSize => {
    const cached = entry.pages.get(pageIndex);
    if (cached) return cached;
    const page = entry.doc.loadPage(pageIndex);
    const bounds = page.getBounds();
    page.destroy?.();
    const size: PageSize = { widthPt: bounds[2] - bounds[0], heightPt: bounds[3] - bounds[1] };
    entry.pages.set(pageIndex, size);
    return size;
  }, []);

  /**
   * Capture the page's stroke geometry once, for snapping. Deferred to idle: it is a
   * full page walk and the cursor must not stutter while it runs.
   */
  const ensureSnapIndex = useCallback((entry: DocEntry, pageIndex: number) => {
    if (entry.snap.has(pageIndex) || entry.capturing.has(pageIndex)) return;
    entry.capturing.add(pageIndex);
    const run = () => {
      if (!aliveRef.current) return;
      let page: any = null;
      try {
        page = entry.doc.loadPage(pageIndex);
        const extract = capturePage(mupdfRef.current, page);
        entry.snap.set(pageIndex, extract.geometry.length ? buildSnapIndex(extract.geometry) : null);
      } catch {
        entry.snap.set(pageIndex, null);
      } finally {
        page?.destroy?.();
        entry.capturing.delete(pageIndex);
      }
    };
    const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    if (idle) idle(run, { timeout: 1500 });
    else setTimeout(run, 0);
  }, []);

  /** The snap for a cursor, using only what is already captured (never blocks). */
  const snapFor = useCallback(
    (tile: StitchTile, canvasPoint: CanvasPoint): { point: CanvasPoint; kind: SnapHit["kind"] } | null => {
      if (!snapRef.current) return null;
      const entry = docsRef.current.get(tile.sourcePdfBytes);
      if (!entry) return null;
      const index = entry.snap.get(tile.sourcePageIndex);
      if (!index) return null;
      const page = entry.pages.get(tile.sourcePageIndex);
      if (!page) return null;
      const at = canvasToPagePoint(canvasPoint, tile, page);
      if (!at) return null;
      const hit = findSnapPoint(index, at, snapRadiusPagePt(tile, page, zoomRef.current));
      if (!hit) return null;
      return { point: pagePointToCanvas(hit, tile, page), kind: hit.kind };
    },
    []
  );

  const renderCrop = useCallback(
    async (tile: StitchTile, canvasPoint: CanvasPoint, screen: { x: number; y: number }, token: number) => {
      const entry = await ensureDoc(tile);
      if (!entry || !aliveRef.current || token !== tokenRef.current) return;
      let page: PageSize;
      try {
        page = pageSizeOf(entry, tile.sourcePageIndex);
      } catch {
        return;
      }
      ensureSnapIndex(entry, tile.sourcePageIndex);

      const magnification = loupeMagnification(zoomRef.current);
      const centre = canvasToPagePoint(canvasPoint, tile, page);
      if (!centre) return;
      const crop = loupeCropRect(centre, tile, page, magnification);
      const plan = planCropRender(crop, undefined, tile.rotation ?? 0);
      let image: ImageData;
      try {
        image = await entry.renderer.renderPageCrop(entry.doc, tile.sourcePageIndex, plan);
      } catch {
        return; // the canvas-level fallback keeps the loupe from blanking
      }
      // Late arrival: the cursor has moved and this crop is for the wrong place.
      if (!aliveRef.current || token !== tokenRef.current) return;

      const canvas = getCropCanvas();
      canvas.width = plan.width;
      canvas.height = plan.height;
      canvas.getContext("2d")?.putImageData(image, 0, 0);

      setView((prev) =>
        prev && prev.tileId === tile.id
          ? {
              ...prev,
              screen,
              canvasPoint,
              crop,
              cropAt: canvasPoint,
              drawPlan: loupeDrawPlan(crop, plan),
              version: token,
              magnification,
              page,
            }
          : prev
      );
    },
    [ensureDoc, ensureSnapIndex, getCropCanvas, pageSizeOf]
  );

  const track = useCallback<LoupeRender["track"]>(
    (tile, canvasPoint, screen) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      if (!tile || !canvasPoint) {
        tokenRef.current++;
        setView(null);
        return;
      }
      // The cursor's own frame is never debounced — only the crop behind it is.
      const token = ++tokenRef.current;
      const snap = snapFor(tile, canvasPoint);
      setView((prev) =>
        prev && prev.tileId === tile.id
          ? { ...prev, screen, canvasPoint, snap }
          : {
              tileId: tile.id,
              screen,
              canvasPoint,
              crop: null,
              cropAt: null,
              drawPlan: null,
              version: 0,
              snap,
              magnification: loupeMagnification(zoomRef.current),
              page: null,
            }
      );
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void renderCrop(tile, canvasPoint, screen, token);
      }, CROP_DEBOUNCE_MS);
    },
    [renderCrop, snapFor]
  );

  const resolveClick = useCallback<LoupeRender["resolveClick"]>(
    (tile, canvasPoint) => snapFor(tile, canvasPoint)?.point ?? canvasPoint,
    [snapFor]
  );

  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    tokenRef.current++;
    setView(null);
  }, []);

  return { view, cropCanvas: cropCanvasRef.current, track, resolveClick, clear };
}
