/**
 * Stitch feasibility probe worker.
 *
 * Runs the SAME deterministic aligner that "Add & auto-align" runs, once, in a
 * worker with its OWN mupdf document (mupdf docs are not safe to share with the
 * modal's thumbnail-render loop). The result feeds the button's feasibility gate
 * and is committed verbatim on click, so the heavy stitch runs once, not twice.
 *
 * Mirrors the mupdf-in-worker init pattern of src/core/pdf/tiles/tileRender.worker.ts.
 */
import { autoStitch, AutoStitchAborted } from "./autoStitch";
import { OCR_JOB_TIMEOUT_MS } from "./ocrPool";
import { toProbeResult, type ProbeRequest, type ProbeMessage } from "./stitchProbe";
import type { OcrWord, RawImage } from "./ocrService";

let mupdf: any = null;
async function ensureMupdf() {
  if (!mupdf) mupdf = (await import("mupdf")).default;
}

// Cooperative-abort WATERMARK. A plain "Add pages" click, a superseded check or an
// expired time budget posts {kind:"abort", docId}; the running autoStitch for that
// docId then throws AutoStitchAborted at its next checkpoint.
//
// A high-water mark, not "the last docId anyone asked to stop". Probes are
// serialized but their aborts are not: the budget for probe N fires and aborts N,
// the user immediately hits Re-check, and the hook's stop() aborts N+1 — which,
// with a single scalar, CLOBBERED the request to stop N. Probe N's
// `abortDocId === docId` test went false again, so it ran to completion with the
// Re-check queued behind it: exactly the grind the budget exists to prevent.
// `>=` on a watermark cannot be un-set.
//
// Starting at -1 also matters. `abortDocId = 0` matched AddPdfModal's very first
// probe, which posts docId 0 (it only increments on supersede), so that probe saw
// shouldAbort() true at its first checkpoint and gave up before doing any work.
let abortUpTo = -1;

