interface Hole { x: number; y: number; w: number; h: number; }

/**
 * Build a CSS `clip-path: polygon(...)` (evenodd) that shows the whole tile
 * EXCEPT the given rectangular holes. Technique: trace the outer rectangle, then
 * for each hole cut in via a zero-width bridge from the outer edge, walk the hole,
 * and return. Coordinates are emitted as percentages of the tile size so the clip
 * survives the tile's CSS scaling. Returns null when there are no holes.
 */
export function cssClipPathWithHoles(tileW: number, tileH: number, holes: Hole[]): string | null {
  if (!holes.length || tileW <= 0 || tileH <= 0) return null;
  // `+(...).toFixed(3)` drops trailing zeros so a whole number reads "25%" not "25.000%".
  const px = (v: number) => `${+((v / tileW) * 100).toFixed(3)}%`;
  const py = (v: number) => `${+((v / tileH) * 100).toFixed(3)}%`;
  const pt = (x: number, y: number) => `${px(x)} ${py(y)}`;
  const parts: string[] = [
    pt(0, 0), pt(tileW, 0), pt(tileW, tileH), pt(0, tileH), pt(0, 0),
  ];
  for (const h of holes) {
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
