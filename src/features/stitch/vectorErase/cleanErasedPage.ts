/**
 * Produce a copy of a source PDF page with the linework the user ERASED on the
 * stitch canvas actually removed from its vector content — so an erased sheet
 * exports as clean vectors (what AGTEK and other takeoff tools read) instead of
 * a flat raster.
 *
 * How the erase is recovered: the tile's stored raster (alpha 0 where the erase
 * tools cleared it) is compared against a fresh render of the untouched page on
 * the SAME pixel grid (see eraseMask). The grid is rebuilt exactly: the stored
 * raster was rendered at one uniform scale (`tileRenderScale`) with its sides
 * rounded to whole pixels, so the scale is recovered from that rule — never
 * from width/height ratios, which differ by the rounding and drift the grid —
 * and the reference render's own pixel origin anchors every mapping. A
 * registration check then refuses a pair that does not line up. No erase
 * history is needed, so this works for tiles erased before this existed, and
 * undo/redo/saves need no schema change.
 *
 * How it is applied:
 *   - PATHS: the page's content stream (and any Form XObject an erase touches)
 *     is filtered byte-for-byte (contentFilter): an erased path's paint operator
 *     becomes `n`; a stroked path the erase only partly covered is re-emitted
 *     with the erased stretches cut out; a multi-part fill loses only its
 *     erased parts (pathDecision).
 *   - TEXT: each glyph near an erase is rendered ON ITS OWN, and it goes only
 *     when most of ITS ink was erased (an erased line crossing a "1" does not
 *     take the "1"). Removal uses mupdf's redaction with a small box on the
 *     glyph's ink, text only — line art and images untouched.
 *   - VERIFY: the cleaned page is re-rendered and checked against the mask,
 *     locally: every erased blob must be gone, no kept ink away from the erase
 *     may disappear, and no removed path may have carried kept ink the erase
 *     never reached. Any failure returns `failed` and the caller falls back to
 *     the raster export, which always matches the screen.
 *
 * The output is a one-page PDF (the page grafted from the source with its
 * resources, /Rotate and boxes), embedded by the normal vector path.
 */
import { filterContentStream, matMul, type Mat } from "./contentFilter";
import { decidePath, FAR_PX } from "./pathDecision";
import { OccluderIndex, pathRings } from "./occluders";
import {
  anyErasedIn,
  buildEraseMask,
  registrationMismatch,
  STATE_ERASED,
  STATE_KEPT,
  INK_THRESHOLD,
  type EraseMask,
} from "./eraseMask";
import { tileRenderScale, TILE_RENDER_SCALE } from "../rasterEncode";

