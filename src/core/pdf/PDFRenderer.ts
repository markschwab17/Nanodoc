/**
 * PDF Renderer Abstraction
 *
 * Provides a unified interface for rendering PDF pages using mupdf-js
 * with caching and performance optimizations.
 *
 * Heavy rendering (toPixmap) runs in a Web Worker so the main thread
 * stays responsive during scroll, pan, and zoom.
 *
 * If the worker gets stuck on an oversized page (head-of-line blocking),
 * it is terminated and restarted so other pages can continue.
 */

import type { WorkerRequest, WorkerResponse } from "./pdfRender.worker";

export interface RenderOptions {
  scale?: number;
  rotation?: number;
  backgroundColor?: string;
}

export interface RenderedPage {
  pageNumber: number;
  imageData: ImageData | string;
  width: number;
  height: number;
  scale: number;
}

/** How long to wait for a worker render before killing and restarting (ms) */
const WORKER_RENDER_TIMEOUT = 15_000;

export class PDFRenderer {
  private mupdf: any;
  private renderCache: Map<string, RenderedPage> = new Map();

  // Worker state
  private worker: Worker | null = null;
  private workerReady = false;
  private nextRequestId = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (r: RenderedPage) => void; reject: (e: Error) => void; pageNumber: number; scale: number; timer: ReturnType<typeof setTimeout> }
  >();
  private workerDocId: string | null = null;

  private getAdaptiveCacheSize(scale: number): number {
    // Generous cache so scrolling back to previously-viewed pages is instant.
    // Each entry is an ImageData: at 2MP (~8MB) to 29MP (~116MB) depending on page size.
    if (scale >= 3.0) return 50;
    if (scale >= 2.0) return 80;
    if (scale >= 1.5) return 100;
    return 150;
  }

  constructor(mupdf: any) {
    this.mupdf = mupdf;
    this.spawnWorker();
  }

  // ─── Worker lifecycle ───────────────────────────────────────────────

  private spawnWorker() {
    try {
      this.worker = new Worker(
        new URL("./pdfRender.worker.ts", import.meta.url),
        { type: "module" }
      );

      this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const msg = event.data;
        if (msg.type === "ready") {
          this.workerReady = true;
          return;
        }
        if (msg.type === "renderResult") {
          const pending = this.pendingRequests.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(msg.id);
            const imageData = new ImageData(
              new Uint8ClampedArray(msg.buffer),
              msg.width,
              msg.height
            );
            const rendered: RenderedPage = {
              pageNumber: pending.pageNumber,
              imageData,
              width: msg.width,
              height: msg.height,
              scale: pending.scale,
            };
            this.cacheRender(this.getCacheKey(pending.pageNumber, pending.scale, 0), rendered);
            pending.resolve(rendered);
          }
          return;
        }
        if (msg.type === "error") {
          const pending = this.pendingRequests.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(msg.id);
            pending.reject(new Error(msg.message));
          }
        }
      };

      this.worker.onerror = (e) => {
        console.warn("Render worker error, falling back to main thread:", e.message);
        this.killWorker();
      };

      this.worker.postMessage({ type: "init" } satisfies WorkerRequest);
    } catch (e) {
      console.warn("Could not create render worker, using main thread:", e);
      this.worker = null;
    }
  }

  /**
   * Terminate the current worker, reject all pending requests, and
   * optionally restart. Used when the worker is stuck on a massive page.
   */
  private killWorker(restart = true) {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.workerReady = false;
    this.workerDocId = null;

    // Reject everything still waiting
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Worker terminated (render timeout)"));
    }
    this.pendingRequests.clear();

    if (restart) {
      this.spawnWorker();
    }
  }

  // ─── Cache helpers ──────────────────────────────────────────────────

  private getCacheKey(pageNumber: number, scale: number, rotation: number): string {
    // Round scale to 4 decimals so floating-point drift doesn't cause cache misses
    return `${pageNumber}_${Math.round(scale * 10000) / 10000}_${rotation}`;
  }

  clearCache(): void {
    this.renderCache.clear();
  }

  clearCacheForPage(pageNumber: number): void {
    const prefix = `${pageNumber}_`;
    for (const key of this.renderCache.keys()) {
      if (key.startsWith(prefix)) {
        this.renderCache.delete(key);
      }
    }
  }

  /**
   * Check if a render is already in cache (for skip-debounce fast path).
   */
  hasCachedRender(pageNumber: number, scale: number, rotation = 0): boolean {
    return this.renderCache.has(this.getCacheKey(pageNumber, scale, rotation));
  }

  // ─── Render API ─────────────────────────────────────────────────────

  async renderPage(
    document: any,
    pageNumber: number,
    options: RenderOptions = {},
    pdfData?: Uint8Array | null,
    docId?: string
  ): Promise<RenderedPage> {
    const scale = options.scale ?? 1.0;
    const rotation = options.rotation ?? 0;
    const cacheKey = this.getCacheKey(pageNumber, scale, rotation);

    if (this.renderCache.has(cacheKey)) {
      const cached = this.renderCache.get(cacheKey)!;
      this.renderCache.delete(cacheKey);
      this.renderCache.set(cacheKey, cached);
      return cached;
    }

    // Try worker path
    if (this.worker && this.workerReady && pdfData && docId) {
      return this.renderPageInWorker(docId, pdfData, pageNumber, scale, rotation);
    }

    // Fallback: main-thread rendering
    return this.renderPageMainThread(document, pageNumber, scale, rotation);
  }

  private renderPageInWorker(
    docId: string,
    pdfData: Uint8Array,
    pageNumber: number,
    scale: number,
    rotation: number
  ): Promise<RenderedPage> {
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;

      // Timeout: if the worker is stuck on a massive page, kill it and restart
      // so other pages can proceed. The timed-out page falls back to main thread.
      const timer = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          console.warn(`Worker render timeout for page ${pageNumber} (scale ${scale.toFixed(2)}), restarting worker`);
          this.killWorker(true);
          pending.reject(new Error("Render timeout"));
        }
      }, WORKER_RENDER_TIMEOUT);

      this.pendingRequests.set(id, { resolve, reject, pageNumber, scale, timer });

      const needsData = this.workerDocId !== docId;
      const msg: WorkerRequest = {
        type: "render",
        id,
        docId,
        data: needsData ? pdfData : undefined,
        pageNumber,
        scale,
        rotation,
      };
      this.worker!.postMessage(msg);
      if (needsData) this.workerDocId = docId;
    });
  }

  private async renderPageMainThread(
    document: any,
    pageNumber: number,
    scale: number,
    rotation: number
  ): Promise<RenderedPage> {
    try {
      const page = document.loadPage(pageNumber);

      let matrix = this.mupdf.Matrix.scale(scale, scale);
      if (rotation !== 0) {
        const rotationMatrix = this.mupdf.Matrix.rotate(rotation);
        matrix = this.mupdf.Matrix.concat(matrix, rotationMatrix);
      }

      const pixmap = page.toPixmap(
        matrix,
        this.mupdf.ColorSpace.DeviceRGB,
        true,
        false
      );

      const width = pixmap.getWidth();
      const height = pixmap.getHeight();
      const pixels = pixmap.getPixels();

      const imageData = new ImageData(width, height);
      const data = imageData.data;
      const numPixels = width * height;
      const components = pixmap.getNumberOfComponents();

      if (components === 4) {
        data.set(pixels.subarray(0, numPixels * 4));
      } else if (components === 3) {
        for (let i = 0; i < numPixels; i++) {
          const srcIdx = i * 3;
          const dstIdx = i * 4;
          data[dstIdx] = pixels[srcIdx];
          data[dstIdx + 1] = pixels[srcIdx + 1];
          data[dstIdx + 2] = pixels[srcIdx + 2];
          data[dstIdx + 3] = 255;
        }
      } else {
        throw new Error(`Unsupported color components: ${components}`);
      }

      const rendered: RenderedPage = { pageNumber, imageData, width, height, scale };
      this.cacheRender(this.getCacheKey(pageNumber, scale, rotation), rendered);
      return rendered;
    } catch (error) {
      console.error(`Error rendering page ${pageNumber}:`, error);
      throw new Error(`Failed to render page ${pageNumber}: ${error}`);
    }
  }

  /**
   * Render a PDF page to data URL (for thumbnails) — always main thread
   */
  async renderPageToDataURL(
    document: any,
    pageNumber: number,
    options: RenderOptions = {}
  ): Promise<string> {
    try {
      const scale = options.scale ?? 0.15;
      const page = document.loadPage(pageNumber);
      const matrix = this.mupdf.Matrix.scale(scale, scale);
      const pixmap = page.toPixmap(
        matrix,
        this.mupdf.ColorSpace.DeviceRGB,
        false,
        true
      );

      const pngData = pixmap.asPNG();
      const blob = new Blob([pngData], { type: 'image/png' });
      return URL.createObjectURL(blob);
    } catch (error) {
      console.error(`Error rendering thumbnail for page ${pageNumber}:`, error);
      throw error;
    }
  }

  cancelPendingRequests(): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Render cancelled"));
    }
    this.pendingRequests.clear();
  }

  private cacheRender(key: string, rendered: RenderedPage): void {
    const adaptiveMaxSize = this.getAdaptiveCacheSize(rendered.scale);
    if (this.renderCache.size >= adaptiveMaxSize) {
      const firstKey = this.renderCache.keys().next().value;
      if (firstKey) {
        this.renderCache.delete(firstKey);
      }
    }
    this.renderCache.set(key, rendered);
  }
}
