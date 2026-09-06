/**
 * Auto-align, EARNED.
 *
 * Mark, 2026-09-04: "if the system says it can auto-align I want it to work otherwise
 * it doesn't even have it as an option. I also want the speed at which it identifies
 * if autoalign will work to be relatively quick and nonblocking."
 *
 * So the takeoff flow no longer decides up front. The sheets are placed in a GRID
 * immediately — the canvas is interactive within a frame — and this hook then runs the
 * existing feasibility probe over exactly those sheets in its worker. Only a probe that
 * clears `autoAlignGate` puts an **Auto-align N sheets** button in the step strip;
 * anything else becomes a note saying which of the three things was missing. Nothing
 * here ever blocks input: the probe is a worker, the strip is a chip, and the user can
 * drag sheets around, add more, or leave the whole time.
 *
 * Two rules follow from "the user can keep working while the check runs":
 *
 *  - the set is always derived from the CANVAS (`canvasProbeSet`), never from the
 *    pages of whichever commit ran last, so an Add PDF re-check covers plan sheets and
 *    added sheets together and the offer places ONE composite;
 *  - the probe's placements are ABSOLUTE, so before applying them the hook checks that
 *    nothing moved since the check (`movedSinceCheck`). If anything did, the offer
 *    becomes a re-check prompt instead of quietly discarding the user's own drags or
 *    resurrecting a sheet they deleted.
 *
 * Running it re-commits through `commitAutoAlign` with the probe's placements CACHED
 * (the solver does not run twice), which is also what routes the commit through T0's
 * demotion — a sheet the seam report cannot stand behind is placed below rather than
 * claimed. The grid tiles are swapped for the aligned ones in ONE undo step.
 *
 * NEVER A VERDICT ON UNKNOWN EVIDENCE. The aligner reports what its OCR channel did
 * (`ProbeResult.ocrStats`), and `unknown > 0` means it reached its answer without a read
 * it asked for twice — a timed-out band, a lost strip, an unread title block. Those are
 * exactly the reads that make two probes of the SAME four sheets disagree, so a reply
 * carrying one is not shown at all: the hook re-runs the check ONCE, silently, on a
 * fresh budget with the status still "checking". If the second run has a hole too, the
 * honest answer is the one the time budget already gives — "the check took too long",
 * with Re-check still there — rather than a verdict that happens to rest on whichever
 * reads came back this time.
 *
 * THE ANSWER MAY ALREADY EXIST. CTO's droplet probes the combined PDF on the way out of
 * the combine, with a Lambda running THIS repo's engine bundle, and stores the verdict on
 * `site_sheet_sources.probe`. When the takeoff flow hands one over, `check()` takes it
 * instead of spending the minute — but only when it is provably an answer to the SAME
 * question: the same engine commit (`ENGINE_VERSION`), the same plan (`planHashHex`), the
 * same page set and scales (`serverProbeRequestMatches` against `canvasProbeSet`), and
 * evidence with no holes in it (`ocrStats.unknown === 0`, the same bar a worker reply has
 * to clear). A row still being computed is polled
 * briefly (2 s apart, 20 s in total, with the strip saying exactly what it says for any
 * check in flight); anything else — an older CTO, a different build, a `status` of
 * `unknown`/`timeout`/`error`, a plan since edited — is not a verdict, and the worker runs
 * as it always has. Never a gate, only a shortcut: every failure lands on the same probe
 * that would have run anyway. `recheck()` is the user asking THIS browser to look again,
 * so it never consults the row.
 *
 * `check()` also carries a soft time budget (`PROBE_BUDGET_MS`): if the worker has not
 * settled 60s after the request went out, the hook sends the probe the same abort it
 * would send on a superseded check, and reports `unavailable`/`too_slow` — "it never
 * grinds" is a promise about wall-clock time, not just about the UI staying responsive
 * while the probe runs. `recheck()` — the user asking again on purpose — gets a much
 * longer leash (`RECHECK_BUDGET_MS`), so a Re-check after the budget fires has room for
 * a real answer, but it is still bounded: un-budgeted, a Re-check on a set the aligner
 * cannot finish spun forever.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { PDFRenderer } from "@/core/pdf/PDFRenderer";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { attachOcrRpc, shutdownOcr } from "./autostitch/ocrService";
import { autoAlignGate } from "./autostitch/feasibility";
import type { ProbeMessage, ProbeRequest, ProbeResult } from "./autostitch/stitchProbe";
import { commitAutoAlign, type CommitResult } from "./commitPages";
import { AutoStitchAborted, type OcrStats } from "./autostitch/autoStitch";
import type { AutoAlignUnavailableReason } from "./addToProjectCopy";
import { canvasProbeSet, hasMixedSources, movedSinceCheck, type CanvasProbeSet } from "./earnedAutoAlignSet";
import { ENGINE_VERSION } from "./autostitch/engineVersion";
import { classifyServerProbe, planHashHex, type ServerProbe } from "./ctoSessionSource";

/** How long a probe gets before the hook stops waiting and says so instead. */
const PROBE_BUDGET_MS = 60_000;
/** A manual Re-check gets a far longer leash — the user asked again on purpose, and
 *  the budget exists to stop an UNATTENDED probe from grinding, not to hurry a
 *  deliberate retry. But it is still a leash: unbounded meant a Re-check on a set the
 *  aligner cannot finish spun forever with no way out but closing the modal. */
