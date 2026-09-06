// @vitest-environment jsdom
/**
 * The earned Auto-align hook against a stubbed probe worker.
 *
 * These are the rules that cannot be read off the code: a reply that arrives after the
 * selection changed must be ignored, the StrictMode remount must not kill the hook,
 * OCR must be handed back on every terminal reply, and taking an offer after the user
 * has touched the canvas must NOT apply absolute placements over their work.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { StrictMode, useEffect } from "react";

// `vi.mock` factories are hoisted above every top-level binding, so the spies they
// close over have to be created inside `vi.hoisted`.
const mocks = vi.hoisted(() => ({
  shutdownOcr: vi.fn(async () => {}),
  commitAutoAlign: vi.fn(async (_input?: unknown) => ({
    added: 2,
    unalignedIds: [] as string[],
    message: "Aligned 2 pages.",
  })),
}));
const { shutdownOcr, commitAutoAlign } = mocks;

vi.mock("./autostitch/ocrService", () => ({
  attachOcrRpc: () => {},
  recognize: async () => [],
  shutdownOcr: mocks.shutdownOcr,
}));

vi.mock("./commitPages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./commitPages")>();
  return { ...actual, commitAutoAlign: mocks.commitAutoAlign };
});

vi.mock("@/core/pdf/PDFRenderer", () => ({ PDFRenderer: class { dispose() {} } }));
vi.mock("mupdf", () => ({
  default: { Document: { openDocument: () => ({ destroy() {} }) } },
}));

import { useEarnedAutoAlign, type EarnedAutoAlign } from "./useEarnedAutoAlign";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { autoAlignUnavailableNote } from "./addToProjectCopy";
import { ENGINE_VERSION } from "./autostitch/engineVersion";
import { planHashHex } from "./ctoSessionSource";
import type { StitchTile } from "./stitchTypes";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** The REAL `setTimeout`, captured before any test installs a fake clock.
 *  `crypto.subtle.digest` (the plan hash) completes on the event loop, and a faked
 *  clock does not turn it — so the server-verdict tests below need one genuine
 *  macrotask to let the hash, and the async check waiting on it, land. */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

// ── the stubbed worker ───────────────────────────────────────────────────────
interface Posted { kind?: string; docId: number; pageIndices?: number[]; pageCodes?: [number, string][] }
const posted: Posted[] = [];
const workers: FakeWorker[] = [];

class FakeWorker {
  onmessage: ((ev: MessageEvent<unknown>) => void) | null = null;
  terminated = false;
  constructor() { workers.push(this); }
  postMessage(msg: Posted) { posted.push(msg); }
  terminate() { this.terminated = true; }
  addEventListener() {}
  /** Deliver a reply as the real worker would. */
  reply(msg: unknown) { this.onmessage?.({ data: msg } as MessageEvent<unknown>); }
}
(globalThis as Record<string, unknown>).Worker = FakeWorker;

/** What a clean OCR channel reports: reads made, nothing lost. */
const CLEAN_STATS = { calls: 12, nonAnswers: 0, retries: 0, unknown: 0, withheldVotes: 0 };
/** …and one that reached its answer with a hole in the evidence. */
const holedStats = (unknown = 1) => ({ calls: 12, nonAnswers: 2, retries: 1, unknown, withheldVotes: 0 });

/** The probe payload of a set that clears every bar of the gate. */
const goodProbe = (docId: number, pages: number[]) => ({
  docId,
  placements: pages.map((p, i) => ({ pageIndex: p, x: i * 100, y: 0, width: 100, height: 100, aligned: true })),
  method: "geometric" as const,
  alignedPageIndices: pages,
  worstResidFt: 1.2,
  rootFtPerIn: 20,
  poses: [],
  refPageIndices: pages,
  seamReport: [{ status: "verified" }],
  alignmentVerdict: "partial" as const,
  alongAnchored: pages,
  worstAlongUncertaintyFt: 0,
});

// ── harness ──────────────────────────────────────────────────────────────────
let container: HTMLDivElement;
let root: Root;
let hook: EarnedAutoAlign;
let mounts = 0;

function Probe() {
  hook = useEarnedAutoAlign();
  useEffect(() => { mounts++; }, []);
  return null;
}

function mount(strict = false) {
  act(() => {
    root.render(strict ? <StrictMode><Probe /></StrictMode> : <Probe />);
  });
}

const tile = (over: Partial<StitchTile> & { id: string }): StitchTile => ({
  sourcePdfBytes: BYTES,
  sourcePageIndex: 0,
  x: 0, y: 0, width: 100, height: 100,
  scaleFeetPerInch: 20,
  ...over,
});
const BYTES = new Uint8Array([1, 2, 3]);

/** Put N sheets on the canvas without going through a commit. */
function seedCanvas(pages: number[]) {
  useStitchStore.setState({
    tiles: pages.map((p, i) => tile({ id: `t${p}`, sourcePageIndex: p, x: i * 200 })),
  });
}

