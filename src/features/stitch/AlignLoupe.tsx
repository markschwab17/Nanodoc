/**
 * The align loupe: a 220 px circular magnifier that follows the cursor while the user
 * is placing the four alignment points.
 *
 * It paints in three layers so it can NEVER go blank while a crop is in flight:
 *   1. the tile's own committed raster, scaled up — instant, blurry, always there;
 *   2. the on-demand 300 dpi crop from `useLoupeRender`, once it lands (drawn shifted
 *      by however far the cursor has moved since, so it stays registered with the page);
 *   3. the crosshair, and a ring on the point a click would snap to.
 */

import { memo, useEffect, useRef } from "react";
import { canvasToTileLocal } from "./stitchGeometry";
import { LOUPE_SIZE_PX, placeLoupe, type Viewport } from "./loupeGeometry";
import type { LoupeView } from "./useLoupeRender";
import type { StitchTile } from "./stitchTypes";

export interface AlignLoupeProps {
  view: LoupeView | null;
  cropCanvas: HTMLCanvasElement | null;
  /** The tile under the cursor (the loupe's subject). */
  tile: StitchTile | null;
  /** Blob/data URL of that tile's raster — the always-available fallback layer. */
  fallbackUrl?: string;
  /** The canvas viewport, in client coordinates: the loupe flips to stay inside it. */
  viewport: Viewport;
  /** Step hint, shown on a pill under the circle. */
  hint: string;
}

export const AlignLoupe = memo(function AlignLoupe({
  view,
  cropCanvas,
  tile,
  fallbackUrl,
  viewport,
  hint,
}: AlignLoupeProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fallbackRef = useRef<{ url: string; img: HTMLImageElement } | null>(null);

  // One decoded fallback image at a time — swapped when the subject sheet changes.
  useEffect(() => {
    if (!fallbackUrl) {
      fallbackRef.current = null;
      return;
    }
    if (fallbackRef.current?.url === fallbackUrl) return;
    const img = new Image();
    img.src = fallbackUrl;
    fallbackRef.current = { url: fallbackUrl, img };
  }, [fallbackUrl]);

  const version = view?.version ?? 0;
  const cursorX = view?.canvasPoint.x;
  const cursorY = view?.canvasPoint.y;
  const magnification = view?.magnification ?? 4;
  const snapX = view?.snap?.point.x;
  const snapY = view?.snap?.point.y;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !view || !tile) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = LOUPE_SIZE_PX;
    if (canvas.width !== size * dpr) {
      canvas.width = size * dpr;
      canvas.height = size * dpr;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    // Literal white, in both themes, on purpose: what the loupe shows is PAPER. The
    // sheets themselves stay white under `.dark` for the same reason (see StitchCanvas)
    // — the linework is black, and a themed ground would swallow it. The crosshair and
    // snap ring below are fixed red/blue for the same reason: they are drawn on paper,
    // not on the app's surface.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);

    // 1. Fallback: the tile raster, sampled around the cursor in TILE-LOCAL terms so
    //    it works before any page geometry is known.
    const img = fallbackRef.current?.img;
    const local = canvasToTileLocal(view.canvasPoint, tile);
    if (img && img.complete && img.naturalWidth > 0 && local && tile.width > 0 && tile.height > 0) {
      const spanCanvas = size / magnification;
      const sx = ((local.u - spanCanvas / 2) / tile.width) * img.naturalWidth;
      const sy = ((local.v - spanCanvas / 2) / tile.height) * img.naturalHeight;
      const sw = (spanCanvas / tile.width) * img.naturalWidth;
      const sh = (spanCanvas / tile.height) * img.naturalHeight;
      ctx.save();
      ctx.translate(size / 2, size / 2);
      ctx.rotate((((tile.rotation ?? 0) * Math.PI) / 180));
      ctx.imageSmoothingEnabled = true;
      try {
        ctx.drawImage(img, sx, sy, sw, sh, -size / 2, -size / 2, size, size);
      } catch {
        // A raster that is not decodable yet just leaves the white ground.
      }
      ctx.restore();
    }

    // 2. The crop, if one has landed. Shifted by however far the cursor moved since.
    if (cropCanvas && cropCanvas.width > 0 && view.drawPlan && view.cropAt) {
      const dx = (view.canvasPoint.x - view.cropAt.x) * magnification;
      const dy = (view.canvasPoint.y - view.cropAt.y) * magnification;
      ctx.drawImage(
        cropCanvas,
        view.drawPlan.left - dx,
        view.drawPlan.top - dy,
        view.drawPlan.width,
        view.drawPlan.height
      );
    }

    // 3. Crosshair at the centre — the cursor's exact point.
    ctx.strokeStyle = "rgba(220, 38, 38, 0.9)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(size / 2 - 14, size / 2);
    ctx.lineTo(size / 2 + 14, size / 2);
    ctx.moveTo(size / 2, size / 2 - 14);
    ctx.lineTo(size / 2, size / 2 + 14);
    ctx.stroke();

    // …and the point the click would actually record, when snapping found one.
    if (view.snap) {
      const rx = size / 2 + (view.snap.point.x - view.canvasPoint.x) * magnification;
      const ry = size / 2 + (view.snap.point.y - view.canvasPoint.y) * magnification;
      ctx.strokeStyle = "rgba(37, 99, 235, 0.95)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(rx, ry, 7, 0, Math.PI * 2);
      ctx.stroke();
    }
    // `version`, `cursorX/Y` and the snap coords are what a repaint depends on; the
    // canvas element itself is stable.
  }, [view, tile, cropCanvas, version, cursorX, cursorY, magnification, snapX, snapY]);

  if (!view || !tile) return null;
  const { left, top } = placeLoupe(view.screen, viewport);

  return (
    // Decoration for the eye: the step hint it repeats is already announced by the
    // mode bar's live region, so a screen reader must not hear it twice.
    <div className="fixed z-[110] pointer-events-none" style={{ left, top }} aria-hidden="true">
      <div
        className="rounded-full overflow-hidden border-2 border-primary/70 shadow-xl bg-white"
        style={{ width: LOUPE_SIZE_PX, height: LOUPE_SIZE_PX }}
      >
        <canvas
          ref={canvasRef}
          style={{ width: LOUPE_SIZE_PX, height: LOUPE_SIZE_PX, display: "block" }}
        />
      </div>
      {hint && (
        <div className="mt-1.5 max-w-[260px] rounded bg-popover/95 border border-border px-2 py-1 text-[11px] text-popover-foreground shadow">
          {hint}
        </div>
      )}
    </div>
  );
});
