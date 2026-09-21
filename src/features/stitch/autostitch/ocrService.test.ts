import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { RawImage } from "./ocrService";

/**
 * ocrService runs tesseract on the MAIN thread (nested workers aren't portable
 * to WKWebView/WebKitGTK), queues jobs through the shared pool in ocrPool.ts,
 * and offloads only the raster→Blob conversion to ocr.worker.ts. Tests mock
 * BOTH:
 *   - tesseract.js (via vi.mock) — fake workers whose recognize() behaviour is
 *     swappable per test through the hoisted `h.recognize`, each recorded in
 *     `h.workers` so a test can see how many were built and which were killed.
 *   - `Worker` (the conversion worker) — a controllable FakeWorker.
 * OffscreenCanvas is stubbed so the conversion-worker path is taken; one test
 * removes it to prove the main-thread fallback path is used instead.
 * `navigator.hardwareConcurrency` is stubbed too, because it sizes the pool.
 * Module state (lazy pool/worker singletons, id seq, pending maps) is reset per
 * test via vi.resetModules().
 */

interface FakeTessWorker {
  terminateCalls: number;
  seen: string[];
  setParameters(p: unknown): Promise<void>;
  recognize(blob: any): Promise<any>;
  terminate(): Promise<void>;
}

const h = vi.hoisted(() => ({
  // Default: succeed, echoing the blob's tag as the recognized word so tests can
  // trace which request produced which words.
  recognize: async (blob: any): Promise<any> => ({
    data: { words: [{ text: blob?.__tag ?? "ok", confidence: 90, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }] },
  }),
  // Every worker createWorker() hands out, in creation order.
  workers: [] as FakeTessWorker[],
}));