beforeEach(() => {
  posted.length = 0;
  workers.length = 0;
  mounts = 0;
  shutdownOcr.mockClear();
  commitAutoAlign.mockClear();
  useStitchStore.getState().reset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useEarnedAutoAlign", () => {
  it("checks the canvas and reports an offer with the CLAIMED sheet count", () => {
    seedCanvas([0, 1, 2]);
    mount();
    act(() => hook.check());
    expect(hook.status).toBe("checking");
    expect(posted.at(-1)!.pageIndices).toEqual([0, 1, 2]);
    act(() => workers[0].reply(goodProbe(posted.at(-1)!.docId, [0, 1, 2])));
    expect(hook.status).toBe("offer");
    expect(hook.sheets).toBe(3);
  });

  it("says nothing at all when the canvas cannot be checked honestly", () => {
    seedCanvas([0]); // one sheet — nothing to align to
    mount();
    act(() => hook.check());
    expect(hook.status).toBe("idle");
    expect(posted.filter((p) => !p.kind)).toHaveLength(0);
  });

  it("passes the caller's sheet codes and remembers them for a re-check", () => {
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check({ pageCodes: new Map([[0, "C500"]]) }));
    expect(posted.at(-1)!.pageCodes).toEqual([[0, "C500"]]);
    act(() => hook.recheck());
    expect(posted.at(-1)!.pageCodes).toEqual([[0, "C500"]]);
  });

  it("ignores a reply from a superseded check and aborts the one in flight", () => {
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    const first = posted.at(-1)!.docId;
    act(() => hook.check());
    expect(posted.some((p) => p.kind === "abort" && p.docId === first)).toBe(true);
    const second = posted.at(-1)!.docId;
    expect(second).not.toBe(first);
    // The OLD run answers late. It must not become the offer.
    act(() => workers[0].reply(goodProbe(first, [0, 1])));
    expect(hook.status).toBe("checking");
    act(() => workers[0].reply(goodProbe(second, [0, 1])));
    expect(hook.status).toBe("offer");
  });

  it("hands tesseract back on every terminal reply", () => {
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    act(() => workers[0].reply(goodProbe(posted.at(-1)!.docId, [0, 1])));
    expect(shutdownOcr).toHaveBeenCalled();
  });

  it("a failed probe becomes the honest note, never a button", () => {
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    act(() => workers[0].reply({ docId: posted.at(-1)!.docId, error: "boom" }));
    warn.mockRestore();
    expect(hook.status).toBe("unavailable");
    expect(hook.reason).toBe("unverified");
  });

  it("an aborted probe is not a failure — it just stops saying anything", () => {
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    act(() => workers[0].reply({ docId: posted.at(-1)!.docId, aborted: true }));
    expect(hook.status).toBe("idle");
  });

  it("survives the StrictMode double-mount — the reply is NOT dropped", () => {
    // The unmount cleanup latches a "gone" flag; without clearing it on mount, the
    // remounted hook discarded every reply and the chip span forever in dev.
    seedCanvas([0, 1]);
    mount(true);
    expect(mounts).toBeGreaterThan(1); // StrictMode really did remount
    act(() => hook.check());
    expect(hook.status).toBe("checking");
    act(() => workers.at(-1)!.reply(goodProbe(posted.at(-1)!.docId, [0, 1])));
    expect(hook.status).toBe("offer");
  });

  it("running the offer commits with the probe's placements cached and replaces the grid", async () => {
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    act(() => workers[0].reply(goodProbe(posted.at(-1)!.docId, [0, 1])));
    await act(async () => { await hook.run(); });
    expect(commitAutoAlign).toHaveBeenCalledTimes(1);
    const arg = commitAutoAlign.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.replaceTileIds).toEqual(["t0", "t1"]);
    expect((arg.cached as { alongAnchored: number[] }).alongAnchored).toEqual([0, 1]);
    expect(hook.status).toBe("idle");
  });

  it("REFUSES to apply the offer when a sheet moved since the check", async () => {
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    act(() => workers[0].reply(goodProbe(posted.at(-1)!.docId, [0, 1])));
    // The user drags a sheet while the check is settling.
    act(() => {
      const tiles = useStitchStore.getState().tiles.map((t) => (t.id === "t1" ? { ...t, x: t.x + 40 } : t));
      useStitchStore.setState({ tiles });
    });
    await act(async () => { await hook.run(); });
    expect(commitAutoAlign).not.toHaveBeenCalled();
    expect(hook.status).toBe("stale");
  });

  it("REFUSES to apply the offer when a sheet was deleted, and never re-adds it", async () => {
    seedCanvas([0, 1, 2]);
    mount();
    act(() => hook.check());
    act(() => workers[0].reply(goodProbe(posted.at(-1)!.docId, [0, 1, 2])));
    act(() => useStitchStore.setState({ tiles: useStitchStore.getState().tiles.filter((t) => t.id !== "t2") }));
    await act(async () => { await hook.run(); });
    expect(commitAutoAlign).not.toHaveBeenCalled();
    expect(hook.status).toBe("stale");
  });

  it("a re-check after a stale offer probes the canvas as it NOW stands", () => {
    seedCanvas([0, 1, 2]);
    mount();
    act(() => hook.check());
    act(() => workers[0].reply(goodProbe(posted.at(-1)!.docId, [0, 1, 2])));
    act(() => useStitchStore.setState({ tiles: useStitchStore.getState().tiles.filter((t) => t.id !== "t2") }));
    act(() => hook.recheck());
    expect(posted.at(-1)!.pageIndices).toEqual([0, 1]); // the deleted page is gone for good
  });

  it("names the two-PDF canvas instead of going silent", () => {
    // One solve takes one document, so this canvas is never probed — but silence read
    // as "the feature is broken", so the strip gets a reason it can print.
    useStitchStore.setState({
      tiles: [
        tile({ id: "a", sourcePageIndex: 0 }),
        tile({ id: "b", sourcePageIndex: 0, sourcePdfBytes: new Uint8Array([9, 9]) }),
      ],
    });
    mount();
    act(() => hook.check());
    expect(hook.status).toBe("unavailable");
    expect(hook.reason).toBe("mixed_sources");
    expect(posted.filter((p) => !p.kind)).toHaveLength(0);
    // A check that posts nothing must still hand tesseract back: the reply handler now
    // KEEPS the pool alive across an automatic re-check, and a canvas that lost a sheet
    // between the discarded reply and that re-check lands exactly here. No settle is
    // coming, so this is the only release on the path.
    expect(shutdownOcr).toHaveBeenCalled();
  });

  it("REFUSES to apply the offer when a sheet was EDITED since the check", async () => {
    // Not a move: a clean-up region hidden while the probe ran. The replace rebuilds
    // every tile from the source page, so applying it would silently drop the edit.
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    act(() => workers[0].reply(goodProbe(posted.at(-1)!.docId, [0, 1])));
    act(() => {
      const tiles = useStitchStore.getState().tiles.map((t) =>
        t.id === "t1" ? { ...t, hiddenRegions: [{ x: 0, y: 0, w: 0.2, h: 0.1 }] } : t,
      );
      useStitchStore.setState({ tiles });
    });
    await act(async () => { await hook.run(); });
    expect(commitAutoAlign).not.toHaveBeenCalled();
    expect(hook.status).toBe("stale");
  });

  it("an erase override also makes the offer stale", async () => {
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    act(() => workers[0].reply(goodProbe(posted.at(-1)!.docId, [0, 1])));
    act(() => {
      const tiles = useStitchStore.getState().tiles.map((t) =>
        t.id === "t0" ? { ...t, imageDataUrl: "blob:erased", imageModified: true } : t,
      );
      useStitchStore.setState({ tiles });
    });
    await act(async () => { await hook.run(); });
    expect(commitAutoAlign).not.toHaveBeenCalled();
    expect(hook.status).toBe("stale");
  });

  it("undoing back to the checked canvas takes the offer back up", async () => {
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    act(() => workers[0].reply(goodProbe(posted.at(-1)!.docId, [0, 1])));
    const before = useStitchStore.getState().tiles;
    act(() => {
      useStitchStore.setState({
        tiles: before.map((t) => (t.id === "t1" ? { ...t, x: t.x + 40 } : t)),
      });
    });
    await act(async () => { await hook.run(); });
    expect(hook.status).toBe("stale");
    // Ctrl+Z — the canvas is exactly what the probe looked at, so its answer stands.
    act(() => { useStitchStore.setState({ tiles: before }); });
    expect(hook.status).toBe("offer");
    // …and it is a real offer, not a label: running it now commits.
    await act(async () => { await hook.run(); });
    expect(commitAutoAlign).toHaveBeenCalledTimes(1);
  });

  it("cancel asks the commit to stop and leaves the offer standing", async () => {
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    act(() => workers[0].reply(goodProbe(posted.at(-1)!.docId, [0, 1])));
    let shouldAbort: (() => boolean) | undefined;
    commitAutoAlign.mockImplementationOnce(async (input?: unknown) => {
      shouldAbort = (input as { shouldAbort: () => boolean }).shouldAbort;
      throw new (await import("./autostitch/autoStitch")).AutoStitchAborted();
    });
    const running = act(async () => { await hook.run(); });
    act(() => hook.cancelRun());
    await running;
    expect(shouldAbort!()).toBe(true);
    expect(hook.status).toBe("offer");
  });

  it("reset drops the offer and makes any reply in flight stale", () => {
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    const docId = posted.at(-1)!.docId;
    act(() => hook.reset());
    expect(hook.status).toBe("idle");
    act(() => workers[0].reply(goodProbe(docId, [0, 1])));
    expect(hook.status).toBe("idle");
  });

  it("terminates the worker on unmount", () => {
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    act(() => root.unmount());
    expect(workers[0].terminated).toBe(true);
    // re-create so afterEach's unmount is a no-op
    root = createRoot(container);
  });
});

