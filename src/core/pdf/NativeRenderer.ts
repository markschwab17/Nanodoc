/**
 * Native PDF Renderer (Tauri / Rust backend)
 *
 * Delegates rendering to the Rust mupdf library via Tauri IPC commands,
 * bypassing WASM and browser canvas limits. Provides the same public API
 * as PDFRenderer so callers can swap transparently.
 *
 * Binary data is transferred as base64 strings to avoid the catastrophic
 * performance of JSON number arrays over Tauri IPC.
 */

import { invoke } from "@tauri-apps/api/core";
import type { RenderOptions, RenderedPage } from "./PDFRenderer";

interface NativeRenderResult {
  page_number: number;
  width: number;
  height: number;
  /** Base64-encoded RGBA pixel data */
  data: string;
}

interface NativePageInfo {
  width: number;
  height: number;
  rotation: number;
}

interface NativeDocInfo {
  page_count: number;
  pages: NativePageInfo[];
}

// ── Base64 helpers ──────────────────────────────────────────────────

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8Clamped(b64: string): Uint8ClampedArray {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8ClampedArray(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ── Renderer ────────────────────────────────────────────────────────

export class NativeRenderer {
  private renderCache: Map<string, RenderedPage> = new Map();
  private loadedDocs: Set<string> = new Set();

  // ── Cache helpers ──────────────────────────────────────────────────

  private getCacheKey(pageNumber: number, scale: number, rotation: number): string {
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

  hasCachedRender(pageNumber: number, scale: number, rotation = 0): boolean {
    return this.renderCache.has(this.getCacheKey(pageNumber, scale, rotation));
  }

  // ── Document lifecycle ─────────────────────────────────────────────

  async ensureLoaded(docId: string, pdfData: Uint8Array): Promise<NativeDocInfo> {
    if (this.loadedDocs.has(docId)) {
      return { page_count: 0, pages: [] };
    }
    const info = await invoke<NativeDocInfo>("load_pdf", {
      pdfData: uint8ToBase64(pdfData),
      docId,
    });
    this.loadedDocs.add(docId);
    return info;
  }

  async closeDocument(docId: string): Promise<void> {
    if (!this.loadedDocs.has(docId)) return;
    await invoke("close_pdf", { docId });
    this.loadedDocs.delete(docId);
  }

  // ── Render API (same shape as PDFRenderer) ─────────────────────────

  async renderPage(
    _document: any,
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

    if (!pdfData || !docId) {
      throw new Error("NativeRenderer requires pdfData and docId");
    }

    await this.ensureLoaded(docId, pdfData);

    const result = await invoke<NativeRenderResult>("render_page", {
      docId,
      pageNumber,
      scale,
    });

    const pixels = base64ToUint8Clamped(result.data);
    const imageData = new ImageData(pixels as unknown as Uint8ClampedArray<ArrayBuffer>, result.width, result.height);

    const rendered: RenderedPage = {
      pageNumber: result.page_number,
      imageData,
      width: result.width,
      height: result.height,
      scale,
    };

    this.cacheRender(cacheKey, rendered);
    return rendered;
  }

  /**
   * Render a page to data URL (thumbnails).
   */
  async renderPageToDataURL(
    document: any,
    pageNumber: number,
    options: RenderOptions = {},
    pdfData?: Uint8Array | null,
    docId?: string
  ): Promise<string> {
    const rendered = await this.renderPage(document, pageNumber, options, pdfData, docId);
    const imageData = rendered.imageData as ImageData;
    const canvas = globalThis.document.createElement("canvas");
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get canvas context");
    ctx.putImageData(imageData, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b: Blob | null) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
    });
    return URL.createObjectURL(blob);
  }

  cancelPendingRequests(): void {
    // No persistent worker to cancel
  }

  private cacheRender(key: string, rendered: RenderedPage): void {
    const maxSize = 300;
    if (this.renderCache.size >= maxSize) {
      const firstKey = this.renderCache.keys().next().value;
      if (firstKey) {
        this.renderCache.delete(firstKey);
      }
    }
    this.renderCache.set(key, rendered);
  }
}