vi.mock("tesseract.js", () => ({
  createWorker: async () => {
    const w: FakeTessWorker = {
      terminateCalls: 0,
      seen: [],
      setParameters: async () => {},
      recognize: (blob: any) => { w.seen.push(blob?.__tag); return h.recognize(blob); },
      terminate: async () => { w.terminateCalls++; },
    };
    h.workers.push(w);
    return w;
  },
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
const WORD = (text: string) => ({ text, confidence: 90, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } });
/** Pool size is clamp(hardwareConcurrency - 1, 2, 3), so cores ⇒ workers. */
const setCores = (n: number) =>
  Object.defineProperty(globalThis.navigator, "hardwareConcurrency", { value: n, configurable: true });
/** Answer the conversion worker's Nth (0-based) request with a tagged blob. */
const convReply = (n: number, tag: string) => {
  const conv = FakeWorker.instances[0];
  conv.emit({ ocrId: conv.posted[n].ocrId, blob: fakeBlob(tag) });
};

beforeEach(() => {
  FakeWorker.instances.length = 0;
  (globalThis as any).Worker = FakeWorker;
  (globalThis as any).OffscreenCanvas = class {}; // present ⇒ conversion-worker path
  setCores(3); // ⇒ a 2-worker pool unless a test says otherwise
  h.recognize = async (blob: any) => ({ data: { words: [WORD(blob?.__tag ?? "ok")] } });
  h.workers.length = 0;
  vi.resetModules();
});

afterEach(() => { vi.useRealTimers(); });

describe("ocrService.recognize (main-thread tesseract + conversion worker)", () => {
  it("converts in the worker then resolves the pool's words", async () => {
    const { recognize } = await import("./ocrService");
    const p = recognize(IMG());
    // The conversion worker was spawned and received the raster.
    const conv = FakeWorker.instances[0];
    expect(conv).toBeTruthy();
    expect(conv.posted[0]).toHaveProperty("ocrId");
    // Reply with a tagged blob; the mocked tesseract worker echoes the tag.
    convReply(0, "SEE SHEET 9");
    await expect(p).resolves.toEqual([WORD("SEE SHEET 9")]);
  });

  it("resolves [] when the conversion worker reports failure", async () => {
    const { recognize } = await import("./ocrService");
    const p = recognize(IMG());
    const conv = FakeWorker.instances[0];
    conv.emit({ ocrId: conv.posted[0].ocrId, error: "no OffscreenCanvas ctx" });
    await expect(p).resolves.toEqual([]);
  });

  it("resolves [] when tesseract's recognize rejects", async () => {
    h.recognize = async () => { throw new Error("recognize blew up"); };
    const { recognize } = await import("./ocrService");
    const p = recognize(IMG());
    convReply(0, "x");
    await expect(p).resolves.toEqual([]);
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

describe("ocrService.recognize — pool concurrency", () => {
  it("runs concurrent calls on separate workers", async () => {
    const { recognize } = await import("./ocrService");
    const inflight: (() => void)[] = [];
    h.recognize = (blob: any) => new Promise((res) => { inflight.push(() => res({ data: { words: [WORD(blob.__tag)] } })); });

    const pA = recognize(IMG());
    const pB = recognize(IMG());
    convReply(0, "a");
    convReply(1, "b");
    await flush();

    // Both jobs are in flight at once — two workers, one job each.
    expect(h.workers.length).toBe(2);
    expect(inflight.length).toBe(2);
    expect(h.workers.map((w) => w.seen)).toEqual([["a"], ["b"]]);

    inflight[1]();
    inflight[0]();
    await expect(pA).resolves.toEqual([WORD("a")]);
    await expect(pB).resolves.toEqual([WORD("b")]);
  });

  it("sizes the pool from hardwareConcurrency, clamped to [2, 3]", async () => {
    setCores(16);
    const { recognize } = await import("./ocrService");
    h.recognize = () => new Promise(() => { /* hold every worker */ });

    const jobs = [recognize(IMG()), recognize(IMG()), recognize(IMG()), recognize(IMG()), recognize(IMG()), recognize(IMG())];
    for (let i = 0; i < 6; i++) convReply(i, `j${i}`);
    await flush();

    expect(h.workers.length).toBe(3); // clamped, not 15
    void jobs;
  });
});

describe("ocrService.recognize — per-job dispatch-time timeout", () => {
  it("resolves [] on a hang, retires only that worker, and the sibling still answers", async () => {
    vi.useFakeTimers();
    const { recognize, __setOcrJobTimeoutMsForTest } = await import("./ocrService");
    __setOcrJobTimeoutMsForTest(100);
    const settlers: Record<string, () => void> = {};
    h.recognize = (blob: any) => new Promise((res) => { settlers[blob.__tag] = () => res({ data: { words: [WORD(blob.__tag)] } }); });

    const pHang = recognize(IMG());
    const pOk = recognize(IMG());
    convReply(0, "hang");
    convReply(1, "ok");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.workers.length).toBe(2);

    settlers["ok"]();
    await expect(pOk).resolves.toEqual([WORD("ok")]);

    await vi.advanceTimersByTimeAsync(100);
    await expect(pHang).resolves.toEqual([]);
    expect(h.workers[0].terminateCalls).toBe(1); // the hung one
    expect(h.workers[1].terminateCalls).toBe(0); // its sibling, untouched

    // OCR still works afterwards — the survivor takes the next job.
    h.recognize = async (blob: any) => ({ data: { words: [WORD(blob.__tag)] } });
    const pNext = recognize(IMG());
    await vi.advanceTimersByTimeAsync(0);
    convReply(2, "fresh");
    await vi.advanceTimersByTimeAsync(0);
    await expect(pNext).resolves.toEqual([WORD("fresh")]);
  });

  it("a per-call timeoutMs overrides the pool's budget for that read alone", async () => {
    // The aligner names this for exactly one thing: the single re-read a lost read
    // earns. It must reach the POOL — a longer budget the pool never hears about is a
    // read that times out at the old one and a band that goes `unknown` for nothing.
    vi.useFakeTimers();
    const { recognize, __setOcrJobTimeoutMsForTest } = await import("./ocrService");
    __setOcrJobTimeoutMsForTest(100);
    h.recognize = () => new Promise(() => { /* hangs forever */ });

    let lostLong = false;
    const pLong = recognize(IMG(), { timeoutMs: 500, onNoResult: () => { lostLong = true; } });
    convReply(0, "long");
    await vi.advanceTimersByTimeAsync(0);

    // t=200: twice the pool's budget, and this read is untouched.
    await vi.advanceTimersByTimeAsync(200);
    expect(lostLong).toBe(false);
    expect(h.workers[0].terminateCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(301);
    await expect(pLong).resolves.toEqual([]);
    expect(lostLong).toBe(true);
    expect(h.workers[0].terminateCalls).toBe(1);
  });

  it("does not charge a job for the time it spent queued", async () => {
    vi.useFakeTimers();
    const { recognize, __setOcrJobTimeoutMsForTest } = await import("./ocrService");
    __setOcrJobTimeoutMsForTest(100);
    // Every job takes 80ms of real work — inside the budget, but the third one
    // only starts once a worker frees up at t=80.
    h.recognize = (blob: any) =>
      new Promise((res) => { setTimeout(() => res({ data: { words: [WORD(blob.__tag)] } }), 80); });

    const jobs = [recognize(IMG()), recognize(IMG()), recognize(IMG())];
    convReply(0, "a");
    convReply(1, "b");
    convReply(2, "c");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.workers.length).toBe(2); // "c" is queued, not running

    await vi.advanceTimersByTimeAsync(300);
    // Under a queue-time timeout "c" would have expired at t=100 while waiting.
    await expect(Promise.all(jobs)).resolves.toEqual([[WORD("a")], [WORD("b")], [WORD("c")]]);
    expect(h.workers.every((w) => w.terminateCalls === 0)).toBe(true);
  });

  it("an aborted signal drops a queued job before it ever reaches a worker", async () => {
    const { recognize } = await import("./ocrService");
    h.recognize = () => new Promise(() => { /* both workers stay busy */ });

    const ac = new AbortController();
    const pA = recognize(IMG());
    const pB = recognize(IMG());
    const pC = recognize(IMG(), { signal: ac.signal }); // queued behind A and B
    convReply(0, "a");
    convReply(1, "b");
    convReply(2, "c");
    await flush();
    expect(h.workers.flatMap((w) => w.seen)).toEqual(["a", "b"]);

    ac.abort();
    await expect(pC).resolves.toEqual([]);
    await flush();
    expect(h.workers.flatMap((w) => w.seen)).toEqual(["a", "b"]); // "c" never ran
    expect(h.workers.every((w) => w.terminateCalls === 0)).toBe(true);
    void pA; void pB;
  });
});

describe("ocrService.shutdownOcr", () => {
  it("terminates the pool's workers and the conversion worker, then rebuilds lazily", async () => {
    const { recognize, shutdownOcr } = await import("./ocrService");

    const p = recognize(IMG());
    const conv = FakeWorker.instances[0];
    convReply(0, "first");
    await expect(p).resolves.toHaveLength(1);
    expect(h.workers.length).toBe(1);

    await shutdownOcr();
    expect(h.workers[0].terminateCalls).toBe(1);
    expect(conv.terminated).toBe(true);

    // Lazy recreate: the next recognize builds a fresh pool and a fresh
    // conversion worker, and still answers.
    const p2 = recognize(IMG());
    const conv2 = FakeWorker.instances[1];
    expect(conv2).toBeTruthy();
    expect(conv2).not.toBe(conv);
    conv2.emit({ ocrId: conv2.posted[0].ocrId, blob: fakeBlob("second") });
    await expect(p2).resolves.toEqual([WORD("second")]);
    expect(h.workers.length).toBe(2);
    expect(h.workers[1].terminateCalls).toBe(0);
  });

  it("a recognize starting mid-teardown gets fresh workers, not the dying ones", async () => {
    const { recognize, shutdownOcr } = await import("./ocrService");

    const p0 = recognize(IMG());
    const conv0 = FakeWorker.instances[0];
    convReply(0, "a");
    await p0;

    // Terminating the pool is async. A recognize that starts inside that window
    // must find the singletons already detached and build its own — otherwise it
    // adopts the workers that are about to be terminated underneath it.
    const teardown = shutdownOcr();
    const p1 = recognize(IMG());
    await flush();

    const conv1 = FakeWorker.instances[1];
    expect(conv1).toBeTruthy();
    expect(conv1).not.toBe(conv0);
    conv1.emit({ ocrId: conv1.posted[0].ocrId, blob: fakeBlob("b") });

    await teardown;
    await expect(p1).resolves.toEqual([WORD("b")]);
    // The teardown killed the first worker and left the newcomer alone.
    expect(h.workers.length).toBe(2);
    expect(h.workers[0].terminateCalls).toBe(1);
    expect(h.workers[1].terminateCalls).toBe(0);
    expect(conv1.terminated).toBe(false);
  });

  it("releases a job still queued behind a hung one", async () => {
    const { recognize, shutdownOcr } = await import("./ocrService");
    h.recognize = () => new Promise(() => { /* hang */ });

    const pA = recognize(IMG());
    const pB = recognize(IMG());
    const pC = recognize(IMG()); // queued behind the two busy workers
    for (let i = 0; i < 3; i++) convReply(i, `j${i}`);
    await flush();

    await shutdownOcr();
    await expect(pC).resolves.toEqual([]); // released, not left hanging
    expect(h.workers.map((w) => w.terminateCalls)).toEqual([1, 1]);
    void pA; void pB;
  });

  it("is safe when nothing was ever initialised, and is idempotent", async () => {
    const { shutdownOcr } = await import("./ocrService");
    await expect(shutdownOcr()).resolves.toBeUndefined();
    await expect(shutdownOcr()).resolves.toBeUndefined();
    expect(h.workers.length).toBe(0);
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
    // blob flows through the pool into the recognized word.
    conv.emit({ ocrId: c200.ocrId, blob: fakeBlob("b") });
    conv.emit({ ocrId: c100.ocrId, blob: fakeBlob("a") });
    await flush();

    const relays = probe.posted.filter((p) => p.kind === "ocr-res");
    expect(relays.length).toBe(2);
    const byId = new Map(relays.map((r) => [r.ocrId, r.words[0].text]));
    expect(byId.get(200)).toBe("b"); // completed first, still paired to 200
    expect(byId.get(100)).toBe("a");
  });

  it("relays a NON-ANSWER to the probe when conversion fails", async () => {
    const { attachOcrRpc } = await import("./ocrService");
    const probe = new FakeWorker("probe");
    attachOcrRpc(probe as unknown as Worker);
    probe.emit({ kind: "ocr-req", ocrId: 42, image: IMG() });
    const conv = FakeWorker.instances.find((w) => w !== probe)!;
    conv.emit({ ocrId: conv.posted[0].ocrId, error: "boom" });
    await flush();
    const relay = probe.posted.find((p) => p.kind === "ocr-res");
    // A conversion failure is a read that NEVER HAPPENED, and it used to be relayed as
    // `noResult: false` — the same `[]` a wordless crop returns, so the aligner never
    // re-read it and no counter recorded it. That is the silent read the probe-flip
    // diagnosis pinned: an answer moves while `ocrStats` stays all zeros.
    expect(relay).toEqual({ kind: "ocr-res", ocrId: 42, words: [], noResult: true });
  });

  it("tells the probe when a read was a NON-ANSWER, so the band can be re-read", async () => {
    vi.useFakeTimers();
    const { attachOcrRpc, __setOcrJobTimeoutMsForTest } = await import("./ocrService");
    __setOcrJobTimeoutMsForTest(100);
    h.recognize = () => new Promise(() => { /* hangs past the budget */ });
    const probe = new FakeWorker("probe");
    attachOcrRpc(probe as unknown as Worker);
    probe.emit({ kind: "ocr-req", ocrId: 7, image: IMG() });
    const conv = FakeWorker.instances.find((w) => w !== probe)!;
    conv.emit({ ocrId: conv.posted[0].ocrId, blob: fakeBlob("x") });
    await vi.advanceTimersByTimeAsync(200);
    const relay = probe.posted.find((p) => p.kind === "ocr-res");
    // Same `[]` a wordless crop produces — the flag is the only thing that tells
    // them apart, and it is what `readPageOcr` retries on.
    expect(relay).toEqual({ kind: "ocr-res", ocrId: 7, words: [], noResult: true });
  });
});

describe("ocrService.recognize — onNoResult", () => {
  it("fires on an expired job budget and not on a crop that simply has no text", async () => {
    vi.useFakeTimers();
    const { recognize, __setOcrJobTimeoutMsForTest } = await import("./ocrService");
    __setOcrJobTimeoutMsForTest(100);
    h.recognize = () => new Promise(() => { /* hangs */ });
    let hung = false;
    const pHang = recognize(IMG(), { onNoResult: () => { hung = true; } });
    convReply(0, "hang");
    await vi.advanceTimersByTimeAsync(200);
    await expect(pHang).resolves.toEqual([]);
    expect(hung).toBe(true);

    // A worker that answers with no words is an ANSWER: same [], no flag.
    h.recognize = async () => ({ data: { words: [] } });
    let empty = false;
    const pEmpty = recognize(IMG(), { onNoResult: () => { empty = true; } });
    await vi.advanceTimersByTimeAsync(0);
    convReply(1, "empty");
    await vi.advanceTimersByTimeAsync(0);
    await expect(pEmpty).resolves.toEqual([]);
    expect(empty).toBe(false);
  });

  /**
   * The silent read — the one shape that changes an answer while every counter stays
   * zero, and the one the harness structurally cannot produce (Node encodes its PNG
   * synchronously, in-process: no worker, no RPC, no budget). Measured on Belcourt:
   * the same three strip reads flagged are re-read and land identical placements;
   * silently empty, the reciprocal anchor is lost and a sheet moves ~39 ft with
   * `ocrStats` reading `61/0/0/0/0`.
   */
  it("fires when the CONVERSION worker fails — a read that never happened is not an empty crop", async () => {
    const { recognize } = await import("./ocrService");
    let flagged = false;
    const p = recognize(IMG(), { onNoResult: () => { flagged = true; } });
    const conv = FakeWorker.instances[0];
    conv.emit({ ocrId: conv.posted[0].ocrId, error: "OffscreenCanvas 2d context unavailable" });
    await expect(p).resolves.toEqual([]);
    expect(flagged).toBe(true);
  });

  it("fires when the pool's own worker REJECTS — a broken pipe is a non-answer", async () => {
    h.recognize = async () => { throw new Error("recognize blew up"); };
    const { recognize } = await import("./ocrService");
    let flagged = false;
    const p = recognize(IMG(), { onNoResult: () => { flagged = true; } });
    convReply(0, "x");
    await expect(p).resolves.toEqual([]);
    expect(flagged).toBe(true);
  });

  it("does NOT fire when the caller aborted — that is the caller's own doing", async () => {
    const { recognize } = await import("./ocrService");
    h.recognize = () => new Promise(() => { /* both workers stay busy */ });
    const ac = new AbortController();
    const pA = recognize(IMG());
    const pB = recognize(IMG());
    let flagged = false;
    const pC = recognize(IMG(), { signal: ac.signal, onNoResult: () => { flagged = true; } });
    convReply(0, "a"); convReply(1, "b"); convReply(2, "c");
    await flush();
    ac.abort();
    await expect(pC).resolves.toEqual([]);
    expect(flagged).toBe(false);
    void pA; void pB;
  });

  it("does not fire from the CATCH branch either once the caller has aborted", async () => {
    // The other half of the same rule, on the other exit. Tearing a run down is exactly
    // what BREAKS the pipe — `shutdownOcr` fails every outstanding conversion, so an
    // abandoned probe's reads all land in this catch at once — and reporting them as
    // non-answers would have the aligner re-read a whole page for a run that has
    // already given up, on the pool being torn down under it.
    const { recognize } = await import("./ocrService");
    const ac = new AbortController();
    let flagged = false;
    const p = recognize(IMG(), { signal: ac.signal, onNoResult: () => { flagged = true; } });
    const conv = FakeWorker.instances[0];
    ac.abort();
    conv.emit({ ocrId: conv.posted[0].ocrId, error: "conversion worker gone" });
    await expect(p).resolves.toEqual([]);
    expect(flagged).toBe(false);
  });

  it("a THROWING onNoResult cannot report the read twice, or reject it", async () => {
    // `onNoResult` is bookkeeping; a broken hook must not rewrite the read's own
    // outcome. Unguarded, a throw from the OCR_NO_RESULT branch fell into the catch
    // below it and fired the SAME hook a second time — double-counting `nonAnswers`
    // and buying the band a second `retries++` for one lost read — while a throw from
    // the catch escaped `recognize` altogether, rejecting a call whose whole contract
    // is "best-effort, resolves []".
    vi.useFakeTimers();
    const { recognize, __setOcrJobTimeoutMsForTest } = await import("./ocrService");
    __setOcrJobTimeoutMsForTest(100);
    h.recognize = () => new Promise(() => { /* hangs past the budget */ });
    let fired = 0;
    const pHang = recognize(IMG(), { onNoResult: () => { fired++; throw new Error("hook blew up"); } });
    convReply(0, "hang");
    await vi.advanceTimersByTimeAsync(200);
    await expect(pHang).resolves.toEqual([]);
    expect(fired).toBe(1);

    // …and the same on the catch branch, which has no handler after it at all.
    vi.useRealTimers();
    let firedC = 0;
    const pConv = recognize(IMG(), { onNoResult: () => { firedC++; throw new Error("hook blew up"); } });
    const conv = FakeWorker.instances[0];
    conv.emit({ ocrId: conv.posted.at(-1)!.ocrId, error: "boom" });
    await expect(pConv).resolves.toEqual([]);
    expect(firedC).toBe(1);
  });
});
