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
import { OCR_CONVERT_TIMEOUT_MS, OCR_JOB_TIMEOUT_MS } from "./ocrPool";
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
// Per-RPC backstop — the last resort for a request the main thread never answers at
// all (a lost reply, a listener torn down). It is NOT a second copy of the pool's
// budget, and it must not behave like one.
//
// IT COVERS THE WHOLE PIPELINE, because it is measured from a different instant than
// anything downstream. This clock starts when the request is POSTED; what follows is
// the raster→Blob conversion RPC (its own budget, OCR_CONVERT_TIMEOUT_MS = 30 s), then
// an unbounded wait in the pool's QUEUE — a page issues 7-13 reads at once onto 2-3
// workers — and only then the job's own budget, measured from DISPATCH. A backstop of
// `budget + slack` therefore fires while perfectly healthy reads are still converting
// or still queued, and every one of those spurious non-answers costs a re-read, which
// puts MORE load on the pool that was already running late. That cascade is what a
// browser probe was showing: 13-14 non-answers a run, all "recovered", on four sheets
// where nothing was actually lost. So the sum is explicit —
// conversion + job + slack — and each term is the constant that actually governs
// that stage.
//
// IT STILL SCALES WITH THE JOB'S BUDGET. A re-read is dispatched with a DOUBLED budget
// (RETRY_JOB_TIMEOUT_MS, named per call by the aligner); a backstop fixed at the
// ordinary read's figure would fire early on a job entitled to 40 s, turning the whole
// point of the longer budget into a non-answer the caller can no longer retry.
//
// Reaching it still means one of two things — a lost reply, or a job whose budget
// expired without the answer coming back — and it cannot tell them apart, so both are
// reported as NON-ANSWERS (see `finish`).
const OCR_BACKSTOP_SLACK_MS = 5_000;
const backstopFor = (jobBudgetMs?: number) =>
  OCR_CONVERT_TIMEOUT_MS + (jobBudgetMs ?? OCR_JOB_TIMEOUT_MS) + OCR_BACKSTOP_SLACK_MS;
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
    // Reported as a NON-ANSWER, because that is what it is either way: a job whose
    // budget expired without the reply coming back, or a reply that went missing.
    // Neither is "this crop holds no text", and calling it that hides a lost band
    // behind an empty answer. The cost of being wrong is bounded — a retry is one
    // extra pass over one band, it is itself subject to the same backstop, and it
    // never recurses.
    //
    // CANCELLED ON THE MAIN THREAD FIRST. Giving up here does not stop the work: the
    // request may still be sitting in the pool's queue, and a queued job has no
    // deadline of its own, so without this the run pays for a crop nobody will read —
    // and pays for it exactly when the pool is already the bottleneck. `ocr-abort` is
    // the same message the abort path sends, and it is safe to send for a read that is
    // about to be reported as a non-answer: `attachOcrRpc` drops the reply for an
    // aborted id, and `recognize` suppresses the duplicate `onNoResult` an abort would
    // otherwise raise, so the read settles here once and only once.
    const timer = setTimeout(() => {
      (self as any).postMessage({ kind: "ocr-abort", ocrId: id });
      finish([], true);
    }, backstopFor(opts?.timeoutMs));
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
