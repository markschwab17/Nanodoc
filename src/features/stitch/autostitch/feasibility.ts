/**
 * Pure feasibility gate for auto-align. Turns a background stitch probe + the
 * current page selection into a button state. Two independent steps:
 *   1. quality gate (enable vs disable) — keymap coverage, or geometric
 *      ratio + a seam-residual ceiling (the piece a raw aligned-count misses:
 *      a "pile" reports a high count but a large residual).
 *   2. confident vs partial — did EVERY selected page make it in.
 */
import type { StitchMethod, AlignmentVerdict, SeamStatus } from "./stitchCore";
import type { AutoAlignUnavailableReason } from "../addToProjectCopy";

export const KEYMAP_COVERAGE = 0.6;
export const GEOM_RATIO_FLOOR = 0.5;
export const GEOM_RESID_CEIL_FT = 5;

/** Shown on the disabled button when a geometric fit is otherwise good but its seams
 *  can't be physically verified — the cannot-align honesty gate. */
export const UNVERIFIED_REASON =
  "seams cannot be verified — matchline references ambiguous or repetitive layout";

/** Shown when the ONLY thing stopping auto-align is the along-matchline axis: the
 *  sheets demonstrably abut on the right line, but too few of them are pinned along
 *  it, so the composite would look right and be tens of feet out. */
export function alongUncertainReason(worstAlongUncertaintyFt?: number): string {
  const n = Math.round(worstAlongUncertaintyFt ?? 0);
  return n > 0
    ? `sheets can be lined up across the matchline but not along it — they may slide up to ${n} ft`
    : "sheets can be lined up across the matchline but not along it";
}

export type FeasibilityStatus = "confident" | "partial" | "unstitchable";

export interface FeasibilityInput {
  method: StitchMethod;
  alignedPageIndices: number[];
  worstResidFt: number;
  /** Cannot-align verdict from the seam report. When "unverified", the geometric
   *  method is NOT allowed to enable auto-align (the fit is plausible-but-unchecked).
   *  Absent (old probes) → gate is not applied, preserving prior behavior. */
  alignmentVerdict?: AlignmentVerdict;
  /** Ref-bearing page indices (pages carrying a usable adjacency signal). When
   *  present, the geometric ratio's denominator is the selected ref-bearing
   *  pages (not the whole selection), so selecting all pages of a set full of
   *  notes/details sheets doesn't read as unstitchable. Absent/empty OR
   *  empty intersection → old behavior (denominator = selectedCount). */
  refPageIndices?: number[];
  /** Page indices pinned on the ALONG-matchline axis as well as across it. `aligned`
   *  is only a connectivity flag, so a set can be fully "aligned" and still slide
   *  tens of feet along its seams — the offered composite would look right and be
   *  wrong. Absent (old probes) → the along gate is not applied. */
  alongAnchored?: number[];
  /** How far an un-anchored unit could slide, in feet (drives the reason copy). */
  worstAlongUncertaintyFt?: number;
}

export interface Feasibility {
  status: FeasibilityStatus;
  /** How many of the selected pages will actually be CLAIMED as aligned — the number
   *  the "N of M will align" copy quotes and the number `status` is decided on. When
   *  the probe reports `alongAnchored` this is `aligned ∩ alongAnchored`: a page
   *  connected across its seams but free to slide ALONG them is demoted to unaligned
   *  by the commit, so counting it here would promise a sheet the commit then drops
   *  below the composite. Absent `alongAnchored` (old probes) it is the aligned count. */
  alignedInSelection: number;
  selectedCount: number;
  /** Set only when auto-align is disabled specifically because the seams cannot be
   *  verified (a good-looking fit that fails the honesty gate). Drives the reason-
   *  aware UI copy. Absent for the ordinary "not a tiled set" disable. */
  reason?: string;
}

