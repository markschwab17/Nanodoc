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
