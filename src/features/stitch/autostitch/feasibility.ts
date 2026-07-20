/**
 * Pure feasibility gate for auto-align. Turns a background stitch probe + the
 * current page selection into a button state. Two independent steps:
 *   1. quality gate (enable vs disable) — keymap coverage, or geometric
 *      ratio + a seam-residual ceiling (the piece a raw aligned-count misses:
 *      a "pile" reports a high count but a large residual).
 *   2. confident vs partial — did EVERY selected page make it in.
 */
import type { StitchMethod, AlignmentVerdict } from "./stitchCore";

export const KEYMAP_COVERAGE = 0.6;
export const GEOM_RATIO_FLOOR = 0.5;
export const GEOM_RESID_CEIL_FT = 5;

/** Shown on the disabled button when a geometric fit is otherwise good but its seams
 *  can't be physically verified — the cannot-align honesty gate. */
export const UNVERIFIED_REASON =
  "seams cannot be verified — matchline references ambiguous or repetitive layout";

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
}

export interface Feasibility {
  status: FeasibilityStatus;
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
  // Cannot-align gate: an "unverified" verdict blocks geometric auto-align even when
  // the fit looks good. Absent verdict (old probes) never blocks (backward compat).
  const verified = probe.alignmentVerdict !== "unverified";

  let passesGate = false;
  if (alignedInSelection >= 2) {
    if (probe.method === "keymap") passesGate = ratio >= KEYMAP_COVERAGE; // keymap path unchanged
    else if (probe.method === "geometric") passesGate = geomFitOk && verified;
  }

  if (!passesGate) {
    // Reason-aware disable: only when the SOLE blocker is the unverified verdict
    // (the geometric fit would otherwise have passed) do we surface the honesty copy.
    const reason = probe.method === "geometric" && geomFitOk && !verified && alignedInSelection >= 2
      ? UNVERIFIED_REASON
      : undefined;
    return { status: "unstitchable", alignedInSelection, selectedCount, reason };
  }
  return { status: alignedInSelection === selectedCount ? "confident" : "partial", alignedInSelection, selectedCount };
}