const RECHECK_BUDGET_MS = 3 * PROBE_BUDGET_MS;

/**
 * OCR batch width for every browser probe this hook runs.
 *
 * Named rather than left to `defaultOcrPoolSize()` because the SERVER probe runs at 3
 * (`probeNode.ts`, `NODE_OCR_POOL_SIZE`) and the two have to be interchangeable: the
 * aligner stops issuing strips once one has hit, so the chunk width decides which
 * bands are read and what the honesty counters say. A 4-core laptop chunking at 2 and
 * a Lambda chunking at 3 are two different questions. Placements are unaffected —
 * this changes what is READ, not how the reads are solved.
 */
const BROWSER_OCR_CONCURRENCY = 3;

/** How often a `pending` server verdict is re-read, and for how long in total. Past
 *  the window the editor stops waiting and probes in the browser — a check that sits
 *  on a spinner waiting for somebody else's job is exactly what this feature is
 *  supposed to remove. */
const SERVER_POLL_INTERVAL_MS = 2_000;
const SERVER_POLL_WINDOW_MS = 20_000;

/** The `[probe]` line for a verdict nobody in this browser computed. Same shape as
 *  every other settle line — the `ms` is how long the EDITOR waited (a hit is instant;
 *  a poll is however long the Lambda still had to run), the counters are the server's
 *  own, and ` (server)` says where the answer came from. */
const SERVER_SOURCE = " (server)";

/**
 * Re-read the stored verdict. `null` for anything that is not a probe object — a 4xx
 * on an expired token, a 5xx, a network drop, a body that is not JSON.
 *
 * Never throws and never distinguishes those cases, deliberately: every one of them
 * means the same thing to the caller ("no verdict from here"), and the caller's answer
 * to that is already the right one — run the browser probe.
 *
 * IT HAS ITS OWN DEADLINE. The poll loop's 20 s window is enforced by comparing clocks
 * BETWEEN reads, so it only advances when a read comes back: one request that hangs
 * (a captive-portal proxy, a socket that is never reset) parked the hook in "checking"
 * with no escape and no probe running — the one state this feature must never produce.
 * One poll interval is the whole budget a poll deserves; the abort lands in the catch
 * below like any other failure, and the loop moves on to the next tick or gives up.
 */
async function fetchServerProbe(url: string): Promise<unknown> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(SERVER_POLL_INTERVAL_MS) });
    if (!res.ok) return null;
    const json = (await res.json()) as { probe?: unknown } | null;
    return json?.probe ?? null;
  } catch {
    return null;
  }
}

/** Session knowledge the canvas cannot supply. Remembered between checks. */
export interface EarnedAutoAlignContext {
  /** Sheet identity CTO already knows, by page index (the plan's labels). Free — CTO
   *  ran its own extraction — and it is what the aligner otherwise has to OCR out of a
   *  title block. Pages CTO does not know are simply absent. */
  pageCodes?: Map<number, string>;
  /** Matches the commit that placed the grid, so a re-align produces identical tiles. */
  removeWhiteBackground?: boolean;
  /**
   * The verdict CTO's droplet already computed for this page set
   * (`site_sheet_sources.probe`, handed over by `GET /api/nanodoc/pdf`).
   *
   * Only honoured on the check that SUPPLIES it — a later `check()` (Add PDF added
   * sheets, the user pressed Re-check) is asking about a canvas this verdict was never
   * about, and runs the browser probe. `null`/absent is the ordinary case: an older
   * CTO build, a row whose probe never ran, a session that is not a takeoff handoff.
   */
  serverProbe?: unknown;
  /** The RAW stitch plan the verdict must hash to — the same object CTO sent, unparsed
   *  and un-reserialised, because the hash is over `JSON.stringify` of exactly it. */
  plan?: unknown;
  /** `GET /api/nanodoc/probe?token=…`, for re-reading a verdict that was still being
   *  computed when the editor opened. Absent means a pending row cannot be polled, so
   *  it is treated as no verdict. */
  probeUrl?: string | null;
}

