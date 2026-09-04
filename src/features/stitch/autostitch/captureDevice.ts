import type { PageExtract, Atom, Geom, Label } from "./types";
import { reconstruct } from "./reconstruct";

// mupdf is the module namespace; callers pass (await import("mupdf")).default.
// Access mupdf.Device / mupdf.Matrix directly, never mupdf.default.
const CURVE_STEPS = 8; // chords per bezier when flattening
// Drop paths whose whole bounding box is smaller than this (points). The stitch
// keeps only segments ≥8ft and cleanup only full-span borders — both far larger
// than a few points at any realistic plan scale (8ft = 5.8pt even at 100 ft/in),
// so sub-threshold paths (hatching, glyph detail, tiny symbols) are pure noise.
// On heavy sheets this drops ~90% of captured paths → no OOM, faster downstream.
const MIN_GEOM_EXTENT_PT = 3;
// Floats per geometry arena chunk (see `intern`). 64 k floats = 256 KB, i.e. one
// buffer per ~16 k short paths.
const ARENA_FLOATS = 1 << 16;

/** fz matrix concat: result = m * n, both [a,b,c,d,e,f]. */
function matMul(m: number[], n: number[]): number[] {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}
const applyX = (m: number[], x: number, y: number): number => m[0] * x + m[2] * y + m[4];
const applyY = (m: number[], x: number, y: number): number => m[1] * x + m[3] * y + m[5];

/**
 * Run a page through a capture Device, returning glyphs (visible + invisible
 * render-mode-3 "SHX" channel) reconstructed into words/labels, plus stroke
 * geometry — all in mupdf page space (points, y-down). Identity CTM at page.run
 * keeps everything in one frame that matches the tile raster and DOM canvas.
 */
export function capturePage(mupdf: any, page: any): PageExtract {
  const visAtoms: Atom[] = [];
  const shxAtoms: Atom[] = [];
  const geometry: Geom[] = [];
  let gid = 0;

  const walkText = (text: any, ctm: number[], bucket: Atom[]) => {
    let span: { m: number[]; ucs: number }[] = [];
    const flushSpan = () => {
      for (let i = 0; i < span.length; i++) {
        const { m, ucs } = span[i];
        const ch = ucs > 0 ? String.fromCodePoint(ucs) : "";
        if (!ch) continue;
        const a = m[0], b = m[1], c = m[2], d = m[3];
        const norm = Math.hypot(a, b) || 1;
        // advance = distance to the next glyph origin within the span (real
        // kerning/advance, incl. skipped space glyphs); last glyph falls back to h.
        const len = i + 1 < span.length
          ? Math.hypot(span[i + 1].m[4] - m[4], span[i + 1].m[5] - m[5])
          : (Math.hypot(c, d) || 1);
        bucket.push({
          text: ch, x: m[4], y: m[5],
          dirX: a / norm, dirY: b / norm,
          h: Math.hypot(c, d) || 1, len,
          angle: (Math.atan2(b, a) * 180) / Math.PI, font: null,
        });
      }
      span = [];
    };
    text.walk({
      beginSpan() { flushSpan(); },
      showGlyph(_font: any, trm: number[], _gid: number, ucs: number) {
        // Glyph device matrix = trm THEN ctm (mupdf fz_concat(trm, ctm) — apply
        // trm first, then the device ctm). Order matters: matMul(a,b) applies a first.
        span.push({ m: matMul(trm as unknown as number[], ctm), ucs });
      },
      endSpan() { flushSpan(); },
    });
    flushSpan();
  };

  // Points accumulate FLAT (x,y,x,y,...) in one reused scratch array, so a path
  // costs one Float32Array at flush() instead of one JS array per point. Reused
  // across paths because a dense sheet walks hundreds of thousands of them.
  const cur: number[] = [];

  // Kept paths are copied into a CHUNKED arena and handed out as subarray views.
  // A dense sheet keeps ~67 k paths; a private Float32Array each means 67 k
  // ArrayBuffers, and the per-buffer bookkeeping (view + buffer object + a
  // rounded-up backing store) outweighs the ~40 B of floats a short path holds.
  // One buffer per ARENA_FLOATS instead costs a view per path and nothing else.
  // Only paths that SURVIVE the prune are written, so no chunk is kept alive by
  // geometry that was thrown away.
  let arena = new Float32Array(ARENA_FLOATS);
  let arenaUsed = 0;
  const intern = (n: number): Float32Array => {
    if (arenaUsed + n > arena.length) {
      arena = new Float32Array(Math.max(ARENA_FLOATS, n));
      arenaUsed = 0;
    }
    const view = arena.subarray(arenaUsed, arenaUsed + n);
    for (let i = 0; i < n; i++) view[i] = cur[i];
    arenaUsed += n;
    return view;
  };
  const walkPath = (path: any, ctm: number[]) => {
    let closed = false;
    let px = 0, py = 0;
    // Track the page-space bbox as we go so flush() can reject a tiny path in O(1).
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const push = (x: number, y: number) => {
      const wx = applyX(ctm, x, y), wy = applyY(ctm, x, y);
      cur.push(wx, wy);
      if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
    };
    const flush = () => {
      // Drop tiny paths: no stitch segment (≥8ft) or cleanup border (full-span)
      // can live in a sub-MIN_GEOM_EXTENT_PT bounding box. ~90% of paths on a
      // heavy sheet, so this is the memory/throughput win.
      if (cur.length >= 4 && Math.hypot(maxX - minX, maxY - minY) >= MIN_GEOM_EXTENT_PT) {
        geometry.push({ id: gid++, pts: intern(cur.length), closed });
      }
      cur.length = 0; closed = false; minX = minY = Infinity; maxX = maxY = -Infinity;
    };
    path.walk({
      moveTo(x: number, y: number) { flush(); px = x; py = y; push(x, y); },
      lineTo(x: number, y: number) { px = x; py = y; push(x, y); },
      curveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) {
        const x0 = px, y0 = py;
        for (let k = 1; k <= CURVE_STEPS; k++) {
          const t = k / CURVE_STEPS, u = 1 - t;
          push(
            u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
            u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3
          );
        }
        px = x3; py = y3;
      },
      closePath() { closed = true; if (cur.length >= 2) cur.push(cur[0], cur[1]); },
    });
    flush();
  };

  const device = new mupdf.Device({
    fillText: (text: any, ctm: any) => walkText(text, ctm as unknown as number[], visAtoms),
    strokeText: (text: any, _s: any, ctm: any) => walkText(text, ctm as unknown as number[], visAtoms),
    ignoreText: (text: any, ctm: any) => walkText(text, ctm as unknown as number[], shxAtoms),
    fillPath: (path: any, _eo: any, ctm: any) => walkPath(path, ctm as unknown as number[]),
    strokePath: (path: any, _s: any, ctm: any) => walkPath(path, ctm as unknown as number[]),
  });
  page.run(device, mupdf.Matrix.identity);
  (device as any).close?.();
  (device as any).destroy?.();

  const bounds = page.getBounds();
  const view: [number, number, number, number] = [bounds[0], bounds[1], bounds[2], bounds[3]];
  const vis = reconstruct(visAtoms);
  const shx = reconstruct(shxAtoms);
  return { view, labels: vis.labels, words: vis.words, shxLabels: shx.labels as Label[], geometry };
}
