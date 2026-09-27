// @vitest-environment node
/**
 * End to end: a synthetic vector sheet → rendered to a tile raster exactly as the
 * commit does it → erased with the REAL erase tools (flood-fill element erase and
 * rectangle content-delete) → cleaned → exported. Asserts on the actual PDF
 * content (mupdf capture + pdf-lib resources) that the erased linework is GONE
 * from the vectors, kept linework is intact, and the export still embeds the
 * sheet as a vector Form XObject with no full-sheet image.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFDict, PDFRawStream, StandardFonts, degrees, rgb } from "pdf-lib";
import { cleanErasedPage, type StoredRaster } from "./cleanErasedPage";
import { eraseCanvasRectInImage, floodFillErase, makeWhiteTransparentInPlace } from "../imageUtils";
import { tileRenderScale } from "../rasterEncode";
import { exportStitchToPdf } from "../stitchExport";
import { useStitchStore } from "@/shared/stores/stitchStore";
import { DELETE_ELEMENT_COLOR_TOLERANCE } from "../stitchConstants";

let mupdf: any;
beforeAll(async () => {
  mupdf = (await import("mupdf")).default;
});

const W = 400, H = 300;

/** The fixture sheet, drawn in user space (y-up). */
async function buildSheet(rotations: number[] = [0]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // A block (Form XObject) holding one line, like a CAD block reference.
  const blockSrc = await PDFDocument.create();
  blockSrc.addPage([100, 10]).drawLine({ start: { x: 0, y: 5 }, end: { x: 100, y: 5 }, thickness: 1 });
  const [block] = await doc.embedPdf(await blockSrc.save(), [0]);
  for (const r of rotations) {
    const p = doc.addPage([W, H]);
    if (r) p.setRotation(degrees(r));
    // V: a red vertical line crossed by A (drawn first so A lies on top of it).
    p.drawLine({ start: { x: 300, y: 100 }, end: { x: 300, y: 280 }, thickness: 1, color: rgb(1, 0, 0) });
    p.drawLine({ start: { x: 20, y: 250 }, end: { x: 380, y: 250 }, thickness: 1 }); // A: element-erased
    p.drawLine({ start: { x: 20, y: 200 }, end: { x: 380, y: 200 }, thickness: 1 }); // B: kept
    p.drawLine({ start: { x: 20, y: 120 }, end: { x: 380, y: 120 }, thickness: 1 }); // C: cut by the rect
    p.drawRectangle({ x: 170, y: 40, width: 60, height: 40, color: rgb(0, 0, 1) }); // E: fill inside the rect
    p.drawText("KEEP", { x: 30, y: 60, size: 16, font });
    p.drawText("GONE", { x: 280, y: 60, size: 16, font });
    p.drawPage(block, { x: 20, y: 155 }); // F: block line at y=160, x 20..120
  }
  return doc.save();
}

/** User-space point → pixel of the stored raster (displayed orientation). */
function userToPixel(page: any, scale: number, x: number, y: number): [number, number] {
  const m = page.getTransform();
  return [(x * m[0] + y * m[2] + m[4]) * scale, (x * m[1] + y * m[3] + m[5]) * scale];
}

/** Render + erase exactly as the app does; returns the stored raster. */
function eraseSheet(bytes: Uint8Array, pageIndex: number): StoredRaster {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const page = doc.loadPage(pageIndex);
  const b = page.getBounds();
  const scale = tileRenderScale(b[2] - b[0], b[3] - b[1]);
  const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, true, false);
  const width = pix.getWidth(), height = pix.getHeight();
  const data = new Uint8ClampedArray(pix.getPixels());
  const img = { data, width, height } as unknown as ImageData;
  makeWhiteTransparentInPlace(img);
  // Canvas == raster pixels for these calls: a tile at the origin, raster-sized.
  const tile = { x: 0, y: 0, width, height, rotation: 0 };
  const px = (x: number, y: number) => userToPixel(page, scale, x, y);
  // Element erase: click line A, and the block line F.
  const a = px(100, 250);
  expect(floodFillErase(img, width, height, tile, a[0], a[1], DELETE_ELEMENT_COLOR_TOLERANCE, true, 248)).not.toBeNull();
  const f = px(70, 160);
  expect(floodFillErase(img, width, height, tile, f[0], f[1], DELETE_ELEMENT_COLOR_TOLERANCE, true, 248)).not.toBeNull();
  // Rectangle erases: x 150..250 × y 30..130 (C's middle + E), and the word GONE.
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    const p = px(x0, y0), q = px(x1, y1);
    const r = { x: Math.min(p[0], q[0]), y: Math.min(p[1], q[1]), w: Math.abs(q[0] - p[0]), h: Math.abs(q[1] - p[1]) };
    expect(eraseCanvasRectInImage(img, width, height, tile, r)).not.toBeNull();
  };
  rect(150, 30, 250, 130);
  rect(275, 50, 330, 80);
  pix.destroy?.();
  return { data, width, height };
}

