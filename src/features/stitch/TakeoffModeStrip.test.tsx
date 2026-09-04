// @vitest-environment jsdom
/**
 * The earned Auto-align offer in the step strip. The strip is the ONLY place the
 * offer appears, so its three states are the whole user-facing contract of the gate:
 * a chip while the check runs, a primary button when the check clears it, a note
 * naming what was missing when it does not — and nothing at all when there is nothing
 * to say. "Offered means it works" starts here: a button that renders is a promise.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { TakeoffModeStrip, type TakeoffModeAutoAlign } from "./TakeoffModeStrip";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(autoAlign?: TakeoffModeAutoAlign) {
  act(() => {
    root.render(
      <TakeoffModeStrip
        sheetCount={4}
        unplacedCount={0}
        canAdd
        onAddToProject={() => {}}
        autoAlign={autoAlign}
      />,
    );
  });
  return container.textContent ?? "";
}

const offer = (over: Partial<TakeoffModeAutoAlign> = {}): TakeoffModeAutoAlign => ({
  status: "offer",
  sheets: 5,
  onRun: () => {},
  ...over,
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("TakeoffModeStrip auto-align offer", () => {
  it("says nothing at all when there is nothing to offer", () => {
    const text = render(offer({ status: "idle" }));
    expect(text).not.toContain("Auto-align");
    expect(text).not.toContain("Checking");
  });

  it("shows the checking chip while the probe runs", () => {
    expect(render(offer({ status: "checking" }))).toContain(
      "Checking whether these sheets can be auto-aligned…",
    );
  });

  it("offers a button naming the sheets it would claim", () => {
    expect(render(offer({ sheets: 5 }))).toContain("Auto-align 5 sheets");
  });

  it("running the offer calls back", () => {
    const onRun = vi.fn();
    render(offer({ onRun }));
    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Auto-align"),
    )!;
    act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("explains, rather than offering a disabled button, when the gate said no", () => {
    const text = render(offer({ status: "unavailable", reason: "no_matchline" }));
    expect(text).toContain("Auto-align isn't available for these sheets — they don't share a matchline");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.includes("Auto-align"))).toBe(
      false,
    );
  });

  it("keeps the fuller along-axis sentence in the note's tooltip", () => {
    render(
      offer({
        status: "unavailable",
        reason: "unverified",
        detail: "sheets can be lined up across the matchline but not along it — they may slide up to 48 ft",
      }),
    );
    const note = [...container.querySelectorAll("[title]")].find((el) =>
      el.textContent?.includes("Auto-align isn't available"),
    )!;
    expect(note.getAttribute("title")).toContain("slide up to 48 ft");
  });

  it("disables the button and says so while the run commits", () => {
    const text = render(offer({ status: "aligning" }));
    expect(text).toContain("Aligning…");
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Aligning"))!;
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("Add to project is still there in every state", () => {
    for (const status of ["idle", "checking", "offer", "unavailable", "aligning"] as const) {
      expect(render(offer({ status, reason: "no_refs" }))).toContain("Add to project");
    }
  });
});
