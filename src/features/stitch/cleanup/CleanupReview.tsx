/**
 * Clean-Composite review overlay.
 *
 * Rendered INSIDE the StitchCanvas canvas-area (the same transformed container
 * that holds the tiles and the cropRect), so proposed hide-regions map from
 * tile-local px → canvas px exactly the way `StitchTile` does: each tile's
 * regions live in a wrapper carrying that tile's `translate(x,y) rotate()`
 * transform (transformOrigin: center center), and each region is an absolutely
 * positioned dashed rect at its tile-local (x,y).
 *
 * Two interactions coexist without a full-screen erase portal (which would eat
 * the region clicks):
 *   1. A draw surface (below the region rects) captures box drags → `onManualBox`
 *      with a canvas-space rect (reuses the erase-box draw pattern).
 *   2. Each region rect is a clickable button (above the draw surface) that
 *      toggles its `enabled` state via `onToggleRegion`.
 *
 * Colour: red dashed = will hide (enabled), amber dashed = off (kept).
 */

import { useRef, useState } from "react";
import type { StitchTile } from "@/shared/stores/stitchStore";
import type { CleanupRegion } from "./cleanupDetect";
import type { CanvasRect } from "../imageUtils";
import { MIN_ERASE_SIZE } from "../stitchConstants";

/** A detected/manual region plus its review toggle state. */
export interface CleanupRegionUI extends CleanupRegion {
  enabled: boolean;
}
export interface TileProposalUI {
  tileId: string;
  regions: CleanupRegionUI[];
}

const KIND_LABEL: Record<CleanupRegion["kind"], string> = {
  "title-block": "Title block",
  "match-margin": "Match margin",
  manual: "Manual",
};

interface CleanupReviewProps {
  proposals: TileProposalUI[];
  tiles: StitchTile[];
  /** Convert a client (screen) point to canvas-area coordinates (same space as tile x/y). */
  clientToCanvas: (clientX: number, clientY: number) => { x: number; y: number } | null;
  onToggleRegion: (tileId: string, index: number) => void;
  /** Called with a canvas-space rect when the user finishes drawing a manual box. */
  onManualBox: (rect: CanvasRect) => void;
}

export function CleanupReview({
  proposals,
  tiles,
  clientToCanvas,
  onToggleRegion,
  onManualBox,
}: CleanupReviewProps) {
  const [box, setBox] = useState<{ start: { x: number; y: number }; current: { x: number; y: number } } | null>(null);
  const drawingRef = useRef(false);

  return (
    <>
      {/* Manual-box draw surface — above tiles, below the region rects. Empty
          drags here become manual hide-boxes; clicks that land on a region rect
          hit the (higher-z) button instead. */}
      <div
        className="absolute inset-0 z-[40] cursor-crosshair"
        style={{ touchAction: "none" }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const c = clientToCanvas(e.clientX, e.clientY);
          if (!c) return;
          drawingRef.current = true;
          setBox({ start: c, current: c });
          (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drawingRef.current) return;
          const c = clientToCanvas(e.clientX, e.clientY);
          if (c) setBox((prev) => (prev ? { ...prev, current: c } : null));
        }}
        onPointerUp={(e) => {
          if (!drawingRef.current) return;
          drawingRef.current = false;
          try {
            (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
          } catch (_) {
            /* pointer already released */
          }
          setBox((prev) => {
            if (prev) {
              const x = Math.min(prev.start.x, prev.current.x);
              const y = Math.min(prev.start.y, prev.current.y);
              const w = Math.abs(prev.current.x - prev.start.x);
              const h = Math.abs(prev.current.y - prev.start.y);
              if (w >= MIN_ERASE_SIZE && h >= MIN_ERASE_SIZE) onManualBox({ x, y, w, h });
            }
            return null;
          });
        }}
        onPointerLeave={() => {
          if (!drawingRef.current) return;
          drawingRef.current = false;
          setBox(null);
        }}
      />

      {/* Live draw box */}
      {box && (
        <div
          className="absolute z-[41] border-2 border-dashed border-red-500 bg-red-500/10 pointer-events-none"
          style={{
            left: Math.min(box.start.x, box.current.x),
            top: Math.min(box.start.y, box.current.y),
            width: Math.abs(box.current.x - box.start.x),
            height: Math.abs(box.current.y - box.start.y),
          }}
        />
      )}

      {/* Region rects, grouped per tile inside that tile's transform so they
          align (and rotate) exactly like the tile image. */}
      {proposals.map((p) => {
        const tile = tiles.find((t) => t.id === p.tileId);
        if (!tile || p.regions.length === 0) return null;
        const rotation = tile.rotation ?? 0;
        return (
          <div
            key={p.tileId}
            className="absolute z-[42]"
            style={{
              left: 0,
              top: 0,
              width: tile.width,
              height: tile.height,
              transform: `translate(${tile.x}px, ${tile.y}px)${rotation ? ` rotate(${rotation}deg)` : ""}`,
              transformOrigin: "center center",
              pointerEvents: "none",
            }}
          >
            {p.regions.map((r, i) => (
              <button
                key={i}
                type="button"
                className={`absolute block p-0 m-0 border-2 border-dashed focus:outline-none ${
                  r.enabled
                    ? "border-red-500 bg-red-500/15 hover:bg-red-500/25"
                    : "border-amber-500 bg-amber-500/10 hover:bg-amber-500/20"
                }`}
                style={{
                  // region.rect is stored as fractions (0..1) of the tile — scale
                  // back to this tile's local px so it aligns inside the transform.
                  left: r.rect.x * tile.width,
                  top: r.rect.y * tile.height,
                  width: r.rect.w * tile.width,
                  height: r.rect.h * tile.height,
                  pointerEvents: "auto",
                }}
                title={`${KIND_LABEL[r.kind]} — click to ${r.enabled ? "keep this area" : "hide this area"}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleRegion(p.tileId, i);
                }}
              >
                <span
                  className={`absolute left-0 top-0 px-1 text-[10px] font-medium leading-tight text-white pointer-events-none ${
                    r.enabled ? "bg-red-600/80" : "bg-amber-600/80"
                  }`}
                >
                  {KIND_LABEL[r.kind]}
                  {r.enabled ? "" : " · off"}
                </span>
              </button>
            ))}
          </div>
        );
      })}
    </>
  );
}
