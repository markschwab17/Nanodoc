// @vitest-environment jsdom
/**
 * The Add-pages modal's probe LIFECYCLE — the parts `modalProbeGate` cannot answer:
 * how long the modal is willing to wait, what the automatic re-run inherits, and what
 * it stops holding on to once a check has settled.
 *
 * The document, the renderer and the probe worker are all stubbed; what is real is the
 * modal's own bookkeeping (debounce → request → budget → settle).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";

const mocks = vi.hoisted(() => ({ shutdownOcr: vi.fn(async () => {}) }));
vi.mock("@/features/stitch/autostitch/ocrService", () => ({
  attachOcrRpc: () => {},
  recognize: async () => [],
  shutdownOcr: mocks.shutdownOcr,
}));
vi.mock("@/core/pdf/PDFRenderer", () => ({
  PDFRenderer: class {
    clearCache() {}
    dispose() {}
    async renderPage() { return { imageData: null }; }
  },
}));
vi.mock("mupdf", () => ({
  default: {
    Document: {
      openDocument: () => ({
        countPages: () => 3,
        needsPassword: () => false,
        destroy() {},
        loadPage: () => ({ getBounds: () => [0, 0, 612, 792], destroy() {} }),
      }),
    },
  },
}));

import { AddPdfModal } from "./AddPdfModal";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { planHashHex, SERVER_PROBE_VERSION } from "./ctoSessionSource";
import { ENGINE_VERSION } from "./autostitch/engineVersion";
import { autoAlignUnavailableNote } from "./addToProjectCopy";

// ── the stubbed probe worker ─────────────────────────────────────────────────
interface Posted { kind?: string; docId: number; pageIndices?: number[]; pdfBytes?: Uint8Array }
const posted: Posted[] = [];
let worker: FakeWorker | null = null;
class FakeWorker {
  onmessage: ((ev: MessageEvent<unknown>) => void) | null = null;
  constructor() { worker = this; }
  postMessage(msg: Posted) { posted.push(msg); }
  terminate() {}
  addEventListener() {}
  reply(msg: unknown) { act(() => { this.onmessage?.({ data: msg } as MessageEvent<unknown>); }); }
}
(globalThis as Record<string, unknown>).Worker = FakeWorker;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as Record<string, unknown>).ResizeObserver ??= class {
  observe() {} unobserve() {} disconnect() {}
};

const CLEAN = { calls: 12, nonAnswers: 0, retries: 0, unknown: 0, withheldVotes: 0 };
const HOLED = { calls: 12, nonAnswers: 2, retries: 1, unknown: 1, withheldVotes: 0 };

/** A probe reply that would otherwise be an offer. */
const result = (docId: number, ocrStats?: typeof CLEAN) => ({
  docId,
  placements: [0, 1, 2].map((p, i) => ({ pageIndex: p, x: i * 100, y: 0, width: 100, height: 100, aligned: true })),
  method: "geometric",
  alignedPageIndices: [0, 1, 2],
  worstResidFt: 1.2,
  rootFtPerIn: 20,
  poses: [],
  refPageIndices: [0, 1, 2],
  seamReport: [{ status: "verified" }],
  alignmentVerdict: "partial",
  alongAnchored: [0, 1, 2],
  worstAlongUncertaintyFt: 0,
  ocrStats,
});

/** Probe REQUESTS only — `posted` also carries every `{kind:"abort"}`. */
const requests = () => posted.filter((p) => !p.kind);
const aborts = () => posted.filter((p) => p.kind === "abort");
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(label));
const body = () => document.body.textContent ?? "";

let container: HTMLDivElement;
let root: Root;

/** Type into a controlled input the way React sees a user do it. */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const setScaleInput = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="Scale for all selected pages, feet per inch"]')!;
const pageScaleInput = (page: number) =>
  document.querySelector<HTMLInputElement>(`input[aria-label="Scale for page ${page}, feet per inch"]`)!;

/** Mount with a PDF already in hand, tick every page, type the set scale (the probe
 *  waits for it — null leaves it blank), and let the debounce fire. */
