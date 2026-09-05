import { describe, it, expect } from "vitest";
import {
  cleanupBoxChrome,
  cleanupBoxColors,
  cleanupBoxLabel,
  cleanupBoxState,
  toolbarPlacement,
  pointInHoverRegion,
  GRIP_INK,
  GRIP_PX,
  HANDLE_PX,
  HOVER_LINGER_MS,
  HOVER_PAD_PX,
  TOOLBAR_FLIP_MARGIN_PX,
} from "./cleanupBoxModel";

describe("cleanupBoxState", () => {
  it("enabled and not moved → hidden", () => {
    expect(cleanupBoxState({ enabled: true })).toBe("hidden");
  });
  it("disabled → kept", () => {
    expect(cleanupBoxState({ enabled: false })).toBe("kept");
  });
  it("a relocation offset wins over the enabled flag", () => {
    expect(cleanupBoxState({ enabled: true, move: { dx: 0.1, dy: 0 } })).toBe("moved");
    expect(cleanupBoxState({ enabled: false, move: { dx: 0.1, dy: 0 } })).toBe("moved");
  });
});

describe("cleanupBoxLabel", () => {
  it("keeps the detected kind first", () => {
    expect(cleanupBoxLabel("title-block", "hidden")).toBe("Title block · Hidden");
    expect(cleanupBoxLabel("match-margin", "kept")).toBe("Match margin · Kept");
    expect(cleanupBoxLabel("title-block", "moved")).toBe("Title block · Moved");
  });
  it("a hand-drawn box is labelled by its state alone", () => {
    expect(cleanupBoxLabel("manual", "hidden")).toBe("Hidden");
    expect(cleanupBoxLabel("manual", "kept")).toBe("Kept");
    expect(cleanupBoxLabel("manual", "moved")).toBe("Moved");
  });
});

