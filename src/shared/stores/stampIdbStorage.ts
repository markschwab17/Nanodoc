/**
 * IndexedDB-backed storage for the stamp store.
 *
 * Stamp images are full-resolution data-URLs; a handful of them blow past
 * localStorage's ~5MB origin cap. Persisting them there caused
 * QuotaExceededError to surface synchronously out of zustand's `set()` (and
 * therefore out of `addStamp()`), which left the StampCreator modal stuck
 * open and blocked placement. IndexedDB's quota is orders of magnitude larger
 * (typically a large fraction of free disk), and because this adapter is
 * async, zustand never re-throws a write failure synchronously — so the bug
 * is gone structurally as well.
 *
 * Behavior:
 *  - getItem migrates a legacy localStorage value into IndexedDB on first
 *    read, then clears it from localStorage (freeing the clogged origin cap).
 *  - setItem writes to IndexedDB; on failure it falls back to (quota-safe)
 *    localStorage and reports the error once.
 *  - When IndexedDB is unavailable (private mode, old browser), it degrades
 *    to quota-safe localStorage.
 *
 * The IndexedDB layer is injected so the migration/fallback logic is unit
 * testable without a real IndexedDB (jsdom has none).
 */

import { createQuotaSafeStorage, type QuotaSafeStorage } from "@/shared/utils/quotaSafeStorage";

/** Minimal async key/value contract over a persistence backend. */
export interface AsyncKV {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  del: (key: string) => Promise<void>;
}

/** zustand StateStorage shape (async variant). */
export interface AsyncStateStorage {
  getItem: (name: string) => Promise<string | null>;
  setItem: (name: string, value: string) => Promise<void>;
  removeItem: (name: string) => Promise<void>;
}

/** Build a real IndexedDB-backed AsyncKV, or null if IndexedDB is unavailable. */
export function createIdbKV(dbName: string, storeName: string): AsyncKV | null {
  if (typeof indexedDB === "undefined") return null;

  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(storeName)) {
          req.result.createObjectStore(storeName);
        }
      };
    });

  const tx = <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> =>
    open().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const t = db.transaction(storeName, mode);
          const req = run(t.objectStore(storeName));
          req.onsuccess = () => resolve(req.result as T);
          req.onerror = () => reject(req.error);
          t.oncomplete = () => db.close();
          t.onabort = () => {
            db.close();
            reject(t.error);
          };
        }),
    );

  return {
    get: (key) => tx<string | null>("readonly", (s) => s.get(key)).then((v) => (v == null ? null : String(v))),
    set: (key, value) => tx<void>("readwrite", (s) => s.put(value, key)).then(() => undefined),
    del: (key) => tx<void>("readwrite", (s) => s.delete(key)).then(() => undefined),
  };
}

export interface StampStorageOptions {
  /** IndexedDB backend; null routes everything to localStorage. */
  idb?: AsyncKV | null;
  /** Quota-safe localStorage used for migration source + fallback. */
  local?: QuotaSafeStorage;
  /** Called once-ish when a write fails (e.g. to notify the user). */
  onWriteError?: (error: unknown) => void;
}

/**
 * Compose the async StateStorage zustand persists through. Migrates a legacy
 * localStorage value into IndexedDB on first read and falls back to
 * localStorage when IndexedDB is missing or a write fails.
 */
export function createStampStorage(opts: StampStorageOptions = {}): AsyncStateStorage {
  const idb =
    opts.idb !== undefined ? opts.idb : createIdbKV("pdf-editor-stamps", "kv");
  const local =
    opts.local ??
    createQuotaSafeStorage(
      typeof window !== "undefined" ? window.localStorage : undefined,
      opts.onWriteError,
    );
  const onWriteError = opts.onWriteError;

  return {
    async getItem(name) {
      if (!idb) return local.getItem(name);
      try {
        const fromIdb = await idb.get(name);
        if (fromIdb != null) return fromIdb;
        // One-time migration of pre-IndexedDB data.
        const legacy = local.getItem(name);
        if (legacy != null) {
          await idb.set(name, legacy);
          local.removeItem(name); // free the clogged localStorage origin cap
          return legacy;
        }
        return null;
      } catch {
        return local.getItem(name);
      }
    },

    async setItem(name, value) {
      if (!idb) {
        local.setItem(name, value);
        return;
      }
      try {
        await idb.set(name, value);
      } catch (error) {
        onWriteError?.(error);
        // Last-resort: try localStorage (quota-safe; may also no-op).
        local.setItem(name, value);
      }
    },

    async removeItem(name) {
      if (idb) {
        try {
          await idb.del(name);
        } catch {
          /* ignore */
        }
      }
      local.removeItem(name);
    },
  };
}
