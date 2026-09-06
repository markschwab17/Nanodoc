/**
 * Shared types + result shaping for the auto-align feasibility probe. Imported
 * by both the worker (runtime) and AddPdfModal (types). Kept out of the worker
 * file so `toProbeResult` is unit-testable without spawning a worker.
 */
import type { TilePlacement, PlacedSheetPose } from "./layout";
import type { AutoStitchResult, OcrStats } from "./autoStitch";
import type { StitchMethod, SeamReportEntry, AlignmentVerdict } from "./stitchCore";

export interface ProbeRequest {
  docId: number;
  pdfBytes: Uint8Array;
  pageIndices: number[];
  userScale: number | null;
  /** Optional per-page feet-per-inch; absent = uniform. AddPdfModal deliberately does NOT
   *  send this: the probe exists to answer a uniform-scale feasibility question ahead of
   *  time, and the cached-probe reuse gate (`isUniform` in AddPdfModal) assumes the probe's
   *  poses were computed uniform. Wiring per-page scales through here would break that
   *  assumption — a probe run with mixed scales could be reused for a selection whose
   *  cached poses no longer match a fresh per-page-scale-aware run. */
  pageScales?: [number, number][];
  /** Sheet identity the caller already knows (CTO's plan labels), page index → code.
   *  Free — CTO ran its own extraction on these pages — and it is exactly what the
   *  aligner otherwise has to OCR out of a title block. The takeoff plan path sends
   *  it so the probe answers the same question the commit will; AddPdfModal has no
   *  plan and sends nothing. */
  pageCodes?: [number, string][];
}

export interface ProbeResult {
  docId: number;
  placements: TilePlacement[];
  method: StitchMethod;
  alignedPageIndices: number[];
  worstResidFt: number;
  rootFtPerIn: number;
  poses: PlacedSheetPose[];
  refPageIndices: number[];
  /** Post-solve per-seam verification (geometric method). Absent for keymap/none. */
  seamReport?: SeamReportEntry[];
  /** Cannot-align honesty verdict. Absent → old (pre-gate) behavior. */
  alignmentVerdict?: AlignmentVerdict;
  /** Page indices pinned ALONG the matchline as well as across it, and how far an
   *  un-anchored one could slide. Absent → the along gate is not applied. */
  alongAnchored?: number[];
  worstAlongUncertaintyFt?: number;
  /** Where that figure came from — `"bound"` means nothing measured it. */
  worstAlongUncertaintySource?: "sweep" | "vote" | "bound";
  /** What the run's OCR channel actually did — see `OcrStats`. THE FIELD THE HOOK
   *  REASONS ABOUT: `ocrStats.unknown > 0` means the aligner reached this result
   *  without a read it wanted, so the result must not be presented as a verdict
   *  (`useEarnedAutoAlign` re-checks once, then says the check took too long).
   *
   *  Optional because a reply can carry no stats at all: the failure paths below
   *  have no `AutoStitchResult` to take them from, and a stubbed worker in a test
   *  need not supply them. Absent is read as "nobody told us", NOT as zero — every
   *  comparison here is `> 0`, which is false for `undefined` and for `NaN`. */
  ocrStats?: OcrStats;
  /** How many OCR round-trips this probe made — kept for compatibility with
   *  everything that read it before `ocrStats` existed, and now simply
   *  `ocrStats.calls`. (It used to be the WORKER's own RPC tally; the two differ
   *  only for reads `ocrViaMain` declines to issue because the run is already
   *  aborting, and such a run never reaches this result.) */
  ocrCalls?: number;
}

export type ProbeMessage =
  | ProbeResult
  /** `ocrCalls` is carried on the failure paths too: a probe that errored or was
   *  aborted still SPENT those round-trips, and reporting 0 for them made the
   *  settle log quietly understate what a giving-up check had cost. */
  | { docId: number; error: string; ocrCalls?: number }
  /** The probe was aborted mid-run (the user clicked plain "Add pages"). Not an
   *  error — the modal treats it as a skipped check, no toast. */
  | { docId: number; aborted: true; ocrCalls?: number };

export function toProbeResult(res: AutoStitchResult, docId: number): ProbeResult {
  // Read once, defensively: `AutoStitchResult.ocrStats` is a required field, but this
  // is the boundary a stubbed/older aligner crosses, and a missing tally must degrade
  // to "unreported" rather than throw on the way out of a probe that otherwise worked.
  const stats: OcrStats | undefined = res.ocrStats;
  return {
    docId,
    placements: res.placements,
    method: res.method,
    alignedPageIndices: [...new Set(res.placements.filter((p) => p.aligned).map((p) => p.pageIndex))],
    worstResidFt: res.worstResidFt,
    rootFtPerIn: res.rootFtPerIn,
    poses: res.poses,
    refPageIndices: res.refPageIndices,
    seamReport: res.seamReport,
    alignmentVerdict: res.alignmentVerdict,
    alongAnchored: res.alongAnchored,
    worstAlongUncertaintyFt: res.worstAlongUncertaintyFt,
    worstAlongUncertaintySource: res.worstAlongUncertaintySource,
    ocrStats: stats,
    ocrCalls: stats?.calls,
  };
}
