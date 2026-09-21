/**
 * The canvas is PAPER: it stays white in both themes, so anything drawn on it must be
 * a fixed colour and any text on it must bring its own surface. These lock that in —
 * the dark-mode failure Mark hit was white text on a white pill on white paper.
 */
import { describe, expect, it } from "vitest";
import {
  badgeLeftInset,
  OVERLAY_ACCENT,
  OVERLAY_INK,
  OVERLAY_PAPER,
  OVERLAY_PILL_STYLE,
  RING_SCREEN_PX,
  badgePlacement,
  groupMemberRingStyle,
  hoverRingStyle,
  screenPx,
  selectionRingStyle,
} from "./canvasOverlayStyle";

describe("ring weights are SCREEN pixels", () => {
  it("grows the drawn width as the canvas zooms out", () => {
    expect(screenPx(3, 1)).toBe(3);
    // The reported case: a fit zoom of 14 % turned a 3 px ring into 0.4 px.
    expect(screenPx(3, 0.14)).toBeCloseTo(21.43, 2);
    expect(screenPx(3, 4)).toBeCloseTo(0.75, 5);
  });

  it("survives a zero or broken zoom rather than dividing by it", () => {
    expect(screenPx(3, 0)).toBe(3);
    expect(screenPx(3, Number.NaN)).toBe(3);
  });

  it("yields at least 3 screen px for the selection ring at any zoom", () => {
    for (const zoom of [0.05, 0.14, 0.5, 1, 3]) {
      const { outline } = selectionRingStyle(zoom);
      const drawn = Number(outline.split("px")[0]);
      // Drawn in canvas units; multiplied back by the zoom it is the screen width.
      expect(drawn * zoom).toBeCloseTo(RING_SCREEN_PX, 6);
    }
  });
});

describe("every overlay colour is fixed, never a theme token", () => {
  it("uses no hsl(var(--…)) anywhere", () => {
    const styles = [
      JSON.stringify(selectionRingStyle(1)),
      JSON.stringify(selectionRingStyle(1, "hsl(217 91% 55%)")),
      JSON.stringify(groupMemberRingStyle(1, "hsl(217 91% 55%)")),
      JSON.stringify(hoverRingStyle(1)),
      JSON.stringify(OVERLAY_PILL_STYLE),
    ].join(" ");
    expect(styles).not.toContain("var(--");
  });

  it("puts a white counter-stroke inside the accent ring so it reads on black linework", () => {
    const { boxShadow, outline } = selectionRingStyle(1);
    expect(outline).toContain(OVERLAY_ACCENT);
    expect(boxShadow).toContain(OVERLAY_PAPER);
  });

  it("gives on-canvas labels an opaque dark pill with white text", () => {
    expect(OVERLAY_PILL_STYLE.background).toBe(OVERLAY_INK);
    expect(OVERLAY_PILL_STYLE.color).toBe(OVERLAY_PAPER);
    expect(OVERLAY_PILL_STYLE.boxShadow).toContain(OVERLAY_PAPER); // the hairline
  });

  it("tints the halo with the group's colour without touching the ring", () => {
    const grouped = selectionRingStyle(1, "hsl(142 66% 38%)");
    expect(grouped.boxShadow).toContain("hsl(142 66% 38%)");
    expect(grouped.outline).toContain(OVERLAY_ACCENT);
  });
});

describe("badges stay on screen", () => {
  it("sits above the box when there is room", () => {
    expect(badgePlacement(300)).toBe("above");
    expect(badgePlacement(23, 22)).toBe("above");
  });

  it("drops inside the box when the top edge is off the top of the viewport", () => {
    // The reported case: a sheet at the top of the canvas had its badge clipped away.
    expect(badgePlacement(10, 22)).toBe("inside");
    expect(badgePlacement(-200, 22)).toBe("inside");
  });
});

describe("badgeLeftInset", () => {
  it("is zero when the box starts on screen", () => {
    expect(badgeLeftInset(0)).toBe(0);
    expect(badgeLeftInset(120)).toBe(0);
  });
  it("shifts the label right by exactly the overflow when the box starts off the left edge", () => {
    expect(badgeLeftInset(-75)).toBe(75);
  });
});
