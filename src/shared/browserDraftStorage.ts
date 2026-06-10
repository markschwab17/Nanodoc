/**
 * Crash-recovery draft storage backed by IndexedDB.
 *
 * Used for documents that have no file path to auto-save to (browser opens,
 * never-saved documents). The full serialized PDF bytes are stored every
 * auto-save tick; on startup any leftover drafts are offered for recovery.
 *
 * Drafts are deleted when the document is saved for real (tab becomes
 * unmodified), recovered, or explicitly discarded. Old drafts are garbage
 * collected on startup.
 */

const DB_NAME = "pdf-editor-drafts";
const STORE_NAME = "drafts";
const DB_VERSION = 1;

/** Keep at most this many drafts; oldest beyond the cap are GC'd. */
const MAX_DRAFTS = 5;
/** Drafts older than this are GC'd on startup. */
const MAX_DRAFT_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface DraftRecord {
  /** Document id at the time the draft was written (unique per session). */
  key: string;
  /** Display file name, e.g. "plans.pdf". */
  name: string;
  /** Full serialized PDF bytes (annotations already baked in). */
  bytes: Uint8Array;
  updatedAt: number;
}

export function isDraftStorageAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
  });
}

export async function saveDraft(key: string, name: string, bytes: Uint8Array): Promise<void> {
  if (!isDraftStorageAvailable() || !key) return;
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({ key, name, bytes, updatedAt: Date.now() } satisfies DraftRecord);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch (e) {
    console.warn("[draftStorage] saveDraft failed:", e);
  }
}

export async function listDrafts(): Promise<DraftRecord[]> {
  if (!isDraftStorageAvailable()) return [];
  try {
    const db = await openDB();
    return await new Promise<DraftRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => {
        db.close();
        const rows = (req.result as DraftRecord[]) || [];
        rows.sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(rows);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  } catch (e) {
    console.warn("[draftStorage] listDrafts failed:", e);
    return [];
  }
}

export async function deleteDraft(key: string): Promise<void> {
  if (!isDraftStorageAvailable() || !key) return;
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch (e) {
    console.warn("[draftStorage] deleteDraft failed:", e);
  }
}

/** Remove expired drafts and trim to MAX_DRAFTS. Returns the surviving drafts. */
export async function cleanupDrafts(): Promise<DraftRecord[]> {
  const drafts = await listDrafts();
  const now = Date.now();
  const keep: DraftRecord[] = [];
  const drop: DraftRecord[] = [];
  for (const d of drafts) {
    if (now - d.updatedAt > MAX_DRAFT_AGE_MS || keep.length >= MAX_DRAFTS) drop.push(d);
    else keep.push(d);
  }
  await Promise.all(drop.map((d) => deleteDraft(d.key)));
  return keep;
}
