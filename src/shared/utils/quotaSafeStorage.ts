/**
 * Quota-safe localStorage wrapper for zustand's persist middleware.
 *
 * zustand v4 persist runs the in-memory state update FIRST, then writes to
 * storage synchronously and RE-THROWS any storage error out of `set()`
 * (zustand/middleware.js setItem → `throw errorInSync`). With plain
 * localStorage a `QuotaExceededError` therefore propagates out of the store
 * action that triggered the write — e.g. `addStamp()` — aborting whatever
 * called it mid-flow (the StampCreator's modal-close ran AFTER addStamp, so a
 * quota throw left the modal stuck open while the stamp still appeared in the
 * gallery from the in-memory update).
 *
 * This wrapper swallows write failures: the in-memory state still updates and
 * stays usable for the session; the data just isn't persisted. An optional
 * onWriteError callback lets the caller surface a one-time notification.
 */

export interface QuotaSafeStorage {
  getItem: (name: string) => string | null;
  setItem: (name: string, value: string) => void;
  removeItem: (name: string) => void;
}

export function createQuotaSafeStorage(
  backing: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined,
  onWriteError?: (error: unknown) => void,
): QuotaSafeStorage {
  // No backing storage (SSR, sandboxed iframe) — act as a no-op so persist
  // degrades to in-memory rather than throwing at construction.
  const store = backing ?? null;
  return {
    getItem: (name) => {
      try {
        return store ? store.getItem(name) : null;
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      if (!store) return;
      try {
        store.setItem(name, value);
      } catch (error) {
        // Quota exceeded or storage disabled — keep the in-memory state,
        // drop the persisted copy, and let the caller warn the user once.
        onWriteError?.(error);
      }
    },
    removeItem: (name) => {
      try {
        store?.removeItem(name);
      } catch {
        /* ignore */
      }
    },
  };
}
