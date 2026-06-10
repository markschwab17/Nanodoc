/**
 * Tiled-renderer registry — one TiledPageRenderer per docId, shared across
 * all PageCanvas instances rendering pages of that document.
 *
 * Avoids spawning N×workerCount workers per page. Lifetime: instances live
 * until the app exits or `destroyTiledRenderer(docId)` is called explicitly.
 * Tab/document close-time cleanup is a phase-7 concern; today the cost of
 * leaking is one mupdf wasm instance + one decoded copy of the doc per
 * worker, per opened doc.
 */

import { TiledPageRenderer } from "./TiledPageRenderer";
import type { PageDims } from "./types";

const cache = new Map<string, TiledPageRenderer>();

export interface RegistryParams {
  docId: string;
  pdfBytes: Uint8Array;
  pageDims: (page: number) => PageDims;
  workerCount?: number;
  cacheCapacity?: number;
}

export function getOrCreateTiledRenderer(
  params: RegistryParams,
): TiledPageRenderer {
  const existing = cache.get(params.docId);
  if (existing) return existing;
  const renderer = new TiledPageRenderer(params);
  cache.set(params.docId, renderer);
  return renderer;
}

/** Lookup-only access; returns undefined when no renderer exists for the doc. */
export function getTiledRenderer(docId: string): TiledPageRenderer | undefined {
  return cache.get(docId);
}

/**
 * Drop every cached tile for a document after its content changed (e.g. a
 * redaction baked into the page), and notify mounted TiledCanvas instances
 * to re-request their viewports. No-op when the tile renderer isn't active
 * for the doc.
 */
export function invalidateTiledRendererForDoc(docId: string): void {
  const renderer = cache.get(docId);
  if (!renderer) return;
  renderer.invalidate();
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("nanodoc:tiles-invalidated", { detail: { docId } }),
    );
  }
}

export function destroyTiledRenderer(docId: string): void {
  const renderer = cache.get(docId);
  if (renderer) {
    renderer.destroy();
    cache.delete(docId);
  }
}

export function destroyAllTiledRenderers(): void {
  for (const renderer of cache.values()) renderer.destroy();
  cache.clear();
}
