/**
 * Rasterize a page clip to a RawImage for OCR. Thin mupdf shim — everything
 * downstream of the pixels is pure and tested in ocrBands.test.ts. Runs
 * wherever the mupdf document lives (probe worker, or main thread in the
 * modal's fallback path). Pixmaps are created and destroyed per call.
 */
import type { RawImage } from "./ocrService";

export function renderBand(
  mupdf: any, page: any, clip: [number, number, number, number], dpi = 200
): { image: RawImage; scale: number } {
  const S = dpi / 72;
  const bbox = [Math.floor(clip[0] * S), Math.floor(clip[1] * S), Math.ceil(clip[2] * S), Math.ceil(clip[3] * S)];
  const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, true /* alpha */);
  try {
    pix.clear(255);
    const dev = new mupdf.DrawDevice(mupdf.Matrix.scale(S, S), pix);
    page.run(dev, mupdf.Matrix.identity);
    dev.close();
    return {
      image: { width: pix.getWidth(), height: pix.getHeight(), data: new Uint8ClampedArray(pix.getPixels()) },
      scale: S,
    };
  } finally {
    pix.destroy?.();
  }
}