export function deriveFeasibility(probe: FeasibilityInput, selectedPageIndices: number[]): Feasibility {
  const selectedCount = selectedPageIndices.length;
  const aligned = new Set(probe.alignedPageIndices);
  const alignedInSelection = selectedPageIndices.reduce((n, i) => n + (aligned.has(i) ? 1 : 0), 0);
  const ratio = selectedCount > 0 ? alignedInSelection / selectedCount : 0;

  // Geometric denominator: rate the aligned count against the selected pages
  // that are ref-bearing, not the whole selection (notes/details sheets carry
  // no adjacency signal, can't align, and shouldn't drag the ratio down). Falls
  // back to selectedCount when refPageIndices is absent or the intersection with
  // the selection is empty (backward compat).
  const refSet = new Set(probe.refPageIndices ?? []);
  const selectedRefCount = selectedPageIndices.reduce((n, i) => n + (refSet.has(i) ? 1 : 0), 0);
  const geomDenom = selectedRefCount > 0 ? selectedRefCount : selectedCount;
  const geomRatio = geomDenom > 0 ? alignedInSelection / geomDenom : 0;

  // The geometric fit is otherwise acceptable (ratio + residual). Kept separate from
  // the verdict so we can tell "not a tiled set" apart from "tiled but unverifiable".
  const geomFitOk = geomRatio >= GEOM_RATIO_FLOOR && probe.worstResidFt <= GEOM_RESID_CEIL_FT;
  // ALONG-AXIS gate: the along-anchored pages must clear the SAME two bars the
  // aligned count does. Without it a set whose cross-seam residuals are all sub-foot
  // is offered while its sheets are 20-70 ft out along the matchline — the composite
  // looks right and is wrong, which is the one thing auto-align must never do.
  // Absent on an old probe → not applied (backward compat).
  const alongProvided = probe.alongAnchored != null;
  const alongSet = new Set(probe.alongAnchored ?? []);
  const alongInSelection = selectedPageIndices.reduce((n, i) => n + (alongSet.has(i) ? 1 : 0), 0);
  const alongRatio = geomDenom > 0 ? alongInSelection / geomDenom : 0;
  const alongOk = !alongProvided || (alongInSelection >= 2 && alongRatio >= GEOM_RATIO_FLOOR);
  // What the caller is TOLD, as opposed to what the gate is computed on: only a page
  // that is both connected and along-anchored survives the commit's demotion, so that
  // intersection is the honest "will align" count. The gate bars above deliberately
  // keep their own denominators (aligned vs along are two separate tests).
  const claimedInSelection = alongProvided
    ? selectedPageIndices.reduce((n, i) => n + (aligned.has(i) && alongSet.has(i) ? 1 : 0), 0)
    : alignedInSelection;
  // Cannot-align gate: an "unverified" verdict blocks geometric auto-align even when
  // the fit looks good. Absent verdict (old probes) never blocks (backward compat).
  const verified = probe.alignmentVerdict !== "unverified";

  let passesGate = false;
  if (alignedInSelection >= 2) {
    if (probe.method === "keymap") passesGate = ratio >= KEYMAP_COVERAGE; // keymap path unchanged
    else if (probe.method === "geometric") passesGate = geomFitOk && verified && alongOk;
  }

  if (!passesGate) {
    // Reason-aware disable: only when the geometric fit would OTHERWISE have passed
    // do we name the specific blocker, and the along axis is named ahead of the
    // verdict because it is the more concrete thing to say.
    const geomOtherwiseOk = probe.method === "geometric" && geomFitOk && alignedInSelection >= 2;
    const reason = geomOtherwiseOk && !alongOk
      ? alongUncertainReason(probe.worstAlongUncertaintyFt)
      : geomOtherwiseOk && !verified
        ? UNVERIFIED_REASON
        : undefined;
    return { status: "unstitchable", alignedInSelection: claimedInSelection, selectedCount, reason };
  }
  return {
    status: claimedInSelection === selectedCount ? "confident" : "partial",
    alignedInSelection: claimedInSelection,
    selectedCount,
  };
}

// ── The earned Auto-align gate (takeoff step strip) ──────────────────────────
/**
 * Whether the step strip may OFFER Auto-align, and if not, what to say.
 *
 * Mark's rule for round 3, verbatim: "if the system says it can auto-align I want it
 * to work otherwise it doesn't even have it as an option." So this is deliberately
 * stricter than the modal's enable/disable, which is a hint on a button the user can
 * still weigh up. Here the button's existence IS the claim, and every bar has to
 * clear at once:
 *
 *   1. the method is `geometric` — the keymap path carries none of the honesty
 *      machinery below (no seam report, no along anchoring), so however good its
 *      coverage looks there is nothing to stand behind the claim with;
 *   2. `deriveFeasibility` passes — ratio, residual ceiling, and the along-anchored
 *      count against the same two bars as the aligned count;
 *   3. the verdict is `verified` or `partial`, and `alongAnchored` was reported at
 *      all — ABSENT is not a pass here. `deriveFeasibility` treats both as backward
 *      compat because it only greys out a button; a button that exists solely to
 *      promise "this will work" cannot be offered on evidence that was never sent;
 *   4. no seam is `suspect` — one seam the engine positively believes is wrong is
 *      enough to withdraw the offer, even if the rest verify;
 *   5. at least two sheets survive to be claimed.
 *
 * `sheets` is the CLAIMED count (aligned ∩ along-anchored) — what the button says and
 * what the commit will actually keep aligned after its demotion.
 */
export interface AutoAlignGateInput extends FeasibilityInput {
  /** Post-solve seam verification. Only `status` is read. */
  seamReport?: readonly { status: SeamStatus }[];
}

export type AutoAlignGate =
  | { offered: true; sheets: number }
  /** `detail` is the fuller sentence (e.g. the along-axis slide) for a tooltip; the
   *  three short reasons are the strip note's own vocabulary. */
  | { offered: false; reason: AutoAlignUnavailableReason; detail?: string };

export function autoAlignGate(probe: AutoAlignGateInput, selectedPageIndices: number[]): AutoAlignGate {
  const f = deriveFeasibility(probe, selectedPageIndices);
  const suspect = (probe.seamReport ?? []).filter((s) => s.status === "suspect").length;
  const verdictOk = probe.alignmentVerdict === "verified" || probe.alignmentVerdict === "partial";
  if (
    probe.method === "geometric" &&
    f.status !== "unstitchable" &&
    verdictOk &&
    probe.alongAnchored != null &&
    suspect === 0 &&
    f.alignedInSelection >= 2
  ) {
    return { offered: true, sheets: f.alignedInSelection };
  }
  // Nothing was placed at all: say WHICH kind of nothing. Fewer than two of the
  // selected sheets carried a usable adjacency signal → there was never anything to
  // match by; otherwise they are readable and simply are not neighbours.
  if (probe.method === "none") {
    const refs = new Set(probe.refPageIndices ?? []);
    const readable = selectedPageIndices.reduce((n, i) => n + (refs.has(i) ? 1 : 0), 0);
    return { offered: false, reason: readable < 2 ? "no_refs" : "no_matchline" };
  }
  // Everything else — an unverified verdict, a suspect seam, an unpinned along axis,
  // a fit below the ratio floor, a keymap probe — is one sentence to the user: the
  // sheets were matched but the seams could not be stood behind. `f.reason` keeps the
  // specific wording (notably the along-axis slide) for the tooltip.
  return { offered: false, reason: "unverified", detail: f.reason };
}
