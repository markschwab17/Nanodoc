export interface Hole { x: number; y: number; w: number; h: number; }

/** `a` minus `b`, as up to four non-overlapping rects (empty when `b` covers `a`). */
function subtractRect(a: Hole, b: Hole): Hole[] {
  const ax1 = a.x + a.w, ay1 = a.y + a.h;
  const ix0 = Math.max(a.x, b.x), ix1 = Math.min(ax1, b.x + b.w);
  const iy0 = Math.max(a.y, b.y), iy1 = Math.min(ay1, b.y + b.h);
  if (ix1 <= ix0 || iy1 <= iy0) return [a]; // no overlap
  const out: Hole[] = [];
  if (iy0 > a.y) out.push({ x: a.x, y: a.y, w: a.w, h: iy0 - a.y });          // above
  if (iy1 < ay1) out.push({ x: a.x, y: iy1, w: a.w, h: ay1 - iy1 });          // below
  if (ix0 > a.x) out.push({ x: a.x, y: iy0, w: ix0 - a.x, h: iy1 - iy0 });    // left band
  if (ix1 < ax1) out.push({ x: ix1, y: iy0, w: ax1 - ix1, h: iy1 - iy0 });    // right band
  return out;
}

/**
 * Rewrite `holes` as a set of NON-OVERLAPPING rects covering the same union.
 *
 * Why this exists: every hole clip in the app (the CSS `clip-path` below, and
 * the PDF `clipEvenOdd` in stitchExport) is EVEN-ODD, so an area covered by an
 * EVEN number of holes is filled back in. Two identical hide-boxes over the same
 * title block therefore hid nothing at all, and `frameMask`'s four bands (which
 * overlap at the page corners by design) left the corners showing. Making the
 * list disjoint first means "covered once" is the only case the clip ever sees.
 */
export function disjointRects(holes: readonly Hole[]): Hole[] {
  const out: Hole[] = [];
  for (const h of holes) {
    if (!(h.w > 0) || !(h.h > 0)) continue;
    let pieces: Hole[] = [h];
    for (const kept of out) {
      if (!pieces.length) break;
      pieces = pieces.flatMap((p) => subtractRect(p, kept));
    }
    out.push(...pieces);
  }
  return out;
}

/**
 * Build a CSS `clip-path: polygon(...)` (evenodd) that shows the whole tile
 * EXCEPT the given rectangular holes. Technique: trace the outer rectangle, then
 * for each hole cut in via a zero-width bridge from the outer edge, walk the hole,
 * and return. Coordinates are emitted as percentages of the tile size so the clip
 * survives the tile's CSS scaling. Returns null when there are no holes.
 */
export function cssClipPathWithHoles(tileW: number, tileH: number, holes: Hole[]): string | null {
  if (!holes.length || tileW <= 0 || tileH <= 0) return null;
  // Overlaps would cancel under evenodd — see disjointRects.
  const cut = disjointRects(holes);
  if (!cut.length) return null;
  // `+(...).toFixed(3)` drops trailing zeros so a whole number reads "25%" not "25.000%".
  const px = (v: number) => `${+((v / tileW) * 100).toFixed(3)}%`;
  const py = (v: number) => `${+((v / tileH) * 100).toFixed(3)}%`;
  const pt = (x: number, y: number) => `${px(x)} ${py(y)}`;
  const parts: string[] = [
    pt(0, 0), pt(tileW, 0), pt(tileW, tileH), pt(0, tileH), pt(0, 0),
  ];
  for (const h of cut) {
    const x2 = h.x + h.w, y2 = h.y + h.h;
    // bridge from left edge at the hole's top-y, around the hole, and back
    parts.push(pt(0, h.y), pt(h.x, h.y), pt(h.x, y2), pt(x2, y2), pt(x2, h.y), pt(h.x, h.y), pt(0, h.y), pt(0, 0));
  }
  return `polygon(evenodd, ${parts.join(", ")})`;
}

/**
 * Build a CSS `clip-path: polygon(...)` that shows ONLY the given rect (the
 * inverse of the holes clip) — used to render a relocated region's cut-out from
 * a copy of the tile image. Coordinates are percentages of the tile size.
 */
export function cssClipToRect(tileW: number, tileH: number, rect: Hole): string | null {
  if (tileW <= 0 || tileH <= 0) return null;
  const px = (v: number) => `${+((v / tileW) * 100).toFixed(3)}%`;
  const py = (v: number) => `${+((v / tileH) * 100).toFixed(3)}%`;
  const x2 = rect.x + rect.w, y2 = rect.y + rect.h;
  return `polygon(${px(rect.x)} ${py(rect.y)}, ${px(x2)} ${py(rect.y)}, ${px(x2)} ${py(y2)}, ${px(rect.x)} ${py(y2)})`;
}
