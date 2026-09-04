import { describe, it, expect, beforeEach, vi } from "vitest";
import { createOcrPool, OCR_NO_RESULT, type OcrPool } from "./ocrPool";

/**
 * Pool semantics in isolation — no tesseract, no DOM. The fake worker hands
 * every recognize() back as a controllable deferred so a test can decide, per
 * job, whether it completes, rejects, or hangs.
 */

interface FakeJob { input: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }

class FakeW {
  jobs: FakeJob[] = [];
  terminated = 0;
  constructor(public readonly id: number) {}
  recognize(input: string): Promise<unknown> {
    return new Promise((resolve, reject) => { this.jobs.push({ input, resolve, reject }); });
  }
  terminate() { this.terminated++; }
  /** The one job still awaiting an answer, if any. */
  get open() { return this.jobs[this.jobs.length - 1]; }
}

let created: FakeW[] = [];
let inFlightCreates = 0;
let maxParallelCreates = 0;
let createCalls = 0;
let failCreates = 0;   // fail this many createWorker calls before succeeding

async function createWorker(): Promise<FakeW> {
  createCalls++;
  inFlightCreates++;
  maxParallelCreates = Math.max(maxParallelCreates, inFlightCreates);
  try {
    await Promise.resolve(); // a yield: parallel creation would be visible here
    if (failCreates > 0) { failCreates--; throw new Error("boot failed"); }
    const w = new FakeW(created.length);
    created.push(w);
    return w;
  } finally { inFlightCreates--; }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function pool(size: number, timeout = 100_000): OcrPool<string, unknown> {
  return createOcrPool<string, unknown>({ size, createWorker, timeoutMs: () => timeout });
}

beforeEach(() => {
  created = [];
  inFlightCreates = 0;
  maxParallelCreates = 0;
  createCalls = 0;
  failCreates = 0;
});

describe("createOcrPool — concurrency", () => {
  it("runs N jobs on N workers, created lazily and never two at a time", async () => {
    const p = pool(3);
    expect(created.length).toBe(0); // nothing built until there is work

    const jobs = [p.run("a"), p.run("b"), p.run("c")];
    await flush();

    expect(created.length).toBe(3);
    expect(maxParallelCreates).toBe(1); // sequential creation
    expect(created.map((w) => w.jobs.map((j) => j.input))).toEqual([["a"], ["b"], ["c"]]);

    created[0].open.resolve("A");
    created[1].open.resolve("B");
    created[2].open.resolve("C");
    await expect(Promise.all(jobs)).resolves.toEqual(["A", "B", "C"]);
  });

  it("never exceeds `size`; the surplus waits and reuses the first free worker", async () => {
    const p = pool(2);
    const jobs = [p.run("a"), p.run("b"), p.run("c")];
    await flush();

    expect(created.length).toBe(2);
    expect(created[0].jobs.map((j) => j.input)).toEqual(["a"]);
    expect(created[1].jobs.map((j) => j.input)).toEqual(["b"]);

    created[0].open.resolve("A");
    await flush();
    // "c" went to the worker that came free, not to a third one.
    expect(created.length).toBe(2);
    expect(created[0].jobs.map((j) => j.input)).toEqual(["a", "c"]);

    created[0].open.resolve("C");
    created[1].open.resolve("B");
    await expect(Promise.all(jobs)).resolves.toEqual(["A", "B", "C"]);
  });

  it("prewarm boots one worker before any job arrives", async () => {
    const p = pool(3);
    p.prewarm();
    await flush();
    expect(created.length).toBe(1);
    expect(created[0].jobs).toEqual([]);

    const job = p.run("a");
    await flush();
    expect(created.length).toBe(1); // the warm worker took it
    created[0].open.resolve("A");
    await expect(job).resolves.toBe("A");
  });
});

describe("createOcrPool — timeouts", () => {
  it("charges the timeout from DISPATCH, not from queueing", async () => {
    vi.useFakeTimers();
    try {
      const p = pool(1, 100);
      const a = p.run("a");
      const b = p.run("b"); // queued behind "a" the whole time
      await vi.advanceTimersByTimeAsync(0);
      expect(created.length).toBe(1);

      // t=90: past the point a queue-time timer would have killed "b" (t=100),
      // but "b" has not been dispatched yet, so its budget is untouched.
      await vi.advanceTimersByTimeAsync(90);
      created[0].open.resolve("A");
      await vi.advanceTimersByTimeAsync(0);
      await expect(a).resolves.toBe("A");

      // "b" dispatched at t=90 and answers at t=140 — 50ms of its own budget.
      await vi.advanceTimersByTimeAsync(50);
      created[0].open.resolve("B");
      await expect(b).resolves.toBe("B");
      expect(created[0].terminated).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("a hung job resolves OCR_NO_RESULT and retires ONLY its own worker", async () => {
    vi.useFakeTimers();
    try {
      const p = pool(2, 100);
      const a = p.run("a"); // will hang
      const b = p.run("b"); // healthy sibling
      await vi.advanceTimersByTimeAsync(0);
      expect(created.length).toBe(2);

      // The sibling answers well inside its own budget…
      await vi.advanceTimersByTimeAsync(50);
      created[1].open.resolve("B");
      await expect(b).resolves.toBe("B");

      // …and "a" then blows its budget alone.
      await vi.advanceTimersByTimeAsync(50);
      await expect(a).resolves.toBe(OCR_NO_RESULT);
      expect(created[0].terminated).toBe(1);
      expect(created[1].terminated).toBe(0);

      // The retired slot is refilled lazily: "c" goes to the idle survivor and
      // only "d" — which needs a second worker — pays for a fresh boot.
      const c = p.run("c");
      const d = p.run("d");
      await vi.advanceTimersByTimeAsync(0);
      expect(created.length).toBe(3);
      expect(created[1].open.input).toBe("c");
      expect(created[2].open.input).toBe("d");
      created[1].open.resolve("C");
      created[2].open.resolve("D");
      await expect(c).resolves.toBe("C");
      await expect(d).resolves.toBe("D");
    } finally { vi.useRealTimers(); }
  });

  it("a timeout hands the queue to the surviving worker instead of stalling it", async () => {
    vi.useFakeTimers();
    try {
      const p = pool(2, 100);
      const a = p.run("a"); // hangs
      const b = p.run("b");
      const c = p.run("c"); // queued
      await vi.advanceTimersByTimeAsync(0);

      created[1].open.resolve("B");
      await vi.advanceTimersByTimeAsync(0);
      await expect(b).resolves.toBe("B");
      expect(created[1].jobs.map((j) => j.input)).toEqual(["b", "c"]); // c took the free worker

      // "c" was never stuck behind the hang: it answers before "a" even expires.
      await vi.advanceTimersByTimeAsync(50);
      created[1].open.resolve("C");
      await expect(c).resolves.toBe("C");

      await vi.advanceTimersByTimeAsync(50);
      await expect(a).resolves.toBe(OCR_NO_RESULT);
      expect(created[1].terminated).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("a timeout with an empty queue does not boot a replacement for zero work", async () => {
    vi.useFakeTimers();
    try {
      const p = pool(2, 100);
      p.prewarm();                 // arms the sticky warm hint
      const a = p.run("a");        // will hang; nothing queued behind it
      await vi.advanceTimersByTimeAsync(0);
      expect(createCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(100);
      await expect(a).resolves.toBe(OCR_NO_RESULT);
      expect(created[0].terminated).toBe(1);
      // The last live worker is gone and there is no pending work: a sticky
      // `warm` would have booted a fresh wasm heap here for nothing.
      await vi.advanceTimersByTimeAsync(0);
      expect(createCalls).toBe(1);

      // …and the pool is still usable: the next job builds its own worker.
      const b = p.run("b");
      await vi.advanceTimersByTimeAsync(0);
      expect(createCalls).toBe(2);
      created[1].open.resolve("B");
      await expect(b).resolves.toBe("B");
    } finally { vi.useRealTimers(); }
  });

  it("a throwing onTimeout hook cannot break the timeout path", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn(() => { throw new Error("logger blew up"); });
      const p = createOcrPool<string, unknown>({
        size: 1, createWorker, timeoutMs: () => 100, onTimeout,
      });
      const a = p.run("a"); // hangs
      const b = p.run("b"); // queued; only the hang can free the single worker
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(100);
      expect(onTimeout).toHaveBeenCalledTimes(1);
      // Settle, retire and pump all still happened despite the hook throwing.
      await expect(a).resolves.toBe(OCR_NO_RESULT);
      expect(created[0].terminated).toBe(1);
      created[1].open.resolve("B");
      await expect(b).resolves.toBe("B");
    } finally { vi.useRealTimers(); }
  });
});

describe("createOcrPool — abort", () => {
  it("drops a still-queued job: it never reaches a worker", async () => {
    const p = pool(1);
    const ac = new AbortController();
    const a = p.run("a");
    const b = p.run("b", { signal: ac.signal });
    await flush();
    expect(created[0].jobs.map((j) => j.input)).toEqual(["a"]);

    ac.abort();
    await expect(b).resolves.toBe(OCR_NO_RESULT);

    created[0].open.resolve("A");
    await expect(a).resolves.toBe("A");
    await flush();
    expect(created[0].jobs.map((j) => j.input)).toEqual(["a"]); // "b" never ran
  });

  it("an already-aborted signal short-circuits without queueing", async () => {
    const p = pool(1);
    const ac = new AbortController();
    ac.abort();
    await expect(p.run("a", { signal: ac.signal })).resolves.toBe(OCR_NO_RESULT);
    await flush();
    expect(created.length).toBe(0);
  });

  it("an in-flight job's result is ignored, and its (healthy) worker is reused", async () => {
    const p = pool(1);
    const ac = new AbortController();
    const a = p.run("a", { signal: ac.signal });
    await flush();

    ac.abort();
    await expect(a).resolves.toBe(OCR_NO_RESULT);
    expect(created[0].terminated).toBe(0); // the worker did nothing wrong

    created[0].open.resolve("A (too late)");
    await flush();
    const b = p.run("b");
    await flush();
    expect(created.length).toBe(1); // same worker, back in the pool
    created[0].open.resolve("B");
    await expect(b).resolves.toBe("B");
  });
});

describe("createOcrPool — failures and teardown", () => {
  it("propagates a worker's recognize rejection and keeps the worker", async () => {
    const p = pool(1);
    const a = p.run("a");
    await flush();
    created[0].open.reject(new Error("recognize blew up"));
    await expect(a).rejects.toThrow("recognize blew up");

    const b = p.run("b");
    await flush();
    expect(created.length).toBe(1);
    created[0].open.resolve("B");
    await expect(b).resolves.toBe("B");
  });

  it("fails queued jobs when no worker can be built, then retries on the next call", async () => {
    failCreates = 1;
    const p = pool(2);
    await expect(p.run("a")).rejects.toThrow("boot failed");

    const b = p.run("b");
    await flush();
    expect(created.length).toBe(1); // retried and succeeded
    created[0].open.resolve("B");
    await expect(b).resolves.toBe("B");
  });

  it("terminate() kills every worker, clears the queue, and stays closed", async () => {
    const p = pool(2);
    const a = p.run("a");
    const b = p.run("b");
    const c = p.run("c"); // queued
    await flush();
    expect(created.length).toBe(2);

    await p.terminate();
    expect(created.map((w) => w.terminated)).toEqual([1, 1]);
    await expect(c).resolves.toBe(OCR_NO_RESULT); // queued job released, never ran

    // In-flight jobs settle however their (now dead) worker settles.
    created[0].open.resolve("A");
    created[1].open.reject(new Error("terminated"));
    await expect(a).resolves.toBe("A");
    await expect(b).rejects.toThrow("terminated");

    await expect(p.run("d")).resolves.toBe(OCR_NO_RESULT);
    expect(createCalls).toBe(2); // nothing new was built
  });
});
