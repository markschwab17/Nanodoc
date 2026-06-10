/**
 * Regression for the stamp bug: when localStorage is over quota (the user had
 * 5 full-resolution logo stamps stored), persisting a new image/signature
 * stamp re-threw QuotaExceededError out of addStamp() — which ran before the
 * StampCreator's onClose, leaving the modal stuck open and blocking placement.
 * addStamp must now keep the stamp in memory and NOT throw.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { useStampStore } from "./stampStore";
import type { StampData } from "@/core/pdf/PDFEditor";

function bigImageStamp(id: string): StampData {
  return {
    id,
    name: `Logo ${id}`,
    type: "image",
    createdAt: 1,
    thumbnail: "data:image/png;base64," + "A".repeat(2000),
    imageData: "data:image/png;base64," + "A".repeat(2000),
    thumbnailWidthPoints: 100,
    thumbnailHeightPoints: 60,
  } as StampData;
}

afterEach(() => {
  vi.restoreAllMocks();
  useStampStore.setState({ stamps: [], recentlyUsed: [] });
});

describe("stampStore quota resilience", () => {
  it("does not throw when localStorage is over quota, keeps stamp in memory", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("exceeded the quota", "QuotaExceededError");
    });

    const stamp = bigImageStamp("s1");
    expect(() => useStampStore.getState().addStamp(stamp)).not.toThrow();

    // In-memory state still updated so selection + placement work this session
    expect(useStampStore.getState().getStamp("s1")).toMatchObject({ id: "s1", type: "image" });
  });

  it("persists normally when storage has room", () => {
    const stamp = bigImageStamp("s2");
    expect(() => useStampStore.getState().addStamp(stamp)).not.toThrow();
    expect(useStampStore.getState().getStamp("s2")).toBeTruthy();
  });
});