describe("useEarnedAutoAlign — probe time budget", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("gives up after the budget: aborts once, reports unavailable/too_slow, logs it", () => {
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    const docId = posted.at(-1)!.docId;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    act(() => vi.advanceTimersByTime(60_000));
    expect(posted.filter((p) => p.kind === "abort" && p.docId === docId)).toHaveLength(1);
    expect(hook.status).toBe("unavailable");
    expect(hook.reason).toBe("too_slow");
    // The SHORT line: the budget expired with no reply, so nobody ever told us any of
    // the counts — not even the round-trip one. "?" says that; printing 0 would claim a
    // check that had been grinding through OCR for a minute made no OCR calls at all,
    // and padding the long format with NaNs is noise, not honesty.
    expect(info).toHaveBeenCalledWith(
      "[probe] %s: %d ms, %s OCR calls%s",
      "unavailable", expect.any(Number), "?", "",
    );
    info.mockRestore();

    // A reply that lands after the budget already gave up must not resurrect it.
    act(() => workers[0].reply(goodProbe(docId, [0, 1])));
    expect(hook.status).toBe("unavailable");
    expect(hook.reason).toBe("too_slow");
  });

  it("the budget expiring hands tesseract's workers back", () => {
    // Nothing else will: `stop()` bumps the docId, so the worker's eventual
    // {aborted:true} is dropped by the staleness guard BEFORE it reaches the reply
    // handler's shutdownOcr(), and 160-240 MB stayed held until unmount.
    seedCanvas([0, 1]);
    mount();
    shutdownOcr.mockClear();
    act(() => hook.check());
    expect(shutdownOcr).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(60_000));
    expect(hook.reason).toBe("too_slow");
    expect(shutdownOcr).toHaveBeenCalled();
  });

  it("reset() hands them back too, for the same reason", () => {
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    shutdownOcr.mockClear();
    act(() => hook.reset());
    expect(shutdownOcr).toHaveBeenCalled();
  });

  it("logs the count the worker reported, including on an aborted reply", () => {
    seedCanvas([0, 1]);
    mount();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    act(() => hook.check());
    act(() => workers[0].reply({ docId: posted.at(-1)!.docId, aborted: true, ocrCalls: 42 }));
    // An aborted probe threw, so there is no OcrStats behind it: the round-trip count
    // is real and the other four were never reported, so the short line prints the one
    // number that exists and says nothing about the four that do not.
    expect(info).toHaveBeenCalledWith(
      "[probe] %s: %d ms, %s OCR calls%s",
      "aborted", expect.any(Number), "42", "",
    );
    info.mockRestore();
  });

  it("does not fire the budget once the worker settles first", () => {
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    act(() => workers[0].reply(goodProbe(posted.at(-1)!.docId, [0, 1])));
    expect(hook.status).toBe("offer");
    const abortsBefore = posted.filter((p) => p.kind === "abort").length;
    act(() => vi.advanceTimersByTime(60_000));
    // No extra abort was sent, and the settled offer was left alone.
    expect(posted.filter((p) => p.kind === "abort")).toHaveLength(abortsBefore);
    expect(hook.status).toBe("offer");
  });

  it("Re-check after the budget fires runs a fresh check on a 3x leash", () => {
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    act(() => vi.advanceTimersByTime(60_000));
    expect(hook.status).toBe("unavailable");
    expect(hook.reason).toBe("too_slow");

    act(() => hook.recheck());
    expect(hook.status).toBe("checking");
    const abortsAfterRecheck = posted.filter((p) => p.kind === "abort").length;
    // Waiting out a NORMAL budget's worth of time does not touch the Re-check.
    act(() => vi.advanceTimersByTime(60_000));
    expect(hook.status).toBe("checking");
    expect(posted.filter((p) => p.kind === "abort")).toHaveLength(abortsAfterRecheck);

    // It still settles normally, on its own schedule.
    act(() => workers.at(-1)!.reply(goodProbe(posted.at(-1)!.docId, [0, 1])));
    expect(hook.status).toBe("offer");
  });

  it("…but the Re-check is bounded too: it gives up at 3x, not never", () => {
    seedCanvas([0, 1]);
    mount();
    act(() => hook.recheck());
    act(() => vi.advanceTimersByTime(120_000));
    expect(hook.status).toBe("checking");   // still inside the longer leash
    act(() => vi.advanceTimersByTime(60_001));
    expect(hook.status).toBe("unavailable");
    expect(hook.reason).toBe("too_slow");
  });

  it("a superseded check (new docId) clears the old budget — no stray abort or state write", () => {
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    const first = posted.at(-1)!.docId;
    act(() => hook.check()); // supersedes before the first budget could fire
    const second = posted.at(-1)!.docId;
    expect(second).not.toBe(first);
    const abortsSoFar = posted.filter((p) => p.kind === "abort").length; // the supersede's own abort
    act(() => vi.advanceTimersByTime(60_000));
    // The first check's budget never fires a SECOND abort for it.
    expect(posted.filter((p) => p.kind === "abort" && p.docId === first)).toHaveLength(1);
    expect(posted.filter((p) => p.kind === "abort")).toHaveLength(abortsSoFar + 1); // only the second check's own budget
    expect(hook.status).toBe("unavailable");
    expect(hook.reason).toBe("too_slow");
  });

  it("clears the timer on unmount — the pending budget is actually cancelled", () => {
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    act(() => root.unmount());
    // Not just guarded by goneRef — the timeout itself is gone.
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });
});

