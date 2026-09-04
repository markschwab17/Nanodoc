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
import type { StitchTile } from "./stitchTypes";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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
