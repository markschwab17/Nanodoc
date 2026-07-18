export interface PlacedSheetPose {
  pageIndex: number;
  scale: number; // ftPerIn
  sizePt: { w: number; h: number };
  posFt: { x: number; y: number } | null; // null => could not be placed
  /** Page-pt bbox of the frame this pose anchors; absent = whole page. */
  frame?: [number, number, number, number];
}
export interface TilePlacement {
  pageIndex: number;
  x: number; y: number; width: number; height: number;
  aligned: boolean;
  /** Copied from the pose: the frame this tile shows (mask the rest). */
  sourceFrame?: [number, number, number, number];
}

/**
 * Map world-feet placements into canvas (PDF-point) tile poses. The root sheet
 * keeps its native size; other sheets scale uniformly by scale/rootFtPerIn so
 * every sheet shares the same points-per-foot. Unplaced sheets (posFt null) are
 * grid-laid below the aligned cluster at native size.
 */
export function layoutPlacements(
  sheets: PlacedSheetPose[],
  rootFtPerIn: number,
  opts: { margin?: number; gap?: number; tilesPerRow?: number } = {}
): TilePlacement[] {
  const MARGIN = opts.margin ?? 20;
  const GAP = opts.gap ?? 10;
  const PER_ROW = opts.tilesPerRow ?? 3;
  const P = 72 / rootFtPerIn; // canvas points per foot

  const out: TilePlacement[] = [];
  const placed = sheets.filter((s) => s.posFt);
  let maxYCanvas = MARGIN;

  if (placed.length) {
    const minX = Math.min(...placed.map((s) => s.posFt!.x));
    const minY = Math.min(...placed.map((s) => s.posFt!.y));
    for (const s of placed) {
      const si = (P * s.scale) / 72; // == s.scale / rootFtPerIn
      const width = s.sizePt.w * si;
      const height = s.sizePt.h * si;
      const fx = s.frame ? s.frame[0] : 0;
      const fy = s.frame ? s.frame[1] : 0;
      const x = (s.posFt!.x - minX) * P + MARGIN - fx * si;
      const y = (s.posFt!.y - minY) * P + MARGIN - fy * si;
      out.push({ pageIndex: s.pageIndex, x, y, width, height, aligned: true, sourceFrame: s.frame });
      maxYCanvas = Math.max(maxYCanvas, y + height);
    }
  }

  const unplaced = sheets.filter((s) => !s.posFt);
  let rowY = maxYCanvas + (placed.length ? GAP * 3 : 0);
  for (let i = 0; i < unplaced.length; i += PER_ROW) {
    const row = unplaced.slice(i, i + PER_ROW);
    let x = MARGIN;
    let maxH = 0;
    for (const s of row) {
      out.push({ pageIndex: s.pageIndex, x, y: rowY, width: s.sizePt.w, height: s.sizePt.h, aligned: false });
      x += s.sizePt.w + GAP;
      maxH = Math.max(maxH, s.sizePt.h);
    }
    rowY += maxH + GAP;
  }
  return out;
}

/**
 * Fractional hiddenRegions masking everything OUTSIDE `frame` on a page of
 * pageW x pageH pts. Full-height side bands + full-width top/bottom bands
 * (overlapping at corners — harmless for masks). Empty for a full-page frame.
 */
export function frameMask(
  frame: [number, number, number, number], pageW: number, pageH: number
): { x: number; y: number; w: number; h: number }[] {
  const [fx0, fy0, fx1, fy1] = frame;
  const EPS = 1e-3;
  const out: { x: number; y: number; w: number; h: number }[] = [];
  if (fy0 / pageH > EPS) out.push({ x: 0, y: 0, w: 1, h: fy0 / pageH });
  if (1 - fy1 / pageH > EPS) out.push({ x: 0, y: fy1 / pageH, w: 1, h: 1 - fy1 / pageH });
  if (fx0 / pageW > EPS) out.push({ x: 0, y: 0, w: fx0 / pageW, h: 1 });
  if (1 - fx1 / pageW > EPS) out.push({ x: fx1 / pageW, y: 0, w: 1 - fx1 / pageW, h: 1 });
  return out;
}
