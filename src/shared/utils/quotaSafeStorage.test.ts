/**
 * Reproduces the stamp root cause: a localStorage write that throws
 * QuotaExceededError must NOT propagate out (which aborted addStamp before
 * the StampCreator could close its modal). Plain localStorage re-throws;
 * the quota-safe wrapper swallows and reports.
 */

import { describe, expect, it, vi } from "vitest";
import { createQuotaSafeStorage } from "./quotaSafeStorage";

function throwingBacking() {
  return {
    getItem: vi.fn((_name: string) => null),
    setItem: vi.fn((_name: string, _value: string) => {
      throw new DOMException("quota", "QuotaExceededError");
    }),
    removeItem: vi.fn((_name: string) => {}),
  };
}

describe("plain storage reproduces the bug", () => {
  it("a raw backing setItem throws (the original failure mode)", () => {
    const backing = throwingBacking();
    expect(() => backing.setItem("k", "v")).toThrow(/quota/i);
  });
});

describe("createQuotaSafeStorage", () => {
  it("does NOT throw when the backing setItem throws (quota)", () => {
    const backing = throwingBacking();
    const onError = vi.fn();
    const storage = createQuotaSafeStorage(backing as any, onError);
    expect(() => storage.setItem("pdf-stamp-storage", "x".repeat(100))).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("writes through when the backing succeeds", () => {
    const mem: Record<string, string> = {};
    const backing = {
      getItem: (k: string) => mem[k] ?? null,
      setItem: (k: string, v: string) => {
        mem[k] = v;
      },
      removeItem: (k: string) => {
        delete mem[k];
      },
    };
    const storage = createQuotaSafeStorage(backing);
    storage.setItem("k", "v");
    expect(storage.getItem("k")).toBe("v");
    storage.removeItem("k");
    expect(storage.getItem("k")).toBe(null);
  });

  it("treats a missing backing store as a no-op", () => {
    const storage = createQuotaSafeStorage(undefined);
    expect(() => storage.setItem("k", "v")).not.toThrow();
    expect(storage.getItem("k")).toBe(null);
  });
});
