/**
 * The Add-pages modal's probe gate — the rule, without the modal.
 *
 * These are the cases the modal's `w.onmessage` cannot be asked about directly: what
 * it does with a reply whose evidence had a hole in it, and how it tells that apart
 * from a reply nobody reported any counters for.
 */
import { describe, it, expect } from "vitest";
import { modalProbeOutcome } from "./modalProbeGate";
import type { ProbeResult } from "./autostitch/stitchProbe";

const CLEAN = { calls: 12, nonAnswers: 0, retries: 0, unknown: 0, withheldVotes: 0 };
const HOLED = { calls: 12, nonAnswers: 2, retries: 1, unknown: 1, withheldVotes: 0 };

const reply = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  docId: 1,
  placements: [{ pageIndex: 0, x: 0, y: 0, width: 100, height: 100, aligned: true }],
  method: "geometric",
  alignedPageIndices: [0],
  worstResidFt: 1.2,
  rootFtPerIn: 20,
  poses: [],
  refPageIndices: [0],
  ...over,
});

describe("modalProbeOutcome", () => {
  it("shows a clean reply — nothing to re-check", () => {
    expect(modalProbeOutcome(reply({ ocrStats: CLEAN }), false)).toEqual({
      kind: "done",
      probe: expect.objectContaining({ method: "geometric" }),
    });
  });

  it("re-checks ONCE when the run had an unknown read, carrying the tally with it", () => {
    expect(modalProbeOutcome(reply({ ocrStats: HOLED }), false)).toEqual({ kind: "recheck", stats: HOLED });
  });

  it("…and after that re-check, an unknown read is the end of it: no offer", () => {
    // The reply itself is a perfectly good-looking alignment — that is the point. One
    // lost strip read moves a sheet ~39 ft with every measurable check still green.
    expect(modalProbeOutcome(reply({ ocrStats: HOLED }), true)).toEqual({ kind: "too_slow" });
  });

  it("never withholds an answer on a reply that reported no counters at all", () => {
    // Absent is "nobody told us", not "zero unknowns" — an older worker or a stub.
    expect(modalProbeOutcome(reply(), false).kind).toBe("done");
    expect(modalProbeOutcome(reply(), true).kind).toBe("done");
  });

  it("a run that reported unknown 0 is shown even after the re-check was spent", () => {
    expect(modalProbeOutcome(reply({ ocrStats: CLEAN }), true).kind).toBe("done");
  });

  it("an abort is a skipped check, an error is an error — neither is re-checked", () => {
    expect(modalProbeOutcome({ docId: 1, aborted: true, ocrCalls: 42 }, false)).toEqual({ kind: "skipped" });
    expect(modalProbeOutcome({ docId: 1, error: "boom" }, false)).toEqual({ kind: "error", error: "boom" });
  });
});