/** RGBA raster exactly as stored on the tile (erased pixels have alpha 0). */
export interface StoredRaster {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

export interface CleanStats {
  erasedPx: number;
  keptPx: number;
  pathsPainted: number;
  pathsErased: number;
  pathsCut: number;
  formsCopied: number;
  glyphsErased: number;
  /** Pixel-run redactions applied to embedded images under the erase. */
  imageRedactions: number;
  /** Kept samples, away from any erase, inside removed paths (must be 0). */
  farKeptRemoved: number;
  /** Stored-raster ink with no ink under it in the reference (registration). */
  unregisteredPx: number;
  /** Share of core erased pixels still drawn after cleaning. */
  residue: number;
  /** Erased blobs (≥ BLOB_MIN_PX) still mostly drawn after cleaning (must be 0). */
  residueBlobs: number;
  /** Kept pixels, away from the erase, no longer drawn after cleaning. */
  lostPx: number;
  lostMaxBlob: number;
  ms: number;
}

export type CleanOutcome =
  | { kind: "unchanged" }
  | { kind: "cleaned"; bytes: Uint8Array; pageIndex: 0; stats: CleanStats }
  | { kind: "failed"; reason: string; stats?: Partial<CleanStats> };

/** Above this share of core erased pixels still drawn, the clean is refused. */
export const MAX_RESIDUE = 0.03;
/** Erased blobs at least this big are checked one by one… */
export const BLOB_MIN_PX = 8;
/** …and each must be at least this much gone. */
export const BLOB_MAX_RESIDUE = 0.5;
/** Kept ink allowed to vanish away from the erase (anti-aliasing rounding only). */
export const MAX_LOST_PX = 60;
export const MAX_LOST_BLOB_PX = 8;
/** Only clearly visible erased ink (reference darker than 255 − this) is checked:
 *  a faint anti-aliased hatch hairline half-taken by a flood fill is not. */
const RESIDUE_MIN_INK = 64;
/** A core erased pixel within this of its reference colour still shows the erased ink. */
const RESIDUE_DIFF = 32;
/** A kept pixel further than this from its reference colour was changed by the clean. */
const LOST_DIFF = 64;
/** Stored ink allowed off the reference's ink before the grids count as misregistered. */
export const MAX_UNREGISTERED = 0.01;
const MAX_FORM_DEPTH = 12;
/** A glyph pixel counts as its ink from this coverage (0..255). */
const GLYPH_INK_ALPHA = 96;

type Mupdf = any; // mupdf is a namespace passed in by the caller: (await import("mupdf")).default

/**
 * The uniform scale the stored raster was rendered at. The commit renders at
 * `tileRenderScale(w, h)` (older builds: a flat 1.5) and mupdf rounds each side
 * OUT to whole pixels; the long edge is the last resort. Null when no candidate
 * reproduces the raster's size — then it is not a render of this page. Pure.
 */
export function storedRasterScale(wPt: number, hPt: number, W: number, H: number): number | null {
  const long = Math.max(wPt, hPt);
  const cands = [tileRenderScale(wPt, hPt), TILE_RENDER_SCALE, (wPt >= hPt ? W : H) / long];
  for (const s of cands) {
    if (!(s > 0)) continue;
    if (Math.abs(Math.ceil(wPt * s - 1e-3) - W) <= 1 && Math.abs(Math.ceil(hPt * s - 1e-3) - H) <= 1) return s;
  }
  return null;
}

function readMatrix(obj: any): Mat {
  if (!obj || obj.isNull?.() || !obj.isArray?.() || obj.length !== 6) return [1, 0, 0, 1, 0, 0];
  const m: number[] = [];
  for (let k = 0; k < 6; k++) m.push(obj.get(k).asNumber());
  return m as Mat;
}

function isNullish(obj: any): boolean {
  return !obj || obj.isNull?.();
}

function renderRGB(mupdf: Mupdf, page: any, s: number) {
  const pix = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, false);
  try {
    return {
      pixels: pix.getPixels().slice() as Uint8ClampedArray,
      width: pix.getWidth() as number,
      height: pix.getHeight() as number,
      comps: pix.getNumberOfComponents() as number,
      x: pix.getX() as number,
      y: pix.getY() as number,
    };
  } finally {
    pix.destroy?.();
  }
}

/** 8-connected components of the pixels `pick` selects; calls `visit` per component. */
function components(W: number, H: number, pick: (p: number) => boolean, visit: (pixels: number[]) => void): void {
  const seen = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  for (let p0 = 0; p0 < W * H; p0++) {
    if (seen[p0] || !pick(p0)) continue;
    let head = 0, tail = 0;
    queue[tail++] = p0;
    seen[p0] = 1;
    const comp: number[] = [];
    while (head < tail) {
      const p = queue[head++];
      comp.push(p);
      const x = p % W, y = (p - x) / W;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const q = yy * W + xx;
          if (!seen[q] && pick(q)) { seen[q] = 1; queue[tail++] = q; }
        }
      }
    }
    visit(comp);
  }
}

/**
 * Check a cleaned render against the mask and the reference render (all three
 * on one pixel grid). Pure.
 *
 * A pixel is compared with the REFERENCE, not just tested for ink: removing a
 * line drawn over a grey fill correctly reveals the fill, which is ink but no
 * longer the line. So:
 *   residue — clearly inked ERASED pixels with at most 2 KEPT neighbours ("core") that
 *             still look as they did before the erase: reported overall and
 *             per connected blob;
 *   lost    — KEPT pixels with no ERASED pixel within FAR_PX that changed:
 *             reported as a pixel count and the largest connected blob.
 * Edges are excluded on both sides because there the raster and the vectors
 * legitimately disagree (a flood fill's anti-aliased fringe; the gaps it takes
 * out of dense hatching whose line cores stay).
 */
