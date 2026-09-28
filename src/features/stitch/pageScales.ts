/** Per-sheet scale for mixed-scale plan sets (Site Sheet spec, decision 5). Feet per inch.
 *
 *  NOT an import default any more. Sizing a sheet at a guessed 1"=20' is how four
 *  1"=10' grading sheets were stitched at twice their true size and every takeoff
 *  measurement came out 2x long, so an import now requires a scale the user typed
 *  (`typedCommitScales`) and `resolvePageScale` throws rather than guess. What is left
 *  of this constant is the display fallback in `compositionFeetPerInch` and the
 *  feasibility probe's scale-free run (`autoStitch` with no `userScale`). */
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

/** A commit was asked to size a sheet nobody gave a scale. Thrown instead of guessing
 *  1"=20' — a guessed scale is silently wrong in every measurement taken off it.
 *  `pages` are 0-based page indices. */
export class MissingSheetScaleError extends Error {
  readonly pages: number[];
  constructor(pages: number[]) {
    super(`No scale for page${pages.length === 1 ? "" : "s"} ${pages.map((p) => p + 1).join(", ")}`);
    this.name = "MissingSheetScaleError";
    this.pages = pages;
  }
}

/** The page's own scale, else the set scale. Throws `MissingSheetScaleError` when
 *  neither exists — there is deliberately no default. */
export function resolvePageScale(pageIndex: number, pageScales: ReadonlyMap<number, number>, uniform: number | null): number {
  const own = pageScales.get(pageIndex);
  if (own != null && own > 0) return own;
  if (uniform != null && uniform > 0) return uniform;
  throw new MissingSheetScaleError([pageIndex]);
}

/** Commit-side guard: every page in `selection` resolves to a scale, or this throws
 *  naming all the pages that do not. Run before any rendering so a commit fails
 *  before it has done (or written) anything. */
export function assertEveryPageScaled(selection: readonly number[], pageScales: ReadonlyMap<number, number>, uniform: number | null): void {
  const hasUniform = uniform != null && uniform > 0;
  const missing = selection.filter((i) => {
    const own = pageScales.get(i);
    return !(own != null && own > 0) && !hasUniform;
  });
  if (missing.length) throw new MissingSheetScaleError(missing);
}

/**
 * The selected pages that have no scale the user typed, ascending as given.
 *
 * A page is covered by its OWN box when that holds a readable scale, or — when its
 * own box is blank — by a readable set-wide scale. A page whose own box holds text
 * that is not a scale ("ten", "0") is missing even when a set scale exists: the user
 * meant something for that sheet, and quietly handing it the set scale instead would
 * be the same silent guess this rule exists to stop.
 */
export function missingScalePages(
  selection: readonly number[],
  pageScaleText: ReadonlyMap<number, string>,
  uniformText: string,
): number[] {
  const uniform = parseScaleInput(uniformText);
  return selection.filter((i) => {
    const own = (pageScaleText.get(i) ?? "").trim();
    if (own) return parseScaleInput(own) == null;
    return uniform == null;
  });
}

/**
 * The scales a modal commit uses, or null while any selected page still lacks one
 * (see `missingScalePages`). The map holds EVERY selected page — per-page value or
 * the set value — so nothing downstream is ever left to fall back on a default.
 */
export function typedCommitScales(
  selection: readonly number[],
  pageScaleText: ReadonlyMap<number, string>,
  uniformText: string,
): { pageScales: Map<number, number>; uniformScale: number | null } | null {
  if (selection.length === 0) return null;
  if (missingScalePages(selection, pageScaleText, uniformText).length) return null;
  const uniformScale = parseScaleInput(uniformText);
  const pageScales = new Map<number, number>();
  for (const i of selection) {
    const own = parseScaleInput(pageScaleText.get(i) ?? "");
    pageScales.set(i, own ?? (uniformScale as number));
  }
  return { pageScales, uniformScale };
}

/** Short visible reason for a disabled commit, naming pages 1-based; null when none. */
export function missingScaleReason(missing: readonly number[]): string | null {
  if (!missing.length) return null;
  const MAX = 5;
  const shown = missing.slice(0, MAX).map((p) => p + 1).join(", ");
  const more = missing.length > MAX ? ` and ${missing.length - MAX} more` : "";
  return `Enter the scale for page${missing.length === 1 ? "" : "s"} ${shown}${more}`;
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
 * reports a sane figure instead of nothing. DISPLAY ONLY (the align-to-neighbour
 * seam note): it sizes nothing, and every sheet committed through `commitPages`
 * carries a typed scale, so the default is reachable only on a canvas with no sheet
 * scale at all.
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

/** The scales a probe is ASKED at, in the shape the canvas probe set and the server
 *  verdict gate use (`canvasProbeSet`, `serverProbeRequestMatches`): ascending pages,
 *  a scale for each, and the one shared scale when every page has the same one. */
export interface ScaleSet {
  pageIndices: number[];
  pageScales: Map<number, number>;
  uniformScale: number | null;
}

/** `pageScales` must hold every page in `selection` (e.g. `typedCommitScales`). */
export function scaleSetFor(selection: readonly number[], pageScales: ReadonlyMap<number, number>): ScaleSet {
  const pageIndices = [...selection].sort((a, b) => a - b);
  const scales = new Map<number, number>();
  for (const i of pageIndices) {
    const v = pageScales.get(i);
    if (v != null && v > 0) scales.set(i, v);
  }
  let uniformScale: number | null = null;
  if (pageIndices.length && scales.size === pageIndices.length) {
    const first = scales.get(pageIndices[0])!;
    if (pageIndices.every((i) => scales.get(i) === first)) uniformScale = first;
  }
  return { pageIndices, pageScales: scales, uniformScale };
}

/** Identity of a scale set. A probe result may be reused by a commit only when the
 *  keys agree: seam statuses, the feasibility gate and every feet figure were decided
 *  at the probe's scales (a 2 ft token residual at 1"=20' is 4 ft at 1"=40'), so a
 *  probe asked at other scales is re-run, never rescaled. */
export function scaleSetKey(set: ScaleSet): string {
  return set.pageIndices.map((i) => `${i}:${set.pageScales.get(i) ?? "-"}`).join(",");
}
