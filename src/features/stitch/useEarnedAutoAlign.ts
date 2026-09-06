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

/** How long a probe gets before the hook stops waiting and says so instead. */
const PROBE_BUDGET_MS = 60_000;
/** A manual Re-check gets a far longer leash — the user asked again on purpose, and
 *  the budget exists to stop an UNATTENDED probe from grinding, not to hurry a
 *  deliberate retry. But it is still a leash: unbounded meant a Re-check on a set the
 *  aligner cannot finish spun forever with no way out but closing the modal. */
const RECHECK_BUDGET_MS = 3 * PROBE_BUDGET_MS;

/**
 * The counters for a settle nobody could report.
 *
 * `NaN`, not 0. A budget that expired never got a reply, and an aborted or errored
 * probe has no `AutoStitchResult` to take a tally from — printing 0 there claimed a
 * check that had been grinding through OCR for a minute had made no OCR calls at all,
 * which is the same class of lie as treating a timed-out read as an empty crop. `%d`
 * renders `NaN` as "NaN", which reads as "not reported"; every decision below tests
 * `> 0`, which is false for `NaN`, so an unreported tally can never trigger a re-check
 * or suppress a verdict.
 */
const UNREPORTED: OcrStats = { calls: NaN, nonAnswers: NaN, retries: NaN, unknown: NaN, withheldVotes: NaN };

/** Session knowledge the canvas cannot supply. Remembered between checks. */
export interface EarnedAutoAlignContext {
  /** Sheet identity CTO already knows, by page index (the plan's labels). Free — CTO
   *  ran its own extraction — and it is what the aligner otherwise has to OCR out of a
   *  title block. Pages CTO does not know are simply absent. */
  pageCodes?: Map<number, string>;
  /** Matches the commit that placed the grid, so a re-align produces identical tiles. */
  removeWhiteBackground?: boolean;
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
   *  vanish (its wall-clock and its reads are NOT included in the re-check's line). */
  const logSettle = useCallback((settled: string, stats: OcrStats, rerun: boolean) => {
    const ms = Math.round(performance.now() - checkStartRef.current);
    console.info(
      "[probe] %s: %d ms, %d OCR calls, %d non-answers, %d retries, %d unknown, %d withheld%s",
      settled, ms, stats.calls, stats.nonAnswers, stats.retries, stats.unknown, stats.withheldVotes,
      rerun ? " (auto re-check)" : "",
    );
  }, []);

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
      // The probe is done with tesseract either way; 160-240 MB is worth handing back
      // (`ensurePool` rebuilds it lazily if another check follows).
      void shutdownOcr();
      const rerun = autoRerunRef.current;
      // A probe that threw carries only its round-trip count — there is no
      // `AutoStitchResult` behind it to take the rest from. See `UNREPORTED`.
      const spent = (calls?: number): OcrStats => ({ ...UNREPORTED, calls: calls ?? NaN });
      if ("aborted" in msg) { setStatus("idle"); logSettle("aborted", spent(msg.ocrCalls), rerun); return; }
      if ("error" in msg) {
        // A failed check is not a failed feature: the sheets are already on the canvas
        // in a grid, and the honest thing is to say the seams were not verified rather
        // than offer a button on a probe that never finished.
        console.warn("[earnedAutoAlign] probe failed:", msg.error);
        probeRef.current = null;
        setReason("unverified");
        setDetail(undefined);
        setStatus("unavailable");
        logSettle("error", spent(msg.ocrCalls), rerun);
        return;
      }
      // NEVER A VERDICT ON UNKNOWN EVIDENCE (see the header). `> 0` is deliberately
      // false for an absent tally: a reply with no `ocrStats` is a stub or an older
      // worker, and the old behaviour — show what came back — is the safe reading.
      const stats = msg.ocrStats ?? spent(msg.ocrCalls);
      if (stats.unknown > 0) {
        if (!autoRecheckSpentRef.current) {
          autoRecheckSpentRef.current = true;
          // Logged before it is thrown away, so the run's cost is on the record and
          // the reason for the second run is visible: this line is the only place the
          // discarded reply is ever mentioned.
          logSettle("re-checking", stats, rerun);
          // Status stays "checking" and nothing else is written, so the strip does not
          // flicker: `check` re-asserts exactly the values a check in flight already has.
          autoRecheckRef.current();
          return;
        }
        // Twice now. Whatever this run decided rests on reads that never came back, and
        // showing it would be the flip the whole exercise exists to stop. The time
        // budget's answer is the true one — and it is the one unavailable reason that
        // keeps the Re-check action (TakeoffModeStrip), which is what the user wants.
        probeRef.current = null;
        setSheets(0);
        setReason("too_slow");
        setDetail(undefined);
        setStatus("unavailable");
        logSettle("unavailable", stats, rerun);
        return;
      }
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
      logSettle(gate.offered ? "offer" : "unavailable", stats, rerun);
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

  const check = useCallback(
    // `budgetMs` and `auto` are internal-only — `recheck` below passes the longer
    // leash, and the reply handler passes `auto` for its one silent re-run. Not part
    // of the public `EarnedAutoAlign["check"]` signature; TS allows the wider
    // function here.
    (ctx?: EarnedAutoAlignContext, budgetMs: number = PROBE_BUDGET_MS, auto = false) => {
      if (ctx) ctxRef.current = { ...ctxRef.current, ...ctx };
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
        logSettle("unavailable", UNREPORTED, autoRerunRef.current);
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

  // The user asking again on purpose gets a much longer answer window, but not an
  // infinite one — see RECHECK_BUDGET_MS.
  const recheck = useCallback(() => check(undefined, RECHECK_BUDGET_MS), [check]);

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