/**
 * NEVER A VERDICT ON UNKNOWN EVIDENCE.
 *
 * `ocrStats.unknown > 0` means the aligner answered without a read it asked for twice.
 * Those reads are the whole reason two probes of the SAME four sheets disagreed, so a
 * reply carrying one is not shown: the hook re-runs the check ONCE, and if the second
 * run has a hole too it says the check took too long rather than pick a side.
 */
describe("useEarnedAutoAlign — unknown OCR reads", () => {
  const LINE = "[probe] %s: %d ms, %d OCR calls, %d non-answers, %d retries, %d unknown, %d withheld%s";
  /** Probe REQUESTS only — `posted` also carries every `{kind:"abort"}`. */
  const requests = () => posted.filter((p) => !p.kind);
  const holed = (docId: number, pages: number[]) => ({ ...goodProbe(docId, pages), ocrStats: holedStats() });
  const clean = (docId: number, pages: number[]) => ({ ...goodProbe(docId, pages), ocrStats: CLEAN_STATS });

  it("a clean reply is shown at once — no second probe", () => {
    seedCanvas([0, 1]);
    mount();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    act(() => hook.check());
    act(() => workers[0].reply(clean(posted.at(-1)!.docId, [0, 1])));
    expect(hook.status).toBe("offer");
    expect(requests()).toHaveLength(1);
    expect(info).toHaveBeenCalledWith(LINE, "offer", expect.any(Number), 12, 0, 0, 0, 0, "");
    info.mockRestore();
  });

  it("a reply with an unknown read is never shown — one silent re-check, then the answer", () => {
    seedCanvas([0, 1]);
    mount();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    act(() => hook.check());
    const first = posted.at(-1)!.docId;

    // The reply that would have been an OFFER. It is thrown away instead.
    act(() => workers[0].reply(holed(first, [0, 1])));
    expect(hook.status).toBe("checking");          // no flicker: still checking
    expect(hook.sheets).toBe(0);
    expect(hook.reason).toBeUndefined();
    expect(requests()).toHaveLength(2);            // …because a second probe went out
    expect(requests().at(-1)!.docId).not.toBe(first);
    expect(info).toHaveBeenCalledWith(LINE, "re-checking", expect.any(Number), 12, 2, 1, 1, 0, "");
    // Nothing to run on while the re-check is in flight.
    void hook.run();
    expect(commitAutoAlign).not.toHaveBeenCalled();

    // The re-check comes back whole, and THAT is what the user is shown.
    act(() => workers.at(-1)!.reply(clean(requests().at(-1)!.docId, [0, 1])));
    expect(hook.status).toBe("offer");
    expect(hook.sheets).toBe(2);
    expect(info).toHaveBeenCalledWith(LINE, "offer", expect.any(Number), 12, 0, 0, 0, 0, " (auto re-check)");
    info.mockRestore();
  });

  it("unknown twice: the honest 'took too long', with Re-check still offered", () => {
    seedCanvas([0, 1]);
    mount();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    act(() => hook.check());
    act(() => workers[0].reply(holed(posted.at(-1)!.docId, [0, 1])));
    act(() => workers.at(-1)!.reply(holed(requests().at(-1)!.docId, [0, 1])));

    expect(hook.status).toBe("unavailable");
    expect(hook.reason).toBe("too_slow");
    expect(hook.sheets).toBe(0);
    // The EXISTING copy, and the one unavailable reason TakeoffModeStrip keeps a
    // Re-check button on — which is the right next step for a hole in the evidence.
    expect(autoAlignUnavailableNote(hook.reason!))
      .toBe("Auto-align isn't available for these sheets — the check took too long");
    expect(info).toHaveBeenCalledWith(LINE, "unavailable", expect.any(Number), 12, 2, 1, 1, 0, " (auto re-check)");
    // ONE re-check, not a loop.
    expect(requests()).toHaveLength(2);
    info.mockRestore();
  });

  it("an offer is not taken from a probe whose evidence had a hole", () => {
    // The failure this guards: adopting the discarded reply as `probeRef` would let the
    // user commit placements the hook had just refused to stand behind.
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    act(() => workers[0].reply(holed(posted.at(-1)!.docId, [0, 1])));
    act(() => workers.at(-1)!.reply(holed(requests().at(-1)!.docId, [0, 1])));
    void hook.run();
    expect(commitAutoAlign).not.toHaveBeenCalled();
    expect(hook.status).toBe("unavailable");
  });

  it("a fresh user check re-arms the one automatic re-check", () => {
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    act(() => workers[0].reply(holed(posted.at(-1)!.docId, [0, 1])));
    act(() => workers.at(-1)!.reply(holed(requests().at(-1)!.docId, [0, 1])));
    expect(requests()).toHaveLength(2);

    // The user asks again (the Re-check the strip offers). That check is entitled to
    // its own automatic re-check — the latch belongs to a check, not to the session.
    act(() => hook.recheck());
    expect(requests()).toHaveLength(3);
    act(() => workers.at(-1)!.reply(holed(requests().at(-1)!.docId, [0, 1])));
    expect(hook.status).toBe("checking");
    expect(requests()).toHaveLength(4);
    act(() => workers.at(-1)!.reply(clean(requests().at(-1)!.docId, [0, 1])));
    expect(hook.status).toBe("offer");
  });

  it("the automatic re-check keeps the OCR pool — it is about to read with it", () => {
    // Handing tesseract back between the discarded reply and the re-check made the
    // re-check pay a full pool boot and briefly held two pools' worth of memory.
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    shutdownOcr.mockClear();
    act(() => workers[0].reply(holed(posted.at(-1)!.docId, [0, 1])));
    expect(hook.status).toBe("checking");
    expect(shutdownOcr).not.toHaveBeenCalled();
    // …and the re-check's own settle releases it, exactly like any other settle.
    act(() => workers.at(-1)!.reply(clean(requests().at(-1)!.docId, [0, 1])));
    expect(shutdownOcr).toHaveBeenCalled();
  });

  it("reset() during the automatic re-check stops it dead — no third probe", () => {
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    act(() => workers[0].reply(holed(posted.at(-1)!.docId, [0, 1])));
    expect(requests()).toHaveLength(2);

    const inFlight = requests().at(-1)!.docId;
    act(() => hook.reset());
    expect(hook.status).toBe("idle");
    // The abandoned re-check's own reply is stale and writes nothing…
    act(() => workers.at(-1)!.reply(clean(inFlight, [0, 1])));
    expect(hook.status).toBe("idle");
    // …and nothing re-armed itself: no third request ever went out.
    expect(requests()).toHaveLength(2);
    // The pool is handed back by reset(), not left held by the skipped release above.
    expect(shutdownOcr).toHaveBeenCalled();
  });

  it("a user check AFTER a reset still gets its own single automatic re-check", () => {
    // The latch belongs to a check, not to the session — and a reset in the middle of
    // one must not leave it stuck in either position.
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    act(() => workers[0].reply(holed(posted.at(-1)!.docId, [0, 1])));
    act(() => hook.reset());

    act(() => hook.check());
    expect(requests()).toHaveLength(3);
    act(() => workers.at(-1)!.reply(holed(requests().at(-1)!.docId, [0, 1])));
    expect(hook.status).toBe("checking");
    expect(requests()).toHaveLength(4);          // its one re-check, granted afresh
    act(() => workers.at(-1)!.reply(holed(requests().at(-1)!.docId, [0, 1])));
    expect(hook.status).toBe("unavailable");
    expect(hook.reason).toBe("too_slow");
    expect(requests()).toHaveLength(4);          // and no more than one
  });

  it("a reply with no ocrStats at all behaves exactly as before — shown, not re-checked", () => {
    // Absent is "nobody told us", and the old behaviour (show what came back) is the
    // safe reading of it. `undefined > 0` is false, which is what makes that so.
    seedCanvas([0, 1]);
    mount();
    act(() => hook.check());
    act(() => workers[0].reply(goodProbe(posted.at(-1)!.docId, [0, 1])));
    expect(hook.status).toBe("offer");
    expect(requests()).toHaveLength(1);
  });

  describe("its budget", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("the automatic re-check runs on a FRESH normal budget", () => {
      // Not the Re-check leash: this is not the user asking again, it is the hook
      // declining to answer, so it stays inside the same "never grinds" promise.
      seedCanvas([0, 1]);
      mount();
      act(() => hook.check());
      act(() => vi.advanceTimersByTime(59_000));    // the FIRST check's budget, nearly up
      act(() => workers[0].reply(holed(posted.at(-1)!.docId, [0, 1])));
      expect(hook.status).toBe("checking");

      // The first check's remaining 1s does not end the re-check…
      act(() => vi.advanceTimersByTime(59_999));
      expect(hook.status).toBe("checking");
      // …but 60s from ITS OWN start does.
      act(() => vi.advanceTimersByTime(2));
      expect(hook.status).toBe("unavailable");
      expect(hook.reason).toBe("too_slow");
    });
  });
});

