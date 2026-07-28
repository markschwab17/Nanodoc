/**
 * OCR CONVERSION worker — NOT a tesseract worker.
 *
 * Portability rule: tesseract MUST be created from the MAIN thread. Nested
 * workers (a tesseract worker spawned from inside another worker) are not
 * dependable in the webviews this app packages for — macOS WKWebView and Linux
 * WebKitGTK (see src-tauri/tauri.conf.json `targets: "all"`). A nested-worker
 * failure there is silent, so OCR-based alignment would quietly never work. The
 * tesseract scheduler therefore lives on the main thread in ocrService.ts.
 *
 * This worker's ONLY job is the CPU raster→image conversion that would
 * otherwise starve the modal's page-render loop: it receives
 * `{ocrId, image: RawImage}` (the pixel buffer is transferred, not copied),
 * draws it onto an OffscreenCanvas and `convertToBlob()`s it (both supported in
 * plain workers across modern Chrome/WebKit), then replies `{ocrId, blob}`
 * (Blobs are cheap to postMessage). The main thread hands that Blob straight to
 * `scheduler.addJob("recognize", blob)`, so the only main-thread cost is the
 * postMessage — the heavy canvas/putImageData/convertToBlob stays off main.
 *
 * If OffscreenCanvas/convertToBlob is unavailable (an ancient webview), the
 * conversion throws and we reply `{ocrId, error}` so the main thread can fall
 * back to a `<canvas>` conversion — degraded, but never silently dead.
 */
import type { RawImage } from "./ocrService";

async function toBlob(image: RawImage): Promise<Blob> {
  // ImageData requires Uint8ClampedArray<ArrayBuffer>, not <ArrayBufferLike>
  // (the latter could be SharedArrayBuffer-backed) — same cast used in NativeRenderer.ts.
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
  ctx.putImageData(
    new ImageData(image.data as unknown as Uint8ClampedArray<ArrayBuffer>, image.width, image.height),
    0,
    0,
  );
  return await canvas.convertToBlob({ type: "image/png" });
}

self.onmessage = async (e: MessageEvent<{ ocrId: number; image: RawImage }>) => {
  const { ocrId, image } = e.data;
  try {
    const blob = await toBlob(image);
    (self as any).postMessage({ ocrId, blob });
  } catch (err) {
    // The main thread treats a missing blob as "convert on main" (or []).
    (self as any).postMessage({ ocrId, error: String(err) });
  }
};
