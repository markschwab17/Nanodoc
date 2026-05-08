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
import { useTilesPaused } from "@/core/pdf/tiles/tileRendererPause";
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
    // Filter by page so that an arrival for page X doesn't trigger re-renders
    // in TiledCanvas instances for pages Y/Z. Important in multi-page read
    // mode where 10+ pages may be mounted at once.
    //
    // Coalesce via requestAnimationFrame: many tiles can arrive within a
    // single frame during initial page load, and firing setTick per tile
    // would do per-tile React re-renders (each one walking visibleTileKeys
    // and reconciling N child Tile components). Saturating the main thread
    // makes scroll stutter. With RAF coalescing, an arbitrary burst of
    // tile arrivals produces one re-render per frame.
    let scheduled = false;
    const unsub = renderer.onTileReady((tile) => {
      if (tile.key.page !== pageNumber) return;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        setTick((t) => t + 1);
      });
    });
    return unsub;
  }, [renderer, pageNumber]);

  // VirtualizedPageList raises this signal during fast/fling scrolls so we
  // skip generating thousands of viewport changes for pages the user is
  // flying past. Cached fallbacks (LOD-0 from prefetchAllLod0) still paint
  // via getVisibleTiles below; we only suppress *new* tile requests until
  // the scroll settles. `paused` is in the dep array so resume immediately
  // re-fires setViewport.
  const paused = useTilesPaused();
  useEffect(() => {
    if (paused) return;
    renderer.setViewport(pageNumber, viewport, displayPxPerPoint);
  }, [renderer, pageNumber, viewport, displayPxPerPoint, paused]);

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
      {/* Use tileKeyString (no f-/p- prefix) as the React key so a tile
          that transitions between primary and fallback roles reuses the
          same Tile component instead of unmounting + remounting. The
          remount would re-trigger the 120ms fade-in animation from
          opacity 0, which the user saw as flickers during LOD changes.
          Primary and fallback never have the same tileKey since they're
          at different LODs by definition, so there's no key collision. */}
      {visible.fallback.map((t) => (
        <Tile key={tileKeyString(t.key)} tile={t} pageDims={pageDims} />
      ))}
      {visible.primary.map((t) => (
        <Tile key={tileKeyString(t.key)} tile={t} pageDims={pageDims} />
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

const Tile = React.memo(function Tile({
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
});
