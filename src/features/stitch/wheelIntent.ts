/**
 * Wheel-intent classification for the stitch canvas — a port of takeoff v2's
 * heuristic (`TakeoffV2Client.tsx` handleWheel) so the two canvases behave the
 * same way under the same hardware.
 *
 * The problem: a mouse wheel should ZOOM, a trackpad two-finger swipe should
 * PAN, and the browser hands both to the same `wheel` event. The only reliable
 * per-event signal is a HORIZONTAL component: a mouse scrolls purely vertically
 * (deltaX === 0); a trackpad two-finger gesture almost always carries some
 * deltaX jitter. (Fractional deltaY is NOT reliable — macOS scroll acceleration
 * makes MICE fractional too.) A line/page deltaMode is a classic mouse wheel. A
 * pure-vertical pixel scroll is ambiguous: inherit a recent trackpad frame
 * within the gesture window (so mid-pan vertical-only frames still pan), else
 * treat it as a mouse so any connected mouse ZOOMS.
 *
 * Pure so it can be unit-tested without a DOM: the caller owns the remembered
 * device state and threads it back in.
 */

/** How long a "this is a trackpad" observation keeps covering ambiguous frames. */
export const WHEEL_KIND_WINDOW_MS = 500;

export type WheelDeviceKind = "mouse" | "trackpad";

/** The caller's remembered device state: what we last decided, and when. */
export interface WheelKindState {
  kind: WheelDeviceKind;
  time: number;
}

/** Only the wheel-event fields the heuristic reads. */
export interface WheelSignal {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface WheelIntent {
  intent: "zoom" | "pan";
  /** True for a real trackpad pinch (or Ctrl+wheel): continuous deltas, scale proportionally. */
  pinch: boolean;
  /** The device state to remember for the next event. */
  state: WheelKindState;
}

/** The state a fresh canvas starts from: assume a mouse until a trackpad frame proves otherwise. */
export function initialWheelKindState(): WheelKindState {
  return { kind: "mouse", time: 0 };
}

export function classifyWheel(
  e: WheelSignal,
  state: WheelKindState,
  now: number
): WheelIntent {
  const pinch = e.ctrlKey; // macOS trackpad pinch-zoom (also Ctrl+wheel)

  // A pinch carries no device information (it is always a deliberate zoom), so it
  // neither updates nor consults the remembered kind — same as v2.
  if (pinch) return { intent: "zoom", pinch: true, state };

  let kind = state.kind;
  if (e.deltaX !== 0) kind = "trackpad"; // horizontal component ⇒ trackpad
  else if (e.deltaMode !== 0) kind = "mouse"; // line/page mode ⇒ mouse wheel
  // ambiguous pure-vertical: keep trackpad only if a trackpad frame was seen very recently
  else if (!(kind === "trackpad" && now - state.time < WHEEL_KIND_WINDOW_MS)) kind = "mouse";
  const next: WheelKindState = { kind, time: now };

  // Cmd+wheel is not part of v2's heuristic; nanodoc has always treated it as an
  // explicit zoom (it predates this port), so it overrides the device guess. It is
  // NOT a pinch: a Cmd+wheel notch takes the adaptive step, not the continuous
  // pinch factor, which would jump wildly on a 100px notch.
  if (e.metaKey) return { intent: "zoom", pinch: false, state: next };

  if (e.shiftKey || kind === "trackpad") return { intent: "pan", pinch: false, state: next };
  return { intent: "zoom", pinch: false, state: next };
}

/**
 * v1/v2's zoom-adaptive step: finer increments the deeper you are, so high zoom
 * stays controllable.
 */
export function zoomStepFor(zoom: number): number {
  return zoom > 8 ? 1.005 : zoom > 4 ? 1.01 : zoom > 2 ? 1.03 : 1.15;
}

/**
 * The multiplier to apply to the current zoom for one wheel event. Pinch deltas
 * are small and continuous → scale proportionally for a smooth pinch; a wheel
 * notch is one adaptive step in the delta's direction.
 */
export function zoomFactorFor(zoom: number, deltaY: number, pinch: boolean): number {
  if (pinch) return Math.exp(-deltaY * 0.01);
  const step = zoomStepFor(zoom);
  return deltaY < 0 ? step : 1 / step;
}

/**
 * Pan deltas for one wheel event, in raw OS pixels (the trackpad already reports
 * pixel deltas, so 1:1 feels native). A mouse user holding Shift over a
 * vertical-only wheel gets that vertical mapped to horizontal.
 */
export function panDeltasFor(e: Pick<WheelSignal, "deltaX" | "deltaY" | "shiftKey">): {
  dx: number;
  dy: number;
} {
  const horizontalOnly = e.shiftKey && e.deltaX === 0;
  return horizontalOnly ? { dx: e.deltaY, dy: 0 } : { dx: e.deltaX, dy: e.deltaY };
}
