/**
 * Building the Trim review's proposal list.
 *
 * Trim is a TWO-PART tool — Mark (2026-09-04): "I don't love that the title
 * block icon is an AI symbol because it is a 2-part tool, either AI or manual."
 * So opening the review and running the detector are separate acts:
 *
 *   Trim (scissors)       → open the review with whatever is already hidden on
 *                           the sheets, and nothing else. Draw boxes by hand.
 *   Auto-detect (sparkles) → run the detector and ADD what it finds to the open
 *                           review, never replacing what the user drew.
 *   Step 3 in the strip    → both, in one click.
 *
 * These two helpers are the whole of that logic, kept pure so the merge rules
 * (never drop a manual box, never duplicate a region the sheet already hides)
 * can be tested without a canvas or a wasm detector.
 */

import type { CleanupRegion } from "./cleanupDetect";
import type { CleanupRegionUI, TileProposalUI } from "./CleanupReview";

/** The subset of a tile these helpers care about. */
export interface TrimTile {
  id: string;
  rotation?: number;
  isScaleStamp?: boolean;
  sourcePdfBytes: { length: number };
  hiddenRegions?: { x: number; y: number; w: number; h: number }[];
  relocatedRegions?: { rect: { x: number; y: number; w: number; h: number }; dx: number; dy: number }[];
}

const EPS = 1e-9;
const sameRect = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS && Math.abs(a.w - b.w) < EPS && Math.abs(a.h - b.h) < EPS;

/**
 * Sheets Trim can act on: no scale stamps, nothing rotated (v1 does not clip a
 * rotated tile in either the preview or the export, so a box there would be
 * stored and never take effect), and a real PDF source to re-render from.
 */
export function trimReviewableTiles<T extends TrimTile>(tiles: readonly T[]): T[] {
  return tiles.filter((t) => !t.isScaleStamp && !(t.rotation ?? 0) && t.sourcePdfBytes.length > 0);
}

/**
 * The starting state of a freshly opened review: every region the sheets ALREADY
 * hide or relocate, so re-opening Trim shows the work so far rather than an empty
 * canvas the next Apply would wipe. Tiles with nothing hidden contribute nothing.
 */
export function seedProposals(tiles: readonly TrimTile[]): TileProposalUI[] {
  const out: TileProposalUI[] = [];
  for (const t of trimReviewableTiles(tiles)) {
    const regions: CleanupRegionUI[] = [
      ...(t.hiddenRegions ?? []).map((rect) => ({
        rect: { ...rect },
        kind: "manual" as const,
        confidence: "high" as const,
        enabled: true,
      })),
      ...(t.relocatedRegions ?? []).map((r) => ({
        rect: { ...r.rect },
        kind: "manual" as const,
        confidence: "high" as const,
        enabled: true,
        move: { dx: r.dx, dy: r.dy },
      })),
    ];
    if (regions.length) out.push({ tileId: t.id, regions });
  }
  return out;
}

/**
 * Fold a detection pass into the open review. Detected regions are APPENDED —
 * a hand-drawn box is never dropped by pressing Auto-detect, and running it
 * twice does not double up, because a detection whose rect the review already
 * holds is skipped. Fresh detections arrive enabled: the user confirms by
 * applying and switches the false positives to Keep.
 */
export function mergeDetected(
  prev: readonly TileProposalUI[],
  detected: readonly { tileId: string; regions: CleanupRegion[] }[]
): TileProposalUI[] {
  const byTile = new Map(prev.map((p) => [p.tileId, { tileId: p.tileId, regions: [...p.regions] }]));
  for (const d of detected) {
    const entry = byTile.get(d.tileId) ?? { tileId: d.tileId, regions: [] as CleanupRegionUI[] };
    for (const r of d.regions) {
      if (entry.regions.some((e) => sameRect(e.rect, r.rect))) continue;
      entry.regions.push({ ...r, rect: { ...r.rect }, enabled: true });
    }
    if (entry.regions.length) byTile.set(d.tileId, entry);
  }
  // Keep `prev`'s order, then any tile the detector introduced.
  const order = [...prev.map((p) => p.tileId), ...detected.map((d) => d.tileId)];
  const seen = new Set<string>();
  const out: TileProposalUI[] = [];
  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    const e = byTile.get(id);
    if (e) out.push(e);
  }
  return out;
}
