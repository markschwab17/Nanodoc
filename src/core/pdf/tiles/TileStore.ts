/**
 * TileStore — L2 tile cache backed by OPFS (Origin Private File System).
 *
 * Persists rendered tile pixel buffers across reloads so the second-load
 * tile-rendering pass is decode-only (no mupdf invocation). Module-level
 * singleton: one OPFS subdirectory per origin, all docs share it, namespaced
 * by docId via tileKeyString.
 *
 * File format (per tile):
 *   bytes 0–3   uint32 LE   width
 *   bytes 4–7   uint32 LE   height
 *   bytes 8–N               RGBA pixel data (w * h * 4 bytes)
 *
 * Capacity is byte-limited (~500 MB default). Eviction uses an in-memory
 * LRU index by `lastAccessed`. The index is rebuilt on first init by walking
 * OPFS file headers — `lastAccessed` resets to init time on cold start, but
 * relative ordering within a session is preserved.
 *
 * Graceful degradation: if OPFS isn't available (older browsers, some
 * Tauri webview configurations), get/set become no-ops so the renderer
 * silently falls through to the worker every time.
 *
 * NOT in scope: cross-tab coordination. Two tabs writing the same key can
 * interleave; the last write wins. Acceptable since same-key writes
 * produce identical pixels (deterministic mupdf output for the same input).
 */

import { tileKeyString, type TileKey } from "./types";

const OPFS_DIR_NAME = "nanodoc-tile-cache-v1";
const HEADER_BYTES = 8;
/** ~500 MB browser-default. Tauri can comfortably hold more — bumped to 1 GB. */
const DEFAULT_CAPACITY_BYTES = 500 * 1024 * 1024;

interface TileEntry {
  width: number;
  height: number;
  byteSize: number; // header + pixels
  lastAccessed: number;
}

/** Result of a successful L2 hit. */
export interface TileStoreHit {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Sanitize a tileKeyString into an OPFS-safe filename. tileKeyString
 * uses `/` separators (e.g. "abc123/7/3/2_4") which OPFS forbids in
 * filenames; we replace with `__`.
 */
function fileNameFor(key: TileKey): string {
  return tileKeyString(key).replace(/\//g, "__");
}

/** Reverse: read a stored filename back into a docId-prefix check. */
function fileNameStartsWithDoc(name: string, docId: string): boolean {
  return name.startsWith(`${docId}__`);
}

class TileStore {
  private dir: FileSystemDirectoryHandle | null = null;
  private meta = new Map<string, TileEntry>(); // tileKeyString → meta
  private totalBytes = 0;
  private capacityBytes: number;
  private initPromise: Promise<boolean> | null = null;
  private supported: boolean;

  constructor(capacityBytes = DEFAULT_CAPACITY_BYTES) {
    this.capacityBytes = capacityBytes;
    this.supported =
      typeof navigator !== "undefined" &&
      typeof navigator.storage?.getDirectory === "function";
  }

  /**
   * Lazily initialize: open the OPFS subdirectory and walk its files to
   * rebuild the in-memory metadata index. Returns true if usable, false if
   * OPFS isn't supported or init failed (after which all gets/sets no-op).
   */
  private async ensureInit(): Promise<boolean> {
    if (!this.supported) return false;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      try {
        const root = await navigator.storage.getDirectory();
        this.dir = await root.getDirectoryHandle(OPFS_DIR_NAME, {
          create: true,
        });
        // Walk existing entries to seed metadata. Rebuilds size estimate.
        // FileSystemDirectoryHandle is async-iterable per WICG spec.
        // @ts-expect-error TS lib doesn't include the iterator yet.
        for await (const [name, handle] of this.dir.entries()) {
          if (handle.kind !== "file") continue;
          try {
            const file = await handle.getFile();
            // Read just the header to learn dims; don't load pixels here.
            const headerBuf = await file.slice(0, HEADER_BYTES).arrayBuffer();
            if (headerBuf.byteLength < HEADER_BYTES) continue;
            const view = new DataView(headerBuf);
            const w = view.getUint32(0, true);
            const h = view.getUint32(4, true);
            // Reconstruct the original tileKeyString — opposite of fileNameFor.
            const tileKey = name.replace(/__/g, "/");
            const entry: TileEntry = {
              width: w,
              height: h,
              byteSize: file.size,
              lastAccessed: Date.now(),
            };
            this.meta.set(tileKey, entry);
            this.totalBytes += file.size;
          } catch {
            // Corrupt/partial file — ignore; will be overwritten or pruned.
          }
        }
        return true;
      } catch (e) {
        if (e instanceof Error) {
          console.warn("TileStore init failed; L2 disabled:", e.message);
        }
        this.dir = null;
        return false;
      }
    })();
    return this.initPromise;
  }

  /** Synchronous metadata check — does this key probably hit L2? */
  hasMeta(key: TileKey): boolean {
    return this.meta.has(tileKeyString(key));
  }