describe("cleanupBoxColors", () => {
  it("gives each state its own fixed, non-token colour", () => {
    const h = cleanupBoxColors("hidden"), k = cleanupBoxColors("kept"), m = cleanupBoxColors("moved");
    expect(new Set([h.border, k.border, m.border]).size).toBe(3);
    // Fixed colours only — a theme token would disappear against white paper.
    for (const c of [h, k, m]) {
      expect(c.border).toMatch(/^#[0-9a-f]{6}$/i);
      expect(c.chip).toMatch(/^#[0-9a-f]{6}$/i);
      expect(c.fill).toMatch(/^rgba\(/);
      expect(c.fillHover).toMatch(/^rgba\(/);
      expect(c).not.toHaveProperty("var");
    }
    expect(h.border).toBe("#ef4444"); // red = will hide
    expect(m.border).toBe("#0ea5e9"); // blue = will move
  });
});

describe("toolbarPlacement", () => {
  it("sits above the box when there is room", () => {
    expect(toolbarPlacement(500)).toBe("above");
    expect(toolbarPlacement(TOOLBAR_FLIP_MARGIN_PX)).toBe("above"); // exactly the margin still fits
  });
  it("flips below when the box top is within 40 screen px of the viewport top", () => {
    expect(toolbarPlacement(TOOLBAR_FLIP_MARGIN_PX - 1)).toBe("below");
    expect(toolbarPlacement(0)).toBe("below");
    expect(toolbarPlacement(-200)).toBe("below"); // scrolled off the top entirely
  });
  it("takes an explicit margin", () => {
    expect(toolbarPlacement(50, 80)).toBe("below");
    expect(toolbarPlacement(50, 10)).toBe("above");
  });
});

describe("cleanupBoxChrome", () => {
  it("centres the move handle on the box's top edge and puts the toolbar to its right", () => {
    const c = cleanupBoxChrome(200, 100, 1, "above");
    expect(c.grip.left + c.grip.width / 2).toBe(100); // box mid-x
    expect(c.grip.width).toBe(GRIP_PX);
    expect(c.grip.height).toBe(GRIP_PX); // square pill
    expect(c.toolbar.left).toBeGreaterThan(c.grip.left + c.grip.width); // right of the grip
  });
  it("keeps the move handle at a grabbable size — Mark: 'make it obvious'", () => {
    expect(GRIP_PX).toBeGreaterThanOrEqual(24);
    expect(GRIP_INK).toMatch(/^#[0-9a-f]{6}$/i); // fixed ink, not a theme token
  });
  it("puts the row fully OUTSIDE the box, clear of the edge", () => {
    const above = cleanupBoxChrome(200, 100, 1, "above");
    expect(above.toolbar.top + above.toolbar.height).toBeLessThan(0); // entirely above y=0
    const below = cleanupBoxChrome(200, 100, 1, "below");
    expect(below.toolbar.top).toBeGreaterThan(100); // entirely below the box's height
  });
  it("keeps the grip on the same row as the toolbar", () => {
    const c = cleanupBoxChrome(200, 100, 1, "above");
    const rowMid = c.toolbar.top + c.toolbar.height / 2;
    expect(c.grip.top + c.grip.height / 2).toBeCloseTo(rowMid, 6);
  });
  it("sizes chrome in SCREEN px — zoom divides every measurement", () => {
    const one = cleanupBoxChrome(200, 100, 1, "above");
    const quarter = cleanupBoxChrome(200, 100, 0.25, "above");
    expect(quarter.grip.width).toBe(one.grip.width * 4);
    expect(quarter.handle).toBe(HANDLE_PX / 0.25);
    const four = cleanupBoxChrome(200, 100, 4, "above");
    expect(four.grip.height).toBe(GRIP_PX / 4);
    // …but the grip stays centred whatever the zoom
    expect(four.grip.left + four.grip.width / 2).toBe(100);
  });
  it("treats a zero/negative zoom as 1 rather than dividing by it", () => {
    expect(cleanupBoxChrome(200, 100, 0, "above").grip.width).toBe(GRIP_PX);
    expect(Number.isFinite(cleanupBoxChrome(200, 100, 0, "above").grip.top)).toBe(true);
  });
});

describe("the hover region — controls must stay reachable", () => {
  // Mark: "when you move your mouse to the hover interactions they disappear and
  // you cannot interact with them." The region the pointer may occupy without
  // "leaving" the box is the union of the box, the controls row, and padding.
  const TOOLBAR_W = 150;
  const chrome = (placement: "above" | "below" = "above") =>
    cleanupBoxChrome(200, 100, 1, placement, TOOLBAR_W);
  const inside = (x: number, y: number, placement: "above" | "below" = "above") =>
    pointInHoverRegion(x, y, chrome(placement).hoverRegion);

  it("gives the pointer a grace period rather than hiding on the first leave", () => {
    expect(HOVER_LINGER_MS).toBeGreaterThanOrEqual(300);
  });

  it("covers the box itself", () => {
    expect(inside(100, 50)).toBe(true);
    expect(inside(0, 0)).toBe(true);
    expect(inside(200, 100)).toBe(true);
  });

  it("covers the GAP between the box's top edge and the controls row", () => {
    const c = chrome();
    const gapY = (c.toolbar.top + c.toolbar.height + 0) / 2; // somewhere in the gap
    expect(gapY).toBeLessThan(0); // the gap really is above the box
    expect(inside(100, gapY)).toBe(true);
  });

  it("covers the move handle and the whole toolbar", () => {
    const c = chrome();
    expect(inside(c.grip.left + c.grip.width / 2, c.grip.top + c.grip.height / 2)).toBe(true);
    expect(inside(c.toolbar.left + c.toolbar.width - 1, c.toolbar.top + 1)).toBe(true);
  });

  it("pads by 12 screen px around the union, and stops shortly after", () => {
    const c = chrome();
    expect(HOVER_PAD_PX).toBe(12);
    expect(inside(-HOVER_PAD_PX + 0.5, 50)).toBe(true);   // just inside the left pad
    expect(inside(-HOVER_PAD_PX - 1, 50)).toBe(false);    // beyond it
    expect(inside(100, 100 + HOVER_PAD_PX - 0.5)).toBe(true);
    expect(inside(100, 100 + HOVER_PAD_PX + 1)).toBe(false);
    const topEdge = c.toolbar.top - HOVER_PAD_PX;
    expect(inside(100, topEdge + 0.5)).toBe(true);
    expect(inside(100, topEdge - 1)).toBe(false);
  });

  it("follows the row when the toolbar flips below the box", () => {
    const c = chrome("below");
    expect(c.toolbar.top).toBeGreaterThan(100);
    expect(inside(100, c.toolbar.top + 1, "below")).toBe(true);
    expect(inside(100, -HOVER_PAD_PX + 0.5, "below")).toBe(true); // pad above the box only
    expect(inside(100, -HOVER_PAD_PX - 1, "below")).toBe(false);  // no row up there any more
  });

  it("widens with the measured toolbar so a long row is still covered", () => {
    const narrow = cleanupBoxChrome(200, 100, 1, "above", 40).hoverRegion;
    const wide = cleanupBoxChrome(200, 100, 1, "above", 400).hoverRegion;
    expect(wide.width).toBeGreaterThan(narrow.width);
    expect(pointInHoverRegion(380, -10, wide)).toBe(true);
    expect(pointInHoverRegion(380, -10, narrow)).toBe(false);
  });

  it("scales the padding in screen px too", () => {
    const far = cleanupBoxChrome(200, 100, 0.5, "above", TOOLBAR_W).hoverRegion;
    expect(far.left).toBeCloseTo(Math.min(0, cleanupBoxChrome(200, 100, 0.5, "above", TOOLBAR_W).grip.left) - HOVER_PAD_PX / 0.5, 6);
  });
});