export function verifyAgainstMask(
  mask: EraseMask,
  cleaned: ArrayLike<number>,
  cw: number,
  ch: number,
  comps: number,
  ref: ArrayLike<number>,
  refW: number,
  refH: number,
  refComps: number
): { residue: number; residueBlobs: number; lostPx: number; lostMaxBlob: number; failingBlobs: number[][] } {
  const { width: W, height: H, state } = mask;
  /** Largest channel difference between cleaned and reference at mask pixel p. */
  const diff = (p: number) => {
    const x = p % W, y = (p - x) / W;
    const i = (Math.min(ch - 1, y) * cw + Math.min(cw - 1, x)) * comps;
    const j = (Math.min(refH - 1, y) * refW + Math.min(refW - 1, x)) * refComps;
    let d = 0;
    for (let k = 0; k < Math.min(3, comps, refComps); k++) d = Math.max(d, Math.abs(cleaned[i + k] - ref[j + k]));
    return d;
  };
  const inkAt = (p: number) => {
    const x = p % W, y = (p - x) / W;
    const i = (Math.min(ch - 1, y) * cw + Math.min(cw - 1, x)) * comps;
    for (let k = 0; k < Math.min(3, comps); k++) if (cleaned[i + k] < INK_THRESHOLD) return true;
    return false;
  };
  const stillThere = (p: number) => inkAt(p) && diff(p) < RESIDUE_DIFF;
  const near = (p: number, r: number, st: number) => {
    const x = p % W, y = (p - x) / W;
    for (let yy = Math.max(0, y - r); yy <= Math.min(H - 1, y + r); yy++) {
      for (let xx = Math.max(0, x - r); xx <= Math.min(W - 1, x + r); xx++) {
        if (state[yy * W + xx] === st) return true;
      }
    }
    return false;
  };
  // An erased pixel is checked unless 3+ of its 8 neighbours are kept: a full
  // row of kept pixels beside it (two lines a pixel apart, one erased — which
  // is which is below the raster's resolution) or kept on both sides (a gap
  // between dense hatch lines whose cores stay) is edge noise.
  const keptNeighbours = (p: number) => {
    const x = p % W, y = (p - x) / W;
    let k = 0;
    for (let yy = Math.max(0, y - 1); yy <= Math.min(H - 1, y + 1); yy++) {
      for (let xx = Math.max(0, x - 1); xx <= Math.min(W - 1, x + 1); xx++) if (state[yy * W + xx] === STATE_KEPT) k++;
    }
    return k;
  };
  // Classify once: 1 = core erased, 2 = kept far from any erase.
  const cls = new Uint8Array(W * H);
  let coreCount = 0;
  for (let p = 0; p < W * H; p++) {
    if (state[p] === STATE_ERASED) { if (mask.ink[p] >= RESIDUE_MIN_INK && keptNeighbours(p) <= 2) { cls[p] = 1; coreCount++; } }
    else if (state[p] === STATE_KEPT && !near(p, FAR_PX, STATE_ERASED)) cls[p] = 2;
  }
  let residuePx = 0, residueBlobs = 0;
  const failingBlobs: number[][] = [];
  components(W, H, (p) => cls[p] === 1, (comp) => {
    let inked = 0;
    for (const p of comp) if (stillThere(p)) inked++;
    residuePx += inked;
    if (comp.length >= BLOB_MIN_PX && inked > BLOB_MAX_RESIDUE * comp.length) { residueBlobs++; failingBlobs.push(comp); }
  });
  let lostPx = 0, lostMaxBlob = 0;
  components(W, H, (p) => cls[p] === 2 && diff(p) > LOST_DIFF, (comp) => {
    lostPx += comp.length;
    if (comp.length > lostMaxBlob) lostMaxBlob = comp.length;
  });
  return { residue: coreCount ? residuePx / coreCount : 0, residueBlobs, lostPx, lostMaxBlob, failingBlobs };
}

