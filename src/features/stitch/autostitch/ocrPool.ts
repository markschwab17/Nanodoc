/**
 * OCR worker pool — our own replacement for tesseract's `createScheduler`.
 *
 * Why not the scheduler: its per-job timeout starts when the job is QUEUED, so
 * on a queue of N crops the later ones burn their whole budget waiting their
 * turn, and one slow crop then recycled the WHOLE scheduler — every worker, and
 * every job still queued behind it. This pool instead:
 *   - starts a job's timer at DISPATCH (the moment a worker picks it up), so
 *     queue time is never charged against the job's budget;
 *   - on timeout retires ONLY the worker that hung (terminate, replaced lazily),
 *     leaving its siblings and the rest of the queue running.
 *
 * It is deliberately transport-agnostic — no tesseract import, no DOM, no Vite
 * `?url` assets — so the browser service (`ocrService.ts`, POOL_SIZE workers)
 * and the Node eval harness (`scripts/stitch-eval.mjs`, 3 workers) drive the
 * SAME queueing/timeout code. Everything tesseract-specific (langPath, core
 * paths, PSM.SPARSE_TEXT) lives in the caller's `createWorker`.
 *
 * Workers are created lazily and SEQUENTIALLY (never two `createWorker` calls in
 * flight): each boots a wasm heap plus the `eng` traineddata, and spinning them
 * up in parallel just made the first job wait on all of them at once.
 */

/**
 * How many OCR jobs this environment can genuinely run at once — the pool's
 * `size`, and therefore the width every CALLER should batch its reads at.
 *
 * One worker per core, minus one left for the main thread, clamped to [2, 3].
 * Two is the floor — with a single worker there is nothing to overlap, which is
 * the whole point. THREE is the ceiling, for two reasons. Memory: each worker
 * holds the tesseract SIMD wasm heap plus the `eng` traineddata, 80-120 MB
 * apiece, and they sit alongside the aligner's own per-page extracts and band
 * rasters — a fourth pushed a 10-sheet probe to roughly 1.0 GB. Evidence: every
 * timing in the probe-speed work was measured at three, so a 16-core machine
 * quietly running a wider pool would be running an unmeasured configuration.
 *
 * Lives HERE, not in `ocrService.ts`, so `autoStitch` can size its OCR batches
 * off the same derivation without importing the browser service (which pulls in
 * Vite `?url` worker assets and cannot load in the probe worker or in Node).
 * Callers that build their own pool at an explicit size — the Node eval harness,
 * three workers — pass that size down instead (`AutoStitchOptions.ocrConcurrency`).
 */
export function defaultOcrPoolSize(): number {
  const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 0;
  return Math.min(3, Math.max(2, cores - 1));
}

/**
 * The per-job OCR budget every transport in the tree runs, measured from DISPATCH.
 *
 * It lives HERE, with the mechanism that enforces it, rather than in each transport:
 * the browser service, the probe worker's RPC backstop and the Node/Lambda pool all
 * have to agree on it, and three copies of `20_000` is three chances to disagree.
 */
export const OCR_JOB_TIMEOUT_MS = 20_000;

/**
 * The budget ONE re-read gets: double.
 *
 * A read that blew the budget is re-read on exactly the same input (`autoStitch`
 * re-renders the identical clip), so re-reading it on the same 20 s clock mostly buys
 * a second non-answer — the crop was too slow, and it is no faster the second time.
 * Doubling is what makes the re-read a genuine second chance rather than a formality,
 * and it is bounded: one band, one extra read, never recursive.
 *
 * It is deliberately NOT the default. Every FIRST read keeps the 20 s budget, because
 * the budget's other job is to stop a hung worker pinning a pool slot, and a run whose
 * every read waited 40 s is a run the user has already abandoned.
 */
export const RETRY_JOB_TIMEOUT_MS = OCR_JOB_TIMEOUT_MS * 2;

