/**
 * Colours for anything drawn OVER the sheets.
 *
 * Mark, in dark mode: the multi-select badge was white text on a white pill on white
 * paper. The cause is structural, not a one-off — the sheets are PAPER and stay white
 * in both themes (see StitchCanvas), so any overlay painted in theme tokens flips
 * underneath itself: `--popover` goes near-black in light and the text with it, and in
 * dark mode `--background` becomes the same near-black the text is supposed to sit on.
 *
 * THE RULE: an overlay on the paper uses FIXED colours, never tokens, and any text on
 * the paper gets its own opaque surface. Everything on the canvas — selection rings,
 * group halos, badges, align markers, the loupe — comes from here.
 *
 * The two-tone treatment (accent stroke + a white counter-stroke) is what makes a ring
 * legible over dense black linework AND over blank paper without changing colour.
 */

/** The accent every selection is drawn in. Vertigraph orange, fixed in both themes. */
export const OVERLAY_ACCENT = "#e0663a";
/** The darker accent, for a second stroke where one is not enough. */
export const OVERLAY_ACCENT_DARK = "#c8471c";
/** Near-black, for pills and handle borders. */
export const OVERLAY_INK = "#1f1f1f";
/** The counter-stroke: paper white. */
export const OVERLAY_PAPER = "#ffffff";

/** Ring weights, in SCREEN pixels — the canvas layer is zoom-scaled, so divide. */
export const RING_SCREEN_PX = 3;
export const RING_COUNTER_SCREEN_PX = 1;

/**
 * Screen pixels → canvas units at this zoom.
 *
 * A ring specified as `3px` inside the scaled layer is 0.4 px at a 14 % fit zoom, which
 * is exactly the "I can't tell what's selected" Mark reported. Dividing by the zoom (and
 * never by less than a sane floor) is the whole fix.
 */
export function screenPx(px: number, zoom: number): number {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return px / z;
}

/**
 * The selection ring: an accent outline with a white counter-stroke just inside it, so
 * it reads on white paper and on solid black linework alike.
 *
 * Returned as `outline` + `boxShadow` because outline does not affect layout and the
 * shadow can carry both the inner white line and the outer halo.
 */
export function selectionRingStyle(zoom: number, haloColor?: string): {
  outline: string;
  outlineOffset: string;
  boxShadow: string;
} {
  const ring = screenPx(RING_SCREEN_PX, zoom);
  const counter = screenPx(RING_COUNTER_SCREEN_PX, zoom);
  const halo = haloColor ?? OVERLAY_ACCENT;
  return {
    outline: `${ring}px solid ${OVERLAY_ACCENT}`,
    outlineOffset: `${-ring}px`,
    boxShadow: [
      // White INSIDE the accent ring: the line the ring needs when the sheet under it
      // is black linework.
      `inset 0 0 0 ${ring + counter}px ${OVERLAY_PAPER}`,
      `inset 0 0 0 ${ring}px ${OVERLAY_ACCENT}`,
      // …and a soft halo outside it, in the group's colour when there is one.
      `0 0 0 ${ring * 1.5}px ${halo}55`,
    ].join(", "),
  };
}

/** An unselected group member: the group's colour, dashed, with a white counter-stroke. */
export function groupMemberRingStyle(zoom: number, color: string): {
  outline: string;
  outlineOffset: string;
  boxShadow: string;
} {
  const ring = screenPx(2, zoom);
  return {
    outline: `${ring}px dashed ${color}`,
    outlineOffset: `${-ring}px`,
    boxShadow: `inset 0 0 0 ${ring + screenPx(1, zoom)}px ${OVERLAY_PAPER}`,
  };
}

/** Hover, when nothing else is drawn: the accent, thinner, no halo. */
export function hoverRingStyle(zoom: number): { outline: string; outlineOffset: string } {
  const ring = screenPx(2, zoom);
  return { outline: `${ring}px solid ${OVERLAY_ACCENT_DARK}`, outlineOffset: `${-ring}px` };
}

/** The pill every on-canvas label sits on: ink, white text, white hairline. */
export const OVERLAY_PILL_STYLE = {
  background: OVERLAY_INK,
  color: OVERLAY_PAPER,
  boxShadow: `0 0 0 1px ${OVERLAY_PAPER}, 0 1px 3px rgba(0,0,0,0.35)`,
} as const;

/**
 * Where a label anchored to the top of a box should go.
 *
 * Above the box normally; INSIDE it when the box's top edge is at or above the top of
 * the viewport, because a badge drawn above that is simply cut off — which is what
 * happened to the "2 sheets" badge on a sheet at the top of the canvas.
 */
export function badgePlacement(
  boxTopScreenPx: number,
  badgeHeightPx = 22
): "above" | "inside" {
  return boxTopScreenPx - badgeHeightPx < 0 ? "inside" : "above";
}

/**
 * How far (screen px) a label anchored to the LEFT of a box must shift right to stay
 * on screen. Zero normally; the overflow when the box starts left of the viewport —
 * the badge was still clipped there after the top edge got its clamp.
 */
export function badgeLeftInset(boxLeftScreenPx: number): number {
  return boxLeftScreenPx < 0 ? -boxLeftScreenPx : 0;
}