/**
 * Redaction rects (page space) that take the erased pixels OUT of embedded
 * raster images (a scanned seal, a logo): for every still-drawn erased blob
 * lying on an image, one rect per horizontal run of erased pixels, so image
 * pixels outside the erase are untouched. mupdf's pixel redaction rewrites the
 * image data itself — the erased pixels are gone from the file, not covered.
 */
function imageResidueRects(mupdf: Mupdf, page: any, mask: EraseMask, blobs: number[][], s: number, ox: number, oy: number): number[][] {
  const boxes: number[][] = [];
  const addImage = (ctm: Mat) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const X = (u * ctm[0] + v * ctm[2] + ctm[4]) * s - ox;
      const Y = (u * ctm[1] + v * ctm[3] + ctm[5]) * s - oy;
      x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
    }
    boxes.push([x0, y0, x1, y1]);
  };
  const dev = new mupdf.Device({
    fillImage: (_img: any, ctm: Mat) => addImage(ctm),
    fillImageMask: (_img: any, ctm: Mat) => addImage(ctm),
  });
  page.runPageContents(dev, mupdf.Matrix.identity);
  dev.close?.();
  if (!boxes.length) return [];
  const W = mask.width;
  const inImage = (x: number, y: number) => boxes.some((b) => x + 0.5 >= b[0] && x + 0.5 <= b[2] && y + 0.5 >= b[1] && y + 0.5 <= b[3]);
  const rects: number[][] = [];
  for (const blob of blobs) {
    let on = 0, bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const p of blob) {
      const x = p % W, y = (p - x) / W;
      if (inImage(x, y)) on++;
      bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y);
    }
    if (on < 0.8 * blob.length) continue; // residue that is not on an image: leave it to fail
    // Every ERASED pixel (fringe included) around the blob, as row runs.
    for (let y = Math.max(0, by0 - 2); y <= Math.min(mask.height - 1, by1 + 2); y++) {
      let run = -1;
      for (let x = Math.max(0, bx0 - 2); x <= Math.min(W, bx1 + 3); x++) {
        const e = x < W && x <= bx1 + 2 && mask.state[y * W + x] === STATE_ERASED && inImage(x, y);
        if (e && run < 0) run = x;
        if (!e && run >= 0) {
          rects.push([(run + ox) / s, (y + oy) / s, (x + ox) / s, (y + 1 + oy) / s]);
          run = -1;
        }
      }
    }
  }
  return rects;
}

/**
 * Redaction boxes (page space) for glyphs whose own ink is mostly erased. Each
 * candidate glyph is rendered alone on the mask's grid; only ITS inked pixels
 * vote, so neither blank glyph-box area nor a line crossing it counts.
 */
