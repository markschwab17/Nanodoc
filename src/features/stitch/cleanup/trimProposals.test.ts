import { describe, it, expect } from "vitest";
import { mergeDetected, seedProposals, trimReviewableTiles, type TrimTile } from "./trimProposals";
import type { CleanupRegion } from "./cleanupDetect";

const tile = (over: Partial<TrimTile> & { id: string }): TrimTile => ({
  sourcePdfBytes: { length: 100 },
  ...over,
});
const rect = (x: number) => ({ x, y: 0.1, w: 0.2, h: 0.2 });
const detection = (x: number, kind: CleanupRegion["kind"] = "title-block"): CleanupRegion => ({
  rect: rect(x),
  kind,
  confidence: "high",
});

describe("trimReviewableTiles", () => {
  it("keeps plain unrotated sheets with a PDF source", () => {
    const t = tile({ id: "a" });
    expect(trimReviewableTiles([t])).toEqual([t]);
  });
  it("drops scale stamps, rotated sheets and sourceless (promoted) tiles", () => {
    const kept = tile({ id: "ok" });
    const out = trimReviewableTiles([
      kept,
      tile({ id: "stamp", isScaleStamp: true }),
      tile({ id: "turned", rotation: 90 }),
      tile({ id: "promoted", sourcePdfBytes: { length: 0 } }),
    ]);
    expect(out.map((t) => t.id)).toEqual(["ok"]);
  });
});

describe("seedProposals — Trim opens with the work already on the sheets", () => {
  it("is empty when nothing is hidden yet", () => {
    expect(seedProposals([tile({ id: "a" })])).toEqual([]);
  });

  it("brings back every already-hidden region as an enabled box", () => {
    const out = seedProposals([tile({ id: "a", hiddenRegions: [rect(0.1), rect(0.5)] })]);
    expect(out).toHaveLength(1);
    expect(out[0].tileId).toBe("a");
    expect(out[0].regions).toHaveLength(2);
    expect(out[0].regions.every((r) => r.enabled && r.kind === "manual" && !r.move)).toBe(true);
    expect(out[0].regions[0].rect).toEqual(rect(0.1));
  });

  it("brings back relocated regions with their offset, so Apply does not undo the move", () => {
    const out = seedProposals([
      tile({ id: "a", relocatedRegions: [{ rect: rect(0.3), dx: 0.05, dy: -0.02 }] }),
    ]);
    expect(out[0].regions[0].move).toEqual({ dx: 0.05, dy: -0.02 });
  });

  it("copies the rects rather than aliasing the store's objects", () => {
    const src = rect(0.1);
    const out = seedProposals([tile({ id: "a", hiddenRegions: [src] })]);
    out[0].regions[0].rect.x = 0.9;
    expect(src.x).toBe(0.1);
  });

  it("skips tiles Trim cannot act on, even when they carry hidden regions", () => {
    const out = seedProposals([
      tile({ id: "turned", rotation: 90, hiddenRegions: [rect(0.1)] }),
      tile({ id: "ok", hiddenRegions: [rect(0.2)] }),
    ]);
    expect(out.map((p) => p.tileId)).toEqual(["ok"]);
  });
});

describe("mergeDetected — Auto-detect ADDS, never replaces", () => {
  it("opens a tile's entry when the review had none", () => {
    const out = mergeDetected([], [{ tileId: "a", regions: [detection(0.1)] }]);
    expect(out).toEqual([
      { tileId: "a", regions: [{ ...detection(0.1), enabled: true }] },
    ]);
  });

  it("keeps every hand-drawn box and appends the detections after them", () => {
    const manual = {
      tileId: "a",
      regions: [{ rect: rect(0.8), kind: "manual" as const, confidence: "high" as const, enabled: true }],
    };
    const out = mergeDetected([manual], [{ tileId: "a", regions: [detection(0.1)] }]);
    expect(out[0].regions).toHaveLength(2);
    expect(out[0].regions[0].rect).toEqual(rect(0.8)); // the drawn one, still first
    expect(out[0].regions[1].kind).toBe("title-block");
  });

  it("does not duplicate a region the review already holds — pressing it twice is safe", () => {
    const first = mergeDetected([], [{ tileId: "a", regions: [detection(0.1), detection(0.5)] }]);
    const second = mergeDetected(first, [{ tileId: "a", regions: [detection(0.1), detection(0.5)] }]);
    expect(second[0].regions).toHaveLength(2);
  });

  it("preserves a box's Keep state and its relocation across a re-detect", () => {
    const prev = [{
      tileId: "a",
      regions: [
        { ...detection(0.1), enabled: false },                       // switched to Keep
        { ...detection(0.5), enabled: true, move: { dx: 0.1, dy: 0 } }, // moved
      ],
    }];
    const out = mergeDetected(prev, [{ tileId: "a", regions: [detection(0.1), detection(0.5)] }]);
    expect(out[0].regions).toHaveLength(2);
    expect(out[0].regions[0].enabled).toBe(false);
    expect(out[0].regions[1].move).toEqual({ dx: 0.1, dy: 0 });
  });

  it("leaves untouched tiles alone and appends newly detected ones in order", () => {
    const prev = [
      { tileId: "a", regions: [{ ...detection(0.1), enabled: true }] },
      { tileId: "b", regions: [{ ...detection(0.2), enabled: true }] },
    ];
    const out = mergeDetected(prev, [{ tileId: "c", regions: [detection(0.3)] }]);
    expect(out.map((p) => p.tileId)).toEqual(["a", "b", "c"]);
    expect(out[0]).toEqual(prev[0]);
  });

  it("ignores a detection pass that found nothing", () => {
    const prev = [{ tileId: "a", regions: [{ ...detection(0.1), enabled: true }] }];
    expect(mergeDetected(prev, [{ tileId: "a", regions: [] }])).toEqual(prev);
    expect(mergeDetected(prev, [])).toEqual(prev);
  });

  it("does not mutate the list it was given", () => {
    const prev = [{ tileId: "a", regions: [{ ...detection(0.1), enabled: true }] }];
    mergeDetected(prev, [{ tileId: "a", regions: [detection(0.9)] }]);
    expect(prev[0].regions).toHaveLength(1);
  });

  it("a fresh detection arrives enabled — the user confirms by applying", () => {
    const out = mergeDetected([], [{ tileId: "a", regions: [detection(0.1, "match-margin")] }]);
    expect(out[0].regions[0].enabled).toBe(true);
    expect(out[0].regions[0].kind).toBe("match-margin");
  });
});

describe("open-then-detect, the way the two buttons compose", () => {
  const tiles = [tile({ id: "a", hiddenRegions: [rect(0.8)] })];

  it("Trim alone opens with the sheet's boxes and NO detections", () => {
    const opened = seedProposals(tiles);
    expect(opened[0].regions).toHaveLength(1);
    expect(opened[0].regions[0].kind).toBe("manual");
  });

  it("Auto-detect on top of that keeps the sheet's boxes and adds the detected ones", () => {
    const opened = seedProposals(tiles);
    const after = mergeDetected(opened, [{ tileId: "a", regions: [detection(0.1)] }]);
    expect(after[0].regions.map((r) => r.kind)).toEqual(["manual", "title-block"]);
  });

  it("step 3 (open + detect in one click) lands in exactly that state", () => {
    const step = mergeDetected(seedProposals(tiles), [{ tileId: "a", regions: [detection(0.1)] }]);
    const manual = mergeDetected(seedProposals(tiles), [{ tileId: "a", regions: [detection(0.1)] }]);
    expect(step).toEqual(manual);
  });
});
