import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RawImage } from "./ocrService";

/**
 * ocrService now runs the tesseract scheduler on the MAIN thread (nested workers
 * aren't portable to WKWebView/WebKitGTK) and offloads only the raster→Blob
 * conversion to ocr.worker.ts. Tests therefore mock BOTH:
 *   - tesseract.js (via vi.mock) — a fake scheduler whose addJob behaviour is
 *     swappable per test through the hoisted `h.addJob`.
 *   - `Worker` (the conversion worker) — a controllable FakeWorker.
 * OffscreenCanvas is stubbed so the conversion-worker path is taken; one test
 * removes it to prove the main-thread fallback path is used instead.
 * Module state (lazy scheduler/worker singletons, id seq, pending/forward maps)
 * is reset per test via vi.resetModules().
 */

const h = vi.hoisted(() => ({
  // Default: succeed, echoing the blob's tag as the recognized word so tests can
  // trace which request produced which words.
  addJob: async (_cmd: string, blob: any): Promise<any> => ({
    data: { words: [{ text: blob?.__tag ?? "ok", confidence: 90, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }] },
  }),
  // Every scheduler createScheduler() hands out, in creation order, so tests
  // can assert how many schedulers were spun up and whether each was terminated.
  schedulersCreated: [] as { terminateCalls: number }[],
}));

vi.mock("tesseract.js", () => ({
  createScheduler: () => {
    const record = { terminateCalls: 0 };
    h.schedulersCreated.push(record);
    return {
      addWorker: () => {},
      addJob: (cmd: string, blob: any) => h.addJob(cmd, blob),
      terminate: async () => { record.terminateCalls++; },
    };
  },
  createWorker: async () => ({ setParameters: async () => {}, terminate: async () => {} }),
  PSM: { SPARSE_TEXT: 10 },
}));

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: { data: any }) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  listeners: ((e: { data: any }) => void)[] = [];
  posted: any[] = [];
  terminated = false;
  constructor(public url: unknown, public opts?: unknown) { FakeWorker.instances.push(this); }
  postMessage(data: any, _transfer?: unknown) { this.posted.push(data); }
  addEventListener(type: string, cb: (e: { data: any }) => void) { if (type === "message") this.listeners.push(cb); }
  terminate() { this.terminated = true; }
  /** Dispatch a message to whichever handler this worker uses (onmessage or listeners). */
  emit(data: any) {
    this.onmessage?.({ data });
    for (const l of this.listeners) l({ data });
  }
}

const IMG = (): RawImage => ({ width: 2, height: 2, data: new Uint8ClampedArray(2 * 2 * 4) });
const fakeBlob = (tag: string) => ({ __tag: tag }) as unknown as Blob;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  FakeWorker.instances.length = 0;
  (globalThis as any).Worker = FakeWorker;
  (globalThis as any).OffscreenCanvas = class {}; // present ⇒ conversion-worker path
  h.addJob = async (_cmd: string, blob: any) => ({
    data: { words: [{ text: blob?.__tag ?? "ok", confidence: 90, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }] },
  });
  h.schedulersCreated.length = 0;
  vi.resetModules();
});