function erasedGlyphRects(mupdf: Mupdf, page: any, mask: EraseMask, s: number, ox: number, oy: number): number[][] {
  const rects: number[][] = [];
  const toDev: Mat = [s, 0, 0, s, 0, 0];
  const touches = (b: number[]) =>
    anyErasedIn(mask, Math.floor(b[0] - ox), Math.floor(b[1] - oy), Math.ceil(b[2] - ox), Math.ceil(b[3] - oy));
  const handle = (text: any, ctm: Mat) => {
    const devCtm = matMul(ctm, toDev);
    if (!touches(text.getBounds(null, devCtm))) return;
    text.walk({
      showGlyph(font: any, trm: Mat, gid: number, uni: number, wmode: number) {
        const g = new mupdf.Text();
        g.showGlyph(font, trm, gid, uni, wmode);
        try {
          const b: number[] = g.getBounds(null, devCtm);
          if (!(b[2] > b[0] && b[3] > b[1]) || !touches(b)) return;
          const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [Math.floor(b[0]), Math.floor(b[1]), Math.ceil(b[2]), Math.ceil(b[3])], true);
          pix.clear(0);
          const dd = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
          dd.fillText(g, devCtm, mupdf.ColorSpace.DeviceGray, [0], 1);
          dd.close();
          const px = pix.getPixels();
          const pw = pix.getWidth(), ph = pix.getHeight(), px0 = pix.getX(), py0 = pix.getY();
          let kept = 0, erased = 0, sx = 0, sy = 0, inkN = 0;
          for (let iy = 0; iy < ph; iy++) {
            const my = py0 + iy - oy;
            if (my < 0 || my >= mask.height) continue;
            for (let ix = 0; ix < pw; ix++) {
              if (px[(iy * pw + ix) * 2 + 1] < GLYPH_INK_ALPHA) continue;
              const mx = px0 + ix - ox;
              if (mx < 0 || mx >= mask.width) continue;
              const st = mask.state[my * mask.width + mx];
              if (st === STATE_KEPT) kept++;
              else if (st === STATE_ERASED) erased++;
              sx += px0 + ix + 0.5; sy += py0 + iy + 0.5; inkN++;
            }
          }
          pix.destroy?.();
          if (erased > 0 && erased >= 0.5 * (erased + kept) && inkN > 0) {
            // A small box on the glyph's own ink (page space): never reaches a neighbour.
            const cx = sx / inkN / s, cy = sy / inkN / s;
            const half = Math.max(0.1, (Math.min(b[2] - b[0], b[3] - b[1]) / s) * 0.12);
            rects.push([cx - half, cy - half, cx + half, cy + half]);
          }
        } finally {
          g.destroy?.();
        }
      },
    });
  };
  const dev = new mupdf.Device({
    fillText: (t: any, ctm: Mat) => handle(t, ctm),
    strokeText: (t: any, _st: any, ctm: Mat) => handle(t, ctm),
  });
  page.runPageContents(dev, mupdf.Matrix.identity);
  dev.close?.();
  return rects;
}

/**
 * Clean one page. `srcDoc` is an open mupdf PDFDocument (callers cache it per
 * source). Never throws for content reasons — a failure is an outcome.
 */
