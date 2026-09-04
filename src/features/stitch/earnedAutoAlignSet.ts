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

export function poseOf(t: StitchTile): TilePose {
  return { x: t.x, y: t.y, width: t.width, height: t.height, rotation: t.rotation ?? 0 };
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
 * True when a checked tile was deleted or moved/resized/rotated, or when a sheet has
 * been added that the check never saw. Any of those makes the probe's absolute
 * placements the wrong answer: applying them would undo the user's own work, resurrect
 * a sheet they deleted, or leave a new sheet out of the composite.
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
      now.rotation !== was.rotation
    ) {
      return true;
    }
  }
  return false;
}
