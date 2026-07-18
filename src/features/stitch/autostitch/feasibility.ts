/**
 * Pure feasibility gate for auto-align. Turns a background stitch probe + the
 * current page selection into a button state. Two independent steps:
 *   1. quality gate (enable vs disable) — keymap coverage, or geometric
 *      ratio + a seam-residual ceiling (the piece a raw aligned-count misses:
 *      a "pile" reports a high count but a large residual).
 *   2. confident vs partial — did EVERY selected page make it in.
 */
import type { StitchMethod } from "./stitchCore";

export const KEYMAP_COVERAGE = 0.6;
export const GEOM_RATIO_FLOOR = 0.5;
export const GEOM_RESID_CEIL_FT = 5;

export type FeasibilityStatus = "confident" | "partial" | "unstitchable";

export interface FeasibilityInput {
  method: StitchMethod;
  alignedPageIndices: number[];
  worstResidFt: number;
  /** Plan-density page indices. When present, the geometric ratio's denominator
   *  is the selected plan-like pages (not the whole selection), so selecting all
   *  pages of a set full of notes/details sheets doesn't read as unstitchable.
   *  Absent/empty → old behavior (denominator = selectedCount). */
  planPageIndices?: number[];
}

export interface Feasibility {
  status: FeasibilityStatus;
  alignedInSelection: number;
  selectedCount: number;
}

export function deriveFeasibility(probe: FeasibilityInput, selectedPageIndices: number[]): Feasibility {
  const selectedCount = selectedPageIndices.length;
  const aligned = new Set(probe.alignedPageIndices);
  const alignedInSelection = selectedPageIndices.reduce((n, i) => n + (aligned.has(i) ? 1 : 0), 0);
  const ratio = selectedCount > 0 ? alignedInSelection / selectedCount : 0;

  // Geometric denominator: rate the aligned count against the selected pages
  // that are plan-like, not the whole selection (notes/details sheets can't
  // align and shouldn't drag the ratio down). Falls back to selectedCount when
  // planPageIndices is absent or empty (backward compat).
  const planSet = new Set(probe.planPageIndices ?? []);
  const selectedPlanCount = selectedPageIndices.reduce((n, i) => n + (planSet.has(i) ? 1 : 0), 0);
  const geomDenom = selectedPlanCount > 0 ? selectedPlanCount : selectedCount;
  const geomRatio = geomDenom > 0 ? alignedInSelection / geomDenom : 0;

  let passesGate = false;
  if (alignedInSelection >= 2) {
    if (probe.method === "keymap") passesGate = ratio >= KEYMAP_COVERAGE;
    else if (probe.method === "geometric") passesGate = geomRatio >= GEOM_RATIO_FLOOR && probe.worstResidFt <= GEOM_RESID_CEIL_FT;
  }

  if (!passesGate) return { status: "unstitchable", alignedInSelection, selectedCount };
  return { status: alignedInSelection === selectedCount ? "confident" : "partial", alignedInSelection, selectedCount };
}