interface Captured {
  strokes: Array<{ pts: Array<[number, number]>; segs: Array<[number, number, number, number]>; subpaths: number }>;
  fills: Array<{ bbox: number[] }>;
  text: string;
  images: number;
}

/** Everything drawn on a page, in page (displayed) space. */
function capture(page: any): Captured {
  const out: Captured = { strokes: [], fills: [], text: "", images: 0 };
  const walkPts = (path: any, ctm: number[]) => {
    const pts: Array<[number, number]> = [];
    const segs: Array<[number, number, number, number]> = [];
    let subpaths = 0;
    let cur: [number, number] = [0, 0];
    const T = (x: number, y: number): [number, number] => [x * ctm[0] + y * ctm[2] + ctm[4], x * ctm[1] + y * ctm[3] + ctm[5]];
    const to = (x: number, y: number) => { const q = T(x, y); segs.push([cur[0], cur[1], q[0], q[1]]); pts.push(q); cur = q; };
    path.walk({
      moveTo: (x: number, y: number) => { subpaths++; cur = T(x, y); pts.push(cur); },
      lineTo: to,
      curveTo: (_a: number, _b: number, _c: number, _d: number, x: number, y: number) => to(x, y),
      closePath: () => {},
    });
    return { pts, segs, subpaths };
  };
  const dev = new mupdf.Device({
    strokePath: (path: any, _s: any, ctm: number[]) => out.strokes.push(walkPts(path, ctm)),
    fillPath: (path: any, _e: boolean, ctm: number[]) => out.fills.push({ bbox: path.getBounds(null, ctm) }),
    fillText: (text: any) => text.walk({ showGlyph: (_f: any, _t: any, _g: any, u: number) => { out.text += String.fromCodePoint(u); } }),
    fillImage: () => { out.images++; },
  });
  page.run(dev, mupdf.Matrix.identity);
  dev.close?.();
  return out;
}

/** Does any captured stroke segment pass within `tol` of the point? */
function strokeThrough(c: Captured, p: [number, number], tol = 0.75): boolean {
  for (const s of c.strokes) {
    for (const [ax, ay, bx, by] of s.segs) {
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2));
      if (Math.hypot(ax + t * dx - p[0], ay + t * dy - p[1]) <= tol) return true;
    }
  }
  return false;
}

function checkCleaned(page: any) {
  const c = capture(page);
  const at = (x: number, y: number) => userToPixel(page, 1, x, y);
  // A (element-erased) is gone end to end.
  expect(strokeThrough(c, at(60, 250))).toBe(false);
  expect(strokeThrough(c, at(200, 250))).toBe(false);
  expect(strokeThrough(c, at(370, 250))).toBe(false);
  // B untouched.
  expect(strokeThrough(c, at(30, 200))).toBe(true);
  expect(strokeThrough(c, at(370, 200))).toBe(true);
  // C cut at the rectangle: both outer stretches remain, the middle is gone.
  expect(strokeThrough(c, at(60, 120))).toBe(true);
  expect(strokeThrough(c, at(145, 120))).toBe(true);
  expect(strokeThrough(c, at(200, 120))).toBe(false);
  expect(strokeThrough(c, at(255, 120))).toBe(true);
  expect(strokeThrough(c, at(370, 120))).toBe(true);
  // V (crossed by the erased A) is intact and NOT split at the crossing.
  const v = c.strokes.filter((s) => s.pts.some((q) => Math.hypot(q[0] - at(300, 100)[0], q[1] - at(300, 100)[1]) < 0.5));
  expect(v).toHaveLength(1);
  expect(v[0].subpaths).toBe(1);
  expect(strokeThrough(c, at(300, 250))).toBe(true);
  // E (fill inside the rectangle) is gone.
  const e = at(200, 60);
  expect(c.fills.some((f) => f.bbox[0] <= e[0] && e[0] <= f.bbox[2] && f.bbox[1] <= e[1] && e[1] <= f.bbox[3])).toBe(false);
  // F (inside the block Form XObject) is gone.
  expect(strokeThrough(c, at(70, 160))).toBe(false);
  // Text: GONE removed glyph by glyph, KEEP intact.
  expect(c.text).toContain("KEEP");
  expect(c.text).not.toMatch(/[GON]/);
  return c;
}