/** Anything that can OCR one input and be shut down — a tesseract worker fits structurally. */
export interface OcrPoolWorker<Input, Result> {
  recognize(input: Input): Promise<Result>;
  terminate(): unknown;
}

/**
 * Resolution for a job that produced no result: it timed out, its signal was
 * aborted, or the pool was torn down under it. A job whose worker REJECTS is not
 * this — that error propagates out of `run` so callers can log it.
 */
export const OCR_NO_RESULT = Symbol("ocr-no-result");
export type OcrNoResult = typeof OCR_NO_RESULT;

export interface OcrPoolOptions<Input, Result> {
  /** Maximum number of live workers. */
  size: number;
  /** Builds one ready-to-use worker (already configured). Called at most `size` times concurrently-never. */
  createWorker: () => Promise<OcrPoolWorker<Input, Result>>;
  /** Per-job budget in ms, read at DISPATCH time so tests can shorten it after the pool
   *  exists. A job that names its own `timeoutMs` in `run` overrides this. */
  timeoutMs: () => number;
  /** Logging hook fired when a job times out. Must not throw. */
  onTimeout?: () => void;
}

export interface OcrPool<Input, Result> {
  /**
   * Queue one job. Resolves the worker's result, or OCR_NO_RESULT on
   * timeout/abort/teardown; rejects only if the worker's own `recognize` rejects.
   *
   * `signal`: aborting REMOVES a still-queued job from the queue (resolves
   * OCR_NO_RESULT and it never runs); aborting an in-flight job resolves
   * OCR_NO_RESULT immediately and ignores the result when it lands — the worker
   * itself is left alone and returns to the pool, because it is healthy.
   *
   * `timeoutMs`: this job's budget, overriding the pool's. Still measured from
   * DISPATCH, so a longer budget is not spent waiting in the queue. It exists for the
   * ONE re-read a lost read earns (`RETRY_JOB_TIMEOUT_MS`): re-reading the same crop
   * on the same clock that just expired mostly buys a second non-answer.
   */
  run(input: Input, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Result | OcrNoResult>;
  /**
   * Start booting one worker now, without a job. Callers use this to overlap the
   * (slow) first worker boot with their own pre-OCR work; it is a hint, so
   * creation failures are silent here and surface on the first real job instead.
   */
  prewarm(): void;
  /** Terminate every worker and clear the queue (queued jobs resolve OCR_NO_RESULT). Permanent. */
  terminate(): Promise<void>;
  readonly size: number;
}

interface Job<Input, Result> {
  input: Input;
  resolve: (value: Result | OcrNoResult) => void;
  reject: (err: unknown) => void;
  settled: boolean;
  /** Kept so the job can take itself off `waiting` when it settles normally. */
  signal?: AbortSignal;
  /** This job's own budget, or undefined for the pool's. Read at DISPATCH. */
  timeoutMs?: number;
}

export function createOcrPool<Input, Result>(
  options: OcrPoolOptions<Input, Result>,
): OcrPool<Input, Result> {
  const size = Math.max(1, Math.floor(options.size));
  const { createWorker, timeoutMs, onTimeout } = options;

  type W = OcrPoolWorker<Input, Result>;
  const live = new Set<W>();      // created and not yet retired (idle or busy)
  const idle: W[] = [];
  const queue: Job<Input, Result>[] = [];
  // One entry per DISPATCHED job whose timeout is still armed — see `dispatch`.
  const armed = new Set<() => void>();
  let pending = 0;                // workers reserved in `grow()` but not created yet
  let busy = 0;
  let creating = false;
  let warm = false;
  let destroyed = false;
  /** The in-flight `grow()`, if any — see `terminate`. */
  let growing: Promise<void> | null = null;

  /**
   * Jobs waiting on each abort signal — ONE "abort" listener per signal, not one per job.
   *
   * A run has a single AbortController (autoStitch makes one and hands the same signal to
   * every read), and a page issues 7-13 reads at once. A listener per job therefore put
   * 11+ listeners on one EventTarget, which is exactly what Node's default limit warns
   * about: every real probe printed a `MaxListenersExceededWarning` naming an
   * `abort` leak that was not one. Muting the limit would have thrown away a genuinely
   * useful warning; registering once per signal removes the cause instead, and works
   * unchanged in the browser (no `node:events`).
   *
   * A WeakMap so a signal whose run is over is collectable with its job set.
   */
  const waiting = new WeakMap<AbortSignal, Set<Job<Input, Result>>>();
  function watchSignal(job: Job<Input, Result>, signal: AbortSignal): void {
    let jobs = waiting.get(signal);
    if (!jobs) {
      jobs = new Set();
      waiting.set(signal, jobs);
      signal.addEventListener("abort", () => {
        // Detach the whole set first: `settle` calls back into `unwatchSignal`, and
        // mutating the set we are iterating is the classic way to skip an entry.
        const all = waiting.get(signal);
        waiting.delete(signal);
        for (const j of all ?? []) {
          const at = queue.indexOf(j);
          if (at >= 0) queue.splice(at, 1);  // still queued: it never runs
          settle(j, OCR_NO_RESULT);          // in flight: result ignored on arrival
        }
      }, { once: true });
    }
    jobs.add(job);
  }
  const unwatchSignal = (job: Job<Input, Result>) => {
    if (job.signal) waiting.get(job.signal)?.delete(job);
  };

  const settle = (job: Job<Input, Result>, value: Result | OcrNoResult) => {
    if (job.settled) return;
    job.settled = true;
    unwatchSignal(job);
    job.resolve(value);
  };
  const fail = (job: Job<Input, Result>, err: unknown) => {
    if (job.settled) return;
    job.settled = true;
    unwatchSignal(job);
    job.reject(err);
  };

  /** How many live workers the current backlog justifies. */
  const desired = () => Math.min(size, Math.max(busy + queue.length, warm ? 1 : 0));

  function dispatchWaiting(): void {
    while (!destroyed && queue.length > 0 && idle.length > 0) {
      dispatch(idle.pop()!, queue.shift()!);
    }
  }

  function pump(): void {
    dispatchWaiting();
    if (!destroyed && !creating && live.size + pending < desired()) {
      // Held, not just fired and forgotten: `terminate()` has to be able to wait for it.
      const p = grow();
      growing = p;
      void p.finally(() => { if (growing === p) growing = null; });
    }
  }

  async function grow(): Promise<void> {
    creating = true;
    try {
      // Sequential by construction: the loop awaits each createWorker, and the
      // `creating` flag keeps a concurrent pump() out until this cycle ends.
      while (!destroyed && live.size + pending < desired()) {
        pending++;
        let worker: W;
        try {
          worker = await createWorker();
        } catch (err) {
          pending--;
          // Nobody left to serve the backlog: fail the queued jobs rather than
          // let them hang forever. (With a live worker still around we simply
          // stop growing — the queue drains more slowly but it drains.) The next
          // job to arrive pumps again and retries creation, so a transient
          // failure never permanently kills the pool.
          if (live.size === 0) {
            for (const job of queue.splice(0)) fail(job, err);
          }
          return;
        }
        pending--;
        // AWAITED, so that a `terminate()` waiting on this grow() really does return with
        // every worker gone: a worker booted into a torn-down pool is otherwise terminated
        // on a promise nobody holds, and it stays alive long enough to pin the event loop.
        if (destroyed) { try { await worker.terminate(); } catch { /* ignore */ } return; }
        live.add(worker);
        idle.push(worker);
        dispatchWaiting();
      }
    } finally {
      creating = false;
    }
  }

  function retire(worker: W): void {
    if (!live.delete(worker)) return;
    const at = idle.indexOf(worker);
    if (at >= 0) idle.splice(at, 1);
    try {
      void Promise.resolve(worker.terminate()).catch(() => { /* best-effort */ });
    } catch { /* best-effort */ }
  }

  function release(worker: W): void {
    busy--;
    if (destroyed || !live.has(worker)) return; // torn down, or retired by a timeout
    idle.push(worker);
    pump();
  }

  function dispatch(worker: W, job: Job<Input, Result>): void {
    busy++;
    let done = false;
    // The timer starts HERE — at dispatch — not when the job was queued.
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      armed.delete(disarm);
      try { onTimeout?.(); } catch { /* logging must never break the timeout path */ }
      settle(job, OCR_NO_RESULT);
      busy--;
      retire(worker);   // only this worker; siblings keep their jobs
      // Drop the warm hint: with an empty queue this timeout may have retired the
      // LAST live worker, and a sticky `warm` would have pump() boot a fresh wasm
      // heap for zero pending work. recognize() re-arms it via prewarm().
      warm = false;
      pump();           // …and a replacement is created lazily if work remains
    }, job.timeoutMs ?? timeoutMs());
    // `terminate()`'s handle on this dispatch. It has to do BOTH halves: clearing
    // the timer alone would strand the job forever (with the worker terminated,
    // the timer was the only thing left that would ever settle it), and settling
    // alone would leave the timer armed to log a phantom "job timed out" a full
    // budget after the modal closed.
    const disarm = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      armed.delete(disarm);
      settle(job, OCR_NO_RESULT);
      busy--;
    };
    armed.add(disarm);
    // Deliberately NOT clearing the timer when the job is merely ABORTED: the
    // worker is still chewing on the crop, and the timer is the only thing that
    // will ever reclaim it if that crop is the one that hangs.
    Promise.resolve()
      .then(() => worker.recognize(job.input))
      .then(
        (result) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          armed.delete(disarm);
          settle(job, result); // no-op if the job was aborted mid-flight
          release(worker);
        },
        (err) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          armed.delete(disarm);
          fail(job, err);
          release(worker);
        },
      );
  }

  return {
    size,
    run(input, opts) {
      return new Promise<Result | OcrNoResult>((resolve, reject) => {
        if (destroyed || opts?.signal?.aborted) { resolve(OCR_NO_RESULT); return; }
        const job: Job<Input, Result> = {
          input, resolve, reject, settled: false, signal: opts?.signal,
          timeoutMs: opts?.timeoutMs,
        };
        if (job.signal) watchSignal(job, job.signal);
        queue.push(job);
        pump();
      });
    },
    prewarm() {
      if (destroyed || warm) return;
      warm = true;
      pump();
    },
    async terminate() {
      destroyed = true;
      for (const job of queue.splice(0)) settle(job, OCR_NO_RESULT);
      // In-flight jobs are settled HERE rather than left to the dispatch timers.
      // Leaving those armed meant the pool logged "recognize job timed out" and
      // called `onTimeout` up to a full budget (20 s) after the modal had closed
      // and the pool had been thrown away — a warning about work nobody was doing
      // any more. `disarm` clears the timer and settles the job it was guarding,
      // so nothing is stranded by the timer going away.
      for (const disarm of [...armed]) disarm();
      armed.clear();
      // A `grow()` sitting on `await createWorker()` when we got here will resume, see
      // `destroyed` and terminate the worker it just booted — but only after this method
      // has already returned, unless we wait for it. Its worker is not in `live`, so the
      // sweep below cannot catch it, and the caller would be told the pool was down while
      // a tesseract thread was still coming up behind it. Waited FIRST, so any worker the
      // cycle managed to publish before it noticed is in `live` by the time we read it.
      if (growing) { try { await growing; } catch { /* grow never rejects; belt and braces */ } }
      const workers = [...live];
      live.clear();
      idle.length = 0;
      await Promise.all(workers.map(async (w) => {
        try { await w.terminate(); } catch { /* already dead */ }
      }));
    },
  };
}