export function cleanErasedPage(mupdf: Mupdf, srcDoc: any, pageIndex: number, stored: StoredRaster): CleanOutcome {
  const t0 = Date.now();
  const out = new mupdf.PDFDocument();
  try {
    out.graftPage(-1, srcDoc, pageIndex);
    let page = out.loadPage(0);
    const bounds: number[] = page.getBounds();
    const wPt = bounds[2] - bounds[0];
    const hPt = bounds[3] - bounds[1];
    if (!(wPt > 0 && hPt > 0) || !(stored.width > 0 && stored.height > 0)) {
      return { kind: "failed", reason: "empty page or raster" };
    }
    // 1. One uniform scale, recovered by the commit's own rule.
    const s = storedRasterScale(wPt, hPt, stored.width, stored.height);
    if (s == null) return { kind: "failed", reason: "stored raster is not a render of this page" };
    const ref = renderRGB(mupdf, page, s);
    if (Math.abs(ref.width - stored.width) > 1 || Math.abs(ref.height - stored.height) > 1) {
      return { kind: "failed", reason: "stored raster size does not match the page render" };
    }
    const mask = buildEraseMask(stored.data, stored.width, stored.height, ref.pixels, ref.width, ref.height, ref.comps);
    const reg = registrationMismatch(stored.data, mask);
    if (reg.unmatched > 50 && reg.unmatched > MAX_UNREGISTERED * reg.storedInk) {
      return { kind: "failed", reason: "stored raster does not register with the page", stats: { unregisteredPx: reg.unmatched } };
    }
    if (mask.erasedCount === 0) return { kind: "unchanged" };

    // User space → mask pixel: page transform, the uniform scale, then the
    // render's own integer origin (covers CropBox offsets).
    const toPixel: Mat = matMul(page.getTransform(), [s, 0, 0, s, -ref.x, -ref.y]);

    // 2. Paths: filter the page stream, recursing into touched forms. Two walks
    // over identical traversals: the first indexes the fills near the erase in
    // paint order (what hides what), the second decides and edits.
    let formsCopied = 0;
    let painted = 0, erased = 0, cut = 0, farKeptRemoved = 0;
    let nameSeq = 0;
    let order = 0;
    const occluders = new OccluderIndex();
    const OCC_PAD = 8;
    const walk = (bytes: Uint8Array, baseCtm: Mat, resources: any, depth: number, lineWidth: number, apply: boolean): Uint8Array | null => {
      const res = filterContentStream(bytes, baseCtm, {
        decide: (p) => {
          const my = order++;
          if (!apply) {
            if (OccluderIndex.isOccluder(p)) {
              const rings = pathRings(p);
              let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
              for (const r of rings) for (const [x, y] of r) {
                if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
              }
              if (anyErasedIn(mask, Math.floor(x0) - OCC_PAD, Math.floor(y0) - OCC_PAD, Math.ceil(x1) + OCC_PAD, Math.ceil(y1) + OCC_PAD)) {
                occluders.add(my, rings, p.paint.endsWith("*"));
              }
            }
            return { kind: "keep" };
          }
          const v = decidePath(p, mask, (x, y) => occluders.coveredAfter(my, x, y));
          if (v.kind !== "keep") farKeptRemoved += v.farKept ?? 0;
          return v;
        },
        onDo: (name, ctm, lw) => {
          if (depth >= MAX_FORM_DEPTH || isNullish(resources)) return null;
          const xobjs = resources.get("XObject");
          if (isNullish(xobjs)) return null;
          const xo = xobjs.get(name);
          if (isNullish(xo) || !xo.isStream()) return null;
          const subtype = xo.get("Subtype");
          if (isNullish(subtype) || subtype.asName() !== "Form") return null;
          const formCtm = matMul(readMatrix(xo.get("Matrix")), ctm);
          // Cheap reject: the form's BBox nowhere near an erased pixel.
          const bb = xo.get("BBox");
          if (!isNullish(bb) && bb.isArray() && bb.length === 4) {
            const b = [0, 1, 2, 3].map((k) => bb.get(k).asNumber());
            let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
            for (const [u, v] of [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]) {
              const X = u * formCtm[0] + v * formCtm[2] + formCtm[4];
              const Y = u * formCtm[1] + v * formCtm[3] + formCtm[5];
              x0 = Math.min(x0, X); x1 = Math.max(x1, X); y0 = Math.min(y0, Y); y1 = Math.max(y1, Y);
            }
            if (!anyErasedIn(mask, Math.floor(x0) - OCC_PAD, Math.floor(y0) - OCC_PAD, Math.ceil(x1) + OCC_PAD, Math.ceil(y1) + OCC_PAD)) return null;
          }
          const formRes = isNullish(xo.get("Resources")) ? resources : xo.get("Resources");
          const edited = walk(xo.readStream().asUint8Array(), formCtm, formRes, depth + 1, lw, apply);
          if (!edited || !apply) return null;
          // A per-instance copy: the same form drawn elsewhere keeps its content.
          const dict = out.newDictionary();
          xo.forEach((v: any, k: string | number) => {
            if (k === "Length" || k === "Filter" || k === "DecodeParms") return;
            dict.put(k, v);
          });
          const copy = out.addStream(edited, dict);
          let newName: string;
          do { newName = `${name}_ve${++nameSeq}`; } while (!isNullish(xobjs.get(newName)));
          xobjs.put(newName, copy);
          formsCopied++;
          return newName;
        },
      }, lineWidth);
      if (apply) {
        painted += res.stats.painted;
        erased += res.stats.erased;
        cut += res.stats.rewritten;
      }
      return res.changed ? res.bytes : null;
    };

    const pageObj = page.getObject();
    const contents = pageObj.get("Contents");
    const chunks: Uint8Array[] = [];
    if (!isNullish(contents)) {
      if (contents.isArray()) {
        for (let k = 0; k < contents.length; k++) {
          const c = contents.get(k);
          if (!isNullish(c) && c.isStream()) chunks.push(c.readStream().asUint8Array(), new Uint8Array([10]));
        }
      } else if (contents.isStream()) {
        chunks.push(contents.readStream().asUint8Array());
      }
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    const pageBytes = new Uint8Array(total);
    { let o = 0; for (const c of chunks) { pageBytes.set(c, o); o += c.length; } }
    const pageRes = pageObj.getInheritable("Resources");
    walk(pageBytes, toPixel, pageRes, 0, 1, false);
    order = 0;
    const newPageBytes = walk(pageBytes, toPixel, pageRes, 0, 1, true);
    const partial = { erasedPx: mask.erasedCount, keptPx: mask.keptCount, pathsPainted: painted, pathsErased: erased, pathsCut: cut, farKeptRemoved };
    if (farKeptRemoved > 0) {
      // A removal would take ink the erase never touched (a fill only partly
      // erased): the vectors cannot reproduce this erase honestly.
      return { kind: "failed", reason: "erase covers only part of a shape that cannot be cut", stats: partial };
    }
    if (newPageBytes) {
      pageObj.put("Contents", out.addStream(newPageBytes, out.newDictionary()));
      page = out.loadPage(0);
    }

    // 3. Text: redact the glyphs whose own ink was erased.
    const redactRects = erasedGlyphRects(mupdf, page, mask, s, ref.x, ref.y);
    if (redactRects.length) {
      for (const r of redactRects) page.createAnnotation("Redact").setRect(r);
      // black boxes off; images, line art untouched; text removed.
      page.applyRedactions(false, 0, 0, 0);
    }

    const save = (): Uint8Array => {
      const buf = out.saveToBuffer("compress,garbage");
      const b = new Uint8Array(buf.asUint8Array());
      buf.destroy?.();
      return b;
    };

    // 4. Verify on the saved bytes (also proves they parse).
    const verifyBytes = (b: Uint8Array) => {
      const check = mupdf.Document.openDocument(b, "application/pdf");
      try {
        const cpage = check.loadPage(0);
        const r = renderRGB(mupdf, cpage, s);
        cpage.destroy?.();
        return verifyAgainstMask(mask, r.pixels, r.width, r.height, r.comps, ref.pixels, ref.width, ref.height, ref.comps);
      } finally {
        check.destroy?.();
      }
    };
    let bytes = save();
    let verdict = verifyBytes(bytes);
    let imageRects = 0;
    if (verdict.failingBlobs.length) {
      // Erased blobs still drawn: if they sit on embedded images, take the
      // erased pixels out of the image data, then verify again.
      const rects = imageResidueRects(mupdf, page, mask, verdict.failingBlobs, s, ref.x, ref.y);
      if (rects.length) {
        for (const r of rects) page.createAnnotation("Redact").setRect(r);
        // black boxes off; image PIXELS redacted; line art and text untouched.
        page.applyRedactions(false, 2, 0, 1);
        imageRects = rects.length;
        bytes = save();
        verdict = verifyBytes(bytes);
      }
    }
    const stats: CleanStats = {
      ...partial,
      formsCopied,
      glyphsErased: redactRects.length,
      imageRedactions: imageRects,
      unregisteredPx: reg.unmatched,
      residue: verdict.residue,
      residueBlobs: verdict.residueBlobs,
      lostPx: verdict.lostPx,
      lostMaxBlob: verdict.lostMaxBlob,
      ms: Date.now() - t0,
    };
    if (verdict.residue > MAX_RESIDUE || verdict.residueBlobs > 0) {
      return { kind: "failed", reason: "erase not reproduced in vectors", stats };
    }
    if (verdict.lostPx > MAX_LOST_PX || verdict.lostMaxBlob > MAX_LOST_BLOB_PX) {
      return { kind: "failed", reason: "vector clean removed kept content", stats };
    }
    return { kind: "cleaned", bytes, pageIndex: 0, stats };
  } catch (e) {
    return { kind: "failed", reason: e instanceof Error ? e.message : String(e) };
  } finally {
    out.destroy?.();
  }
}
