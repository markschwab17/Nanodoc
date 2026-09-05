// @vitest-environment jsdom
/**
 * The Clean-up review box, gesture by gesture.
 *
 * Mark's complaint was that one press could mean three different things. These
 * tests pin the split: the BODY moves the box, the GRIP moves the content, the
 * toolbar carries every discrete action by name, and no press toggles anything
 * invisibly. They also pin the two bugs that came out of the same investigation:
 * a hand-drawn box must be reported exactly ONCE, and Delete must never fire
 * while the user is typing.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { CleanupReview, CANCEL_TITLE, GRIP_TITLE, type TileProposalUI } from "./CleanupReview";
import { useStitchStore } from "@/shared/stores/stitchStore";
import type { StitchTile } from "../stitchTypes";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TILE: StitchTile = {
  id: "t1",
  sourcePdfBytes: new Uint8Array(0),
  sourcePageIndex: 0,
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  imageDataUrl: "blob:sheet/1",
};

const proposal = (over: Partial<TileProposalUI["regions"][number]> = {}): TileProposalUI[] => [
  {
    tileId: "t1",
    regions: [
      {
        rect: { x: 0.5, y: 0.5, w: 0.25, h: 0.25 },
        kind: "manual",
        confidence: "high",
        enabled: true,
        ...over,
      },
    ],
  },
];

/** jsdom has no PointerEvent; MouseEvent + a pointerId is enough for React.
 *  `relatedTarget` matters for pointerover/out: React derives enter/leave from
 *  the pair, and only fires leave up to the common ancestor of from → to. */
function pointer(type: string, x: number, y: number, relatedTarget?: EventTarget | null): Event {
  const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, relatedTarget });
  Object.defineProperty(e, "pointerId", { value: 1 });
  return e;
}