/**
 * THE SERVER VERDICT.
 *
 * CTO's droplet probes the combined PDF the moment it is built, so by the time the
 * editor opens the answer is usually already sitting on the row. These are the rules
 * that decide whether that answer is allowed to stand in for the minute of OCR the
 * worker would otherwise spend — and every one of them fails towards the worker, never
 * towards a verdict the editor cannot bind to what is on the canvas.
 */
describe("useEarnedAutoAlign — the server verdict", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  /** The plan the verdict was computed for. Hashed verbatim — key order included. */
  const PLAN = {
    version: 1,
    mode: "auto",
    entries: [
      { kind: "takeoff", pageUuid: "u-1", scaleFeetPerInch: 20, label: "C5.00 GRADING" },
      { kind: "takeoff", pageUuid: "u-2", scaleFeetPerInch: 20, label: "C5.01 GRADING" },
    ],
  };
  const PROBE_URL = "https://cto.example/api/nanodoc/probe?token=t";

  /** A stored row that answers exactly what `seedCanvas([0, 1])` puts on the canvas. */
  async function storedOk(over: Record<string, unknown> = {}) {
    return {
      v: 1,
      engine: ENGINE_VERSION,
      status: "ok",
      planHash: await planHashHex(PLAN),
      request: { pageIndices: [0, 1], userScale: 20, pageScales: [[0, 20], [1, 20]], pageCodes: [] },
      result: goodProbe(0, [0, 1]),
      ocrStats: CLEAN_STATS,
      ms: 41_000,
      computedAt: new Date().toISOString(),
      ...over,
    };
  }

  /** A row whose Lambda is still running, good for the full pending TTL. */
  async function storedPending(over: Record<string, unknown> = {}) {
    const now = Date.now();
    return {
      v: 1,
      status: "pending",
      startedAt: new Date(now).toISOString(),
      ttlMs: 720_000,
      expiresAt: new Date(now + 720_000).toISOString(),
      planHash: await planHashHex(PLAN),
      ...over,
    };
  }

  /** Browser probes that were actually posted to a worker (aborts excluded). */
  const browserProbes = () => posted.filter((p) => !p.kind);

  /** Start a check and let its asynchronous half run to its first real decision —
   *  the plan hash resolves on the event loop, which `vi.advanceTimersByTime` cannot
   *  turn (see `realSetTimeout`). */
  async function checkWith(ctx: Parameters<typeof hook.check>[0]) {
    await act(async () => {
      hook.check(ctx);
      await new Promise<void>((r) => realSetTimeout(r, 0));
    });
  }

  it("takes a verdict for exactly this page set — offer, no worker, '(server)' on the line", async () => {
    seedCanvas([0, 1]);
    mount();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const probe = await storedOk();
    await checkWith({ serverProbe: probe, plan: PLAN, probeUrl: PROBE_URL });

    expect(hook.status).toBe("offer");
    expect(hook.sheets).toBe(2);
    // The whole point: the worker was never even constructed.
    expect(workers).toHaveLength(0);
    expect(browserProbes()).toHaveLength(0);
    expect(info).toHaveBeenCalledWith(
      "[probe] %s: %d ms, %d OCR calls, %d non-answers, %d retries, %d unknown, %d withheld%s",
      "offer", expect.any(Number), CLEAN_STATS.calls, 0, 0, 0, 0, " (server)",
    );
    info.mockRestore();
  });

  it("commits the SERVER's placements, so the solver never runs twice", async () => {
    seedCanvas([0, 1]);
    mount();
    const probe = await storedOk();
    await checkWith({ serverProbe: probe, plan: PLAN });
    expect(hook.status).toBe("offer");
    await act(async () => { await hook.run(); });
    const input = commitAutoAlign.mock.calls.at(-1)![0] as { cached?: { placements?: unknown[] } };
    expect(input.cached?.placements).toEqual(probe.result.placements);
  });

  it("discards a verdict from a different engine build", async () => {
    seedCanvas([0, 1]);
    mount();
    const probe = await storedOk({ engine: "0ffbeef" });
    await checkWith({ serverProbe: probe, plan: PLAN, probeUrl: PROBE_URL });

    expect(hook.status).toBe("checking");
    expect(browserProbes()).toHaveLength(1);
    act(() => workers[0].reply(goodProbe(posted.at(-1)!.docId, [0, 1])));
    expect(hook.status).toBe("offer");
  });

  it("discards a verdict computed for a different plan", async () => {
    seedCanvas([0, 1]);
    mount();
    const probe = await storedOk({ planHash: "0".repeat(64) });
    await checkWith({ serverProbe: probe, plan: PLAN, probeUrl: PROBE_URL });
    expect(browserProbes()).toHaveLength(1);
  });

  it("discards a verdict computed for a different page set", async () => {
    seedCanvas([0, 1]);
    mount();
    // Same plan, same build — but the canvas reads 20 ft/in on both sheets and this
    // verdict was computed with the second at 40.
    const probe = await storedOk({
      request: { pageIndices: [0, 1], userScale: null, pageScales: [[0, 20], [1, 40]], pageCodes: [] },
    });
    await checkWith({ serverProbe: probe, plan: PLAN, probeUrl: PROBE_URL });
    expect(browserProbes()).toHaveLength(1);
  });

  it("discards a status that is not a verdict — an evidence hole is not an answer", async () => {
    seedCanvas([0, 1]);
    mount();
    const probe = await storedOk({ status: "unknown" });
    await checkWith({ serverProbe: probe, plan: PLAN, probeUrl: PROBE_URL });
    expect(browserProbes()).toHaveLength(1);
  });

  it("runs the browser probe when there is no stored verdict at all", async () => {
    seedCanvas([0, 1]);
    mount();
    await checkWith({ serverProbe: null, plan: PLAN, probeUrl: PROBE_URL });
    expect(browserProbes()).toHaveLength(1);
  });

  it("starts the browser probe IMMEDIATELY when the verdict is still being computed", async () => {
    seedCanvas([0, 1]);
    mount();
    const pending = await storedPending();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ probe: pending }) }));
    vi.stubGlobal("fetch", fetchMock);

    await checkWith({ serverProbe: pending, plan: PLAN, probeUrl: PROBE_URL });
    // THE POINT OF THE RACE. CTO kicks the probe as it combines and opens the editor a
    // second later; the Lambda takes 40-140 s cold. A check that waited would wait for
    // nothing, so the worker goes out now and the poll runs beside it.
    expect(browserProbes()).toHaveLength(1);
    expect(hook.status).toBe("checking");
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenLastCalledWith(PROBE_URL, { signal: expect.any(AbortSignal) });
    // The poll adds no probes of its own.
    expect(browserProbes()).toHaveLength(1);
  });

  it("stops polling at the browser budget plus the grace window", async () => {
    seedCanvas([0, 1]);
    mount();
    const pending = await storedPending();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ probe: pending }) }));
    vi.stubGlobal("fetch", fetchMock);

    await checkWith({ serverProbe: pending, plan: PLAN, probeUrl: PROBE_URL });
    // 60 s budget + 20 s grace. Past that the Lambda has had its chance.
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    const settled = fetchMock.mock.calls.length;
    expect(settled).toBeGreaterThan(30);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(settled);
  });

  it("a verdict that lands while the browser probe is still checking PRE-EMPTS it", async () => {
    seedCanvas([0, 1]);
    mount();
    let answer: unknown = await storedPending();
    const finished = await storedOk();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ probe: answer }) })));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await checkWith({ serverProbe: answer, plan: PLAN, probeUrl: PROBE_URL });
    const workerDocId = posted.at(-1)!.docId;
    expect(browserProbes()).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(28_000); });
    expect(hook.status).toBe("checking");

    // The Lambda finishes at ~30 s, well inside the browser probe's 60 s budget.
    answer = finished;
    shutdownOcr.mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(hook.status).toBe("offer");
    expect(hook.sheets).toBe(2);
    // The worker was aborted through the ordinary path, and tesseract handed back.
    expect(posted.some((p) => p.kind === "abort" && p.docId === workerDocId)).toBe(true);
    expect(shutdownOcr).toHaveBeenCalled();
    // ONE settle line, and it says where the answer came from.
    expect(info.mock.calls.filter((c) => c.at(-1) === " (server)")).toHaveLength(1);
    info.mockRestore();
  });

  it("a verdict that arrives after the browser probe settled is ignored — no flicker", async () => {
    seedCanvas([0, 1]);
    mount();
    let answer: unknown = await storedPending();
    const finished = await storedOk();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ probe: answer }) })));

    await checkWith({ serverProbe: answer, plan: PLAN, probeUrl: PROBE_URL });
    // The browser gets there first and says these sheets cannot be aligned.
    act(() => workers[0].reply({
      ...goodProbe(posted.at(-1)!.docId, [0, 1]),
      method: "none",
      refPageIndices: [],
      ocrStats: CLEAN_STATS,
    }));
    expect(hook.status).toBe("unavailable");

    answer = finished;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    // A real answer is on screen. Replacing it a minute later is a flicker.
    expect(hook.status).toBe("unavailable");
  });

  it("a verdict inside the grace window REPLACES a browser probe that ran out of time", async () => {
    seedCanvas([0, 1]);
    mount();
    let answer: unknown = await storedPending();
    const finished = await storedOk();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ probe: answer }) })));

    await checkWith({ serverProbe: answer, plan: PLAN, probeUrl: PROBE_URL });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(hook.status).toBe("unavailable");
    expect(hook.reason).toBe("too_slow");

    // "The check took too long" is the absence of an answer, not one.
    answer = finished;
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(hook.status).toBe("offer");
    expect(hook.reason).toBeUndefined();
  });

  it("keeps polling a pending row whose job died — the droplet may still rescue it", async () => {
    seedCanvas([0, 1]);
    mount();
    const now = Date.now();
    const dead = await storedPending({
      startedAt: new Date(now - 800_000).toISOString(),
      expiresAt: new Date(now - 80_000).toISOString(),
    });
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ probe: dead }) }));
    vi.stubGlobal("fetch", fetchMock);

    await checkWith({ serverProbe: dead, plan: PLAN, probeUrl: PROBE_URL });
    expect(browserProbes()).toHaveLength(1);
    // An expired claim is a job that fell over, not a final answer: the droplet's own
    // claim predicate lets a later request take the row, so the read can still change.
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops polling at once for a pending probe that names somebody else's plan", async () => {
    seedCanvas([0, 1]);
    mount();
    const pending = await storedPending({ planHash: "f".repeat(64) });
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ probe: pending }) }));
    vi.stubGlobal("fetch", fetchMock);

    await checkWith({ serverProbe: pending, plan: PLAN, probeUrl: PROBE_URL });
    expect(browserProbes()).toHaveLength(1);
    // Every later read returns the same row for the same other plan. Polling it for
    // eighty seconds is pure cost.
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives every poll its own deadline, so one hung read cannot park the check", async () => {
    seedCanvas([0, 1]);
    mount();
    const pending = await storedPending();
    const fetchMock = vi.fn(async (_url: string, _init?: { signal?: AbortSignal }) => ({
      ok: true,
      json: async () => ({ probe: pending }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await checkWith({ serverProbe: pending, plan: PLAN, probeUrl: PROBE_URL });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    // The 20 s window is compared BETWEEN reads, so it only advances when one comes
    // back: without a per-read deadline a socket that never answers leaves the hook in
    // "checking" forever with no probe running.
    const init = fetchMock.mock.calls[0][1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init!.signal!.aborted).toBe(false);
  });

  it("a tile dragged while the verdict resolved still becomes the offer — run() owns stale", async () => {
    seedCanvas([0, 1]);
    mount();
    const pending = await storedPending();
    const finished = await storedOk();
    vi.stubGlobal("fetch", vi.fn(async () => {
      // The user nudges a sheet while the Lambda is still finishing.
      const tiles = useStitchStore.getState().tiles;
      useStitchStore.setState({ tiles: tiles.map((t, i) => (i === 0 ? { ...t, x: t.x + 40 } : t)) });
      return { ok: true, json: async () => ({ probe: finished }) };
    }));

    await checkWith({ serverProbe: pending, plan: PLAN, probeUrl: PROBE_URL });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    // Re-probing here would spend the minute this path exists to save and land on the
    // identical stale offer. The offer stands; taking it is what discovers the drag.
    expect(hook.status).toBe("offer");
    expect(browserProbes()).toHaveLength(1); // the one that started with the check
    await act(async () => { await hook.run(); });
    expect(hook.status).toBe("stale");
    expect(commitAutoAlign).not.toHaveBeenCalled();
  });

  it("an unmount during the poll writes nothing and reads nothing more", async () => {
    seedCanvas([0, 1]);
    mount();
    const pending = await storedPending();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ probe: pending }) }));
    vi.stubGlobal("fetch", fetchMock);

    await checkWith({ serverProbe: pending, plan: PLAN, probeUrl: PROBE_URL });
    act(() => root.unmount());
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(browserProbes()).toHaveLength(1); // the one from the check, and no more
    root = createRoot(container); // so afterEach's unmount is a no-op
  });

  it("reset() ends the race as well as the probe", async () => {
    seedCanvas([0, 1]);
    mount();
    const pending = await storedPending();
    const finished = await storedOk();
    let answer: unknown = pending;
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ probe: answer }) }));
    vi.stubGlobal("fetch", fetchMock);

    await checkWith({ serverProbe: pending, plan: PLAN, probeUrl: PROBE_URL });
    act(() => hook.reset());
    expect(hook.status).toBe("idle");

    // Even a verdict that would otherwise have been used must not resurrect the offer:
    // the canvas the check described is gone.
    answer = finished;
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(hook.status).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Re-check supersedes the race — one new probe, and the old poll goes quiet", async () => {
    seedCanvas([0, 1]);
    mount();
    const pending = await storedPending();
    const finished = await storedOk();
    let answer: unknown = pending;
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ probe: answer }) }));
    vi.stubGlobal("fetch", fetchMock);

    await checkWith({ serverProbe: pending, plan: PLAN, probeUrl: PROBE_URL });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    const readsBefore = fetchMock.mock.calls.length;
    expect(readsBefore).toBeGreaterThan(0);

    act(() => hook.recheck());
    expect(browserProbes()).toHaveLength(2);

    // The abandoned poll neither reads again nor pre-empts the Re-check the user asked
    // for — a Re-check answered from the row would make the button a no-op.
    answer = finished;
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(fetchMock).toHaveBeenCalledTimes(readsBefore);
    expect(browserProbes()).toHaveLength(2);
    expect(hook.status).not.toBe("offer");
  });

  it("names the OCR batch width on every browser probe, so both probes read alike", async () => {
    seedCanvas([0, 1]);
    mount();
    await act(async () => { hook.check(); });
    expect((posted.at(-1) as { ocrConcurrency?: number }).ocrConcurrency).toBe(3);
  });
});
