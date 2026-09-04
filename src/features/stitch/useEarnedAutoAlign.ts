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
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { PDFRenderer } from "@/core/pdf/PDFRenderer";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { attachOcrRpc, shutdownOcr } from "./autostitch/ocrService";
import { autoAlignGate } from "./autostitch/feasibility";
import type { ProbeMessage, ProbeRequest, ProbeResult } from "./autostitch/stitchProbe";
import { commitAutoAlign, type CommitResult } from "./commitPages";
import { AutoStitchAborted } from "./autostitch/autoStitch";
import type { AutoAlignUnavailableReason } from "./addToProjectCopy";
import { canvasProbeSet, hasMixedSources, movedSinceCheck, type CanvasProbeSet } from "./earnedAutoAlignSet";

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
  /** Set on unmount so a reply that lands after teardown writes no state. RESET on
   *  every mount — see the effect below. */
  const goneRef = useRef(false);

  // Callbacks live in refs so `check`/`run` stay stable and a caller need not
  // memoise its handlers to avoid re-probing.
  const onAlignedRef = useRef(onAligned);
  const onErrorRef = useRef(onError);
  onAlignedRef.current = onAligned;
  onErrorRef.current = onError;

  /**
   * One worker, created on first use and terminated on unmount. `attachOcrRpc` bridges
   * the worker's OCR requests to the shared tesseract scheduler (which runs its own
   * workers — the main thread only routes the messages).
   */
  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current;
    const w = new Worker(new URL("./autostitch/stitchProbe.worker.ts", import.meta.url), { type: "module" });
    attachOcrRpc(w);
    w.onmessage = (ev: MessageEvent<ProbeMessage>) => {
      const msg = ev.data;
      if ((msg as { kind?: string })?.kind) return; // ocr-req / ocrPhase frames
      if (goneRef.current || msg.docId !== docIdRef.current) return; // stale
      // The probe is done with tesseract either way; 160-240 MB is worth handing back
      // (`ensureScheduler` rebuilds it lazily if another check follows).
      void shutdownOcr();
      if ("aborted" in msg) { setStatus("idle"); return; }
      if ("error" in msg) {
        // A failed check is not a failed feature: the sheets are already on the canvas
        // in a grid, and the honest thing is to say the seams were not verified rather
        // than offer a button on a probe that never finished.
        console.warn("[earnedAutoAlign] probe failed:", msg.error);
        probeRef.current = null;
        setReason("unverified");
        setDetail(undefined);
        setStatus("unavailable");
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

  /** Stop whatever is running and make any reply still in flight stale. */
  const stop = useCallback(() => {
    workerRef.current?.postMessage({ kind: "abort", docId: docIdRef.current });
    docIdRef.current++;
  }, []);

  const reset = useCallback(() => {
    stop();
    setRef.current = null;
    probeRef.current = null;
    setSheets(0);
    setReason(undefined);
    setDetail(undefined);
    setStatus("idle");
  }, [stop]);

  const check = useCallback(
    (ctx?: EarnedAutoAlignContext) => {
      if (ctx) ctxRef.current = { ...ctxRef.current, ...ctx };
      stop();
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
      ensureWorker().postMessage(req);
    },
    [ensureWorker, stop],
  );

  const recheck = useCallback(() => check(), [check]);

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
