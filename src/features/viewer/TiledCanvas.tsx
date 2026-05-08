/**
 * TiledCanvas — drop-in replacement for the bare <canvas> in PageCanvas
 * when the useTiledRenderer feature flag is on.
 *
 * Sized to PDF-point dimensions (so 1 CSS px = 1 PDF point), matching the
 * existing canvas convention. Parent's CSS transform handles zoom — we
 * don't apply scale here. `displayPxPerPoint` is the EFFECTIVE on-screen
 * resolution (= zoomLevel × dpr) and drives LOD selection inside
 * TiledPageRenderer.
 *
 * Renders fallback (coarser-LOD ancestor) tiles UNDER primary tiles so the
 * page is never blank during LOD threshold crossings.
 */

import React, { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { tilePointSize } from "@/core/pdf/tiles/lod";
import {
  tileKeyString,
  type PageDims,
  type PdfRect,
  type RenderedTile,
} from "@/core/pdf/tiles/types";
import type { TiledPageRenderer } from "@/core/pdf/tiles/TiledPageRenderer";

/** Show the debug HUD when the URL contains `?tile-debug=1`. */
const SHOW_DEBUG_HUD =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("tile-debug") === "1";

export interface TiledCanvasProps {
  pageNumber: number;
  pageDims: PageDims;
  /** Effective screen resolution: zoomLevel × dpr. Drives LOD selection. */
  displayPxPerPoint: number;
  /**
   * Visible portion of THIS page in PDF points (relative to page origin).
   * If `w` or `h` is 0 the page isn't on screen and no tiles are requested.
   * Falls back to the full page rect if not provided.
   */
  viewportPdfRect?: PdfRect;
  renderer: TiledPageRenderer;
  className?: string;
  style?: CSSProperties;
  /**
   * PageCanvas attaches its `pageContentRef` here so getPDFCoordinates etc.
   * can use this wrapper as the page-bitmap reference frame.
   */
  rootRef?: React.MutableRefObject<HTMLElement | null>;
}

export function TiledCanvas({
  pageNumber,
  pageDims,
  displayPxPerPoint,
  viewportPdfRect,
  renderer,
  className,
  style,
  rootRef,
}: TiledCanvasProps) {
  // Bumped on every onTileReady so getVisibleTiles is re-read after async arrivals
  const [tick, setTick] = useState(0);

  // Use the viewport prop if provided (from PageCanvas — the part of the
  // page actually visible on screen). Fall back to full-page if missing OR
  // if it's been measured as 0×0 (page off-screen) but pageDims is known.
  // Falling back to full-page on off-screen means we still render
  // ancestor tiles for that page's prefetch, which is OK for now.
  const viewport: PdfRect = useMemo(() => {
    if (viewportPdfRect && viewportPdfRect.w > 0 && viewportPdfRect.h > 0) {
      return viewportPdfRect;
    }
    return { x: 0, y: 0, w: pageDims.widthPt, h: pageDims.heightPt };
  }, [
    viewportPdfRect?.x,
    viewportPdfRect?.y,
    viewportPdfRect?.w,
    viewportPdfRect?.h,
    pageDims.widthPt,
    pageDims.heightPt,
  ]);

  useEffect(() => {
    return renderer.onTileReady(() => setTick((t) => t + 1));
  }, [renderer]);

  useEffect(() => {
    renderer.setViewport(pageNumber, viewport, displayPxPerPoint);
  }, [renderer, pageNumber, viewport, displayPxPerPoint]);

  const visible = useMemo(
    () => renderer.getVisibleTiles(pageNumber, viewport, displayPxPerPoint),
    // tick included so the memo re-reads after async tile arrivals
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [renderer, pageNumber, viewport, displayPxPerPoint, tick],
  );

  return (
    <div
      ref={(el) => {
        if (rootRef) rootRef.current = el;
      }}
      className={className}
      style={{
        position: "relative",
        width: pageDims.widthPt,
        height: pageDims.heightPt,
        overflow: "hidden",
        background: "white",
        ...style,
      }}
    >
      {visible.fallback.map((t) => (
        <Tile key={"f-" + tileKeyString(t.key)} tile={t} pageDims={pageDims} />
      ))}
      {visible.primary.map((t) => (
        <Tile key={"p-" + tileKeyString(t.key)} tile={t} pageDims={pageDims} />
      ))}
      {/* Dev-only debug HUD. Off by default; enable via ?tile-debug=1 in the URL. */}
      {SHOW_DEBUG_HUD && (
        <div
          style={{
            position: "absolute",
            top: 4,
            left: 4,
            padding: "2px 6px",
            background: "rgba(0,0,0,0.7)",
            color: "#0f0",
            font: "10px ui-monospace, monospace",
            borderRadius: 3,
            pointerEvents: "none",
            zIndex: 100,
          }}
        >
          LOD {visible.lod} · {displayPxPerPoint.toFixed(2)} px/pt · p
          {visible.primary.length} f{visible.fallback.length} m
          {visible.missing.length} · cache {renderer.cacheSize()}
        </div>
      )}
    </div>
  );
}

function Tile({
  tile,
  pageDims,
}: {
  tile: RenderedTile;
  pageDims: PageDims;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // CRITICAL: setting canvas.width/height clears the pixel buffer. Only
    // assign when the dimensions actually changed — otherwise StrictMode's
    // double-invoke clears the canvas, and if the second drawImage throws
    // (e.g., the bitmap is in a detached state), the tile is left blank.
    if (canvas.width !== tile.pixelWidth) canvas.width = tile.pixelWidth;
    if (canvas.height !== tile.pixelHeight) canvas.height = tile.pixelHeight;

    try {
      ctx.drawImage(tile.bitmap, 0, 0);
    } catch (err) {
      // ImageBitmap can be in a "detached" state if it was closed by an
      // aggressive cache eviction or worker termination. Don't crash —
      // skip; the next render with a valid bitmap will paint it.
      if (err instanceof DOMException && err.name === "InvalidStateError") {
        return;
      }
      throw err;
    }
  }, [tile]);

  const tilePt = tilePointSize(pageDims, tile.key.lod);
  return (
    <canvas
      ref={ref}
      style={{
        position: "absolute",
        left: tile.key.x * tilePt,
        top: tile.key.y * tilePt,
        width: tilePt,
        height: tilePt,
        pointerEvents: "none",
        // Phase-4: fade newly-mounted tiles in over 120ms so LOD threshold
        // crossings (where a fresh batch of primaries arrives over a
        // coarser-LOD fallback) don't snap visually. Defined in index.css.
        animation: "tile-fade-in 120ms ease-out",
      }}
    />
  );
}