export type EarnedAutoAlignStatus =
  | "idle"
  | "checking"
  | "offer"
  | "unavailable"
  /** The offer was real but the canvas moved under it — see `movedSinceCheck`. */
  | "stale"
  | "aligning";

export interface EarnedAutoAlign {
  status: EarnedAutoAlignStatus;
  /** Sheets the offer would CLAIM (along-anchored, past the commit's demotion). */
  sheets: number;
  reason?: AutoAlignUnavailableReason;
  /** The fuller sentence behind the short reason. */
  detail?: string;
  /** Page render progress while a run is committing. */
  progress: { done: number; total: number } | null;
  /** Probe the sheets on the canvas now. Supersedes any check already running. */
  check: (ctx?: EarnedAutoAlignContext) => void;
  /** Re-run the check over the canvas as it stands (the Re-check action). */
  recheck: () => void;
  /** Drop the offer and stop any probe. */
  reset: () => void;
  /** Commit the offer. No-op unless there is one; becomes `"stale"` when the canvas
   *  moved since the check. */
  run: () => Promise<void>;
  /** Stop a run in progress. The commit throws before it writes anything, so the
   *  canvas is left exactly as it was and the offer still stands. */
  cancelRun: () => void;
  /** True once cancel has been asked for and the run has not yet noticed. */
  cancelling: boolean;
}

