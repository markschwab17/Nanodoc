import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStampStorage, type AsyncKV } from "./stampIdbStorage";
import type { QuotaSafeStorage } from "@/shared/utils/quotaSafeStorage";

function memKV(): AsyncKV & { _data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    _data: data,
    get: async (k) => (data.has(k) ? data.get(k)! : null),
    set: async (k, v) => void data.set(k, v),
    del: async (k) => void data.delete(k),
  };
}

function memLocal(): QuotaSafeStorage & { _data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    _data: data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const KEY = "pdf-stamp-storage";

describe("createStampStorage with IndexedDB", () => {
  let idb: ReturnType<typeof memKV>;
  let local: ReturnType<typeof memLocal>;

  beforeEach(() => {
    idb = memKV();
    local = memLocal();
  });

  it("reads and writes through IndexedDB", async () => {
    const s = createStampStorage({ idb, local });
    await s.setItem(KEY, "VALUE");
    expect(idb._data.get(KEY)).toBe("VALUE");
    expect(await s.getItem(KEY)).toBe("VALUE");
  });

  it("migrates a legacy localStorage value into IndexedDB and clears it", async () => {
    local._data.set(KEY, "LEGACY"); // pre-IndexedDB stamps
    const s = createStampStorage({ idb, local });

    const got = await s.getItem(KEY);
    expect(got).toBe("LEGACY");
    expect(idb._data.get(KEY)).toBe("LEGACY"); // migrated into IDB
    expect(local._data.has(KEY)).toBe(false); // freed from localStorage
  });

  it("prefers IndexedDB over a stale legacy localStorage value", async () => {
    idb._data.set(KEY, "NEW");
    local._data.set(KEY, "OLD");
    const s = createStampStorage({ idb, local });
    expect(await s.getItem(KEY)).toBe("NEW");
  });

  it("falls back to localStorage and reports when an IndexedDB write fails", async () => {
    const onWriteError = vi.fn();
    const failingIdb: AsyncKV = {
      get: async () => null,
      set: async () => {
        throw new Error("idb write failed");
      },
      del: async () => {},
    };
    const s = createStampStorage({ idb: failingIdb, local, onWriteError });
    await expect(s.setItem(KEY, "X")).resolves.toBeUndefined(); // never rejects
    expect(onWriteError).toHaveBeenCalledOnce();
    expect(local._data.get(KEY)).toBe("X"); // fell back to localStorage
  });

  it("removeItem clears both IndexedDB and localStorage", async () => {
    idb._data.set(KEY, "V");
    local._data.set(KEY, "V");
    const s = createStampStorage({ idb, local });
    await s.removeItem(KEY);
    expect(idb._data.has(KEY)).toBe(false);
    expect(local._data.has(KEY)).toBe(false);
  });
});

describe("createStampStorage without IndexedDB", () => {
  it("routes everything to localStorage when idb is null", async () => {
    const local = memLocal();
    const s = createStampStorage({ idb: null, local });
    await s.setItem(KEY, "V");
    expect(local._data.get(KEY)).toBe("V");
    expect(await s.getItem(KEY)).toBe("V");
    await s.removeItem(KEY);
    expect(local._data.has(KEY)).toBe(false);
  });
});