describe("ocrService.recognize (main-thread tesseract + conversion worker)", () => {
  it("converts in the worker then resolves the scheduler's words", async () => {
    const { recognize } = await import("./ocrService");
    const p = recognize(IMG());
    // The conversion worker was spawned and received the raster.
    const conv = FakeWorker.instances[0];
    expect(conv).toBeTruthy();
    expect(conv.posted[0]).toHaveProperty("ocrId");
    // Reply with a tagged blob; the mocked scheduler echoes the tag as a word.
    conv.emit({ ocrId: conv.posted[0].ocrId, blob: fakeBlob("SEE SHEET 9") });
    await expect(p).resolves.toEqual([
      { text: "SEE SHEET 9", confidence: 90, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } },
    ]);
  });

  it("resolves [] when the conversion worker reports failure", async () => {
    const { recognize } = await import("./ocrService");
    const p = recognize(IMG());
    const conv = FakeWorker.instances[0];
    conv.emit({ ocrId: conv.posted[0].ocrId, error: "no OffscreenCanvas ctx" });
    await expect(p).resolves.toEqual([]);
  });

  it("resolves [] when the tesseract scheduler fails", async () => {
    h.addJob = async () => { throw new Error("recognize blew up"); };
    const { recognize } = await import("./ocrService");
    const p = recognize(IMG());
    const conv = FakeWorker.instances[0];
    conv.emit({ ocrId: conv.posted[0].ocrId, blob: fakeBlob("x") });
    await expect(p).resolves.toEqual([]);
  });

  it("resolves [] and recycles the scheduler when a recognize job hangs (timeout)", async () => {
    const { recognize, __setOcrJobTimeoutMsForTest } = await import("./ocrService");
    __setOcrJobTimeoutMsForTest(20); // shortened-for-test; never resolves for real.
    h.addJob = () => new Promise(() => { /* hang forever */ });

    const p = recognize(IMG());
    const conv = FakeWorker.instances[0];
    conv.emit({ ocrId: conv.posted[0].ocrId, blob: fakeBlob("hang") });

    await expect(p).resolves.toEqual([]);
    // Recycled: the hung scheduler was terminated and the singleton cleared.
    expect(h.schedulersCreated.length).toBe(1);
    expect(h.schedulersCreated[0].terminateCalls).toBe(1);

    // The next call must build a brand-new scheduler (singleton was reset).
    // The conversion worker is a separate singleton that never hung, so it's
    // reused (same FakeWorker instance) — its 2nd queued postMessage is this call.
    h.addJob = async (_cmd: string, blob: any) => ({
      data: { words: [{ text: blob?.__tag ?? "ok", confidence: 90, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }] },
    });
    const p2 = recognize(IMG());
    const conv2 = FakeWorker.instances[0];
    conv2.emit({ ocrId: conv2.posted[1].ocrId, blob: fakeBlob("fresh") });
    await expect(p2).resolves.toEqual([
      { text: "fresh", confidence: 90, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } },
    ]);
    expect(h.schedulersCreated.length).toBe(2);
  });

  it("identity guard: a stale timeout does not terminate a newer scheduler", async () => {
    vi.useFakeTimers();
    try {
      const { recognize, __setOcrJobTimeoutMsForTest } = await import("./ocrService");
      h.addJob = () => new Promise(() => { /* every job in this test hangs */ });

      // The conversion worker is a separate, never-hung singleton — every call
      // reuses the SAME FakeWorker instance, one queued postMessage each.
      const conv = () => FakeWorker.instances[0];

      // Call A: long-lived timeout. It shares the ORIGINAL scheduler and will
      // still be pending when that scheduler gets recycled by someone else.
      __setOcrJobTimeoutMsForTest(100_000);
      const pA = recognize(IMG());
      await vi.advanceTimersByTimeAsync(0);
      conv().emit({ ocrId: conv().posted[0].ocrId, blob: fakeBlob("a") });
      await vi.advanceTimersByTimeAsync(0);

      // Call B: shares the same (not-yet-recycled) scheduler singleton, but
      // with a short timeout — it times out first and recycles scheduler #1.
      __setOcrJobTimeoutMsForTest(10);
      const pB = recognize(IMG());
      await vi.advanceTimersByTimeAsync(0);
      conv().emit({ ocrId: conv().posted[1].ocrId, blob: fakeBlob("b") });
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(10); // fire B's timeout
      await expect(pB).resolves.toEqual([]);
      expect(h.schedulersCreated.length).toBe(1);
      expect(h.schedulersCreated[0].terminateCalls).toBe(1); // recycled by B

      // Call C: ensureScheduler() now builds a fresh scheduler #2.
      __setOcrJobTimeoutMsForTest(100_000);
      const pC = recognize(IMG());
      await vi.advanceTimersByTimeAsync(0);
      conv().emit({ ocrId: conv().posted[2].ocrId, blob: fakeBlob("c") });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.schedulersCreated.length).toBe(2);

      // Fire A's stale 100s timeout (started long before B's recycle). A
      // captured scheduler #1's promise — by now the singleton points at
      // scheduler #2, so the identity guard must skip recycling entirely.
      await vi.advanceTimersByTimeAsync(100_000 - 10);
      await expect(pA).resolves.toEqual([]);
      expect(h.schedulersCreated[0].terminateCalls).toBe(1); // unchanged
      expect(h.schedulersCreated[1].terminateCalls).toBe(0); // #2 untouched

      void pC; // C's own (100s, still pending) hang is irrelevant to this assertion.
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the main thread (no conversion worker) when OffscreenCanvas is absent", async () => {
    delete (globalThis as any).OffscreenCanvas;
    const { recognize } = await import("./ocrService");
    // jsdom has no real 2d canvas, so the fallback conversion fails → []; the
    // point is that NO conversion worker was spawned (main-thread path taken).
    await expect(recognize(IMG())).resolves.toEqual([]);
    expect(FakeWorker.instances.length).toBe(0);
  });
});

describe("ocrService.attachOcrRpc (forwarding)", () => {
  it("preserves ocrId pairing when work completes out of order", async () => {
    const { attachOcrRpc } = await import("./ocrService");
    const probe = new FakeWorker("probe");
    attachOcrRpc(probe as unknown as Worker);

    // Two probe OCR requests with distinct probe-side ids. recognize() posts each
    // raster to the conversion worker synchronously, so posted[] order tracks 100,200.
    probe.emit({ kind: "ocr-req", ocrId: 100, image: IMG() });
    probe.emit({ kind: "ocr-req", ocrId: 200, image: IMG() });

    const conv = FakeWorker.instances.find((w) => w !== probe)!;
    expect(conv).toBeTruthy();
    const [c100, c200] = conv.posted; // conversion requests for probe 100 and 200
    expect(c100.ocrId).not.toBe(c200.ocrId);

    // Complete OUT OF ORDER: probe 200's conversion first, then 100's. The tagged
    // blob flows through the scheduler into the recognized word.
    conv.emit({ ocrId: c200.ocrId, blob: fakeBlob("b") });
    conv.emit({ ocrId: c100.ocrId, blob: fakeBlob("a") });
    await flush();

    const relays = probe.posted.filter((p) => p.kind === "ocr-res");
    expect(relays.length).toBe(2);
    const byId = new Map(relays.map((r) => [r.ocrId, r.words[0].text]));
    expect(byId.get(200)).toBe("b"); // completed first, still paired to 200
    expect(byId.get(100)).toBe("a");
  });

  it("relays [] to the probe when conversion fails", async () => {
    const { attachOcrRpc } = await import("./ocrService");
    const probe = new FakeWorker("probe");
    attachOcrRpc(probe as unknown as Worker);
    probe.emit({ kind: "ocr-req", ocrId: 42, image: IMG() });
    const conv = FakeWorker.instances.find((w) => w !== probe)!;
    conv.emit({ ocrId: conv.posted[0].ocrId, error: "boom" });
    await flush();
    const relay = probe.posted.find((p) => p.kind === "ocr-res");
    expect(relay).toEqual({ kind: "ocr-res", ocrId: 42, words: [] });
  });
});