describe("CleanupReview — one meaning per gesture", () => {
  let container: HTMLDivElement;
  let root: Root;
  let handlers: {
    onToggleRegion: ReturnType<typeof vi.fn>;
    onUpdateRegion: ReturnType<typeof vi.fn>;
    onDeleteRegion: ReturnType<typeof vi.fn>;
    onRelocateRegion: ReturnType<typeof vi.fn>;
    onManualBox: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useStitchStore.getState().reset();
    useStitchStore.setState({ zoomLevel: 1, canvasWidth: 2000, canvasHeight: 2000 });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    handlers = {
      onToggleRegion: vi.fn(),
      onUpdateRegion: vi.fn(),
      onDeleteRegion: vi.fn(),
      onRelocateRegion: vi.fn(),
      onManualBox: vi.fn(),
    };
  });

  // Unmount between tests: the hover chrome has a 300 ms linger timer, and a
  // timer that fires after the test ends is an un-acted state update.
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const render = (proposals: TileProposalUI[]) =>
    act(() => {
      root.render(
        <CleanupReview
          proposals={proposals}
          tiles={[TILE]}
          clientToCanvas={(x, y) => ({ x, y })}
          {...handlers}
        />
      );
    });

  const boxEl = () => container.querySelector("[data-cleanup-box]") as HTMLElement;
  const gripEl = () => container.querySelector("[data-cleanup-grip]") as HTMLElement;
  const button = (title: string) =>
    container.querySelector(`button[title="${title}"]`) as HTMLButtonElement | null;
  const buttonByText = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) ?? null;

  const hover = (el: HTMLElement) => act(() => { el.dispatchEvent(pointer("pointerover", 0, 0)); });

  it("labels a box with its state in words, not colour alone", () => {
    render(proposal());
    expect(boxEl().textContent).toContain("Hidden");
    render(proposal({ enabled: false }));
    expect(boxEl().textContent).toContain("Kept");
    render(proposal({ move: { dx: 0.1, dy: 0 } }));
    expect(boxEl().textContent).toContain("Moved");
  });

  it("names the detected kind before the state", () => {
    render([{ tileId: "t1", regions: [{ rect: { x: 0, y: 0, w: 0.2, h: 0.2 }, kind: "title-block", confidence: "high", enabled: true }] }]);
    expect(boxEl().textContent).toContain("Title block · Hidden");
  });

  it("has NO bare ✕ anywhere — dropping a box is a button labelled Cancel", () => {
    render(proposal());
    hover(boxEl());
    expect(container.textContent).not.toContain("✕");
    const cancel = button(CANCEL_TITLE)!;
    expect(cancel).toBeTruthy();
    // "Remove" read as "delete this area from the sheet", which is the opposite.
    expect(cancel.textContent).toContain("Cancel");
    expect(cancel.textContent).not.toContain("Remove");
    act(() => { cancel.click(); });
    expect(handlers.onDeleteRegion).toHaveBeenCalledWith("t1", 0);
  });

  it("the move handle is a four-arrow icon in an ink pill you can grab", () => {
    render(proposal());
    hover(boxEl());
    const grip = gripEl();
    expect(grip.getAttribute("title")).toBe(GRIP_TITLE);
    expect(grip.getAttribute("aria-label")).toBe(GRIP_TITLE);
    expect(grip.style.cursor).toBe("move");
    expect(grip.style.background).toBe("rgb(17, 24, 39)"); // fixed ink on white paper
    // lucide renders an <svg>; the four-arrow Move glyph, not six dots.
    expect(grip.querySelector("svg")).toBeTruthy();
    expect(grip.querySelectorAll("span").length).toBe(0);
    // ≥ 24 screen px at zoom 1 — "we need to make it obvious"
    expect(parseFloat(grip.style.width)).toBeGreaterThanOrEqual(24);
  });

  it("bridges the gap to the controls so moving onto them is not leaving the box", () => {
    render(proposal());
    hover(boxEl());
    const bridge = container.querySelector("[data-cleanup-bridge]") as HTMLElement;
    expect(bridge).toBeTruthy();
    // Box is 100x75 canvas px at (200,150) tile-local. The bridge spans ONLY the
    // gap between the box's top edge and the controls row above it.
    // jsdom reports every rect at 0,0, so `toolbarPlacement` puts the row BELOW.
    // Either way the bridge is a thin strip flush against one box edge.
    expect(parseFloat(bridge.style.top)).toBeCloseTo(75, 6); // the box's bottom edge
    const height = parseFloat(bridge.style.height);
    expect(height).toBeGreaterThan(0);
    expect(height).toBeLessThan(20);                          // the gap, not a halo
    expect(parseFloat(bridge.style.left)).toBeGreaterThan(0); // inside the box's span
  });

  it("does NOT arm the hide timer when the pointer returns from the bridge to the box", () => {
    // `pointerleave` fires on a child when the pointer moves to its PARENT. A
    // bridge that listened for leave would start the 300 ms countdown on the way
    // BACK from the controls, and the controls would vanish under the cursor —
    // Mark's original complaint, one step later.
    render(proposal());
    hover(boxEl());
    const bridge = container.querySelector("[data-cleanup-bridge]") as HTMLElement;
    const box = boxEl();
    // The return trip: out of the bridge, INTO its parent box. React fires leave
    // only up to the common ancestor, so the bridge alone sees it.
    act(() => {
      bridge.dispatchEvent(pointer("pointerout", 250, 200, box));
      box.dispatchEvent(pointer("pointerover", 250, 200, bridge));
    });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(gripEl()).toBeTruthy();        // still there, with the pointer on the box
    expect(button(CANCEL_TITLE)).toBeTruthy();
  });

  it("does not swallow a drag started on the paper beside a hovered box", () => {
    // The bridge used to be the box + controls + a 12 px halo, and it stops every
    // pointerdown (otherwise a press on it would start a box drag from a point
    // that is not on the box). A halo therefore made the paper AROUND a hovered
    // box undrawable. jsdom does no hit-testing, so this is asserted where the
    // truth actually lives — the bridge's rect must not cover any paper outside
    // the box, on any side.
    render(proposal());
    hover(boxEl());
    const bridge = container.querySelector("[data-cleanup-bridge]") as HTMLElement;
    const r = {
      left: parseFloat(bridge.style.left),
      top: parseFloat(bridge.style.top),
      width: parseFloat(bridge.style.width),
      height: parseFloat(bridge.style.height),
    };
    const covers = (x: number, y: number) =>
      x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height;
    // Box-local coords: the box is (0,0)-(100,75). Just outside each edge:
    expect(covers(-4, 40)).toBe(false);   // left of the box
    expect(covers(104, 40)).toBe(false);  // right of it
    expect(covers(50, -4)).toBe(false);   // above it
    expect(covers(-4, -4)).toBe(false);   // the corner the halo used to eat
    // Still a drag surface everywhere the box is not: the draw surface gets it.
    const surface = container.querySelector(".cursor-crosshair") as HTMLElement;
    act(() => {
      surface.dispatchEvent(pointer("pointerdown", 195, 160));
      surface.dispatchEvent(pointer("pointermove", 120, 100));
      surface.dispatchEvent(pointer("pointerup", 120, 100));
    });
    expect(handlers.onManualBox).toHaveBeenCalledTimes(1);
  });

  it("keeps the controls after the pointer leaves, once the box is SELECTED", () => {
    render(proposal());
    const box = boxEl();
    act(() => {
      box.dispatchEvent(pointer("pointerdown", 250, 200));
      box.dispatchEvent(pointer("pointerup", 250, 200));
      box.dispatchEvent(pointer("pointerout", 0, 0)); // pointer walks away entirely
    });
    expect(gripEl()).toBeTruthy();
    expect(button(CANCEL_TITLE)).toBeTruthy();
    // …and no bridge, so the strip above a selected box is still drawable.
    expect(container.querySelector("[data-cleanup-bridge]")).toBeNull();
  });

  it("Esc clears the selection first, and only then falls through to the review", () => {
    render(proposal());
    const box = boxEl();
    act(() => {
      box.dispatchEvent(pointer("pointerdown", 250, 200));
      box.dispatchEvent(pointer("pointerup", 250, 200));
      box.dispatchEvent(pointer("pointerout", 0, 0));
    });
    expect(gripEl()).toBeTruthy();

    const onDocument = vi.fn();
    document.addEventListener("keydown", onDocument, true);
    const esc = () => act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    esc();
    expect(gripEl()).toBeNull();          // deselected
    expect(onDocument).not.toHaveBeenCalled(); // review NOT exited by that Esc
    esc();
    expect(onDocument).toHaveBeenCalled();     // a second Esc is the review's
    document.removeEventListener("keydown", onDocument, true);
  });

  it("a press on the body SELECTS and never toggles hide/keep", () => {
    render(proposal());
    const box = boxEl();
    act(() => {
      box.dispatchEvent(pointer("pointerdown", 250, 200));
      box.dispatchEvent(pointer("pointerup", 250, 200));
    });
    expect(handlers.onToggleRegion).not.toHaveBeenCalled();
    expect(handlers.onUpdateRegion).not.toHaveBeenCalled();
    expect(handlers.onRelocateRegion).not.toHaveBeenCalled();
  });

  it("dragging the BODY moves the box — same size, new position, via onUpdateRegion", () => {
    render(proposal());
    const box = boxEl();
    act(() => {
      box.dispatchEvent(pointer("pointerdown", 250, 200));
      box.dispatchEvent(pointer("pointermove", 290, 230));
      box.dispatchEvent(pointer("pointerup", 290, 230));
    });
    expect(handlers.onRelocateRegion).not.toHaveBeenCalled(); // the CONTENT stayed put
    expect(handlers.onUpdateRegion).toHaveBeenCalled();
    const [tileId, index, rect] = handlers.onUpdateRegion.mock.calls.at(-1)!;
    expect(tileId).toBe("t1");
    expect(index).toBe(0);
    // 40px right on a 400-wide tile = +0.1; 30px down on 300-high = +0.1
    expect(rect.x).toBeCloseTo(0.6, 6);
    expect(rect.y).toBeCloseTo(0.6, 6);
    expect(rect.w).toBeCloseTo(0.25, 6); // size preserved
    expect(rect.h).toBeCloseTo(0.25, 6);
  });

  it("a body drag is clamped inside the tile", () => {
    render(proposal());
    const box = boxEl();
    act(() => {
      box.dispatchEvent(pointer("pointerdown", 250, 200));
      box.dispatchEvent(pointer("pointermove", 5000, 5000));
    });
    const rect = handlers.onUpdateRegion.mock.calls.at(-1)![2];
    expect(rect.x + rect.w).toBeCloseTo(1, 6);
    expect(rect.y + rect.h).toBeCloseTo(1, 6);
  });

  it("dragging the GRIP moves the CONTENT — onRelocateRegion, never onUpdateRegion", () => {
    render(proposal());
    hover(boxEl());
    const grip = gripEl();
    expect(grip.getAttribute("title")).toBe(GRIP_TITLE);
    act(() => {
      grip.dispatchEvent(pointer("pointerdown", 250, 200));
      grip.dispatchEvent(pointer("pointermove", 290, 230));
    });
    expect(handlers.onUpdateRegion).not.toHaveBeenCalled(); // the BOX stayed put
    const [, , move] = handlers.onRelocateRegion.mock.calls.at(-1)!;
    expect(move.dx).toBeCloseTo(0.1, 6);
    expect(move.dy).toBeCloseTo(0.1, 6);
  });

  it("Esc during a grip drag puts the content back and does NOT bubble to the review's Esc handler", () => {
    render(proposal());
    hover(boxEl());
    const grip = gripEl();
    act(() => {
      grip.dispatchEvent(pointer("pointerdown", 250, 200));
      grip.dispatchEvent(pointer("pointermove", 290, 230));
    });
    handlers.onRelocateRegion.mockClear();
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const onDocument = vi.fn();
    document.addEventListener("keydown", onDocument, true);
    act(() => { document.body.dispatchEvent(esc); });
    document.removeEventListener("keydown", onDocument, true);
    expect(handlers.onRelocateRegion).toHaveBeenCalledWith("t1", 0, null); // back to un-moved
    expect(onDocument).not.toHaveBeenCalled(); // review is NOT torn down mid-drag
  });

  it("the ghost is the sheet's own pixels, clipped to the box and translated", () => {
    render(proposal({ move: { dx: 0.1, dy: 0.2 } }));
    const ghost = [...container.querySelectorAll("img")].find((i) => i.style.clipPath);
    expect(ghost).toBeTruthy();
    expect(ghost!.getAttribute("src")).toBe("blob:sheet/1");
    expect(ghost!.style.transform).toBe("translate(40px, 60px)");
  });

  it("Hide / Keep are a named toggle, and a moved box offers Put back instead", () => {
    render(proposal());
    hover(boxEl());
    expect(buttonByText("Hide")?.getAttribute("aria-pressed")).toBe("true");
    act(() => { buttonByText("Keep")!.click(); });
    expect(handlers.onToggleRegion).toHaveBeenCalledWith("t1", 0);
    // Pressing the state it is already in is a no-op, not a flip back.
    handlers.onToggleRegion.mockClear();
    act(() => { buttonByText("Hide")!.click(); });
    expect(handlers.onToggleRegion).not.toHaveBeenCalled();

    render(proposal({ move: { dx: 0.1, dy: 0 } }));
    hover(boxEl());
    expect(buttonByText("Hide")).toBeNull();
    act(() => { buttonByText("Put back")!.click(); });
    expect(handlers.onRelocateRegion).toHaveBeenCalledWith("t1", 0, null);
  });

  it("Delete removes the SELECTED box, and does nothing with no selection or while typing", () => {
    render(proposal());
    const del = () => act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    });

    del();
    expect(handlers.onDeleteRegion).not.toHaveBeenCalled(); // nothing selected yet

    const box = boxEl();
    act(() => {
      box.dispatchEvent(pointer("pointerdown", 250, 200));
      box.dispatchEvent(pointer("pointerup", 250, 200));
    });
    del();
    expect(handlers.onDeleteRegion).toHaveBeenCalledWith("t1", 0);

    // Select again, then type: Delete belongs to the input, not the box.
    handlers.onDeleteRegion.mockClear();
    act(() => {
      boxEl().dispatchEvent(pointer("pointerdown", 250, 200));
      boxEl().dispatchEvent(pointer("pointerup", 250, 200));
    });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    del();
    expect(handlers.onDeleteRegion).not.toHaveBeenCalled();
    input.remove();
  });

  it("REGRESSION: a hand-drawn box is reported exactly ONCE, even under StrictMode", async () => {
    // onManualBox used to be called from inside a setState updater, which React
    // re-invokes in StrictMode — every manual box was added twice.
    const { StrictMode } = await import("react");
    act(() => {
      root.render(
        <StrictMode>
          <CleanupReview proposals={[]} tiles={[TILE]} clientToCanvas={(x, y) => ({ x, y })} {...handlers} />
        </StrictMode>
      );
    });
    const surface = container.querySelector(".cursor-crosshair") as HTMLElement;
    act(() => {
      surface.dispatchEvent(pointer("pointerdown", 10, 10));
      surface.dispatchEvent(pointer("pointermove", 110, 90));
      surface.dispatchEvent(pointer("pointerup", 110, 90));
    });
    expect(handlers.onManualBox).toHaveBeenCalledTimes(1);
    expect(handlers.onManualBox).toHaveBeenCalledWith({ x: 10, y: 10, w: 100, h: 80 });
  });
});
