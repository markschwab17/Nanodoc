// @vitest-environment node
/**
 * Regression on the customer's real sheets: Grading_Sheets (36x24, 1"=10',
 * large grey paving/pad fills, hatching, text) with ONE rectangle "Delete
 * content" erase — page 0 over the BLDG 4 block, page 3 over the building block
 * right of BLDG 9 — using each tile raster exactly as the browser stored it. The fixture is customer data and deliberately NOT
 * in the repo: the test runs only where the files exist (VECTOR_ERASE_FIXTURES,
 * default ~/Downloads/vector-erase-fixtures), like the Belcourt probe test.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { PDFDocument, PDFDict, PDFName, PDFRawStream } from "pdf-lib";
import { cleanErasedPage } from "./cleanErasedPage";
import { buildEraseMask } from "./eraseMask";
import { exportStitchToPdf } from "../stitchExport";
import { useStitchStore } from "@/shared/stores/stitchStore";

const DIR = process.env.VECTOR_ERASE_FIXTURES ?? path.join(os.homedir(), "Downloads", "vector-erase-fixtures");
const PDF = path.join(DIR, "Grading_Sheets.pdf");
const CASES = [
  { page: 0, raster: path.join(DIR, "grading_p0_erased_tile_raster.png"), what: "rectangle erase over BLDG 4" },
  { page: 3, raster: path.join(DIR, "grading_p3_erased_tile_raster.png"), what: "rectangle erase right of BLDG 9" },
].filter((c) => fs.existsSync(PDF) && fs.existsSync(c.raster));

/** Minimal PNG decoder (8-bit RGBA, non-interlaced) returning the STORED bytes,
 *  exactly as the browser's getImageData hands them to the export. */
function decodePng(buf: Buffer): { data: Uint8ClampedArray; width: number; height: number } {
  let pos = 8, width = 0, height = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) throw new Error("fixture must be 8-bit RGBA, non-interlaced");
    } else if (type === "IDAT") idat.push(body);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = new Uint8ClampedArray(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[y * stride + x - 4] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * stride + x] = v & 255;
    }
  }
  return { data: out, width, height };
}

describe.skipIf(!CASES.length).each(CASES)("real sheet: Grading_Sheets p$page, $what", ({ page: pageIndex, raster }) => {
  let mupdf: any;
  let bytes: Uint8Array;
  let stored: { data: Uint8ClampedArray; width: number; height: number };
  beforeAll(async () => {
    mupdf = (await import("mupdf")).default;
    bytes = new Uint8Array(fs.readFileSync(PDF));
    stored = decodePng(fs.readFileSync(raster));
  });

  /** Render a page at the stored raster's scale (RGB, on white). */
  const render = (pdf: Uint8Array, index: number) => {
    const page = mupdf.Document.openDocument(pdf, "application/pdf").loadPage(index);
    const s = stored.width / (page.getBounds()[2] - page.getBounds()[0]);
    const pix = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, false);
    return { px: pix.getPixels().slice() as Uint8ClampedArray, w: pix.getWidth() as number, h: pix.getHeight() as number };
  };

  it("stays vector: the erased block is gone, everything outside it is unchanged", async () => {
    const t0 = Date.now();
    const outcome = cleanErasedPage(mupdf, mupdf.Document.openDocument(bytes, "application/pdf"), pageIndex, stored);
    const ms = Date.now() - t0;
    expect(outcome.kind).toBe("cleaned");
    if (outcome.kind !== "cleaned") return;
    expect(ms).toBeLessThan(10_000);

    // Export through the real pipeline, one tile the size of the sheet.
    useStitchStore.setState({
      canvasWidth: 2592, canvasHeight: 1728, cropRect: null,
      tiles: [{ id: "t", sourcePdfBytes: bytes, sourcePageIndex: pageIndex, x: 0, y: 0, width: 2592, height: 1728, imageDataUrl: "test://erased", imageModified: true }],
    } as never);
    const out = await exportStitchToPdf({ decodeRaster: async () => stored });
    expect(out).not.toBeNull();
    // Baseline: the same sheet exported unerased (the plain vector path).
    useStitchStore.setState({
      tiles: [{ id: "t", sourcePdfBytes: bytes, sourcePageIndex: pageIndex, x: 0, y: 0, width: 2592, height: 1728 }],
    } as never);
    const baseline = await exportStitchToPdf();
    expect(baseline).not.toBeNull();

    // Vector: the page draws only Form XObjects (no full-sheet image).
    const lib = await PDFDocument.load(out!);
    const xobjs = lib.getPage(0).node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
    const subtypes = xobjs.keys().map((k) => (xobjs.lookup(k) as PDFRawStream).dict.lookup(PDFName.of("Subtype"))?.toString());
    expect(subtypes.length).toBeGreaterThan(0);
    expect(subtypes.every((s) => s === "/Form")).toBe(true);

    // The erase: the rectangle bounding every erased pixel.
    const before = render(baseline!, 0);
    const after = render(out!, 0);
    const src = render(bytes, pageIndex);
    const mask = buildEraseMask(stored.data, stored.width, stored.height, src.px, src.w, src.h, 3);
    const box = mask.erasedBox;
    expect(mask.erasedCount).toBeGreaterThan(10_000);
    const W = stored.width, H = stored.height;
    // Visible ink (a faint anti-aliasing speck of 240+ is not content).
    const ink = (px: Uint8ClampedArray, w: number, x: number, y: number) => {
      const i = (y * w + x) * 3;
      return px[i] < 240 || px[i + 1] < 240 || px[i + 2] < 240;
    };
    // Inside (inset past glyphs the rectangle edge cut through): no ink left.
    const INSET = 10;
    let inkInside = 0, inside = 0;
    for (let y = box.y0 + INSET; y <= box.y1 - INSET; y++) {
      for (let x = box.x0 + INSET; x <= box.x1 - INSET; x++) { inside++; if (ink(after.px, after.w, x, y)) inkInside++; }
    }
    expect(inside).toBeGreaterThan(1000);
    expect(inkInside).toBe(0);
    // Outside (beyond a margin): identical to the unerased export.
    const MARGIN = 3;
    let changed = 0;
    for (let y = 0; y < Math.min(H, after.h, before.h); y++) {
      for (let x = 0; x < Math.min(W, after.w, before.w); x++) {
        if (x >= box.x0 - MARGIN && x <= box.x1 + MARGIN && y >= box.y0 - MARGIN && y <= box.y1 + MARGIN) continue;
        const i = (y * before.w + x) * 3, j = (y * after.w + x) * 3;
        const d = Math.max(Math.abs(before.px[i] - after.px[j]), Math.abs(before.px[i + 1] - after.px[j + 1]), Math.abs(before.px[i + 2] - after.px[j + 2]));
        if (d > 48) changed++;
      }
    }
    expect(changed).toBeLessThan(20); // anti-aliasing rounding only
  }, 120_000);
});
