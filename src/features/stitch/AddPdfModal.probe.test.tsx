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
    Document: { openDocument: () => ({ countPages: () => 3, needsPassword: () => false, destroy() {} }) },
  },
}));

import { AddPdfModal } from "./AddPdfModal";
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

/** Mount with a PDF already in hand, tick every page, and let the debounce fire. */
async function openWithSelection() {
  await act(async () => {
    root.render(
      <AddPdfModal open onClose={() => {}} initialPdf={{ pdfBytes: new Uint8Array([1, 2, 3]), fileName: "sheets.pdf" }} />,
    );
  });
  vi.useFakeTimers();
  act(() => { button("Select all")!.click(); });
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
