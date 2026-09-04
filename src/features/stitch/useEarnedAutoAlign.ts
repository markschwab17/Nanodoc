/**
 * Auto-align, EARNED.
 *
 * Mark, 2026-09-04: "if the system says it can auto-align I want it to work otherwise
 * it doesn't even have it as an option. I also want the speed at which it identifies
 * if autoalign will work to be relatively quick and nonblocking."
 *
 * So the takeoff flow no longer decides up front. The sheets are placed in a GRID
 * immediately — the canvas is interactive within a frame — and this hook then runs the
 * existing feasibility probe over exactly those pages in its worker. Only a probe that
 * clears `autoAlignGate` puts an **Auto-align N sheets** button in the step strip;
 * anything else becomes a note saying which of the three things was missing. Nothing
 * here ever blocks input: the probe is a worker, the strip is a chip, and the user can
 * drag sheets around, add more, or leave the whole time.
 *
 * Running it re-commits the same pages through `commitAutoAlign` with the probe's
 * placements CACHED (the solver does not run twice), which is also what routes the
 * commit through T0's demotion — a sheet the seam report cannot stand behind is placed
 * below rather than claimed. The grid tiles are removed once the aligned ones land, so
 * the sheets are never on the canvas twice.
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

/** Everything the hook needs to re-run a commit over the pages it probed. */
export interface EarnedAutoAlignSource {
  pdfBytes: Uint8Array;
  fileName?: string;
  /** Ascending page indices — the pages already placed in the grid. */
  pageIndices: number[];
  pageScales: Map<number, number>;
  uniformScale: number | null;
  pageCodes?: Map<number, string>;
  /** Ids of the tiles the grid placement created. Removed when the user auto-aligns,
   *  so the same sheets are not left on the canvas twice. */
  tileIds: string[];
  /** Passed to the commit so a plan add and a hand-picked add produce identical tiles. */
  removeWhiteBackground?: boolean;
}

export type EarnedAutoAlignStatus = "idle" | "checking" | "offer" | "unavailable" | "aligning";

export interface EarnedAutoAlign {
  status: EarnedAutoAlignStatus;
  /** Sheets the offer would CLAIM (along-anchored, past the commit's demotion). */
  sheets: number;
  reason?: AutoAlignUnavailableReason;
  /** The fuller sentence behind the short reason, for a tooltip. */
  detail?: string;
  /** Page render progress while a run is committing. */
  progress: { done: number; total: number } | null;
  /** Probe the given pages. Supersedes any check already running. */
  check: (source: EarnedAutoAlignSource) => void;
  /** Drop the offer and stop any probe — the sheets it described are no longer what
   *  is on the canvas. */
  reset: () => void;
  /** Commit the offer. No-op unless `status === "offer"`. */
  run: () => Promise<void>;
  /** Stop a run in progress. The commit throws before it writes anything, so the
   *  canvas is left exactly as it was and the offer still stands. */
  cancelRun: () => void;
  /** True once cancel has been asked for and the run has not yet noticed. */
  cancelling: boolean;
}