// ── OCR over RPC to the main thread (tesseract cannot nest here portably) ──
// SEVERAL requests are outstanding at once: autoStitch issues a whole page's band
// reads in one burst and keeps the next page's burst in flight behind it. That is
// exactly why the pending map is keyed by ocrId — replies may land in any order,
// and each one settles only its own call.
let ocrSeq = 0;
const ocrPending = new Map<number, (words: OcrWord[], noResult: boolean) => void>();
// Per-RPC backstop. Longer than the main-thread pool's own per-job budget
// (OCR_JOB_TIMEOUT_MS), but the two are NOT measured from the same instant and this
// one does not reliably come second: the pool's clock starts when a worker DISPATCHES
// the job, this one when the request is POSTED. A page issues 7-13 reads at once onto
// a pool of 2-3 workers, so a read queued behind two others can dispatch 5s or more
// after it was posted — and its 20s non-answer then lands at t=25s+, after this
// fired. So reaching the backstop means one of two things, a lost reply or a job
// whose budget expired while it waited, and it cannot tell them apart; both are
// reported as NON-ANSWERS (see `finish`).
//
// IT SCALES WITH THE JOB'S BUDGET. A re-read is dispatched with a DOUBLED budget
// (RETRY_JOB_TIMEOUT_MS, named per call by the aligner); a fixed 25 s backstop would
// then fire at 25 s on a job entitled to 40 s, turning the whole point of the longer
// budget into a non-answer the caller can no longer retry. So the backstop is always
// the job's own budget plus the same 5 s of slack it has always carried.
const OCR_BACKSTOP_SLACK_MS = 5_000;
const backstopFor = (jobBudgetMs?: number) => (jobBudgetMs ?? OCR_JOB_TIMEOUT_MS) + OCR_BACKSTOP_SLACK_MS;
// Counts every RPC autoStitch makes through its `ocr` callback for the CURRENT
// probe — reset at the top of `handle()` so a persistent worker's later probes
// don't accumulate a prior run's count.
//
// Only the FAILURE paths report it now. A probe that finished carries `autoStitch`'s
// own `ocrStats` out instead (`toProbeResult`), which counts the same reads plus the
// four things this tally cannot see — non-answers, retries, unknown reads, withheld
// votes. A probe that threw has no `AutoStitchResult` to take those from, and "we
// spent N round-trips getting nowhere" is still worth saying.
let ocrCallCount = 0;
function ocrViaMain(
  image: RawImage,
  opts?: { signal?: AbortSignal; onNoResult?: () => void; timeoutMs?: number },
): Promise<OcrWord[]> {
  return new Promise((resolve) => {
    const signal = opts?.signal;
    // Counted below the guard: a read that is never issued is not a round-trip,
    // and reporting it would inflate the probe's ocrCalls on every abort.
    if (signal?.aborted) { resolve([]); return; }
    ocrCallCount++;
    const id = ++ocrSeq;
    let settled = false;
    const finish = (words: OcrWord[], noResult = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ocrPending.delete(id);
      signal?.removeEventListener("abort", onAbort);
      // Forwarded before resolving so the caller's flag is set by the time its
      // `await` continues — `autoStitch` reads it right after the read settles.
      if (noResult) opts?.onNoResult?.();
      resolve(words);
    };
    // Reported as a NON-ANSWER, because that is what it is either way: a queued job
    // whose budget expired late, or a reply that went missing. Neither is "this crop
    // holds no text", and calling it that hides a lost band behind an empty answer.
    // The cost of being wrong is bounded — a retry is one extra pass over one band,
    // it is itself subject to the same backstop, and it never recurses.
    const timer = setTimeout(() => finish([], true), backstopFor(opts?.timeoutMs));
    // Forwarding the abort is what actually stops the work. An aborted read is
    // usually still QUEUED in the main thread's pool, and a queued job has no
    // deadline of its own — resolving [] here alone would leave the pool grinding
    // through a whole abandoned probe's worth of crops.
    const onAbort = () => {
      (self as any).postMessage({ kind: "ocr-abort", ocrId: id });
      finish([]);
    };
    ocrPending.set(id, finish);
    (self as any).postMessage({ kind: "ocr-req", ocrId: id, image, timeoutMs: opts?.timeoutMs }, [image.data.buffer]);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// A persistent worker can receive a new document (rapid "Change file") while a
// prior probe is still running. Chain each request onto the previous so two
// autoStitch passes never interleave on the shared mupdf WASM instance, and skip
// any request already superseded by a newer docId before it starts.
let latestDocId = 0;
let queue: Promise<void> = Promise.resolve();

async function handle(req: ProbeRequest) {
  const { docId, pdfBytes, pageIndices, userScale, pageScales, pageCodes, ocrConcurrency } = req;
  if (docId !== latestDocId) return; // superseded before we started — skip
  ocrCallCount = 0;
  try {
    await ensureMupdf();
    const doc = mupdf.Document.openDocument(pdfBytes, "application/pdf");
    let res;
    try {
      res = await autoStitch(mupdf, doc, pageIndices, {
        userScale,
        pageScales: pageScales ? new Map(pageScales) : undefined,
        pageCodes: pageCodes ? new Map(pageCodes) : undefined,
        // Undefined leaves `autoStitch` to size the batch off this machine's cores.
        // The takeoff-flow hook always names 3 — see `ProbeRequest.ocrConcurrency`.
        ocrConcurrency,
        ocr: ocrViaMain,
        shouldAbort: () => abortUpTo >= docId,
        onOcrStart: () => self.postMessage({ kind: "ocrPhase", docId }),
      });
    } finally {
      doc.destroy?.();
    }
    const msg: ProbeMessage = toProbeResult(res, docId);
    self.postMessage(msg);
  } catch (err) {
    // An abort is not a failure — report it as skipped so the modal shows no toast.
    const msg: ProbeMessage = err instanceof AutoStitchAborted
      ? { docId, aborted: true, ocrCalls: ocrCallCount }
      : { docId, error: String(err), ocrCalls: ocrCallCount };
    self.postMessage(msg);
  }
}

self.onmessage = (e: MessageEvent<any>) => {
  if (e.data && e.data.kind === "ocr-res") {
    const cb = ocrPending.get(e.data.ocrId);
    ocrPending.delete(e.data.ocrId);
    cb?.(e.data.words as OcrWord[], e.data.noResult === true);
    return;
  }
  if (e.data && e.data.kind === "abort") {
    // Stop the running (or queued) probe for this docId — and every earlier one —
    // at its next checkpoint. Never lowers: see `abortUpTo`.
    abortUpTo = Math.max(abortUpTo, e.data.docId);
    return;
  }
  latestDocId = (e.data as ProbeRequest).docId;
  // .catch keeps the chain self-healing: handle() cannot reject today, but a
  // future edit that let it throw would otherwise poison every later request
  // (the tail would stay a rejected promise → permanent worker death).
  queue = queue.then(() => handle(e.data as ProbeRequest)).catch(() => {});
};