export function useEarnedAutoAlign(
  opts: {
    /** The finished commit, for the coach mark / strip counts / toast. */
    onAligned?: (result: CommitResult) => void;
    onError?: (message: string) => void;
  } = {},
): EarnedAutoAlign {
  const { onAligned, onError } = opts;
  const [status, setStatus] = useState<EarnedAutoAlignStatus>("idle");
  const [sheets, setSheets] = useState(0);
  const [reason, setReason] = useState<AutoAlignUnavailableReason | undefined>();
  const [detail, setDetail] = useState<string | undefined>();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  /** Polled by the commit between page renders; it throws AutoStitchAborted BEFORE
   *  anything is written, so a cancelled run leaves the grid untouched. */
  const abortRunRef = useRef(false);

  const workerRef = useRef<Worker | null>(null);
  /** Monotonic; a reply whose docId is not the current one is stale and ignored. */
  const docIdRef = useRef(0);
  const setRef = useRef<CanvasProbeSet | null>(null);
  const ctxRef = useRef<EarnedAutoAlignContext>({});
  const probeRef = useRef<ProbeResult | null>(null);
  /** `performance.now()` when the current probe request was sent — for the
   *  settle-time log below. */
  const checkStartRef = useRef(0);
  /** The pending soft-budget timeout for the check in flight, if any. Cleared on
   *  settle, on unmount, and by every `stop()` (a superseded check or a reset) so it
   *  never fires for a check that is no longer the current one. */
  const budgetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Set on unmount so a reply that lands after teardown writes no state. RESET on
   *  every mount — see the effect below. */
  const goneRef = useRef(false);
  /** True while the probe in flight IS the automatic re-check — the ONE extra run a
   *  reply with unknown reads earns. Only the `[probe]` line reads it. */
  const autoRerunRef = useRef(false);
  /** Latched once the current USER-initiated check has spent its automatic re-check,
   *  and cleared by the next user-initiated `check()`. This is what makes it ONE
   *  re-check and not a loop: a set whose sheets time out every single run would
   *  otherwise re-probe forever, which is precisely the grind the time budget exists
   *  to prevent. */
  const autoRecheckSpentRef = useRef(false);
  /** How the reply handler asks for that re-check. It cannot call `check` directly —
   *  the handler is built inside `ensureWorker`, which `check` depends on, so closing
   *  over it would be a cycle. Assigned below, once `check` exists. */
  const autoRecheckRef = useRef<() => void>(() => {});

  const clearBudget = useCallback(() => {
    if (budgetTimerRef.current !== null) {
      clearTimeout(budgetTimerRef.current);
      budgetTimerRef.current = null;
    }
  }, []);

  /** One line per check that stopped waiting: how long it took, and what its OCR
   *  channel did. Cheap enough to leave in always — it is the only visibility into
   *  probe cost and probe HONESTY outside the offline harness (scripts/stitch-eval.mjs),
   *  and the counters are what tell a flipping verdict (`unknown > 0`) apart from a
   *  genuinely borderline set (`unknown` 0 and the answer still changes).
   *
   *  Shared by a normal worker reply, by the budget expiring, and by a reply that is
   *  thrown away in favour of the automatic re-check — all three are ways a check
   *  stopped waiting, and the discarded one is the one whose cost would otherwise
   *  vanish (its wall-clock and its reads are NOT included in the re-check's line).
   *
   *  TWO formats, because there are two kinds of settle. A settle behind an
   *  `AutoStitchResult` has the full tally and prints it. A settle that has none — an
   *  abort, an error, a budget that expired without any reply — has only the worker's
   *  own round-trip count, and prints the SHORT line this log has always used for that
   *  case. Padding the long format with placeholders printed `NaN non-answers, NaN
   *  retries, …` on the commonest line in the file (a user-caused abort), which is
   *  noise, not honesty: "we were never told" is what a missing tally means, and
   *  omitting the counters says exactly that. */
  const logSettle = useCallback(
    (settled: string, stats: OcrStats | null, calls: number | undefined, rerun: boolean, source = "") => {
      const ms = Math.round(performance.now() - checkStartRef.current);
      if (!stats) {
        console.info("[probe] %s: %d ms, %s OCR calls%s", settled, ms, calls == null ? "?" : String(calls), source);
        return;
      }
      console.info(
        "[probe] %s: %d ms, %d OCR calls, %d non-answers, %d retries, %d unknown, %d withheld%s",
        settled, ms, stats.calls, stats.nonAnswers, stats.retries, stats.unknown, stats.withheldVotes,
        source || (rerun ? " (auto re-check)" : ""),
      );
    },
    [],
  );

  // Callbacks live in refs so `check`/`run` stay stable and a caller need not
  // memoise its handlers to avoid re-probing.
  const onAlignedRef = useRef(onAligned);
  const onErrorRef = useRef(onError);
  onAlignedRef.current = onAligned;
  onErrorRef.current = onError;

  /**
   * One worker, created on first use and terminated on unmount. `attachOcrRpc` bridges
   * the worker's OCR requests to the shared tesseract POOL (`ocrService`, which owns
   * its own workers — the main thread only routes the messages).
   */
  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current;
    const w = new Worker(new URL("./autostitch/stitchProbe.worker.ts", import.meta.url), { type: "module" });
    attachOcrRpc(w);
    w.onmessage = (ev: MessageEvent<ProbeMessage>) => {
      const msg = ev.data;
      if ((msg as { kind?: string })?.kind) return; // ocr-req / ocrPhase frames
      if (goneRef.current || msg.docId !== docIdRef.current) return; // stale
      // The worker answered — the budget that was watching this same check is moot.
      clearBudget();
      const rerun = autoRerunRef.current;
      // Tesseract's 160-240 MB goes back on every path that ENDS here (`ensurePool`
      // rebuilds it lazily). Deliberately not at the top of the handler: the automatic
      // re-check below starts another probe immediately, and shutting the pool down
      // first made that probe pay a full pool boot AND briefly hold two pools' worth
      // of memory. The re-check's own settle releases it, exactly like any other.
      const releaseOcr = () => { void shutdownOcr(); };
      if ("aborted" in msg) { releaseOcr(); setStatus("idle"); logSettle("aborted", null, msg.ocrCalls, rerun); return; }
      if ("error" in msg) {
        // A failed check is not a failed feature: the sheets are already on the canvas
        // in a grid, and the honest thing is to say the seams were not verified rather
        // than offer a button on a probe that never finished.
        releaseOcr();
        console.warn("[earnedAutoAlign] probe failed:", msg.error);
        probeRef.current = null;
        setReason("unverified");
        setDetail(undefined);
        setStatus("unavailable");
        logSettle("error", null, msg.ocrCalls, rerun);
        return;
      }
      // NEVER A VERDICT ON UNKNOWN EVIDENCE (see the header). A reply with no
      // `ocrStats` is a stub or an older worker: nobody told us, and the old
      // behaviour — show what came back — is the safe reading of that.
      const stats = msg.ocrStats ?? null;
      if (stats && stats.unknown > 0) {
        if (!autoRecheckSpentRef.current) {
          autoRecheckSpentRef.current = true;
          // Logged before it is thrown away, so the run's cost is on the record and
          // the reason for the second run is visible: this line is the only place the
          // discarded reply is ever mentioned.
          logSettle("re-checking", stats, msg.ocrCalls, rerun);
          // Status stays "checking" and nothing else is written, so the strip does not
          // flicker: `check` re-asserts exactly the values a check in flight already has.
          // No `releaseOcr()`: the re-check is about to read with that same pool.
          autoRecheckRef.current();
          return;
        }
        // Twice now. Whatever this run decided rests on reads that never came back, and
        // showing it would be the flip the whole exercise exists to stop. The time
        // budget's answer is the true one — and it is the one unavailable reason that
        // keeps the Re-check action (TakeoffModeStrip), which is what the user wants.
        releaseOcr();
        probeRef.current = null;
        setSheets(0);
        setReason("too_slow");
        setDetail(undefined);
        setStatus("unavailable");
        logSettle("unavailable", stats, msg.ocrCalls, rerun);
        return;
      }
      releaseOcr();
      probeRef.current = msg;
      const gate = autoAlignGate(msg, setRef.current?.pageIndices ?? []);
      if (gate.offered) {
        setSheets(gate.sheets);
        setStatus("offer");
      } else {
        setReason(gate.reason);
        setDetail(gate.detail);
        setStatus("unavailable");
      }
      logSettle(gate.offered ? "offer" : "unavailable", stats, msg.ocrCalls, rerun);
    };
    workerRef.current = w;
    return w;
  }, []);

  useEffect(() => {
    // StrictMode mounts, unmounts and IMMEDIATELY remounts in dev. The cleanup below
    // latches `goneRef`, and with nothing resetting it the remounted hook discarded
    // every reply — the chip spun forever and no offer ever appeared. The flag belongs
    // to the CURRENT mount, so it is cleared here, not only set there.
    goneRef.current = false;
    return () => {
      goneRef.current = true;
      clearBudget();
      workerRef.current?.terminate();
      workerRef.current = null;
      void shutdownOcr();
    };
  }, []);

  /**
   * An undo can put the canvas back exactly as the probe saw it — the usual way out of
   * a stale offer is Ctrl+Z, not a re-check — and the probe's answer is valid again the
   * moment the poses match. So while the offer is withdrawn, watch the store and take
   * it back up rather than making the user pay for a second check that would return
   * the same result.
   */
  useEffect(() => {
    if (status !== "stale") return;
    const recover = () => {
      const set = setRef.current;
      if (!set || !probeRef.current) return;
      if (!movedSinceCheck(set, useStitchStore.getState().tiles)) setStatus("offer");
    };
    recover();
    return useStitchStore.subscribe(recover);
  }, [status]);

  /** Stop whatever is running and make any reply still in flight stale. Also retires
   *  the budget watching that same check — it belongs to the check `stop` just ended,
   *  not to whatever runs next. */
  const stop = useCallback(() => {
    clearBudget();
    workerRef.current?.postMessage({ kind: "abort", docId: docIdRef.current });
    docIdRef.current++;
  }, [clearBudget]);

  const reset = useCallback(() => {
    stop();
    // Same hole as the budget path: `stop()` bumps `docIdRef`, so the abandoned
    // probe's own reply is discarded as stale before it can release OCR. Nothing
    // else is running (this hook probes one at a time), so this is unconditional.
    void shutdownOcr();
    setRef.current = null;
    probeRef.current = null;
    setSheets(0);
    setReason(undefined);
    setDetail(undefined);
    setStatus("idle");
  }, [stop]);

  /**
   * Ask the worker. Everything from the request to the soft time budget — the path a
   * check has always taken, extracted so the server shortcut above it can fall back
   * into it from anywhere (a verdict that does not fit, a poll that ran out of time, a
   * canvas that moved while a verdict was being fetched).
   *
   * Assumes `stop()` has already run and `setStatus("checking")` has been set: it
   * posts on the CURRENT `docIdRef`, which is what makes a fallback a continuation of
   * the same check rather than a new one.
   */
  const startBrowserProbe = useCallback(
    (set: CanvasProbeSet, budgetMs: number) => {
      const req: ProbeRequest = {
        docId: docIdRef.current,
        pdfBytes: set.pdfBytes,
        pageIndices: set.pageIndices,
        // The canvas's OWN scales, unlike the modal's uniform-only probe: this run has
        // to answer the question the commit will ask, because its placements are the
        // ones the commit reuses.
        userScale: set.uniformScale,
        pageScales: set.pageScales.size ? [...set.pageScales] : undefined,
        pageCodes: ctxRef.current.pageCodes?.size ? [...ctxRef.current.pageCodes] : undefined,
        // Named, not inferred from this machine — see BROWSER_OCR_CONCURRENCY.
        ocrConcurrency: BROWSER_OCR_CONCURRENCY,
      };
      checkStartRef.current = performance.now();
      const requestedDocId = req.docId;
      ensureWorker().postMessage(req);
      budgetTimerRef.current = setTimeout(() => {
        budgetTimerRef.current = null;
        // Belt-and-braces: `stop()`/`reset()` already clear this timer on every
        // superseded check, so this should be unreachable, but a reply landing in
        // the same tick as the timeout is not worth a race with `goneRef`.
        if (goneRef.current || requestedDocId !== docIdRef.current) return;
        // No reply at all, so not even a round-trip count: the short line's "?".
        logSettle("unavailable", null, undefined, autoRerunRef.current);
        // The SAME abort a superseded check (or a plain "Add pages" re-check) would
        // send — the worker does not need a different message to know to give up.
        stop();
        // …and hand tesseract's workers back, which nothing else will now do. The
        // reply handler's `shutdownOcr()` is guarded by the docId staleness check,
        // and `stop()` has just bumped `docIdRef` — so the worker's eventual
        // `{aborted:true}` is dropped BEFORE it can reach that release, and 160-240
        // MB stayed held until the component unmounted. No `ocrIdle()` guard is
        // needed here (AddPdfModal has one because it debounces and can have a
        // replacement already queued): this hook runs one probe at a time and
        // `stop()` has just abandoned it.
        void shutdownOcr();
        setReason("too_slow");
        setDetail(undefined);
        setStatus("unavailable");
      }, budgetMs);
    },
    [ensureWorker, stop, logSettle],
  );

  /**
   * The server shortcut, end to end.
   *
   * Three outcomes, and only the first of them skips the worker:
   *
   *  - the stored verdict is for THIS engine build, THIS plan and THIS page set (and
   *    nothing has moved on the canvas since the check began) → take it, run it through
   *    the same `autoAlignGate` a worker reply goes through, and settle;
   *  - a probe is genuinely still running (`pending`, not past its expiry) → re-read
   *    `GET /api/nanodoc/probe` every 2 s for at most 20 s, with the strip still saying
   *    "Checking whether these sheets can be auto-aligned…", then give up on it;
   *  - anything else — no row, an older row, a different build, a plan since edited, a
   *    different page set, a status of `unknown`/`timeout`/`error` → no verdict.
   *
   * Every path that is not "take it" ends in `startBrowserProbe`, so a server that is
   * down, slow, wrong or simply absent costs the user nothing but the poll window.
   *
   * `docId` is the check this began for: every await is a place the user could have
   * superseded it (Add PDF, Re-check) or left the page, so the guard is re-tested after
   * each one and a stale resolution writes nothing.
   */
  const resolveServerVerdict = useCallback(
    async (
      docId: number,
      set: CanvasProbeSet,
      budgetMs: number,
      server: { probe: unknown; plan: unknown; url: string | null; pageCodes: ReadonlyMap<number, string> | null },
    ) => {
      const live = () => !goneRef.current && docId === docIdRef.current;
      checkStartRef.current = performance.now();
      const hash = await planHashHex(server.plan);
      let probe = server.probe;
      const deadline = Date.now() + SERVER_POLL_WINDOW_MS;

      for (;;) {
        if (!live()) return;
        const verdict = classifyServerProbe({
          probe,
          engineVersion: ENGINE_VERSION,
          planHash: hash,
          canvas: set,
          pageCodes: server.pageCodes,
          nowMs: Date.now(),
        });

        if (verdict === "use") {
          // A tile the user dragged while this was resolving does NOT send the check
          // back to the worker. The verdict is about the PAGES, and a browser probe of
          // the same set would answer the same thing — while a canvas that has moved is
          // already handled, once, in `run()`: it withdraws the offer as `"stale"` and
          // an undo puts it straight back. Re-probing here would spend the minute this
          // whole path exists to save and land on the identical stale offer.
          const row = probe as ServerProbe;
          const result = row.result as ProbeResult;
          probeRef.current = result;
          const gate = autoAlignGate(result, set.pageIndices);
          if (gate.offered) {
            setSheets(gate.sheets);
            setStatus("offer");
          } else {
            setReason(gate.reason);
            setDetail(gate.detail);
            setStatus("unavailable");
          }
          logSettle(
            gate.offered ? "offer" : "unavailable",
            (row.ocrStats as OcrStats | null) ?? null,
            row.ocrStats?.calls,
            false,
            SERVER_SOURCE,
          );
          return;
        }

        if (verdict !== "wait" || !server.url || Date.now() >= deadline) break;
        await new Promise<void>((resolve) => setTimeout(resolve, SERVER_POLL_INTERVAL_MS));
        if (!live()) return;
        probe = await fetchServerProbe(server.url);
      }

      if (!live()) return;
      startBrowserProbe(set, budgetMs);
    },
    [logSettle, startBrowserProbe],
  );

  const check = useCallback(
    // `budgetMs` and `auto` are internal-only — `recheck` below passes the longer
    // leash, and the reply handler passes `auto` for its one silent re-run. Not part
    // of the public `EarnedAutoAlign["check"]` signature; TS allows the wider
    // function here.
    (ctx?: EarnedAutoAlignContext, budgetMs: number = PROBE_BUDGET_MS, auto = false, skipServer = false) => {
      // The server verdict is honoured only on the check that HANDS IT OVER, and never
      // for the two internal reruns: `recheck()` is the user asking this browser to
      // look again (answering it from a row would make the button a no-op), and the
      // automatic re-check exists precisely because a probe answered on holed
      // evidence — re-serving a stored verdict would answer with the same hole.
      const server =
        !auto && !skipServer && ctx?.serverProbe != null
          ? {
              probe: ctx.serverProbe,
              plan: ctx.plan,
              url: ctx.probeUrl ?? null,
              // Read AFTER the merge below, so a check that supplies codes and a
              // verdict in one call compares against the codes it just supplied.
              pageCodes: null as ReadonlyMap<number, string> | null,
            }
          : null;
      if (ctx) ctxRef.current = { ...ctxRef.current, ...ctx };
      if (server) server.pageCodes = ctxRef.current.pageCodes ?? null;
      stop();
      // A check the USER asked for earns a fresh entitlement to one automatic re-check.
      // The automatic re-check must not grant itself another — that is the loop.
      if (!auto) autoRecheckSpentRef.current = false;
      autoRerunRef.current = auto;
      probeRef.current = null;
      setSheets(0);
      setReason(undefined);
      setDetail(undefined);
      // The WHOLE canvas, so the offer places one composite. Null means there is
      // nothing honest to check (fewer than two sheets, or two source PDFs one solve
      // cannot span); say nothing rather than offer half an answer.
      const tiles = useStitchStore.getState().tiles;
      const set = canvasProbeSet(tiles);
      setRef.current = set;
      if (!set) {
        // This check posts nothing, so nothing downstream will hand tesseract back —
        // and the reply handler now KEEPS the pool alive across an automatic re-check.
        // A canvas that lost a sheet between the discarded reply and the re-check
        // lands exactly here, so the release belongs here too. A no-op when no pool
        // was ever built, which is the usual case.
        void shutdownOcr();
        // Null has two meanings and only one of them is "nothing to say". A canvas
        // built from two PDFs is a real answer the user can act on (align them one
        // document at a time), so it gets the note rather than silence.
        if (hasMixedSources(tiles)) {
          setReason("mixed_sources");
          setDetail(undefined);
          setStatus("unavailable");
        } else {
          setStatus("idle");
        }
        return;
      }
      setStatus("checking");
      // THE SHORTCUT. A verdict CTO's droplet already computed for exactly this page
      // set, this plan and this engine build is the same answer the worker below would
      // spend a minute of OCR reaching. `resolveServerVerdict` takes it when it fits,
      // waits briefly when one is still being computed, and otherwise starts the very
      // browser probe this branch skipped. Only for the check that CARRIED the verdict:
      // see `EarnedAutoAlignContext.serverProbe`.
      if (server) {
        void resolveServerVerdict(docIdRef.current, set, budgetMs, server);
        return;
      }
      startBrowserProbe(set, budgetMs);
    },
    [stop, startBrowserProbe, resolveServerVerdict],
  );

  // The user asking again on purpose gets a much longer answer window, but not an
  // infinite one — see RECHECK_BUDGET_MS.
  const recheck = useCallback(() => check(undefined, RECHECK_BUDGET_MS, false, true), [check]);

  // The automatic re-check the reply handler fires when a reply came back with unknown
  // reads. A FRESH normal budget, not the Re-check leash: this is not the user asking
  // again, it is the hook declining to answer, and it must stay inside the same "never
  // grinds" promise a first check makes. Assigned every render (like the callback refs
  // above) so the handler, which is built once, always calls the current closure.
  autoRecheckRef.current = () => check(undefined, PROBE_BUDGET_MS, true);

  const run = useCallback(async () => {
    const set = setRef.current;
    const probe = probeRef.current;
    if (!set || !probe) return;
    // THE GUARD. The probe's placements are absolute and its tile list is a snapshot,
    // so applying them after the user has dragged, resized or deleted anything would
    // throw that work away and put deleted sheets back. Withdraw the offer instead and
    // ask for a re-check, which re-derives the set from the canvas as it now stands.
    if (movedSinceCheck(set, useStitchStore.getState().tiles)) { setStatus("stale"); return; }
    setStatus("aligning");
    abortRunRef.current = false;
    setCancelling(false);
    setProgress({ done: 0, total: set.pageIndices.length });
    let doc: any = null;
    let renderer: PDFRenderer | null = null;
    try {
      const mupdf = await import("mupdf").then((m) => m.default);
      doc = mupdf.Document.openDocument(set.pdfBytes, "application/pdf");
      renderer = new PDFRenderer(mupdf);
      const result = await commitAutoAlign({
        mupdf,
        doc,
        pdfBytes: set.pdfBytes,
        fileName: set.fileName,
        selected: set.pageIndices,
        pageScales: set.pageScales,
        uniformScale: set.uniformScale,
        pageCodes: ctxRef.current.pageCodes,
        removeWhiteBackground: ctxRef.current.removeWhiteBackground ?? true,
        renderer,
        onProgress: (done, total) => setProgress({ done, total }),
        shouldAbort: () => abortRunRef.current,
        // ONE undo step: the grid goes and the composite arrives together, so a single
        // undo restores the grid instead of leaving both sets of sheets on the canvas.
        replaceTileIds: set.tileIds,
        // The probe already paid for the stitch, and the honesty payload travels with
        // it — without `seamReport`/`alongAnchored` the commit's demotion would
        // silently do nothing and claim placements the gate never approved.
        cached: {
          placements: probe.placements,
          rootFtPerIn: probe.rootFtPerIn,
          worstResidFt: probe.worstResidFt,
          method: probe.method,
          seamReport: probe.seamReport,
          alignmentVerdict: probe.alignmentVerdict,
          alongAnchored: probe.alongAnchored,
          worstAlongUncertaintyFt: probe.worstAlongUncertaintyFt,
          worstAlongUncertaintySource: probe.worstAlongUncertaintySource,
          refPageIndices: probe.refPageIndices,
        },
      });
      useStitchStore.getState().fitCanvasToTiles();
      if (goneRef.current) return;
      // The offer is spent — these sheets are aligned now.
      setRef.current = null;
      probeRef.current = null;
      setStatus("idle");
      onAlignedRef.current?.(result);
    } catch (e) {
      if (goneRef.current) return;
      // The grid is untouched either way (the commit throws before it writes), so the
      // user is exactly where they were, with the offer still standing.
      setStatus("offer");
      if (!(e instanceof AutoStitchAborted)) {
        console.error(e);
        onErrorRef.current?.("Could not auto-align these sheets — they are still on the canvas to place by hand.");
      }
    } finally {
      renderer?.dispose();
      void shutdownOcr();
      try {
        doc?.destroy?.();
      } catch {
        // already freed
      }
      if (!goneRef.current) { setProgress(null); setCancelling(false); }
    }
  }, []);

  const cancelRun = useCallback(() => {
    abortRunRef.current = true;
    setCancelling(true);
  }, []);

  return { status, sheets, reason, detail, progress, check, recheck, reset, run, cancelRun, cancelling };
}
