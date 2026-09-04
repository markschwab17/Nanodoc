/**
 * Tile-raster PNG ENCODE worker.
 *
 * `canvas.toDataURL("image/png")` on a 10 MP sheet is 0.7–1.5 s of fully
 * synchronous main-thread work, once per sheet — a 5-sheet commit was five
 * multi-second freezes. `OffscreenCanvas.convertToBlob` does the same encode in
 * a worker, and a Blob costs nothing to post back (versus a ~3 MB base64 string
 * per sheet on the JS heap).
 *
 * Same shape as `autostitch/ocr.worker.ts`: the pixel buffer is TRANSFERRED in,
 * never copied. On any failure — no OffscreenCanvas in an old webview, an
 * over-size canvas, an encoder that returns nothing — it replies `{ id, error }`
 * and the caller falls back to a main-thread encode, which reports its own
 * failure as a visible error tile rather than a blank one.
 */
export interface RasterEncodeRequest {
  id: number;
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type RasterEncodeResponse =
  | { id: number; blob: Blob }
  | { id: number; error: string };

async function encode(req: RasterEncodeRequest): Promise<Blob> {
  // ImageData wants Uint8ClampedArray<ArrayBuffer>, not <ArrayBufferLike>
  // (which could be SharedArrayBuffer-backed) — same cast as ocr.worker.ts.
  const canvas = new OffscreenCanvas(req.width, req.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
  ctx.putImageData(
    new ImageData(req.data as unknown as Uint8ClampedArray<ArrayBuffer>, req.width, req.height),
    0,
    0,
  );
  const blob = await canvas.convertToBlob({ type: "image/png" });
  if (!blob || blob.size === 0) throw new Error("convertToBlob produced no data");
  return blob;
}

self.onmessage = async (e: MessageEvent<RasterEncodeRequest>) => {
  const req = e.data;
  try {
    const blob = await encode(req);
    (self as any).postMessage({ id: req.id, blob } satisfies RasterEncodeResponse);
  } catch (err) {
    (self as any).postMessage({ id: req.id, error: String(err) } satisfies RasterEncodeResponse);
  }
};
