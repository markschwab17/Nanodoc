/**
 * Clean-Composite review overlay.
 *
 * Rendered INSIDE the StitchCanvas canvas-area (the same transformed container
 * that holds the tiles), so proposed hide-regions map tile-local px → canvas px
 * exactly the way `StitchTile` does: each tile's regions live in a wrapper
 * carrying that tile's `translate(x,y)` transform, and each region is an
 * absolutely positioned dashed rect at its tile-local (x,y). Review tiles are
 * always unrotated (rotated tiles are filtered out upstream), so the wrapper is
 * translate-only and a canvas-space drag delta maps 1:1 to tile-local px.
 *
 * Interactions:
 *   1. A draw surface (below the region rects) captures empty-canvas box drags →
 *      `onManualBox` (a new manual hide-box).
 *   2. Each region rect can be MOVED (drag body), RESIZED (8 hover handles), and
 *      DELETED (✕). A press that barely moves is a CLICK → toggle keep/hide.
 * Regions stay stored as fractions of tile size; edits rewrite the fraction rect.
 *
 * Colour: red dashed = will hide (enabled), amber dashed = off (kept). Handles
 * and the ✕ are sized in screen px (÷ zoom) so they stay usable at any zoom.
 */

import { useRef, useState } from "react";
import { useStitchStore, type StitchTile } from "@/shared/stores/stitchStore";
import type { CleanupRegion } from "./cleanupDetect";
import { moveRegion, resizeRegion, type FRect, type ResizeHandle } from "./regionEdit";
import type { CanvasRect } from "../imageUtils";
import { MIN_ERASE_SIZE, REGION_DRAG_THRESHOLD_PX, RESIZE_CURSORS } from "../stitchConstants";

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

const HANDLES: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
// each handle's center as a fraction of the region box
const HANDLE_POS: Record<ResizeHandle, { fx: number; fy: number }> = {
  nw: { fx: 0, fy: 0 }, n: { fx: 0.5, fy: 0 }, ne: { fx: 1, fy: 0 }, e: { fx: 1, fy: 0.5 },
  se: { fx: 1, fy: 1 }, s: { fx: 0.5, fy: 1 }, sw: { fx: 0, fy: 1 }, w: { fx: 0, fy: 0.5 },
};

interface CleanupReviewProps {
  proposals: TileProposalUI[];
  tiles: StitchTile[];
  /** Convert a client (screen) point to canvas-area coordinates (same space as tile x/y). */
  clientToCanvas: (clientX: number, clientY: number) => { x: number; y: number } | null;
  onToggleRegion: (tileId: string, index: number) => void;
  onUpdateRegion: (tileId: string, index: number, rect: FRect) => void;
  onDeleteRegion: (tileId: string, index: number) => void;
  /** Called with a canvas-space rect when the user finishes drawing a manual box. */
  onManualBox: (rect: CanvasRect) => void;
}

/** One editable hide-region: drag body to move, hover handles to resize, ✕ to
 *  delete, a barely-moved press to toggle keep/hide. */
