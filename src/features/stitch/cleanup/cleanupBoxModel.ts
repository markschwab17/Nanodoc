/**
 * Pure presentation model for a Clean-up review box.
 *
 * The review overlay lives INSIDE the zoom-scaled canvas layer and sits on white
 * paper, so two rules drive everything here:
 *
 *   1. FIXED colours. The sheets are white in both themes; a theme token would
 *      make the boxes vanish in dark mode. (Same rule as canvasOverlayStyle.)
 *   2. SCREEN-pixel sizing. Every chrome measurement is a screen px divided by
 *      the zoom, so a grip stays grabbable at 0.3× and doesn't swallow the box
 *      at 4×.
 *
 * One meaning per gesture (Mark, 2026-09-04: "the X appears like you are trying
 * to delete an accidental selection area … delete vs drag and drop doesn't make
 * sense"), so the state a box is in has to be *legible*, not inferred from a
 * colour alone — hence a word on every box.
 *
 * No React, no DOM: the geometry is arithmetic and the labels are strings, which
 * makes the fiddly parts (does the toolbar flip? where does the grip sit?)
 * testable without a canvas.
 */

import type { CleanupRegion } from "./cleanupDetect";

/** What a box will do on Apply. */
export type CleanupBoxState = "hidden" | "kept" | "moved";

/** Minimal shape of a reviewed region — matches `CleanupRegionUI`. */
export interface CleanupBoxLike {
  enabled: boolean;
  move?: { dx: number; dy: number };
}

/** A relocated box is "moved" whatever its enabled flag says — the offset is the
 *  stronger statement, and its source is hidden either way. */
export function cleanupBoxState(region: CleanupBoxLike): CleanupBoxState {
  if (region.move) return "moved";
  return region.enabled ? "hidden" : "kept";
}

/** The one-word state, shown on every box (never a bare colour). */
export const CLEANUP_STATE_WORD: Record<CleanupBoxState, string> = {
  hidden: "Hidden",
  kept: "Kept",
  moved: "Moved",
};

const KIND_WORD: Record<CleanupRegion["kind"], string> = {
  "title-block": "Title block",
  "match-margin": "Match margin",
  manual: "", // a box the user drew needs no provenance — it IS what they drew
};

/**
 * Box label: an auto-detected box keeps its kind first so the user can tell what
 * the detector thought it found ("Title block · Hidden"); a hand-drawn box is
 * just its state ("Hidden").
 */
export function cleanupBoxLabel(kind: CleanupRegion["kind"], state: CleanupBoxState): string {
  const word = CLEANUP_STATE_WORD[state];
  const k = KIND_WORD[kind];
  return k ? `${k} · ${word}` : word;
}

/** Fixed (theme-independent) colours for one box state. */
export interface CleanupBoxColors {
  /** Dashed border + handle stroke. */
  border: string;
  /** Translucent body fill. */
  fill: string;
  /** Body fill while the pointer is over the box. */
  fillHover: string;
  /** Solid chip behind the label text. */
  chip: string;
}

const COLORS: Record<CleanupBoxState, CleanupBoxColors> = {
  // red = this area goes away
  hidden: { border: "#ef4444", fill: "rgba(239,68,68,0.15)", fillHover: "rgba(239,68,68,0.25)", chip: "#dc2626" },
  // grey = a box that has been switched off; deliberately NOT amber, which read
  // as a second kind of warning rather than "nothing will happen here"
  kept: { border: "#6b7280", fill: "rgba(107,114,128,0.10)", fillHover: "rgba(107,114,128,0.18)", chip: "#4b5563" },
  // blue = this content is going somewhere else
  moved: { border: "#0ea5e9", fill: "rgba(14,165,233,0.10)", fillHover: "rgba(14,165,233,0.20)", chip: "#0284c7" },
};

export function cleanupBoxColors(state: CleanupBoxState): CleanupBoxColors {
  return COLORS[state];
}

// ── Chrome geometry (screen px, converted to canvas units by ÷ zoom) ─────────

/**
 * The move handle, in SCREEN px. A square ink pill carrying lucide's four-arrow
 * `Move` icon — Mark: "we need to make it obvious." Never below 24 px: this is
 * the only affordance for the one gesture nobody guesses (move the CONTENT, not
 * the box), so it has to read as a grabbable object at any zoom.
 */
