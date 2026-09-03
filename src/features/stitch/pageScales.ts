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