function RegionBox({
  region, tileId, index, tileW, tileH, zoom, clientToCanvas, onToggle, onUpdate, onDelete,
}: {
  region: CleanupRegionUI; tileId: string; index: number; tileW: number; tileH: number; zoom: number;
  clientToCanvas: CleanupReviewProps["clientToCanvas"];
  onToggle: (t: string, i: number) => void;
  onUpdate: (t: string, i: number, r: FRect) => void;
  onDelete: (t: string, i: number) => void;
}) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false); // a drag is in progress — keep handles mounted even if the pointer leaves
  const drag = useRef<{ mode: "move" | ResizeHandle; sx: number; sy: number; rect: FRect; moved: boolean } | null>(null);

  const left = region.rect.x * tileW, top = region.rect.y * tileH;
  const width = region.rect.w * tileW, height = region.rect.h * tileH;
  const hpx = 11 / zoom;                               // handle box, ≈11 screen px
  const threshold = REGION_DRAG_THRESHOLD_PX / zoom;   // move vs click, in canvas units
  const minWFrac = MIN_ERASE_SIZE / tileW, minHFrac = MIN_ERASE_SIZE / tileH;

  const begin = (mode: "move" | ResizeHandle) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const c = clientToCanvas(e.clientX, e.clientY);
    if (!c) return;
    drag.current = { mode, sx: c.x, sy: c.y, rect: region.rect, moved: mode !== "move" };
    setActive(true);
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const c = clientToCanvas(e.clientX, e.clientY);
    if (!c) return;
    const dx = c.x - d.sx, dy = c.y - d.sy;
    if (d.mode === "move") {
      if (!d.moved && Math.hypot(dx, dy) < threshold) return; // still a click
      d.moved = true;
      onUpdate(tileId, index, moveRegion(d.rect, dx / tileW, dy / tileH));
    } else {
      onUpdate(tileId, index, resizeRegion(d.rect, d.mode, dx / tileW, dy / tileH, minWFrac, minHFrac));
    }
  };
  const end = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setActive(false);
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (d && d.mode === "move" && !d.moved) onToggle(tileId, index); // click → toggle
  };

  return (
    <div
      className={`absolute border-2 border-dashed ${region.enabled ? "border-red-500 bg-red-500/15 hover:bg-red-500/25" : "border-amber-500 bg-amber-500/10 hover:bg-amber-500/20"}`}
      style={{ left, top, width, height, pointerEvents: "auto", cursor: "move", touchAction: "none" }}
      title={`${KIND_LABEL[region.kind]} — drag to move · handles to resize · ✕ to delete · click to ${region.enabled ? "keep" : "hide"}`}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onPointerDown={begin("move")}
      onPointerMove={move}
      onPointerUp={end}
    >
      <span
        className={`absolute left-0 top-0 px-1 font-medium leading-tight text-white pointer-events-none ${region.enabled ? "bg-red-600/80" : "bg-amber-600/80"}`}
        style={{ fontSize: 11 / zoom, transformOrigin: "left top" }}
      >
        {KIND_LABEL[region.kind]}{region.enabled ? "" : " · off"}
      </span>

      {(hover || active) && HANDLES.map((h) => {
        const p = HANDLE_POS[h];
        return (
          <div
            key={h}
            onPointerDown={begin(h)}
            onPointerMove={move}
            onPointerUp={end}
            style={{
              position: "absolute",
              left: p.fx * width - hpx / 2,
              top: p.fy * height - hpx / 2,
              width: hpx,
              height: hpx,
              background: "#fff",
              border: `${1 / zoom}px solid ${region.enabled ? "#ef4444" : "#f59e0b"}`,
              cursor: RESIZE_CURSORS[h],
              touchAction: "none",
            }}
          />
        );
      })}

      {(hover || active) && (
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onDelete(tileId, index); }}
          title="Delete this region"
          style={{
            position: "absolute",
            right: -hpx * 0.7,
            top: -hpx * 1.7,
            width: hpx * 1.5,
            height: hpx * 1.5,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "9999px",
            background: "#dc2626",
            color: "#fff",
            fontSize: hpx,
            lineHeight: 1,
            border: "none",
            cursor: "pointer",
          }}
        >
          ✕
        </button>
      )}
    </div>
  );
}

export function CleanupReview({
  proposals,
  tiles,
  clientToCanvas,
  onToggleRegion,
  onUpdateRegion,
  onDeleteRegion,
  onManualBox,
}: CleanupReviewProps) {
  const zoom = useStitchStore((s) => s.zoomLevel) || 1;
  const [box, setBox] = useState<{ start: { x: number; y: number }; current: { x: number; y: number } } | null>(null);
  const drawingRef = useRef(false);

  return (
    <>
      {/* Manual-box draw surface — above tiles, below the region rects. Empty
          drags here become manual hide-boxes; drags that land on a region hit the
          (higher-z) region instead. */}
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

      {/* Region rects, grouped per tile inside that tile's translate transform. */}
      {proposals.map((p) => {
        const tile = tiles.find((t) => t.id === p.tileId);
        if (!tile || p.regions.length === 0) return null;
        return (
          <div
            key={p.tileId}
            className="absolute z-[42]"
            style={{
              left: 0,
              top: 0,
              width: tile.width,
              height: tile.height,
              transform: `translate(${tile.x}px, ${tile.y}px)`,
              transformOrigin: "center center",
              pointerEvents: "none",
            }}
          >
            {p.regions.map((r, i) => (
              <RegionBox
                key={i}
                region={r}
                tileId={p.tileId}
                index={i}
                tileW={tile.width}
                tileH={tile.height}
                zoom={zoom}
                clientToCanvas={clientToCanvas}
                onToggle={onToggleRegion}
                onUpdate={onUpdateRegion}
                onDelete={onDeleteRegion}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}