export const GRIP_PX = 26;
/** The handle's pill: fixed ink, white icon — the sheets are white paper. */
export const GRIP_INK = "#111827";
/** Gap between the box edge and the pill row, and between the grip and toolbar. */
export const GRIP_GAP_PX = 6;
/** Toolbar row height, in SCREEN px. */
export const TOOLBAR_H_PX = 24;
/** Fallback toolbar width (SCREEN px) before the real one has been measured. */
export const TOOLBAR_EST_W_PX = 150;
/** Resize handle box, in SCREEN px. */
export const HANDLE_PX = 11;
/**
 * Padding (SCREEN px) around the box AND its controls that still counts as
 * "hovering this box". Mark: "when you move your mouse to the hover interactions
 * they disappear and you cannot interact with them" — the controls float clear
 * of the box, so without a padded bridge the pointer leaves the box mid-transit
 * and unmounts the very thing it was reaching for.
 */
export const HOVER_PAD_PX = 12;
/** Grace period before hover chrome is hidden, so a slip off the edge is survivable. */
export const HOVER_LINGER_MS = 300;
/**
 * The pill row flips below the box when the box's top is within this many SCREEN
 * px of the viewport top — otherwise the grip (the only way to move content)
 * would be clipped off-screen exactly when the user scrolled the box up there.
 */
export const TOOLBAR_FLIP_MARGIN_PX = 40;

/** Where the pill row goes relative to the box. */
export type ToolbarPlacement = "above" | "below";

/**
 * `boxTopViewportPx` is the box's top edge in VIEWPORT coordinates (what
 * `getBoundingClientRect().top` reports), so this is a pure screen-space
 * decision and the zoom never enters it.
 */
export function toolbarPlacement(
  boxTopViewportPx: number,
  margin: number = TOOLBAR_FLIP_MARGIN_PX
): ToolbarPlacement {
  return boxTopViewportPx < margin ? "below" : "above";
}

/** A rect offset from the box's top-left, in canvas units. */
export interface BoxRect { left: number; top: number; width: number; height: number }

/** Chrome geometry for one box, in CANVAS units (already ÷ zoom). */
export interface CleanupBoxChrome {
  /** Move-handle pill offset from the box's top-left. */
  grip: BoxRect;
  /** Toolbar row offset from the box's top-left — same row, right of the grip. */
  toolbar: BoxRect;
  /** Resize handle side length. */
  handle: number;
  /**
   * The area that counts as "still on this box": the union of the box and the
   * controls row, padded. Rendered as an invisible bridge so the pointer can
   * cross the gap to the controls without the box firing `pointerleave`.
   */
  hoverRegion: BoxRect;
}

/**
 * Lay out the move handle + toolbar for a `boxW` × `boxH` box (canvas units) at
 * `zoom`. The handle is centred on the box's top (or bottom, when flipped) edge —
 * the "drag handle hover above so it is clear" Mark asked for — and the toolbar
 * continues the same row to its right. `toolbarWidthPx` is the toolbar's MEASURED
 * screen width; it only affects how far right the hover bridge reaches, so the
 * estimate is a safe default until the DOM has reported the real one.
 */
export function cleanupBoxChrome(
  boxW: number,
  boxH: number,
  zoom: number,
  placement: ToolbarPlacement,
  toolbarWidthPx: number = TOOLBAR_EST_W_PX
): CleanupBoxChrome {
  const z = zoom > 0 ? zoom : 1;
  const gripSide = GRIP_PX / z;
  const gap = GRIP_GAP_PX / z;
  const rowH = Math.max(gripSide, TOOLBAR_H_PX / z);
  // Above: the row sits fully outside the box, its bottom `gap` clear of the
  // top edge. Below: mirrored off the bottom edge.
  const rowTop = placement === "above" ? -(rowH + gap) : boxH + gap;
  const gripLeft = boxW / 2 - gripSide / 2;
  const grip = { left: gripLeft, top: rowTop + (rowH - gripSide) / 2, width: gripSide, height: gripSide };
  const toolbar = { left: gripLeft + gripSide + gap, top: rowTop, height: rowH, width: toolbarWidthPx / z };

  const pad = HOVER_PAD_PX / z;
  const x0 = Math.min(0, grip.left, toolbar.left) - pad;
  const y0 = Math.min(0, rowTop) - pad;
  const x1 = Math.max(boxW, toolbar.left + toolbar.width) + pad;
  const y1 = Math.max(boxH, rowTop + rowH) + pad;

  return {
    grip,
    toolbar,
    handle: HANDLE_PX / z,
    hoverRegion: { left: x0, top: y0, width: x1 - x0, height: y1 - y0 },
  };
}

/** Is a point (offset from the box's top-left, canvas units) inside `region`? */
export function pointInHoverRegion(x: number, y: number, region: BoxRect): boolean {
  return (
    x >= region.left &&
    x <= region.left + region.width &&
    y >= region.top &&
    y <= region.top + region.height
  );
}