async function openWithSelection(scale: string | null = "10") {
  await act(async () => {
    root.render(
      <AddPdfModal open onClose={() => {}} initialPdf={{ pdfBytes: new Uint8Array([1, 2, 3]), fileName: "sheets.pdf" }} />,
    );
  });
  vi.useFakeTimers();
  act(() => { button("Select all")!.click(); });
  if (scale != null) typeInto(setScaleInput(), scale);
  act(() => { vi.advanceTimersByTime(400); });   // PROBE_DEBOUNCE_MS
}

beforeEach(() => {
  posted.length = 0;
  worker = null;
  mocks.shutdownOcr.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("AddPdfModal — the probe's wall clock", () => {
  it("posts one probe for the settled selection and shows a clean answer", async () => {
    await openWithSelection();
    expect(requests()).toHaveLength(1);
    expect(requests()[0].pageIndices).toEqual([0, 1, 2]);
    expect(body()).toContain("Checking alignment…");

    worker!.reply(result(requests()[0].docId, CLEAN));
    expect(body()).toContain("will auto-align");
    typeInto(setScaleInput(), "10");
    expect(button("Add & auto-align")!.hasAttribute("disabled")).toBe(false);
  });

  it("stops waiting at 60 s: aborts, says the check took too long, keeps the plain add", async () => {
    // Before this the modal would spin for as long as the aligner took, and the
    // automatic re-run below doubled that worst case.
    await openWithSelection();
    const docId = requests()[0].docId;
    act(() => { vi.advanceTimersByTime(60_000); });

    expect(aborts().filter((a) => a.docId === docId)).toHaveLength(1);
    // The EXISTING sentence, shared with the embed strip — not a second wording.
    expect(body()).toContain(autoAlignUnavailableNote("too_slow"));
    expect(button("Auto-align unavailable")!.hasAttribute("disabled")).toBe(true);
    // The pages can still be added and placed by hand — that is the whole point.
    typeInto(setScaleInput(), "10");
    expect(button("Add 3 pages to canvas")!.hasAttribute("disabled")).toBe(false);
    // Nothing else will hand tesseract back: the worker's eventual reply is stale.
    expect(mocks.shutdownOcr).toHaveBeenCalled();
  });

  it("a reply that fires after the budget gave up cannot resurrect the offer", async () => {
    await openWithSelection();
    const docId = requests()[0].docId;
    act(() => { vi.advanceTimersByTime(60_000); });
    worker!.reply(result(docId, CLEAN));
    expect(body()).toContain(autoAlignUnavailableNote("too_slow"));
  });

  it("the automatic re-run gets a FRESH 60 s, not what is left of the first check's", async () => {
    await openWithSelection();
    act(() => { vi.advanceTimersByTime(59_000); });        // the first budget, nearly up
    worker!.reply(result(requests()[0].docId, HOLED));     // …and a reply with a hole in it

    expect(requests()).toHaveLength(2);                    // re-run went out
    expect(body()).toContain("Checking alignment…");       // no flicker
    act(() => { vi.advanceTimersByTime(59_999); });        // the first check's last second
    expect(body()).toContain("Checking alignment…");       // …is not the re-run's
    act(() => { vi.advanceTimersByTime(2); });
    expect(body()).toContain(autoAlignUnavailableNote("too_slow"));
  });

  it("unknown reads twice: no offer, and exactly two probes", async () => {
    await openWithSelection();
    worker!.reply(result(requests()[0].docId, HOLED));
    worker!.reply(result(requests()[1].docId, HOLED));
    expect(body()).toContain(autoAlignUnavailableNote("too_slow"));
    expect(button("Auto-align unavailable")!.hasAttribute("disabled")).toBe(true);
    expect(requests()).toHaveLength(2);
  });

  it("a settled check stops holding its request — the PDF is not pinned by the modal", async () => {
    // `probeReqRef` carries the document's BYTES, and this modal stays mounted for the
    // life of the stitch view. The only way to observe the release is that nothing can
    // re-issue the request afterwards: a second reply carrying unknown reads has no
    // request to re-run and takes the honest answer instead of probing again.
    await openWithSelection();
    const docId = requests()[0].docId;
    worker!.reply(result(docId, CLEAN));
    expect(body()).toContain("will auto-align");

    worker!.reply(result(docId, HOLED));
    expect(requests()).toHaveLength(1);
    expect(body()).toContain(autoAlignUnavailableNote("too_slow"));
  });

  it("unmounting retires the budget too — nothing fires for a modal that is gone", async () => {
    // The budget is a bare `setTimeout`, and its callback aborts the worker, hands
    // tesseract back and writes component state. Every other end of a request cleared
    // it; unmount did not, so a stitch view closed mid-check did all three 60 s later
    // for a component nobody was looking at. Handing the pool back a SECOND time is
    // the observable half — the terminated worker swallows the rest in silence.
    await openWithSelection();
    expect(requests()).toHaveLength(1);
    act(() => root.unmount());
    const afterUnmount = mocks.shutdownOcr.mock.calls.length;
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(mocks.shutdownOcr.mock.calls.length).toBe(afterUnmount);
  });

  it("changing the selection supersedes the check and its budget — no stray abort later", async () => {
    await openWithSelection();
    expect(requests()).toHaveLength(1);
    act(() => { button("Select none")!.click(); });        // below two pages: nothing to check
    const abortsAfterSupersede = aborts().length;
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(aborts()).toHaveLength(abortsAfterSupersede);   // the retired budget never fired
    expect(body()).not.toContain(autoAlignUnavailableNote("too_slow"));
  });
});

describe("AddPdfModal — a typed scale is required (no 1\"=20' default)", () => {
  it("both commit buttons stay disabled, with the pages named, until every page has a scale", async () => {
    await openWithSelection(null);
    expect(button("Add 3 pages to canvas")!.hasAttribute("disabled")).toBe(true);
    expect(button("Add & auto-align")!.hasAttribute("disabled")).toBe(true);
    expect(body()).toContain("Enter the scale for pages 1, 2, 3");
    // Neither box reads as pre-filled with a number.
    expect(setScaleInput().placeholder).not.toMatch(/\d/);
    expect(pageScaleInput(1).placeholder).toBe("");

    // Per-page scales cover only their own page.
    typeInto(pageScaleInput(1), "10");
    typeInto(pageScaleInput(3), "10");
    expect(body()).toContain("Enter the scale for page 2");
    expect(button("Add 3 pages to canvas")!.hasAttribute("disabled")).toBe(true);

    // The set-wide scale fills the rest; the page inherits it visibly.
    typeInto(setScaleInput(), "10");
    expect(body()).not.toContain("Enter the scale for");
    expect(pageScaleInput(2).placeholder).toBe("10");
    expect(button("Add 3 pages to canvas")!.hasAttribute("disabled")).toBe(false);
    // Only now does the alignment check run — at the typed scales.
    act(() => { vi.advanceTimersByTime(400); });
    expect(requests()).toHaveLength(1);
    worker!.reply(result(requests()[0].docId, CLEAN));
    expect(button("Add & auto-align")!.hasAttribute("disabled")).toBe(false);

    // Junk in a page's own box is not quietly replaced by the set scale.
    typeInto(pageScaleInput(2), "ten");
    expect(body()).toContain("Enter the scale for page 2");
    expect(button("Add 3 pages to canvas")!.hasAttribute("disabled")).toBe(true);
  });

  it("the plain add commits the typed scale — 1\"=10' sheets land at 10, not 20", async () => {
    useStitchStore.getState().reset();
    await openWithSelection();
    typeInto(setScaleInput(), "10");
    vi.useRealTimers();
    await act(async () => { button("Add 3 pages to canvas")!.click(); });
    await vi.waitFor(() => expect(useStitchStore.getState().tiles).toHaveLength(3));
    expect(useStitchStore.getState().tiles.map((t) => t.scaleFeetPerInch)).toEqual([10, 10, 10]);
    expect(useStitchStore.getState().referenceScaleFeetPerInch).toBe(10);
  });

  it("a handed-over selection opens ticked, with known scales filled and the rest demanded", async () => {
    await act(async () => {
      root.render(
        <AddPdfModal
          open
          onClose={() => {}}
          initialPdf={{
            pdfBytes: new Uint8Array([1, 2, 3]),
            fileName: "plan.pdf",
            selection: { pageIndices: [0, 1, 2], pageScales: new Map([[0, 10], [2, 10]]) },
          }}
        />,
      );
    });
    expect(pageScaleInput(1).value).toBe("10");
    expect(pageScaleInput(2).value).toBe("");
    expect(pageScaleInput(3).value).toBe("10");
    expect(body()).toContain("Enter the scale for page 2");
    expect(button("Add 3 pages to canvas")!.hasAttribute("disabled")).toBe(true);
  });
});

describe("AddPdfModal — the probe is asked at the TYPED scale", () => {
  it("no probe runs until every page has a scale; then it posts those scales", async () => {
    await openWithSelection(null);
    // Nothing is checked at a guessed 1"=20' — and nothing claims a verdict.
    expect(requests()).toHaveLength(0);
    expect(body()).not.toContain("Checking alignment");
    expect(body()).not.toContain("will auto-align");
    typeInto(setScaleInput(), "40");
    act(() => { vi.advanceTimersByTime(400); });
    expect(requests()).toHaveLength(1);
    const req = requests()[0] as Posted & { userScale?: number | null; pageScales?: [number, number][] };
    expect(req.userScale).toBe(40);
    expect(req.pageScales).toEqual([[0, 40], [1, 40], [2, 40]]);
  });

  it("a verdict reached at 1\"=10' is withdrawn when the scale becomes 1\"=40', and re-checked at 40", async () => {
    // Seam statuses and the gate are decided in FEET: a 2 ft seam at 10 is not the
    // seam it is at 40 — the answer must be re-computed, not carried over.
    await openWithSelection("10");
    worker!.reply(result(requests()[0].docId, CLEAN));
    expect(body()).toContain("will auto-align");
    typeInto(setScaleInput(), "40");
    expect(body()).not.toContain("will auto-align");
    expect(button("Checking alignment…")!.hasAttribute("disabled")).toBe(true);
    act(() => { vi.advanceTimersByTime(400); });
    expect(requests()).toHaveLength(2);
    expect((requests()[1] as { userScale?: number }).userScale).toBe(40);
  });

  it("re-typing the same scale differently does not restart the check", async () => {
    await openWithSelection("10");
    typeInto(setScaleInput(), "10.0");
    act(() => { vi.advanceTimersByTime(400); });
    expect(requests()).toHaveLength(1);
  });
});

describe("AddPdfModal — a CTO plan hand-off keeps what the plan path knew", () => {
  const PLAN = { version: 1, mode: "manual", entries: [{ scaleFeetPerInch: null }, { scaleFeetPerInch: 10 }, { scaleFeetPerInch: 10 }] };
  const codes = new Map([[0, "C500"], [1, "C501"]]);
  const row = async (scale: number) => ({
    v: SERVER_PROBE_VERSION,
    engine: ENGINE_VERSION,
    status: "ok",
    planHash: await planHashHex(PLAN),
    request: {
      pageIndices: [0, 1, 2],
      userScale: scale,
      pageScales: [[0, scale], [1, scale], [2, scale]],
      pageCodes: [...codes],
    },
    result: result(0, CLEAN),
    ocrStats: CLEAN,
  });
  const open = async (serverProbe: unknown) => {
    await act(async () => {
      root.render(
        <AddPdfModal
          open
          onClose={() => {}}
          initialPdf={{
            pdfBytes: new Uint8Array([1, 2, 3]),
            fileName: "plan.pdf",
            selection: {
              pageIndices: [0, 1, 2],
              pageScales: new Map([[1, 10], [2, 10]]),
              pageCodes: codes,
              serverProbe,
              plan: PLAN,
            },
          }}
        />,
      );
    });
    // The user types the one missing scale.
    typeInto(pageScaleInput(1), "10");
  };

  it("the browser probe carries CTO's sheet codes", async () => {
    await open(null);
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    expect((requests()[0] as { pageCodes?: unknown }).pageCodes).toEqual([...codes]);
  });

  it("the droplet's verdict is used when it was computed at the typed scales — no browser probe", async () => {
    await open(await row(10));
    await vi.waitFor(() => expect(body()).toContain("will auto-align"));
    expect(requests()).toHaveLength(0);
  });

  it("a verdict computed at another scale (the droplet's 1\"=20' fill) is not used — the browser probes", async () => {
    await open(await row(20));
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    expect((requests()[0] as { userScale?: number }).userScale).toBe(10);
    expect(body()).not.toContain("will auto-align");
  });
});
