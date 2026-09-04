/**
 * `RenderOptions.noCache` — the render-cache opt-out the one-shot consumers
 * (stitch commit, page-selector thumbnails) use.
 *
 * The cache retains a full `ImageData` per entry (38 MB for a 36x24 in sheet at
 * 1.5x) and evicts nothing under 100 entries, so a consumer that never asks for
 * the same page twice must not populate it. These tests pin BOTH halves: no
 * write, and no read (a `noCache` render always re-renders rather than handing
 * back a stale entry another caller happened to cache).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { PDFRenderer } from "./PDFRenderer";

// jsdom ships no ImageData; the renderer only needs `data`/`width`/`height`.
beforeAll(() => {
  if (typeof (globalThis as any).ImageData === "undefined") {
    (globalThis as any).ImageData = class {
      data: Uint8ClampedArray;
      constructor(public width: number, public height: number) {
        this.data = new Uint8ClampedArray(width * height * 4);
      }
    };
  }
});

/** Minimal mupdf stand-in: one 2x2 RGB page, counting how often it rasterises. */
function fakeMupdf() {
  const state = { renders: 0 };
  const mupdf = {
    Matrix: { scale: () => [1, 0, 0, 1, 0, 0], rotate: () => [1, 0, 0, 1, 0, 0], concat: (a: number[]) => a },
    ColorSpace: { DeviceRGB: {} },
  };
  const doc = {
    loadPage: () => ({
      toPixmap: () => {
        state.renders++;
        return {
          getWidth: () => 2,
          getHeight: () => 2,
          getPixels: () => new Uint8ClampedArray(2 * 2 * 3),
          getNumberOfComponents: () => 3,
          destroy() {},
        };
      },
      destroy() {},
    }),
  };
  return { mupdf, doc, state };
}

describe("PDFRenderer noCache", () => {
  it("caches by default: the second render is served from the cache", async () => {
    const { mupdf, doc, state } = fakeMupdf();
    const r = new PDFRenderer(mupdf);
    await r.renderPage(doc, 0, { scale: 1.5 });
    expect(r.hasCachedRender(0, 1.5)).toBe(true);
    await r.renderPage(doc, 0, { scale: 1.5 });
    expect(state.renders).toBe(1);
  });

  it("noCache never writes the cache", async () => {
    const { mupdf, doc, state } = fakeMupdf();
    const r = new PDFRenderer(mupdf);
    await r.renderPage(doc, 0, { scale: 1.5, noCache: true });
    await r.renderPage(doc, 1, { scale: 1.5, noCache: true });
    expect(r.hasCachedRender(0, 1.5)).toBe(false);
    expect(r.hasCachedRender(1, 1.5)).toBe(false);
    expect(state.renders).toBe(2);
  });

  it("noCache never reads the cache either", async () => {
    const { mupdf, doc, state } = fakeMupdf();
    const r = new PDFRenderer(mupdf);
    await r.renderPage(doc, 0, { scale: 1.5 }); // someone else cached this page
    await r.renderPage(doc, 0, { scale: 1.5, noCache: true });
    expect(state.renders).toBe(2);
  });
});
