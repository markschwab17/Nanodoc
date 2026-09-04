/**
 * `renderPageCrop` is what keeps the align loupe cheap: it must rasterise ONLY the
 * crop. That is entirely a matter of which bbox the pixmap gets and which matrix the
 * page is run through, so those are what this pins — against a fake mupdf, because the
 * real one is WASM and cannot run under jsdom.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PDFRenderer } from "./PDFRenderer";
import { planCropRender } from "@/features/stitch/loupeGeometry";

// jsdom has no ImageData; the renderer only uses `new ImageData(w, h)` and `.data`.
beforeAll(() => {
  if (typeof globalThis.ImageData === "undefined") {
    (globalThis as unknown as { ImageData: unknown }).ImageData = class {
      width: number;
      height: number;
      data: Uint8ClampedArray;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        this.data = new Uint8ClampedArray(width * height * 4);
      }
    };
  }
});

function fakeMupdf() {
  const pixmaps: Array<{ bbox: number[]; cleared: number | undefined; destroyed: boolean }> = [];
  const runs: Array<{ device: unknown; matrix: number[] }> = [];

  class Pixmap {
    bbox: number[];
    record: (typeof pixmaps)[number];
    constructor(_colorspace: unknown, bbox: number[], _alpha: boolean) {
      this.bbox = bbox;
      this.record = { bbox, cleared: undefined, destroyed: false };
      pixmaps.push(this.record);
    }
    clear(value?: number) {
      this.record.cleared = value;
    }
    getWidth() {
      return this.bbox[2] - this.bbox[0];
    }
    getHeight() {
      return this.bbox[3] - this.bbox[1];
    }
    getNumberOfComponents() {
      return 3;
    }
    getPixels() {
      const n = this.getWidth() * this.getHeight() * 3;
      const px = new Uint8ClampedArray(n);
      px.fill(200);
      return px;
    }
    destroy() {
      this.record.destroyed = true;
    }
  }

  class DrawDevice {
    closed = false;
    destroyed = false;
    constructor(public matrix: number[], public pixmap: Pixmap) {}
    close() {
      this.closed = true;
    }
    destroy() {
      this.destroyed = true;
    }
  }

  const page = {
    run: vi.fn((device: unknown, matrix: number[]) => runs.push({ device, matrix })),
    destroy: vi.fn(),
  };
  const document = { loadPage: vi.fn(() => page) };
  const mupdf = {
    ColorSpace: { DeviceRGB: "DeviceRGB" },
    Matrix: { identity: [1, 0, 0, 1, 0, 0] },
    Pixmap,
    DrawDevice,
  };
  return { mupdf, document, page, pixmaps, runs };
}

describe("PDFRenderer.renderPageCrop", () => {
  it("sizes the pixmap to the plan's bbox and runs the page through the plan's matrix", async () => {
    const { mupdf, document, page, pixmaps, runs } = fakeMupdf();
    const renderer = new PDFRenderer(mupdf);
    const plan = planCropRender({ x: 100, y: 200, width: 36, height: 36 }, 144, 0);

    const image = await renderer.renderPageCrop(document, 7, plan);

    expect(document.loadPage).toHaveBeenCalledWith(7);
    // ONLY the crop is rasterised — the pixmap is the plan's bbox, not the page.
    expect(pixmaps).toHaveLength(1);
    expect(pixmaps[0].bbox).toEqual(plan.bbox);
    expect(pixmaps[0].cleared).toBe(255);
    expect(runs).toHaveLength(1);
    expect(runs[0].matrix).toEqual(plan.matrix);
    expect(image.width).toBe(plan.width);
    expect(image.height).toBe(plan.height);
    // RGB was expanded to RGBA with a solid alpha.
    expect(image.data[0]).toBe(200);
    expect(image.data[3]).toBe(255);
    // Nothing is left holding WASM memory.
    expect(pixmaps[0].destroyed).toBe(true);
    expect(page.destroy).toHaveBeenCalled();
  });

  it("frees the page and pixmap even when the run throws", async () => {
    const { mupdf, document, page, pixmaps } = fakeMupdf();
    page.run.mockImplementation(() => {
      throw new Error("boom");
    });
    const renderer = new PDFRenderer(mupdf);
    const plan = planCropRender({ x: 0, y: 0, width: 10, height: 10 }, 72, 0);

    await expect(renderer.renderPageCrop(document, 0, plan)).rejects.toThrow("boom");
    expect(pixmaps[0].destroyed).toBe(true);
    expect(page.destroy).toHaveBeenCalled();
  });
});