describe("cleanErasedPage", () => {
  it("removes erased paths, glyphs and block content from the vectors; keeps the rest", async () => {
    const bytes = await buildSheet();
    const stored = eraseSheet(bytes, 0);
    const src = mupdf.Document.openDocument(bytes, "application/pdf");
    const outcome = cleanErasedPage(mupdf, src, 0, stored);
    expect(outcome.kind).toBe("cleaned");
    if (outcome.kind !== "cleaned") return;
    expect(outcome.stats.residue).toBeLessThan(0.1);
    expect(outcome.stats.lost).toBeLessThan(0.01);
    expect(outcome.stats.formsCopied).toBe(1);
    const page = mupdf.Document.openDocument(outcome.bytes, "application/pdf").loadPage(0);
    checkCleaned(page);
  });

  it("maps the erase correctly on a /Rotate 90 source page", async () => {
    const bytes = await buildSheet([90]);
    const stored = eraseSheet(bytes, 0);
    expect(stored.width).toBeLessThan(stored.height); // raster is in displayed (rotated) orientation
    const outcome = cleanErasedPage(mupdf, mupdf.Document.openDocument(bytes, "application/pdf"), 0, stored);
    expect(outcome.kind).toBe("cleaned");
    if (outcome.kind !== "cleaned") return;
    const page = mupdf.Document.openDocument(outcome.bytes, "application/pdf").loadPage(0);
    expect(page.getObject().getInheritable("Rotate").asNumber()).toBe(90);
    checkCleaned(page);
  });

  it("reports unchanged when nothing was erased", async () => {
    const bytes = await buildSheet();
    const doc = mupdf.Document.openDocument(bytes, "application/pdf");
    const page = doc.loadPage(0);
    const pix = page.toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, true, false);
    const stored = { data: pix.getPixels(), width: pix.getWidth(), height: pix.getHeight() };
    expect(cleanErasedPage(mupdf, doc, 0, stored).kind).toBe("unchanged");
  });

  it("fails (→ raster fallback) when the erase hit a scanned image, not vectors", async () => {
    const pngPix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 40], false);
    pngPix.clear(0);
    const doc = await PDFDocument.create();
    const img = await doc.embedPng(pngPix.asPNG());
    doc.addPage([W, H]).drawImage(img, { x: 100, y: 100, width: 200, height: 100 });
    const bytes = await doc.save();
    const m = mupdf.Document.openDocument(bytes, "application/pdf");
    const page = m.loadPage(0);
    const pix = page.toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, true, false);
    const data = new Uint8ClampedArray(pix.getPixels());
    const w = pix.getWidth(), h = pix.getHeight();
    eraseCanvasRectInImage({ data, width: w, height: h } as unknown as ImageData, w, h, { x: 0, y: 0, width: w, height: h }, { x: 200, y: 200, w: 100, h: 60 });
    expect(cleanErasedPage(mupdf, m, 0, { data, width: w, height: h }).kind).toBe("failed");
  });
});

describe("exportStitchToPdf with an erased sheet", () => {
  it("embeds the cleaned sheet as a vector Form XObject — no image — with the erased paths absent", async () => {
    const bytes = await buildSheet();
    const stored = eraseSheet(bytes, 0);
    useStitchStore.setState({
      canvasWidth: W,
      canvasHeight: H,
      cropRect: null,
      tiles: [{
        id: "erased",
        sourcePdfBytes: bytes,
        sourcePageIndex: 0,
        x: 0, y: 0, width: W, height: H,
        imageDataUrl: "test://erased-raster",
        imageModified: true,
      }],
    } as never);
    const out = await exportStitchToPdf({ decodeRaster: async () => stored });
    expect(out).not.toBeNull();

    // Structure: every XObject on the export page is a Form; none is an Image.
    const lib = await PDFDocument.load(out!);
    const res = lib.getPage(0).node.Resources()!;
    const xobjs = res.lookup(PDFName.of("XObject"), PDFDict);
    const subtypes = xobjs.keys().map((k) => {
      const obj = xobjs.lookup(k) as PDFRawStream;
      return obj.dict.lookup(PDFName.of("Subtype"))?.toString();
    });
    expect(subtypes.length).toBeGreaterThan(0);
    expect(subtypes.every((s) => s === "/Form")).toBe(true);

    // Content: the same erased/kept assertions hold on the exported page.
    const page = mupdf.Document.openDocument(out!, "application/pdf").loadPage(0);
    const c = checkCleaned(page);
    expect(c.images).toBe(0);
  });

  it("still falls back to a raster image when the erased sheet cannot be cleaned", async () => {
    const pngPix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 40], false);
    pngPix.clear(0);
    const doc = await PDFDocument.create();
    const img = await doc.embedPng(pngPix.asPNG());
    doc.addPage([W, H]).drawImage(img, { x: 100, y: 100, width: 200, height: 100 });
    const bytes = await doc.save();
    const m = mupdf.Document.openDocument(bytes, "application/pdf");
    const pix = m.loadPage(0).toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, true, false);
    const data = new Uint8ClampedArray(pix.getPixels());
    const w = pix.getWidth(), h = pix.getHeight();
    eraseCanvasRectInImage({ data, width: w, height: h } as unknown as ImageData, w, h, { x: 0, y: 0, width: w, height: h }, { x: 200, y: 200, w: 100, h: 60 });
    const png = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 4, 4], true).asPNG();
    useStitchStore.setState({
      canvasWidth: W, canvasHeight: H, cropRect: null,
      tiles: [{
        id: "scan", sourcePdfBytes: bytes, sourcePageIndex: 0, x: 0, y: 0, width: W, height: H,
        imageDataUrl: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
        imageModified: true,
      }],
    } as never);
    const out = await exportStitchToPdf({ decodeRaster: async () => ({ data, width: w, height: h }) });
    const page = mupdf.Document.openDocument(out!, "application/pdf").loadPage(0);
    expect(capture(page).images).toBe(1);
  });
});
