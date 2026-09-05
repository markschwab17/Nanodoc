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
 * ── One meaning per gesture ──────────────────────────────────────────────────
 * Mark (2026-09-04): "The X appears like you are trying to delete an accidental
 * selection area. The interaction to have it delete vs drag and drop it
 * somewhere else doesn't make sense." The old box overloaded a single drag: the
 * body relocated the CONTENT, a barely-moved press silently toggled hide/keep,
 * and a bare ✕ deleted the box. Now:
 *
 *   draw on empty canvas → a new hide box
 *   drag the box BODY    → MOVE THE BOX (which area gets hidden)
 *   drag the 8 handles   → resize the box
 *   drag the GRIP        → move the CONTENT somewhere else (ghost follows, Esc cancels)
 *   toolbar              → Hide / Keep, Put back (when moved), Cancel
 *   Delete / Backspace   → remove the SELECTED box
 *
 * A box means one thing — "this area will be hidden" — and every box says which
 * state it is in *in words*, not by colour alone. There is no click-to-toggle
 * and no bare ✕ anywhere: the control that drops a box is labelled **Cancel**,
 * because Mark read "Remove" as "delete this area from the sheet".
 *
 * The controls float clear of the box, so reaching them means leaving it. Three
 * things keep them reachable — Mark: "when you move your mouse to the hover
 * interactions they disappear and you cannot interact with them":
 *   • a click SELECTS the box and pins its controls until you click elsewhere or
 *     press Esc;
 *   • an invisible padded BRIDGE (a DOM child of the box, so it counts as
 *     "inside" for pointerenter/leave) spans the box, the controls and 12 screen
 *     px around them;
 *   • a 300 ms linger before hover chrome is hidden.
 *
 * Colours are FIXED and chrome is sized in SCREEN px (÷ zoom): see
 * `cleanupBoxModel.ts` for both, and for the toolbar's above/below placement.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Move, X } from "lucide-react";
import { useStitchStore, tileRasterUrl, type StitchTile } from "@/shared/stores/stitchStore";
import { isTypingTarget } from "../useStitchKeyboard";
import type { CleanupRegion } from "./cleanupDetect";
import { clampOffsetToCanvas, moveRegion, resizeRegion, type FRect, type ResizeHandle } from "./regionEdit";
import { cssClipToRect } from "./clipRegions";
import {
  cleanupBoxChrome,
  cleanupBoxColors,
  cleanupBoxLabel,
  cleanupBoxState,
  toolbarPlacement,
  GRIP_INK,
  HOVER_LINGER_MS,
  TOOLBAR_EST_W_PX,
  type ToolbarPlacement,
} from "./cleanupBoxModel";
import type { CanvasRect } from "../imageUtils";
import { MIN_ERASE_SIZE, REGION_DRAG_THRESHOLD_PX, RESIZE_CURSORS } from "../stitchConstants";

/** Below this (fractions) a relocation offset snaps back to "not moved". */
const RELOCATE_EPS = 0.004;

/** A detected/manual region plus its review state. `move` (offset in tile
 *  fractions) marks a relocated region — its content is drawn at the offset and
 *  its source hidden, instead of hidden in place. */
export interface CleanupRegionUI extends CleanupRegion {
  enabled: boolean;
  move?: { dx: number; dy: number };
}
export interface TileProposalUI {
  tileId: string;
  regions: CleanupRegionUI[];
}

/** Which box the keyboard acts on. */
export interface CleanupSelection {
  tileId: string;
  index: number;
}

const HANDLES: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
// each handle's center as a fraction of the region box
const HANDLE_POS: Record<ResizeHandle, { fx: number; fy: number }> = {
  nw: { fx: 0, fy: 0 }, n: { fx: 0.5, fy: 0 }, ne: { fx: 1, fy: 0 }, e: { fx: 1, fy: 0.5 },
  se: { fx: 1, fy: 1 }, s: { fx: 0.5, fy: 1 }, sw: { fx: 0, fy: 1 }, w: { fx: 0, fy: 0.5 },
};

