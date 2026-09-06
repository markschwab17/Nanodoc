/**
 * What `AddPdfModal` does with a probe reply.
 *
 * The modal's probe answers one question — "will Add & auto-align actually align
 * these pages" — and the answer is only as good as the reads behind it. A run that
 * reached its result WITHOUT a read it wanted (`ocrStats.unknown > 0`) can place a
 * sheet tens of feet out while every measurable check stays green (reproduced in
 * `scripts/stitch-eval.mjs` under `STITCH_EVAL_FAULT_CALLS=32,35`: one lost strip
 * read moves a Belcourt sheet ~39 ft with the verdict, residual and anchor list
 * unchanged). So the rule here is the SAME one `useEarnedAutoAlign` applies to the
 * embed probe, and deliberately so — one probe, two front doors, one promise:
 *
 *   • unknown reads, first time  → re-run once, silently, still "checking";
 *   • unknown reads, second time → no offer; the check took too long;
 *   • no `ocrStats` at all       → "nobody told us", which is the OLD behaviour:
 *                                  show what came back (`undefined > 0` is false).
 *
 * Pure on purpose: the modal's copy of this used to be four branches inside a
 * `w.onmessage` closure that no test could reach.
 */

import type { ProbeMessage, ProbeResult } from "@/features/stitch/autostitch/stitchProbe";
import type { OcrStats } from "@/features/stitch/autostitch/autoStitch";

export type ModalProbeOutcome =
  /** The user chose not to wait (Skip check / plain add). Not an error, no toast. */
  | { kind: "skipped" }
  | { kind: "error"; error: string }
  /** Unknown reads and the automatic re-run has not been spent — post the same
   *  request again under a fresh docId and keep saying "checking". Carries the tally
   *  that caused it, so the discarded reply's cost can be logged before it is
   *  dropped: it is the only place that run is ever mentioned. */
  | { kind: "recheck"; stats: OcrStats }
  /** Unknown reads twice. Auto-align is not offered; the pages can still be added
   *  and placed by hand. */
  | { kind: "too_slow" }
  | { kind: "done"; probe: ProbeResult };

/**
 * @param msg           the worker's terminal reply (already checked for staleness)
 * @param recheckSpent  has THIS probe request already had its one automatic re-run?
 */
export function modalProbeOutcome(msg: ProbeMessage, recheckSpent: boolean): ModalProbeOutcome {
  if ("aborted" in msg) return { kind: "skipped" };
  if ("error" in msg) return { kind: "error", error: msg.error };
  // `> 0`, never `!= null`: an absent tally is not zero unknowns, it is no report at
  // all, and refusing to answer on it would break every older worker and every stub.
  const stats = msg.ocrStats;
  if (stats && stats.unknown > 0) return recheckSpent ? { kind: "too_slow" } : { kind: "recheck", stats };
  return { kind: "done", probe: msg };
}
