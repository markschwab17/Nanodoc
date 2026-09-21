// @vitest-environment jsdom
/**
 * The error tile. A sheet whose PNG could not be encoded used to set nothing at
 * all, and `StitchTile` returned null for it — an INVISIBLE tile that was still
 * selectable and draggable, so the user could neither see the failure nor find
 * the thing to delete. It now renders a visible card carrying the reason.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { StitchTile } from "./StitchTile";
import { RASTER_ERROR_MESSAGE } from "./commitPages";
import { useStitchStore } from "@/shared/stores/stitchStore";
import type { StitchTile as StitchTileType } from "./stitchTypes";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const tile = (over: Partial<StitchTileType> = {}): StitchTileType => ({
  id: "t1",
  sourcePdfBytes: new Uint8Array(0),
  sourcePageIndex: 0,
  x: 0,
  y: 0,
  width: 100,
  height: 80,
  ...over,
});

describe("StitchTile raster states", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useStitchStore.getState().reset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  const render = (t: StitchTileType) => act(() => { root.render(<StitchTile tile={t} />); });

  it("shows the failure instead of a blank tile when the raster could not be made", () => {
    render(tile({ rasterError: RASTER_ERROR_MESSAGE }));
    expect(container.textContent).toContain(RASTER_ERROR_MESSAGE);
    expect(container.querySelector("img")).toBeNull();
    // Still a real tile: sized, positioned and hit-testable so it can be removed.
    expect(container.querySelector("[data-stitch-tile]")).toBeTruthy();
  });

  it("renders the image when there is one, and no error card", () => {
    render(tile({ imageDataUrl: "blob:fake/1" }));
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("blob:fake/1");
    expect(container.textContent).not.toContain(RASTER_ERROR_MESSAGE);
  });

  it("draws nothing at all for a tile with neither an image nor an error", () => {
    render(tile());
    expect(container.querySelector("[data-stitch-tile]")).toBeNull();
  });

  it("does not hold a compositor layer until the pointer arrives", () => {
    render(tile({ imageDataUrl: "blob:fake/1" }));
    const el = container.querySelector("[data-stitch-tile]") as HTMLElement;
    expect(el.style.willChange).toBe("");
    // jsdom has no PointerEvent; React derives onPointerEnter/Leave from the
    // bubbling pointerover/pointerout pair, which a plain Event satisfies.
    act(() => { el.dispatchEvent(new Event("pointerover", { bubbles: true })); });
    expect(el.style.willChange).toBe("transform");
    act(() => { el.dispatchEvent(new Event("pointerout", { bubbles: true })); });
    expect(el.style.willChange).toBe("");
  });
});