export const GRIP_TITLE = "Drag to move this content somewhere else";
export const CANCEL_TITLE = "Cancel this box";

interface CleanupReviewProps {
  proposals: TileProposalUI[];
  tiles: StitchTile[];
  /** Convert a client (screen) point to canvas-area coordinates (same space as tile x/y). */
  clientToCanvas: (clientX: number, clientY: number) => { x: number; y: number } | null;
  onToggleRegion: (tileId: string, index: number) => void;
  onUpdateRegion: (tileId: string, index: number, rect: FRect) => void;
  onDeleteRegion: (tileId: string, index: number) => void;
  /** Relocate a region's content by an offset (fractions), or null to un-relocate. */
  onRelocateRegion: (tileId: string, index: number, move: { dx: number; dy: number } | null) => void;
  /** Called with a canvas-space rect when the user finishes drawing a manual box. */
  onManualBox: (rect: CanvasRect) => void;
}

/**
 * One editable box. Drag the BODY to move the box, the handles to resize it, and
 * the grip above it to move the sheet's content out from under it. The toolbar
 * beside the grip carries every discrete action, each with a word on it.
 */
function RegionBox({
  region, tileId, index, tileX, tileY, tileW, tileH, canvasW, canvasH, zoom, selected, contentDragRef,
  clientToCanvas, onSelect, onToggle, onUpdate, onDelete, onRelocate,
}: {
  region: CleanupRegionUI; tileId: string; index: number;
  tileX: number; tileY: number; tileW: number; tileH: number; canvasW: number; canvasH: number; zoom: number;
  selected: boolean;
  /** Shared with the parent: true while ANY box is mid content-drag, so Esc goes
   *  to cancelling that drag rather than to clearing the selection. */
  contentDragRef: React.MutableRefObject<boolean>;
  clientToCanvas: CleanupReviewProps["clientToCanvas"];
  onSelect: (sel: CleanupSelection) => void;
  onToggle: (t: string, i: number) => void;
  onUpdate: (t: string, i: number, r: FRect) => void;
  onDelete: (t: string, i: number) => void;
  onRelocate: (t: string, i: number, move: { dx: number; dy: number } | null) => void;
}) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false); // a drag is in progress — keep the chrome mounted even if the pointer leaves
  const [placement, setPlacement] = useState<ToolbarPlacement>("above");
  // The toolbar's real width, once the DOM knows it — the hover bridge has to
  // reach the far end of the row, and the row's width is content-driven.
  const [toolbarW, setToolbarW] = useState(TOOLBAR_EST_W_PX);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const lingerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drag = useRef<
    | { kind: "box"; sx: number; sy: number; rect: FRect; moved: boolean }
    | { kind: "resize"; handle: ResizeHandle; sx: number; sy: number; rect: FRect }
    | { kind: "content"; sx: number; sy: number; rect: FRect; startMove: { dx: number; dy: number } }
    | null
  >(null);

  const state = cleanupBoxState(region);
  const colors = cleanupBoxColors(state);
  const left = region.rect.x * tileW, top = region.rect.y * tileH;
  const width = region.rect.w * tileW, height = region.rect.h * tileH;
  const chrome = cleanupBoxChrome(width, height, zoom, placement, toolbarW);
  const threshold = REGION_DRAG_THRESHOLD_PX / zoom;   // "did the pointer really move?", in canvas units
  const minWFrac = MIN_ERASE_SIZE / tileW, minHFrac = MIN_ERASE_SIZE / tileH;
  const show = hover || active || selected;

  // The pill row flips below the box when the box's top edge is too close to the
  // top of the window — otherwise the grip, the ONLY way to move content, would
  // be the first thing clipped off-screen. Measured, not guessed: the overlay
  // lives inside a pan/zoom transform, so only the real rect knows where it is.
  useLayoutEffect(() => {
    if (!show) return;
    const r = boxRef.current?.getBoundingClientRect();
    if (r) setPlacement(toolbarPlacement(r.top));
    const t = toolbarRef.current?.getBoundingClientRect();
    // getBoundingClientRect is in SCREEN px already — exactly what the model wants.
    if (t && t.width > 0) setToolbarW((prev) => (Math.abs(prev - t.width) > 0.5 ? t.width : prev));
  }, [show, left, top, width, height, zoom, state]);

  // A 300 ms grace period on leave: clipping the edge of the box on the way to a
  // control must not tear the control away mid-reach.
  const cancelLinger = () => {
    if (lingerRef.current) { clearTimeout(lingerRef.current); lingerRef.current = null; }
  };
  const enter = () => { cancelLinger(); setHover(true); };
  const leave = () => {
    cancelLinger();
    lingerRef.current = setTimeout(() => { lingerRef.current = null; setHover(false); }, HOVER_LINGER_MS);
  };
  useEffect(() => cancelLinger, []);

  const capture = (e: React.PointerEvent) => {
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const beginBox = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect({ tileId, index });
    const c = clientToCanvas(e.clientX, e.clientY);
    if (!c) return;
    drag.current = { kind: "box", sx: c.x, sy: c.y, rect: region.rect, moved: false };
    setActive(true);
    capture(e);
  };
  const beginResize = (handle: ResizeHandle) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect({ tileId, index });
    const c = clientToCanvas(e.clientX, e.clientY);
    if (!c) return;
    drag.current = { kind: "resize", handle, sx: c.x, sy: c.y, rect: region.rect };
    setActive(true);
    capture(e);
  };
  const beginContent = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onSelect({ tileId, index });
    const c = clientToCanvas(e.clientX, e.clientY);
    if (!c) return;
    drag.current = { kind: "content", sx: c.x, sy: c.y, rect: region.rect, startMove: region.move ?? { dx: 0, dy: 0 } };
    contentDragRef.current = true;
    setActive(true);
    capture(e);
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const c = clientToCanvas(e.clientX, e.clientY);
    if (!c) return;
    const dx = c.x - d.sx, dy = c.y - d.sy;
    if (d.kind === "box") {
      // A click that jitters by a pixel must not nudge the box — below the
      // threshold this press is still just "select".
      if (!d.moved && Math.hypot(dx, dy) < threshold) return;
      d.moved = true;
      onUpdate(tileId, index, moveRegion(d.rect, dx / tileW, dy / tileH));
    } else if (d.kind === "resize") {
      onUpdate(tileId, index, resizeRegion(d.rect, d.handle, dx / tileW, dy / tileH, minWFrac, minHFrac));
    } else {
      // Relocate the CONTENT: accumulate onto the region's existing offset and
      // clamp to the whole composite canvas, so the piece can leave its sheet's
      // frame and land anywhere on the stitched page (but stays exportable).
      const off = clampOffsetToCanvas(
        d.rect, d.startMove.dx + dx / tileW, d.startMove.dy + dy / tileH,
        tileX, tileY, tileW, tileH, canvasW, canvasH
      );
      const cleared = Math.abs(off.dx) < RELOCATE_EPS && Math.abs(off.dy) < RELOCATE_EPS;
      onRelocate(tileId, index, cleared ? null : off);
    }
  };
  const end = (e: React.PointerEvent) => {
    drag.current = null;
    contentDragRef.current = false;
    setActive(false);
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  // Esc during a CONTENT drag puts the piece back where it started. The listener
  // is on `window` in the capture phase deliberately: StitchView's "Esc leaves
  // clean-up review" handler is a capture listener on `document`, and capture
  // runs window → document, so this one gets first refusal and stops the whole
  // review from being torn down mid-drag.
  useEffect(() => {
    const d = drag.current;
    if (!active || !d || d.kind !== "content") return;
    const startMove = d.startMove;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      drag.current = null;
      contentDragRef.current = false;
      setActive(false);
      const zeroed = Math.abs(startMove.dx) < RELOCATE_EPS && Math.abs(startMove.dy) < RELOCATE_EPS;
      onRelocate(tileId, index, zeroed ? null : startMove);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, tileId, index, onRelocate, contentDragRef]);

  const fontSize = 11 / zoom;
  /** Every toolbar control: a word, never a bare glyph. */
  const buttonStyle = (on: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 3 / zoom,
    padding: `0 ${6 / zoom}px`,
    height: "100%",
    border: "none",
    background: on ? colors.chip : "transparent",
    color: on ? "#fff" : "#1f2937",
    fontSize,
    lineHeight: 1,
    fontWeight: on ? 600 : 500,
    cursor: "pointer",
    whiteSpace: "nowrap",
  });
  const stop = (e: React.PointerEvent) => e.stopPropagation();

  return (
    <div
      ref={boxRef}
      className="absolute"
      data-cleanup-box
      style={{
        left, top, width, height,
        border: `${2 / zoom}px dashed ${colors.border}`,
        background: hover && !active ? colors.fillHover : colors.fill,
        // A selected box gets a solid halo so it is obvious what Delete removes.
        boxShadow: selected ? `0 0 0 ${2 / zoom}px ${colors.border}` : undefined,
        pointerEvents: "auto",
        cursor: "move",
        touchAction: "none",
      }}
      title="Drag to move this box · handles resize · grip above moves the content"
      onPointerEnter={enter}
      onPointerLeave={leave}
      onPointerDown={beginBox}
      onPointerMove={move}
      onPointerUp={end}
    >
      {/* State word — a box never relies on its colour alone. */}
      <span
        className="absolute left-0 top-0 font-medium leading-tight text-white pointer-events-none"
        style={{ background: colors.chip, padding: `0 ${4 / zoom}px`, fontSize, transformOrigin: "left top" }}
      >
        {cleanupBoxLabel(region.kind, state)}
      </span>

      {show && HANDLES.map((h) => {
        const p = HANDLE_POS[h];
        return (
          <div
            key={h}
            onPointerDown={beginResize(h)}
            onPointerMove={move}
            onPointerUp={end}
            style={{
              position: "absolute",
              left: p.fx * width - chrome.handle / 2,
              top: p.fy * height - chrome.handle / 2,
              width: chrome.handle,
              height: chrome.handle,
              background: "#fff",
              border: `${1 / zoom}px solid ${colors.border}`,
              cursor: RESIZE_CURSORS[h],
              touchAction: "none",
            }}
          />
        );
      })}

      {show && (
        <>
          {/* Invisible hover bridge: the union of the box and its controls plus 12
              screen px. It is a DOM CHILD of the box, and pointerenter/leave treat
              descendants as "inside", so crossing the gap up to the handle never
              reads as leaving the box. Mounted only while hovering or dragging —
              a merely SELECTED box keeps its controls anyway, and a permanent
              bridge would block drawing a new box in the strip above it. */}
          {(hover || active) && (
            <div
              data-cleanup-bridge
              aria-hidden
              onPointerEnter={enter}
              onPointerLeave={leave}
              // The bridge is a DOM child of the box, so a press on it would
              // otherwise bubble into beginBox and start a box drag from a point
              // that is not on the box. It is a hover target and nothing else.
              onPointerDown={stop}
              style={{
                position: "absolute",
                left: chrome.hoverRegion.left,
                top: chrome.hoverRegion.top,
                width: chrome.hoverRegion.width,
                height: chrome.hoverRegion.height,
                zIndex: -1, // behind the box body and the controls
                background: "transparent",
              }}
            />
          )}

          {/* The move handle: the ONE gesture that moves the sheet's content,
              floating clear of the box so it can never be confused with moving
              the box itself. Four arrows in an ink pill — "make it obvious". */}
          <div
            role="button"
            aria-label={GRIP_TITLE}
            title={GRIP_TITLE}
            data-cleanup-grip
            onPointerEnter={enter}
            onPointerDown={beginContent}
            onPointerMove={move}
            onPointerUp={end}
            style={{
              position: "absolute",
              left: chrome.grip.left,
              top: chrome.grip.top,
              width: chrome.grip.width,
              height: chrome.grip.height,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxSizing: "border-box",
              borderRadius: 9999,
              background: GRIP_INK,
              color: "#fff",
              border: `${1.5 / zoom}px solid #fff`,
              boxShadow: `0 ${1 / zoom}px ${3 / zoom}px rgba(0,0,0,0.35)`,
              cursor: "move",
              touchAction: "none",
            }}
          >
            <Move
              style={{ width: chrome.grip.width * 0.6, height: chrome.grip.height * 0.6 }}
              strokeWidth={2.5}
              aria-hidden
            />
          </div>

          {/* Discrete actions. Each says what it does. */}
          <div
            ref={toolbarRef}
            onPointerEnter={enter}
            onPointerDown={stop}
            onPointerMove={stop}
            style={{
              position: "absolute",
              left: chrome.toolbar.left,
              top: chrome.toolbar.top,
              height: chrome.toolbar.height,
              display: "flex",
              alignItems: "stretch",
              borderRadius: 4 / zoom,
              overflow: "hidden",
              background: "#fff",
              border: `${1 / zoom}px solid ${colors.border}`,
              boxShadow: `0 ${1 / zoom}px ${3 / zoom}px rgba(0,0,0,0.25)`,
              touchAction: "none",
            }}
          >
            {state === "moved" ? (
              // Hide/Keep would be inert on a moved box (Apply hides its source
              // either way), so the only honest choices here are put it back or
              // drop the box.
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRelocate(tileId, index, null); }}
                title="Put this content back where it came from"
                style={buttonStyle(false)}
              >
                Put back
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); if (!region.enabled) onToggle(tileId, index); }}
                  aria-pressed={state === "hidden"}
                  title="Hide this area"
                  style={buttonStyle(state === "hidden")}
                >
                  Hide
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); if (region.enabled) onToggle(tileId, index); }}
                  aria-pressed={state === "kept"}
                  title="Leave this area as it is"
                  style={buttonStyle(state === "kept")}
                >
                  Keep
                </button>
              </>
            )}
            {/* "Cancel" and not "Remove": Mark read Remove as "delete this area
                from the sheet", which is the opposite of what it does — it drops
                the BOX and leaves the sheet alone. No trash icon, for the same
                reason. (The review bar's own Cancel button, which abandons the
                whole review, stays a normal button down there.) */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDelete(tileId, index); }}
              title={CANCEL_TITLE}
              style={{ ...buttonStyle(false), borderLeft: `${1 / zoom}px solid ${colors.border}` }}
            >
              <X style={{ width: fontSize, height: fontSize }} strokeWidth={2.5} aria-hidden />
              Cancel
            </button>
          </div>
        </>
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
  onRelocateRegion,
  onManualBox,
}: CleanupReviewProps) {
  const zoom = useStitchStore((s) => s.zoomLevel) || 1;
  const canvasW = useStitchStore((s) => s.canvasWidth);
  const canvasH = useStitchStore((s) => s.canvasHeight);
  // The in-progress draw box lives in a REF as well as in state: the ref is what
  // the pointerup handler reads (a handler closes over the `box` from the render
  // it was created in, which is stale for a press-and-release that React batches
  // into one commit), while the state exists only to paint the live rectangle.
  type DrawBox = { start: { x: number; y: number }; current: { x: number; y: number } };
  const [box, setBox] = useState<DrawBox | null>(null);
  const boxRef = useRef<DrawBox | null>(null);
  const drawingRef = useRef(false);
  const setDrawBox = (b: DrawBox | null) => { boxRef.current = b; setBox(b); };
  const [selected, setSelected] = useState<CleanupSelection | null>(null);
  const contentDragRef = useRef(false);

  // Delete / Backspace removes the SELECTED box — never a tile, and never while
  // the user is typing somewhere. Capture on `window` so it lands before the
  // canvas-level key handling on `document`.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // A selected box's controls stay pinned until you click elsewhere or press
        // Esc. Deselecting is the FIRST thing Esc does; only a second Esc (with
        // nothing selected) falls through to StitchView's "leave the review".
        // A content drag in flight owns Esc outright — that box cancels its move.
        if (contentDragRef.current || !selectedRef.current) return;
        e.preventDefault();
        e.stopPropagation();
        setSelected(null);
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const sel = selectedRef.current;
      if (!sel || isTypingTarget()) return;
      e.preventDefault();
      e.stopPropagation();
      onDeleteRegion(sel.tileId, sel.index);
      setSelected(null); // indices shift after a removal
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onDeleteRegion]);

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
          setSelected(null); // pressing empty paper deselects
          setDrawBox({ start: c, current: c });
          try {
            (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
          } catch (_) {
            /* no pointer capture (jsdom, or a pointer already gone) — the drag
               still works off the surface's own move/up handlers */
          }
        }}
        onPointerMove={(e) => {
          if (!drawingRef.current) return;
          const c = clientToCanvas(e.clientX, e.clientY);
          const prev = boxRef.current;
          if (c && prev) setDrawBox({ ...prev, current: c });
        }}
        onPointerUp={(e) => {
          if (!drawingRef.current) return;
          drawingRef.current = false;
          try {
            (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
          } catch (_) {
            /* pointer already released */
          }
          // `onManualBox` used to be called from INSIDE the setBox updater. React
          // treats updaters as pure and re-invokes them under StrictMode, so every
          // hand-drawn box was added TWICE in dev — which is how one box over a
          // title column reported "2 hidden" and then (two identical even-odd
          // holes cancelling each other out) masked nothing at all. Read the box
          // from the ref, clear it, THEN report exactly once.
          const prev = boxRef.current;
          setDrawBox(null);
          if (!prev) return;
          const x = Math.min(prev.start.x, prev.current.x);
          const y = Math.min(prev.start.y, prev.current.y);
          const w = Math.abs(prev.current.x - prev.start.x);
          const h = Math.abs(prev.current.y - prev.start.y);
          if (w >= MIN_ERASE_SIZE && h >= MIN_ERASE_SIZE) onManualBox({ x, y, w, h });
        }}
        onPointerLeave={() => {
          if (!drawingRef.current) return;
          drawingRef.current = false;
          setDrawBox(null);
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
            {/* Live cut-out preview ("ghost") for relocated regions: a copy of the
                sheet image clipped to the source rect, translated by the offset —
                the sheet's OWN pixels show at the new spot while the grip is
                dragged (source still shows via StitchTile until Apply). */}
            {tileRasterUrl(tile) && p.regions.map((r, i) => {
              if (!r.move) return null;
              const clip = cssClipToRect(tile.width, tile.height, {
                x: r.rect.x * tile.width, y: r.rect.y * tile.height,
                w: r.rect.w * tile.width, h: r.rect.h * tile.height,
              });
              return (
                <img
                  key={`reloc-${i}`}
                  src={tileRasterUrl(tile)}
                  alt=""
                  draggable={false}
                  className="absolute inset-0 w-full h-full select-none"
                  style={{
                    pointerEvents: "none",
                    transform: `translate(${r.move.dx * tile.width}px, ${r.move.dy * tile.height}px)`,
                    clipPath: clip ?? undefined,
                    WebkitClipPath: clip ?? undefined,
                    outline: "1px dashed #0ea5e9",
                  }}
                />
              );
            })}
            {p.regions.map((r, i) => (
              <RegionBox
                key={i}
                region={r}
                tileId={p.tileId}
                index={i}
                tileX={tile.x}
                tileY={tile.y}
                tileW={tile.width}
                tileH={tile.height}
                canvasW={canvasW}
                canvasH={canvasH}
                zoom={zoom}
                selected={selected?.tileId === p.tileId && selected.index === i}
                contentDragRef={contentDragRef}
                clientToCanvas={clientToCanvas}
                onSelect={setSelected}
                onToggle={onToggleRegion}
                onUpdate={onUpdateRegion}
                onDelete={onDeleteRegion}
                onRelocate={onRelocateRegion}
              />
            ))}
          </div>
        );
      })}
    </>
  );
}
