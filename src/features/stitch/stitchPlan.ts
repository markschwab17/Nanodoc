/**
 * The CTO stitch plan, read on the nanodoc side.
 *
 * CTO's "single entry screen" hands `/api/nanodoc/pdf` a `stitchPlan` alongside
 * the combined PDF: one entry per page of that PDF, in order, each carrying the
 * page's calibration (`scaleFeetPerInch`, the same unit the stitch manifest
 * uses) and whether the whole set should be auto-aligned or just placed.
 *
 * This module turns that raw JSON into exactly what a commit needs — the page
 * indices to add, the per-page scale map, and the one uniform scale when every
 * page shares it. Nothing here touches mupdf or the store; `pageCount` is passed
 * in by the caller, which has already opened the document.
 *
 * Deliberately NOT re-validating the entries' identifiers (`pageUuid`,
 * `documentId`, `documentPage`): CTO resolved those server-side to produce the
 * combined PDF, and nanodoc only ever consumes an entry's ORDINAL POSITION and
 * its scale. What is validated is the envelope (so a stale/foreign payload is
 * rejected rather than half-applied) and the scale itself.
 */

export interface ParsedStitchPlan {
  mode: "auto" | "manual";
  /** Ascending combined-PDF page indices to commit. */
  pageIndices: number[];
  /** Feet-per-inch for every page that carries a usable scale; pages CTO left
   *  blank are simply absent (so `resolvePageScale` falls back as usual). */
  pageScales: Map<number, number>;
  /** The single scale shared by every page in `pageIndices`, else null — so a
   *  mixed set takes `autoStitch`'s per-page-scale-aware path. */
  uniformScale: number | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** CTO writes `null` for an uncalibrated page; anything else must be a usable
 *  positive, finite feet-per-inch. */
function readScale(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return { ok: true, value: v };
  return { ok: false };
}

/**
 * Parse a raw `stitchPlan` against the page count of the PDF it describes.
 *
 * Returns null — and the caller falls back to the Add PDF modal — when the plan
 * is missing, malformed, a version this build doesn't understand, or describes
 * no page that actually exists in the document. Entries beyond `pageCount` are
 * truncated (the PDF is the authority on what can be committed); a document with
 * MORE pages than entries commits only the pages the plan describes.
 */
export function parseStitchPlan(raw: unknown, pageCount: number): ParsedStitchPlan | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== 1) return null;
  const mode = raw.mode;
  if (mode !== "auto" && mode !== "manual") return null;
  const entries = raw.entries;
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const count = Math.min(entries.length, Number.isFinite(pageCount) ? Math.floor(pageCount) : 0);
  if (count <= 0) return null;

  const pageIndices: number[] = [];
  const pageScales = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const entry = entries[i];
    if (!isRecord(entry)) return null;
    const scale = readScale(entry.scaleFeetPerInch);
    if (!scale.ok) return null;
    pageIndices.push(i);
    if (scale.value != null) pageScales.set(i, scale.value);
  }

  // Uniform only when EVERY committed page carries the same scale — a page with
  // no scale at all leaves the set non-uniform, so the commit resolves each page
  // individually rather than stamping one guessed scale across the batch.
  let uniformScale: number | null = null;
  if (pageScales.size === pageIndices.length) {
    const first = pageScales.get(pageIndices[0])!;
    if (pageIndices.every((i) => pageScales.get(i) === first)) uniformScale = first;
  }

  return { mode, pageIndices, pageScales, uniformScale };
}
