export interface PlacedSheetPose {
  pageIndex: number;
  scale: number; // ftPerIn
  sizePt: { w: number; h: number };
  posFt: { x: number; y: number } | null; // null => could not be placed
}
export interface TilePlacement {
  pageIndex: number;
  x: number; y: number; width: number; height: number;
  aligned: boolean;
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
      const x = (s.posFt!.x - minX) * P + MARGIN;
      const y = (s.posFt!.y - minY) * P + MARGIN;
      out.push({ pageIndex: s.pageIndex, x, y, width, height, aligned: true });
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
