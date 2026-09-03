/**
 * Shared types + result shaping for the auto-align feasibility probe. Imported
 * by both the worker (runtime) and AddPdfModal (types). Kept out of the worker
 * file so `toProbeResult` is unit-testable without spawning a worker.
 */
import type { TilePlacement, PlacedSheetPose } from "./layout";
import type { AutoStitchResult } from "./autoStitch";
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
}

export type ProbeMessage =
  | ProbeResult
  | { docId: number; error: string }
  /** The probe was aborted mid-run (the user clicked plain "Add pages"). Not an
   *  error — the modal treats it as a skipped check, no toast. */
  | { docId: number; aborted: true };

export function toProbeResult(res: AutoStitchResult, docId: number): ProbeResult {
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
  };
}
