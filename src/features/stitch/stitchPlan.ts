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
 * its scale. Only the envelope is validated — a stale or foreign payload is
 * rejected rather than half-applied.
 *
 * Scales are read LENIENTLY: an entry whose `scaleFeetPerInch` is unusable
 * (0, negative, NaN, a string) is treated as an uncalibrated page, exactly like
 * an explicit `null`. One bad scale in a 40-sheet plan must not throw the whole
 * set back to the page picker — the page just resolves its scale the way any
 * blank page does.
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
  /** Sheet identity CTO already knows: the leading sheet code or number of each
   *  entry's `label` (CTO sends the sheet title, e.g. "C5.00 — GRADING PLAN").
   *  Pages whose label carries no such token are absent. Zero-cost — CTO ran its
   *  extraction on these pages already — and it is the identity the aligner
   *  otherwise has to recover by OCR-ing a title block (the investigation's
   *  failure B, the single largest cause of a set aligning nothing). */
  pageCodes: Map<number, string>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The leading sheet code or number of a CTO label: "C5.00 — GRADING PLAN" → "C5.00",
 * "6" → "6", "GRADING PLAN" → null. Separators are stripped and the token upper-cased
 * so it compares with a title-block code however either side punctuated it. Anything
 * that is not a code at the START of the label is ignored — the label is a title, and
 * a number buried in it is not this sheet's identity.
 */
const LABEL_CODE_RE = /^\s*([A-Z]{1,3}[-\s]?\d{1,3}(?:\.\d{1,3})?|\d{1,3})\b/i;
function readLabelCode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.match(LABEL_CODE_RE);
  return m ? m[1].replace(/\s+/g, "").toUpperCase() : null;
}

/** A usable feet-per-inch, or null for "this page has no scale" — which covers
 *  both CTO's explicit `null` and any value that couldn't be a scale. */
function readScale(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  return null;
}

/**
 * Parse a raw `stitchPlan` against the page count of the PDF it describes.
 *
 * Returns null — and the caller falls back to the Add PDF modal — when the plan
 * is missing, structurally malformed, a version this build doesn't understand,
 * or describes no page that actually exists in the document. An unusable SCALE
 * is not a malformed plan (see `readScale`). Entries beyond `pageCount` are
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
  const pageCodes = new Map<number, string>();
  for (let i = 0; i < count; i++) {
    const entry = entries[i];
    if (!isRecord(entry)) return null;
    const scale = readScale(entry.scaleFeetPerInch);
    pageIndices.push(i);
    if (scale != null) pageScales.set(i, scale);
    // Read as LENIENTLY as the scale: a label that is missing, empty or carries no
    // code is simply a page whose identity CTO does not know.
    const code = readLabelCode(entry.label);
    if (code) pageCodes.set(i, code);
  }

  // Uniform only when EVERY committed page carries the same scale — a page with
  // no scale at all leaves the set non-uniform, so the commit resolves each page
  // individually rather than stamping one guessed scale across the batch.
  let uniformScale: number | null = null;
  const first = pageScales.get(pageIndices[0]);
  if (first != null && pageScales.size === pageIndices.length) {
    if (pageIndices.every((i) => pageScales.get(i) === first)) uniformScale = first;
  }

  return { mode, pageIndices, pageScales, uniformScale, pageCodes };
}
