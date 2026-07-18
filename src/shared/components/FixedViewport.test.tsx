// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { FixedViewport, FIXED_VIEWPORT_CLASS } from "./FixedViewport";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("FixedViewport", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.documentElement.classList.remove(FIXED_VIEWPORT_CLASS);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it("adds the viewport-lock class to <html> while mounted and removes it on unmount", () => {
    expect(document.documentElement.classList.contains(FIXED_VIEWPORT_CLASS)).toBe(false);

    act(() => {
      root.render(
        <FixedViewport>
          <span>editor</span>
        </FixedViewport>
      );
    });
    expect(document.documentElement.classList.contains(FIXED_VIEWPORT_CLASS)).toBe(true);
    expect(container.textContent).toBe("editor");

    act(() => {
      root.unmount();
    });
    expect(document.documentElement.classList.contains(FIXED_VIEWPORT_CLASS)).toBe(false);
  });
});