  /**
   * Read a tile's pixels from OPFS. Returns null on miss, on read error,
   * or when L2 is unavailable. Updates the in-memory LRU timestamp on hit.
   */
  async get(key: TileKey): Promise<TileStoreHit | null> {
    if (!(await this.ensureInit()) || !this.dir) return null;
    const k = tileKeyString(key);
    const entry = this.meta.get(k);
    if (!entry) return null;
    try {
      const fh = await this.dir.getFileHandle(fileNameFor(key));
      const file = await fh.getFile();
      const buf = await file.arrayBuffer();
      if (buf.byteLength < HEADER_BYTES) return null;
      const view = new DataView(buf);
      const w = view.getUint32(0, true);
      const h = view.getUint32(4, true);
      const pixelBytes = w * h * 4;
      if (buf.byteLength < HEADER_BYTES + pixelBytes) return null;
      const pixels = new Uint8ClampedArray(buf, HEADER_BYTES, pixelBytes);
      entry.lastAccessed = Date.now();
      return { pixels, width: w, height: h };
    } catch {
      // Read error → drop the (apparently bad) metadata entry so we don't
      // keep racing the worker for nothing.
      this.totalBytes -= entry.byteSize;
      this.meta.delete(k);
      return null;
    }
  }

  /**
   * Persist a tile's pixels to OPFS. Best-effort: storage errors are logged
   * once and otherwise swallowed — never propagate to the renderer.
   */
  async set(
    key: TileKey,
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
  ): Promise<void> {
    if (!(await this.ensureInit()) || !this.dir) return;
    const byteSize = HEADER_BYTES + pixels.byteLength;
    if (byteSize > this.capacityBytes) return; // single tile larger than cap

    // Make room. Evict by oldest lastAccessed until we'd fit. Scanning the
    // whole map per eviction is O(N) but only runs near capacity, and the
    // cap means N is bounded (~500 entries at the worst-case 1 MB/tile).
    while (
      this.totalBytes + byteSize > this.capacityBytes &&
      this.meta.size > 0
    ) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, entry] of this.meta) {
        if (entry.lastAccessed < oldestTime) {
          oldestTime = entry.lastAccessed;
          oldestKey = k;
        }
      }
      if (!oldestKey) break;
      await this.deleteByMetaKey(oldestKey);
    }

    const k = tileKeyString(key);
    try {
      const fh = await this.dir.getFileHandle(fileNameFor(key), {
        create: true,
      });
      const writable = await fh.createWritable();
      const header = new ArrayBuffer(HEADER_BYTES);
      const view = new DataView(header);
      view.setUint32(0, width, true);
      view.setUint32(4, height, true);
      await writable.write(header);
      // Wrap into a Uint8Array view so the FileSystemWritableFileStream
      // accepts it regardless of whether the source Uint8ClampedArray is
      // typed against ArrayBuffer or ArrayBufferLike (TS strictness).
      await writable.write(
        new Uint8Array(
          pixels.buffer as ArrayBuffer,
          pixels.byteOffset,
          pixels.byteLength,
        ),
      );
      await writable.close();
      const prior = this.meta.get(k);
      if (prior) this.totalBytes -= prior.byteSize;
      this.meta.set(k, {
        width,
        height,
        byteSize,
        lastAccessed: Date.now(),
      });
      this.totalBytes += byteSize;
    } catch (e) {
      if (e instanceof Error) {
        console.warn("TileStore.set failed:", e.message);
      }
    }
  }

  /** Drop all stored tiles for a docId. Called on doc close / invalidate. */
  async invalidateDoc(docId: string): Promise<void> {
    // Drop the in-memory metadata BEFORE the first await: callers treat this
    // as fire-and-forget, and a tile fetch issued right after must not
    // hasMeta-hit stale pixels while the OPFS deletions are still pending.
    const toDelete: string[] = [];
    for (const k of this.meta.keys()) {
      if (k.startsWith(`${docId}/`)) toDelete.push(k);
    }
    for (const k of toDelete) {
      const entry = this.meta.get(k);
      if (entry) {
        this.meta.delete(k);
        this.totalBytes -= entry.byteSize;
      }
    }
    if (!(await this.ensureInit()) || !this.dir) return;
    for (const k of toDelete) {
      try {
        await this.dir.removeEntry(k.replace(/\//g, "__"));
      } catch {
        // already gone or locked; metadata index is already updated
      }
    }
    // Also defensively walk OPFS in case our metadata is stale.
    try {
      // @ts-expect-error directory iteration types
      for await (const [name] of this.dir.entries()) {
        if (fileNameStartsWithDoc(name, docId)) {
          try {
            await this.dir.removeEntry(name);
          } catch {}
        }
      }
    } catch {}
  }

  /** Diagnostics: bytes currently consumed in OPFS by this store. */
  bytesUsed(): number {
    return this.totalBytes;
  }

  private async deleteByMetaKey(metaKey: string): Promise<void> {
    if (!this.dir) return;
    const entry = this.meta.get(metaKey);
    if (!entry) return;
    this.meta.delete(metaKey);
    this.totalBytes -= entry.byteSize;
    try {
      await this.dir.removeEntry(metaKey.replace(/\//g, "__"));
    } catch {
      // already gone or locked; metadata index is already updated
    }
  }
}

let _instance: TileStore | null = null;
/** Lazy module-level singleton. First caller initializes; others share. */
export function getTileStore(): TileStore {
  if (!_instance) _instance = new TileStore();
  return _instance;
}