export function useEarnedAutoAlign(opts: {
  /** The finished commit, for the coach mark / strip counts / toast. */
  onAligned?: (result: CommitResult) => void;
  onError?: (message: string) => void;
} = {}): EarnedAutoAlign {
  const { onAligned, onError } = opts;
  const [status, setStatus] = useState<EarnedAutoAlignStatus>("idle");
  const [sheets, setSheets] = useState(0);
  const [reason, setReason] = useState<AutoAlignUnavailableReason | undefined>();
  const [detail, setDetail] = useState<string | undefined>();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  /** Polled by the commit between page renders; it throws AutoStitchAborted BEFORE
   *  `addTiles`, so a cancelled run leaves the grid untouched. */
  const abortRunRef = useRef(false);

  const workerRef = useRef<Worker | null>(null);
  /** Monotonic; a reply whose docId is not the current one is stale and ignored. */
  const docIdRef = useRef(0);
  const sourceRef = useRef<EarnedAutoAlignSource | null>(null);
  const probeRef = useRef<ProbeResult | null>(null);
  /** Set on unmount so a reply that lands after teardown writes no state. */
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
      const gate = autoAlignGate(msg, sourceRef.current?.pageIndices ?? []);
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

  useEffect(
    () => () => {
      goneRef.current = true;
      workerRef.current?.terminate();
      workerRef.current = null;
      void shutdownOcr();
    },
    [],
  );

  /** Stop whatever is running. `bump` makes any reply still in flight stale. */
  const stop = useCallback((bump: boolean) => {
    if (workerRef.current && bump) workerRef.current.postMessage({ kind: "abort", docId: docIdRef.current });
    if (bump) docIdRef.current++;
  }, []);

  const reset = useCallback(() => {
    stop(true);
    sourceRef.current = null;
    probeRef.current = null;
    setSheets(0);
    setReason(undefined);
    setDetail(undefined);
    setStatus("idle");
  }, [stop]);

  const check = useCallback(
    (source: EarnedAutoAlignSource) => {
      stop(true);
      sourceRef.current = source;
      probeRef.current = null;
      setSheets(0);
      setReason(undefined);
      setDetail(undefined);
      // One sheet cannot be aligned to anything. Say nothing rather than check.
      if (source.pageIndices.length < 2) { setStatus("idle"); return; }
      setStatus("checking");
      const req: ProbeRequest = {
        docId: docIdRef.current,
        pdfBytes: source.pdfBytes,
        pageIndices: source.pageIndices,
        // The plan's OWN scales, unlike the modal's uniform-only probe: this run has to
        // answer the question the commit will ask, because its placements are the ones
        // the commit reuses.
        userScale: source.uniformScale,
        pageScales: source.pageScales.size ? [...source.pageScales] : undefined,
        pageCodes: source.pageCodes?.size ? [...source.pageCodes] : undefined,
      };
      ensureWorker().postMessage(req);
    },
    [ensureWorker, stop],
  );

  const run = useCallback(async () => {
    const source = sourceRef.current;
    const probe = probeRef.current;
    if (!source || !probe) return;
    setStatus("aligning");
    abortRunRef.current = false;
    setCancelling(false);
    setProgress({ done: 0, total: source.pageIndices.length });
    let doc: any = null;
    let renderer: PDFRenderer | null = null;
    try {
      const mupdf = await import("mupdf").then((m) => m.default);
      doc = mupdf.Document.openDocument(source.pdfBytes, "application/pdf");
      renderer = new PDFRenderer(mupdf);
      const result = await commitAutoAlign({
        mupdf,
        doc,
        pdfBytes: source.pdfBytes,
        fileName: source.fileName,
        selected: source.pageIndices,
        pageScales: source.pageScales,
        uniformScale: source.uniformScale,
        pageCodes: source.pageCodes,
        removeWhiteBackground: source.removeWhiteBackground ?? true,
        renderer,
        onProgress: (done, total) => setProgress({ done, total }),
        shouldAbort: () => abortRunRef.current,
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
          refPageIndices: probe.refPageIndices,
        },
      });
      // Remove the GRID after the aligned tiles land, never before: the canvas would
      // otherwise sit empty for the seconds the rasters take.
      if (source.tileIds.length) useStitchStore.getState().removeTiles(source.tileIds);
      useStitchStore.getState().fitCanvasToTiles();
      if (goneRef.current) return;
      // The offer is spent — these sheets are aligned now.
      sourceRef.current = null;
      probeRef.current = null;
      setStatus("idle");
      onAlignedRef.current?.(result);
    } catch (e) {
      if (goneRef.current) return;
      // The grid is untouched either way (the commit throws before `addTiles`), so the
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

  return { status, sheets, reason, detail, progress, check, reset, run, cancelRun, cancelling };
}
