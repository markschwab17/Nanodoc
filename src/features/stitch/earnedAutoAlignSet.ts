/**
 * What the earned Auto-align check is ABOUT: the sheets on the canvas right now.
 *
 * Kept pure and separate from the hook so both halves of the rule can be tested
 * without a worker or a store:
 *
 *  - `canvasProbeSet` derives the set from the tiles. It reads the WHOLE canvas, not
 *    the pages of whichever commit ran last, because the offer places ONE composite:
 *    probing only the pages Add PDF just added would put a second composite at the
 *    origin on top of the grid the plan left behind.
 *  - `movedSinceCheck` answers whether that set is still the thing the probe looked
 *    at. The probe's placements are ABSOLUTE, so applying them discards every drag,
 *    nudge and resize made while the check ran — and re-adds a tile the user deleted.
 *    When anything moved, the offer must be withdrawn rather than silently applied.
 */

import type { StitchTile } from "./stitchTypes";

/** A tile's placement, as far as "did the user touch this" is concerned. */
export interface TilePose {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  /** Everything the replace would DISCARD that is not a placement: clean-up regions,
   *  relocations, and an erase-modified raster override. A commit rebuilds each tile
   *  from the source page, so an edit made while the check ran would vanish without
   *  trace when the offer was taken. Compared as one string — this is a "has anything
   *  changed" test, not a diff. */
  edits: string;
}

export interface CanvasProbeSet {
  /** The one source PDF every sheet came from. */
  pdfBytes: Uint8Array;
  fileName?: string;
  /** Ascending, deduped — a two-strip page has two tiles and one page index. */
  pageIndices: number[];
  /** Per-page feet-per-inch as the tiles themselves record it. */
  pageScales: Map<number, number>;
  /** The one scale every sheet shares, else null. */
  uniformScale: number | null;
  /** Every sheet tile's id, in canvas order — what an align REPLACES. */
  tileIds: string[];
  /** Placement at check time, keyed by tile id. */
  poses: Map<string, TilePose>;
}

const isSheet = (t: StitchTile) => t.sourcePageIndex >= 0 && !t.isScaleStamp;

/**
 * Do the canvas's sheets come from more than one source PDF?
 *
 * `canvasProbeSet` returns null for such a canvas — one solve cannot span two
 * documents — and null on its own is indistinguishable from "not enough sheets to
 * bother", which left the strip silent with no explanation. This names the case so the
 * strip can say it. Identity, matching `canvasProbeSet`: two loads of the same file
 * are two documents as far as the solver is concerned.
 */
export function hasMixedSources(tiles: readonly StitchTile[]): boolean {
  const sheets = tiles.filter(isSheet);
  if (sheets.length < 2) return false;
  const first = sheets[0].sourcePdfBytes;
  return !sheets.every((t) => t.sourcePdfBytes === first);
}

export function poseOf(t: StitchTile): TilePose {
  return {
    x: t.x,
    y: t.y,
    width: t.width,
    height: t.height,
    rotation: t.rotation ?? 0,
    edits: editSignature(t),
  };
}

/** The non-placement edits a replace would throw away, as one comparable string. */
function editSignature(t: StitchTile): string {
  const hidden = (t.hiddenRegions ?? []).map((r) => `${r.x},${r.y},${r.w},${r.h}`).join("|");
  const moved = (t.relocatedRegions ?? [])
    .map((r) => `${r.rect.x},${r.rect.y},${r.rect.w},${r.rect.h},${r.dx},${r.dy}`)
    .join("|");
  // The URL identity is enough: content-delete swaps in a NEW object URL every time.
  return `${hidden}/${moved}/${t.imageDataUrl ?? ""}`;
}

/**
 * The probe set for these tiles, or null when there is nothing honest to check.
 *
 * Null when fewer than two sheets are on the canvas (nothing to align to), or when
 * they do not all come from ONE source PDF. The solver takes a single document, so a
 * canvas mixing two PDFs cannot be answered by one run — and rather than probe half
 * of it and offer a button that would place only that half, the strip says nothing.
 * Identity comparison is deliberate: two different files that happen to share a length
 * and a name must never be treated as one document, because the offer is a promise.
 */
export function canvasProbeSet(tiles: readonly StitchTile[]): CanvasProbeSet | null {
  const sheets = tiles.filter(isSheet);
  if (sheets.length < 2) return null;
  const pdfBytes = sheets[0].sourcePdfBytes;
  if (!sheets.every((t) => t.sourcePdfBytes === pdfBytes)) return null;

  const pageScales = new Map<number, number>();
  const poses = new Map<string, TilePose>();
  const pages = new Set<number>();
  for (const t of sheets) {
    pages.add(t.sourcePageIndex);
    if (t.scaleFeetPerInch != null && t.scaleFeetPerInch > 0) pageScales.set(t.sourcePageIndex, t.scaleFeetPerInch);
    poses.set(t.id, poseOf(t));
  }
  const pageIndices = [...pages].sort((a, b) => a - b);
  // Uniform only when EVERY page carries the same scale — a page with none leaves the
  // set mixed, so the commit resolves each page rather than stamping one guess across.
  let uniformScale: number | null = null;
  if (pageScales.size === pageIndices.length) {
    const first = pageScales.get(pageIndices[0])!;
    if (pageIndices.every((i) => pageScales.get(i) === first)) uniformScale = first;
  }
  return {
    pdfBytes,
    fileName: sheets[0].sourceFileName,
    pageIndices,
    pageScales,
    uniformScale,
    tileIds: sheets.map((t) => t.id),
    poses,
  };
}

/**
 * Has the canvas changed under the offer since the check?
 *
 * True when a checked tile was deleted, moved/resized/rotated, or EDITED (a clean-up
 * region hidden or relocated, content erased), or when a sheet has been added that the
 * check never saw. Any of those makes the probe's absolute placements the wrong
 * answer: applying them would undo the user's own work, resurrect a sheet they
 * deleted, drop an edit the replace cannot rebuild, or leave a new sheet out of the
 * composite.
 */
export function movedSinceCheck(set: CanvasProbeSet, tiles: readonly StitchTile[]): boolean {
  const sheets = tiles.filter(isSheet);
  if (sheets.length !== set.poses.size) return true;
  for (const t of sheets) {
    const was = set.poses.get(t.id);
    if (!was) return true; // a sheet the check never saw
    const now = poseOf(t);
    if (
      now.x !== was.x ||
      now.y !== was.y ||
      now.width !== was.width ||
      now.height !== was.height ||
      now.rotation !== was.rotation ||
      // Not a placement, but just as destructive to lose: a clean-up region, a
      // relocation, or an erase applied while the check was running.
      now.edits !== was.edits
    ) {
      return true;
    }
  }
  return false;
}
