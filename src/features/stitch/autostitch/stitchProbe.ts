/**
 * Shared types + result shaping for the auto-align feasibility probe. Imported
 * by both the worker (runtime) and AddPdfModal (types). Kept out of the worker
 * file so `toProbeResult` is unit-testable without spawning a worker.
 */
import type { TilePlacement } from "./layout";
import type { AutoStitchResult } from "./autoStitch";
import type { StitchMethod } from "./stitchCore";

export interface ProbeRequest {
  docId: number;
  pdfBytes: Uint8Array;
  pageIndices: number[];
  userScale: number | null;
}

export interface ProbeResult {
  docId: number;
  placements: TilePlacement[];
  method: StitchMethod;
  alignedPageIndices: number[];
  worstResidFt: number;
  rootFtPerIn: number;
}

export type ProbeMessage = ProbeResult | { docId: number; error: string };

export function toProbeResult(res: AutoStitchResult, docId: number): ProbeResult {
  return {
    docId,
    placements: res.placements,
    method: res.method,
    alignedPageIndices: res.placements.filter((p) => p.aligned).map((p) => p.pageIndex),
    worstResidFt: res.worstResidFt,
    rootFtPerIn: res.rootFtPerIn,
  };
}
