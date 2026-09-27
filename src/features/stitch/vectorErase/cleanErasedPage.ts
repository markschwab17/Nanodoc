/**
 * Produce a copy of a source PDF page with the linework the user ERASED on the
 * stitch canvas actually removed from its vector content — so an erased sheet
 * exports as clean vectors (what AGTEK and other takeoff tools read) instead of
 * a flat raster.
 *
 * How the erase is recovered: the tile's stored raster (alpha 0 where the erase
 * tools cleared it) is compared against a fresh render of the untouched page on
 * the same pixel grid (see eraseMask). No erase history is needed, so this works
 * for every erased tile, including ones erased before this existed, and
 * undo/redo/saves need no schema change.
 *
 * How it is applied:
 *   - PATHS: the page's content stream (and any Form XObject an erase touches)
 *     is filtered byte-for-byte (contentFilter): an erased path's paint operator
 *     becomes `n`; a stroked path the erase only partly covered is re-emitted
 *     with the erased stretches cut out (pathDecision). Everything else in the
 *     stream is left exactly as it was.
 *   - TEXT: glyphs judged erased are removed with mupdf's own redaction, one
 *     small redaction box per glyph, with line art and images explicitly left
 *     alone — mupdf rewrites text runs at glyph granularity, which a byte filter
 *     could only approximate without reimplementing font metrics.
 *   - VERIFY: the cleaned page is re-rendered and checked against the mask. If
 *     the erase could not be reproduced in vectors (it hit a scanned image or a
 *     shading, so most erased ink is still there) or the clean removed a real
 *     share of ink the user kept, the result is `failed` and the caller falls
 *     back to the raster export, which always matches the screen.
 *
 * The output is a one-page PDF (the page grafted from the source with its
 * resources, /Rotate and boxes), embedded by the normal vector path.
 */
import { filterContentStream, matMul, type Mat } from "./contentFilter";
import { decidePath } from "./pathDecision";
import { anyErasedIn, buildEraseMask, sampleState, STATE_ERASED, STATE_KEPT, INK_THRESHOLD, type EraseMask } from "./eraseMask";

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
  /** Share of erased ink still drawn after cleaning. */
  residue: number;
  /** Share of kept ink (away from erase edges) no longer drawn after cleaning. */
  lost: number;
  ms: number;
}

export type CleanOutcome =
  | { kind: "unchanged" }
  | { kind: "cleaned"; bytes: Uint8Array; pageIndex: 0; stats: CleanStats }
  | { kind: "failed"; reason: string; stats?: CleanStats };

/** Above this share of erased ink still showing, the vector clean did not work. */
export const MAX_RESIDUE = 0.5;
/** Above this share of kept ink gone, the vector clean over-deleted. */
export const MAX_LOST = 0.05;
const MAX_FORM_DEPTH = 12;

type Mupdf = any; // mupdf is a namespace passed in by the caller: (await import("mupdf")).default

function readMatrix(obj: any): Mat {
  if (!obj || obj.isNull?.() || !obj.isArray?.() || obj.length !== 6) return [1, 0, 0, 1, 0, 0];
  const m: number[] = [];
  for (let k = 0; k < 6; k++) m.push(obj.get(k).asNumber());
  return m as Mat;
}

function isNullish(obj: any): boolean {
  return !obj || obj.isNull?.();
}

function renderRGB(mupdf: Mupdf, page: any, sx: number, sy: number) {
  const pix = page.toPixmap(mupdf.Matrix.scale(sx, sy), mupdf.ColorSpace.DeviceRGB, false, false);
  try {
    return {
      pixels: pix.getPixels().slice() as Uint8ClampedArray,
      width: pix.getWidth() as number,
      height: pix.getHeight() as number,
      comps: pix.getNumberOfComponents() as number,
    };
  } finally {
    pix.destroy?.();
  }
}

