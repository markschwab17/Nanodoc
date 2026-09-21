/** Per-sheet scale for mixed-scale plan sets (Site Sheet spec, decision 5). Feet per inch. */
export const DEFAULT_SCALE_FT_PER_IN = 20;

/** "20", "12.5", 1"=40', 1in=50ft → feet per inch; null when unusable. */
export function parseScaleInput(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const m = t.match(/^(?:1\s*(?:"|in|″)\s*=\s*)?(\d+(?:\.\d+)?)\s*(?:'|ft|′)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function resolvePageScale(pageIndex: number, pageScales: ReadonlyMap<number, number>, uniform: number | null): number {
  const own = pageScales.get(pageIndex);
  if (own != null && own > 0) return own;
  if (uniform != null && uniform > 0) return uniform;
  return DEFAULT_SCALE_FT_PER_IN;
}

export function isUniform(pageIndices: number[], pageScales: ReadonlyMap<number, number>, uniform: number | null): boolean {
  if (pageIndices.length === 0) return true;
  const first = resolvePageScale(pageIndices[0], pageScales, uniform);
  return pageIndices.every((i) => resolvePageScale(i, pageScales, uniform) === first);
}

/** A sheet at `pageScale` drawn on a composition whose reference is `referenceScale`. */
export function tileSizeAtReference(widthPt: number, heightPt: number, pageScale: number, referenceScale: number): { width: number; height: number } {
  const factor = pageScale / referenceScale;
  return { width: widthPt * factor, height: heightPt * factor };
}

/** The reference scale for a commit: the explicit set scale when given, else the
 *  first selected page's own resolved scale (mirrors the live autoStitch engine's
 *  `rootFtPerIn = units[0].scale` — the first unit's scale roots the composition
 *  when no uniform scale is entered). */
export function referenceScaleFor(pageIndices: number[], pageScales: ReadonlyMap<number, number>, uniform: number | null): number {
  return uniform ?? resolvePageScale(pageIndices[0] ?? 0, pageScales, null);
}

/** The baseline used to size a batch being committed to the canvas. Priority:
 *  1. `typed` — the user explicitly typed a set scale, so it always wins.
 *  2. `existing` — with nothing typed, a canvas that already has sheets keeps its
 *     own reference scale (so a second blank-box batch matches feet with what's
 *     already there instead of re-guessing from the new selection).
 *  3. otherwise — an empty canvas lets the selection decide (first selected
 *     page's own resolved scale; see `referenceScaleFor`). */
export function referenceBaseline(opts: {
  typed: number | null;
  existing: number | null;
  hasTiles: boolean;
  selection: number[];
  pageScales: ReadonlyMap<number, number>;
}): number {
  const { typed, existing, hasTiles, selection, pageScales } = opts;
  if (typed != null) return typed;
  if (hasTiles && existing != null && existing > 0) return existing;
  return referenceScaleFor(selection, pageScales, null);
}

/**
 * Feet per CANVAS inch for the composition as it currently stands.
 *
 * Every tile is sized to the composition's reference scale at commit
 * (`tileSizeAtReference`), so one canvas inch is the same number of feet on every
 * sheet — that reference, divided by the composition shrink factor (the same
 * adjustment the manifest and training export make). Falls back to the moving sheet's
 * own scale, then to the 1"=20' default, so a canvas with no reference set still
 * reports a sane figure instead of nothing.
 */
export function compositionFeetPerInch(opts: {
  referenceScaleFeetPerInch: number | null;
  compositionScaleFactor: number;
  tileScaleFeetPerInch?: number;
}): number {
  const { referenceScaleFeetPerInch, compositionScaleFactor, tileScaleFeetPerInch } = opts;
  const base =
    referenceScaleFeetPerInch != null && referenceScaleFeetPerInch > 0
      ? referenceScaleFeetPerInch
      : tileScaleFeetPerInch != null && tileScaleFeetPerInch > 0
        ? tileScaleFeetPerInch
        : DEFAULT_SCALE_FT_PER_IN;
  const factor = compositionScaleFactor > 0 && Number.isFinite(compositionScaleFactor)
    ? compositionScaleFactor
    : 1;
  return base / factor;
}

/**
 * What a tile sized at the composition's reference scale must be multiplied by to
 * land on the canvas AS IT STANDS.
 *
 * "Adjusted 1\"=" shrinks or grows every sheet already on the canvas by
 * `compositionScaleFactor` (1"=20' adjusted to 1"=40' halves them all). A sheet
 * added afterwards was still sized for the un-adjusted composition, so it came in
 * twice the size of its neighbours — Mark: "it comes in pre-adjust". The same
 * factor applies to a sheet whose batch was rooted on a different feet-per-inch
 * than the canvas keeps (`batchRef` vs `canvasRef`), which is what the solver's
 * `rootFtPerIn` can be on a canvas that already has sheets.
 */
export function newTileCanvasFactor(opts: {
  compositionScaleFactor: number;
  /** Feet per inch the batch's sizes/positions are expressed in. */
  batchRef: number;
  /** Feet per inch the canvas keeps (after this commit decides it). */
  canvasRef: number;
}): number {
  const { compositionScaleFactor, batchRef, canvasRef } = opts;
  const comp =
    Number.isFinite(compositionScaleFactor) && compositionScaleFactor > 0 ? compositionScaleFactor : 1;
  const ref =
    Number.isFinite(batchRef) && batchRef > 0 && Number.isFinite(canvasRef) && canvasRef > 0
      ? batchRef / canvasRef
      : 1;
  return comp * ref;
}
