import { describe, expect, test } from "vitest";
import {
  classifyWheel,
  initialWheelKindState,
  panDeltasFor,
  zoomFactorFor,
  zoomStepFor,
  WHEEL_KIND_WINDOW_MS,
  type WheelSignal,
} from "./wheelIntent";

function wheel(overrides: Partial<WheelSignal> = {}): WheelSignal {
  return {
    deltaX: 0,
    deltaY: 0,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("classifyWheel", () => {
  test("a mouse notch (line deltaMode) zooms", () => {
    const r = classifyWheel(wheel({ deltaY: -3, deltaMode: 1 }), initialWheelKindState(), 1000);
    expect(r.intent).toBe("zoom");
    expect(r.pinch).toBe(false);
    expect(r.state.kind).toBe("mouse");
  });

  test("a horizontal component means trackpad ⇒ pan", () => {
    const r = classifyWheel(wheel({ deltaX: 4, deltaY: 11 }), initialWheelKindState(), 1000);
    expect(r.intent).toBe("pan");
    expect(r.state.kind).toBe("trackpad");
  });

  test("pure-vertical pixel scroll within the window of a trackpad frame still pans", () => {
    const first = classifyWheel(wheel({ deltaX: 4, deltaY: 11 }), initialWheelKindState(), 1000);
    const second = classifyWheel(wheel({ deltaY: 9 }), first.state, 1000 + WHEEL_KIND_WINDOW_MS - 1);
    expect(second.intent).toBe("pan");
    expect(second.state.kind).toBe("trackpad");
  });

  test("pure-vertical pixel scroll after the window zooms (a connected mouse)", () => {
    const first = classifyWheel(wheel({ deltaX: 4, deltaY: 11 }), initialWheelKindState(), 1000);
    const second = classifyWheel(wheel({ deltaY: 9 }), first.state, 1000 + WHEEL_KIND_WINDOW_MS);
    expect(second.intent).toBe("zoom");
    expect(second.state.kind).toBe("mouse");
  });

  test("pure-vertical pixel scroll with no prior trackpad frame zooms", () => {
    const r = classifyWheel(wheel({ deltaY: 120 }), initialWheelKindState(), 1000);
    expect(r.intent).toBe("zoom");
    expect(r.state.kind).toBe("mouse");
  });

  test("ctrl (pinch) always zooms, as a pinch, and leaves the device state untouched", () => {
    const state = { kind: "trackpad" as const, time: 500 };
    const r = classifyWheel(wheel({ deltaY: -6, ctrlKey: true, deltaX: 2 }), state, 1000);
    expect(r.intent).toBe("zoom");
    expect(r.pinch).toBe(true);
    expect(r.state).toEqual(state);
  });

  test("shift always pans, even for a mouse notch", () => {
    const r = classifyWheel(wheel({ deltaY: -3, deltaMode: 1, shiftKey: true }), initialWheelKindState(), 1000);
    expect(r.intent).toBe("pan");
  });

  test("meta zooms with the adaptive step, not as a pinch", () => {
    const r = classifyWheel(wheel({ deltaY: 120, metaKey: true }), initialWheelKindState(), 1000);
    expect(r.intent).toBe("zoom");
    expect(r.pinch).toBe(false);
  });

  test("meta overrides a live trackpad pan", () => {
    const first = classifyWheel(wheel({ deltaX: 4, deltaY: 11 }), initialWheelKindState(), 1000);
    const second = classifyWheel(wheel({ deltaY: 9, metaKey: true }), first.state, 1010);
    expect(second.intent).toBe("zoom");
  });
});

describe("zoomStepFor / zoomFactorFor", () => {
  test("step gets finer the deeper you are", () => {
    expect(zoomStepFor(1)).toBe(1.15);
    expect(zoomStepFor(2.5)).toBe(1.03);
    expect(zoomStepFor(5)).toBe(1.01);
    expect(zoomStepFor(10)).toBe(1.005);
  });

  test("a notch up zooms in, a notch down zooms out", () => {
    expect(zoomFactorFor(1, -3, false)).toBeCloseTo(1.15);
    expect(zoomFactorFor(1, 3, false)).toBeCloseTo(1 / 1.15);
  });

  test("pinch scales proportionally with the delta", () => {
    expect(zoomFactorFor(1, -10, true)).toBeCloseTo(Math.exp(0.1));
    expect(zoomFactorFor(1, 0, true)).toBe(1);
  });
});

describe("panDeltasFor", () => {
  test("raw deltas pass through", () => {
    expect(panDeltasFor({ deltaX: 5, deltaY: -8, shiftKey: false })).toEqual({ dx: 5, dy: -8 });
  });

  test("shift over a vertical-only wheel maps vertical to horizontal", () => {
    expect(panDeltasFor({ deltaX: 0, deltaY: 30, shiftKey: true })).toEqual({ dx: 30, dy: 0 });
  });

  test("shift with a real horizontal component keeps both axes", () => {
    expect(panDeltasFor({ deltaX: 3, deltaY: 30, shiftKey: true })).toEqual({ dx: 3, dy: 30 });
  });
});
