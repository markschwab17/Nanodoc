/**
 * Tile-raster PNG ENCODE worker.
 *
 * `canvas.toDataURL("image/png")` on a 10 MP sheet is 0.7–1.5 s of fully
 * synchronous main-thread work, once per sheet — a 5-sheet commit was five
 * multi-second freezes. `OffscreenCanvas.convertToBlob` does the same encode in
 * a worker, and a Blob costs nothing to post back (versus a ~3 MB base64 string
 * per sheet on the JS heap).
 *
 * CAPABILITY HANDSHAKE. The webviews this app packages for do not all have
 * `OffscreenCanvas.convertToBlob` (Safari < 16.4, and the WKWebView /
 * WebKitGTK builds Tauri ships), and a worker that cannot encode must be found
 * out BEFORE the main thread hands it any pixels — otherwise every sheet takes
 * a doomed round-trip. So the first thing this worker does is actually encode a
 * 1x1 canvas and report `{kind:"ready", capable}`. The client only sends real
 * work to a worker that has said yes.
 *
 * The pixel buffer is COPIED in, not transferred: a transfer detaches the
 * caller's `ImageData` and makes the main-thread fallback unreachable for
 * exactly the failures it exists to cover. See `rasterEncode.ts`.
 */
export interface RasterEncodeRequest {
  id: number;
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type RasterEncodeResponse =
  | { kind: "ready"; capable: boolean }
  | { kind: "result"; id: number; blob: Blob }
  | { kind: "error"; id: number; message: string };

/** ImageData wants Uint8ClampedArray<ArrayBuffer>, not <ArrayBufferLike>
 *  (which could be SharedArrayBuffer-backed) — same cast as ocr.worker.ts. */
async function encode(width: number, height: number, data: Uint8ClampedArray): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
  ctx.putImageData(new ImageData(data as unknown as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  if (!blob || blob.size === 0) throw new Error("convertToBlob produced no data");
  return blob;
}

/** Prove the encode path end to end on one pixel before claiming it works. */
async function probeCapability(): Promise<boolean> {
  try {
    if (typeof OffscreenCanvas === "undefined") return false;
    const blob = await encode(1, 1, new Uint8ClampedArray(4));
    return blob.size > 0;
  } catch {
    return false;
  }
}

void probeCapability().then((capable) => {
  (self as any).postMessage({ kind: "ready", capable } satisfies RasterEncodeResponse);
});

self.onmessage = async (e: MessageEvent<RasterEncodeRequest>) => {
  const req = e.data;
  try {
    const blob = await encode(req.width, req.height, req.data);
    (self as any).postMessage({ kind: "result", id: req.id, blob } satisfies RasterEncodeResponse);
  } catch (err) {
    (self as any).postMessage({ kind: "error", id: req.id, message: String(err) } satisfies RasterEncodeResponse);
  }
};
