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
  /** Per-job budget in ms, read at DISPATCH time so tests can shorten it after the pool exists. */
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
   */
  run(input: Input, opts?: { signal?: AbortSignal }): Promise<Result | OcrNoResult>;
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
  signal?: AbortSignal;
  onAbort?: () => void;
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
  let pending = 0;                // workers reserved in `grow()` but not created yet
  let busy = 0;
  let creating = false;
  let warm = false;
  let destroyed = false;

  const settle = (job: Job<Input, Result>, value: Result | OcrNoResult) => {
    if (job.settled) return;
    job.settled = true;
    if (job.signal && job.onAbort) job.signal.removeEventListener("abort", job.onAbort);
    job.resolve(value);
  };
  const fail = (job: Job<Input, Result>, err: unknown) => {
    if (job.settled) return;
    job.settled = true;
    if (job.signal && job.onAbort) job.signal.removeEventListener("abort", job.onAbort);
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
    if (!destroyed && !creating && live.size + pending < desired()) void grow();
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
        if (destroyed) { try { worker.terminate(); } catch { /* ignore */ } return; }
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
      onTimeout?.();
      settle(job, OCR_NO_RESULT);
      busy--;
      retire(worker);   // only this worker; siblings keep their jobs
      pump();           // …and a replacement is created lazily if work remains
    }, timeoutMs());
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
          settle(job, result); // no-op if the job was aborted mid-flight
          release(worker);
        },
        (err) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
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
        };
        if (job.signal) {
          job.onAbort = () => {
            const at = queue.indexOf(job);
            if (at >= 0) queue.splice(at, 1); // still queued: it never runs
            settle(job, OCR_NO_RESULT);       // in flight: result ignored on arrival
          };
          job.signal.addEventListener("abort", job.onAbort, { once: true });
        }
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
      const workers = [...live];
      live.clear();
      idle.length = 0;
      for (const job of queue.splice(0)) settle(job, OCR_NO_RESULT);
      // In-flight jobs are left to their fate: terminating their worker makes
      // recognize() reject (→ the caller's error path) and, if it never settles
      // at all, the dispatch timer still fires and resolves them OCR_NO_RESULT.
      await Promise.all(workers.map(async (w) => {
        try { await w.terminate(); } catch { /* already dead */ }
      }));
    },
  };
}