/**
 * Residue / lost shares of a cleaned render against the mask. Pure.
 *
 * Both are measured away from the erase's EDGES, where the raster and the
 * vectors legitimately disagree: the anti-aliased fringe a flood fill leaves
 * (kept in the raster, gone with its vector line) and the in-between pixels a
 * flood fill takes out of dense hatching while the hatch lines' cores stay (so
 * the lines, correctly, stay too).
 *   residue — ERASED pixels with no KEPT pixel beside them, still drawn;
 *   lost    — KEPT pixels with no ERASED pixel within 2 px, no longer drawn.
 */
export function verifyAgainstMask(
  mask: EraseMask,
  cleaned: ArrayLike<number>,
  cw: number,
  ch: number,
  comps: number
): { residue: number; lost: number } {
  const { width: W, height: H, state } = mask;
  const inkAt = (x: number, y: number) => {
    const rx = cw === W ? x : Math.min(cw - 1, Math.floor(((x + 0.5) * cw) / W));
    const ry = ch === H ? y : Math.min(ch - 1, Math.floor(((y + 0.5) * ch) / H));
    const i = (ry * cw + rx) * comps;
    for (let k = 0; k < Math.min(3, comps); k++) if (cleaned[i + k] < INK_THRESHOLD) return true;
    return false;
  };
  const near = (x: number, y: number, r: number, st: number) => {
    for (let dy = -r; dy <= r; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < W && state[yy * W + xx] === st) return true;
      }
    }
    return false;
  };
  let residue = 0, core = 0, lost = 0, keptFar = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = state[y * W + x];
      if (s === STATE_ERASED) {
        if (near(x, y, 1, STATE_KEPT)) continue;
        core++;
        if (inkAt(x, y)) residue++;
      } else if (s === STATE_KEPT) {
        if (near(x, y, 2, STATE_ERASED)) continue;
        keptFar++;
        if (!inkAt(x, y)) lost++;
      }
    }
  }
  return { residue: core ? residue / core : 0, lost: keptFar ? lost / keptFar : 0 };
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
    const sx = stored.width / wPt;
    const sy = stored.height / hPt;

    // 1. The erase mask: stored raster vs. a fresh render of the original page.
    const ref = renderRGB(mupdf, page, sx, sy);
    const mask = buildEraseMask(stored.data, stored.width, stored.height, ref.pixels, ref.width, ref.height, ref.comps);
    if (mask.erasedCount === 0) return { kind: "unchanged" };

    // User space → stored-raster pixels.
    const toPixel: Mat = matMul(page.getTransform(), [sx, 0, 0, sy, -bounds[0] * sx, -bounds[1] * sy]);

    // 2. Paths: filter the page stream, recursing into touched forms.
    let formsCopied = 0;
    let painted = 0, erased = 0, cut = 0;
    let nameSeq = 0;
    const processStream = (bytes: Uint8Array, baseCtm: Mat, resources: any, depth: number): Uint8Array | null => {
      const res = filterContentStream(bytes, baseCtm, {
        decide: (p) => decidePath(p, mask),
        onDo: (name, ctm) => {
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
            if (!anyErasedIn(mask, Math.floor(x0) - 2, Math.floor(y0) - 2, Math.ceil(x1) + 2, Math.ceil(y1) + 2)) return null;
          }
          const formRes = isNullish(xo.get("Resources")) ? resources : xo.get("Resources");
          const edited = processStream(xo.readStream().asUint8Array(), formCtm, formRes, depth + 1);
          if (!edited) return null;
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
      });
      painted += res.stats.painted;
      erased += res.stats.erased;
      cut += res.stats.rewritten;
      return res.changed ? res.bytes : null;
    };

    const pageObj = page.getObject();
    const contents = pageObj.get("Contents");
    const chunks: Uint8Array[] = [];
    if (!isNullish(contents)) {
      if (contents.isArray()) {
        for (let k = 0; k < contents.length; k++) {
          const s = contents.get(k);
          if (!isNullish(s) && s.isStream()) chunks.push(s.readStream().asUint8Array(), new Uint8Array([10]));
        }
      } else if (contents.isStream()) {
        chunks.push(contents.readStream().asUint8Array());
      }
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    const pageBytes = new Uint8Array(total);
    { let o = 0; for (const c of chunks) { pageBytes.set(c, o); o += c.length; } }
    const newPageBytes = processStream(pageBytes, toPixel, pageObj.getInheritable("Resources"), 0);
    if (newPageBytes) {
      pageObj.put("Contents", out.addStream(newPageBytes, out.newDictionary()));
      page = out.loadPage(0);
    }

    // 3. Text: redact the glyphs whose ink was erased.
    const redactRects: number[][] = [];
    const stext = page.toStructuredText("preserve-whitespace");
    stext.walk({
      onChar(c: string, _origin: unknown, _font: unknown, _size: number, quad: number[]) {
        if (!c || !c.trim()) return;
        const xs = [quad[0], quad[2], quad[4], quad[6]];
        const ys = [quad[1], quad[3], quad[5], quad[7]];
        const qx0 = Math.min(...xs), qx1 = Math.max(...xs), qy0 = Math.min(...ys), qy1 = Math.max(...ys);
        const px0 = (qx0 - bounds[0]) * sx, px1 = (qx1 - bounds[0]) * sx;
        const py0 = (qy0 - bounds[1]) * sy, py1 = (qy1 - bounds[1]) * sy;
        if (!anyErasedIn(mask, Math.floor(px0), Math.floor(py0), Math.ceil(px1), Math.ceil(py1))) return;
        const step = Math.max(0.5, Math.sqrt(((px1 - px0) * (py1 - py0)) / 400));
        let k = 0, e = 0;
        for (let y = py0 + step / 2; y < py1; y += step) {
          for (let x = px0 + step / 2; x < px1; x += step) {
            const st = sampleState(mask, x, y);
            if (st === STATE_KEPT) k++;
            else if (st === STATE_ERASED) e++;
          }
        }
        if (e > 0 && e >= 0.5 * (e + k)) {
          // A box in the middle of the glyph only: never reaches a neighbour.
          const cx = (qx0 + qx1) / 2, cy = (qy0 + qy1) / 2;
          const hw = (qx1 - qx0) * 0.15, hh = (qy1 - qy0) * 0.15;
          redactRects.push([cx - hw, cy - hh, cx + hw, cy + hh]);
        }
      },
    });
    stext.destroy?.();
    if (redactRects.length) {
      for (const r of redactRects) page.createAnnotation("Redact").setRect(r);
      // black boxes off; images, line art untouched; text removed.
      page.applyRedactions(false, 0, 0, 0);
    }

    if (!newPageBytes && !redactRects.length) {
      // Erased ink exists but nothing vector was under it (scanned image, shading).
      return { kind: "failed", reason: "erase is not on vector content" };
    }

    const buf = out.saveToBuffer("compress,garbage");
    const bytes = new Uint8Array(buf.asUint8Array());
    buf.destroy?.();

    // 4. Verify on the saved bytes (also proves they parse).
    const check = mupdf.Document.openDocument(bytes, "application/pdf");
    let verdict: { residue: number; lost: number };
    try {
      const cpage = check.loadPage(0);
      const r = renderRGB(mupdf, cpage, sx, sy);
      cpage.destroy?.();
      verdict = verifyAgainstMask(mask, r.pixels, r.width, r.height, r.comps);
    } finally {
      check.destroy?.();
    }
    const stats: CleanStats = {
      erasedPx: mask.erasedCount,
      keptPx: mask.keptCount,
      pathsPainted: painted,
      pathsErased: erased,
      pathsCut: cut,
      formsCopied,
      glyphsErased: redactRects.length,
      residue: verdict.residue,
      lost: verdict.lost,
      ms: Date.now() - t0,
    };
    if (verdict.residue > MAX_RESIDUE) return { kind: "failed", reason: "erase not reproduced in vectors", stats };
    if (verdict.lost > MAX_LOST) return { kind: "failed", reason: "vector clean removed kept content", stats };
    return { kind: "cleaned", bytes, pageIndex: 0, stats };
  } catch (e) {
    return { kind: "failed", reason: e instanceof Error ? e.message : String(e) };
  } finally {
    out.destroy?.();
  }
}
