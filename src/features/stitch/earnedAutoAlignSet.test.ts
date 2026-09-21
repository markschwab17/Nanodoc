/**
 * What the earned Auto-align check is about, and when its answer has gone stale.
 * Both halves exist because the probe's placements are ABSOLUTE and its view of the
 * canvas is a snapshot: get the set wrong and the offer lays a second composite over
 * the grid; miss a change and taking the offer silently throws away the user's work.
 */
import { describe, it, expect } from "vitest";
import { canvasProbeSet, hasMixedSources, movedSinceCheck } from "./earnedAutoAlignSet";
import type { StitchTile } from "./stitchTypes";

const BYTES_A = new Uint8Array([1, 2, 3]);
const BYTES_B = new Uint8Array([1, 2, 3]); // same content, different document

const tile = (over: Partial<StitchTile> & { id: string }): StitchTile => ({
  sourcePdfBytes: BYTES_A,
  sourcePageIndex: 0,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  scaleFeetPerInch: 20,
  ...over,
});

describe("canvasProbeSet", () => {
  it("takes the WHOLE canvas, so the offer places one composite", () => {
    // The plan's sheets AND the ones Add PDF just added. Probing only the new pages
    // would offer a button that lays a second composite at the origin on top of them.
    const set = canvasProbeSet([
      tile({ id: "a", sourcePageIndex: 3 }),
      tile({ id: "b", sourcePageIndex: 4 }),
      tile({ id: "c", sourcePageIndex: 9 }),
    ])!;
    expect(set.pageIndices).toEqual([3, 4, 9]);
    expect(set.tileIds).toEqual(["a", "b", "c"]);
  });

  it("dedupes the two strips of one page into one page index but keeps both tiles", () => {
    const set = canvasProbeSet([
      tile({ id: "s1", sourcePageIndex: 1 }),
      tile({ id: "s2", sourcePageIndex: 1 }),
      tile({ id: "b", sourcePageIndex: 2 }),
    ])!;
    expect(set.pageIndices).toEqual([1, 2]);
    expect(set.tileIds).toHaveLength(3);
  });

  it("reads the scales off the tiles and calls a matching set uniform", () => {
    const set = canvasProbeSet([
      tile({ id: "a", sourcePageIndex: 0, scaleFeetPerInch: 20 }),
      tile({ id: "b", sourcePageIndex: 1, scaleFeetPerInch: 20 }),
    ])!;
    expect(set.uniformScale).toBe(20);
    expect([...set.pageScales]).toEqual([[0, 20], [1, 20]]);
  });

  it("a mixed-scale canvas is not uniform — the commit resolves each page", () => {
    const set = canvasProbeSet([
      tile({ id: "a", sourcePageIndex: 0, scaleFeetPerInch: 20 }),
      tile({ id: "b", sourcePageIndex: 1, scaleFeetPerInch: 40 }),
    ])!;
    expect(set.uniformScale).toBeNull();
  });

  it("one page with no scale at all leaves the set mixed", () => {
    const set = canvasProbeSet([
      tile({ id: "a", sourcePageIndex: 0, scaleFeetPerInch: 20 }),
      tile({ id: "b", sourcePageIndex: 1, scaleFeetPerInch: undefined }),
    ])!;
    expect(set.uniformScale).toBeNull();
  });

  it("refuses a canvas mixing two source PDFs — one solve cannot span two documents", () => {
    // Identity, deliberately: two files with the same bytes are still two documents,
    // and the offer is a promise that the placement is right.
    expect(
      canvasProbeSet([tile({ id: "a" }), tile({ id: "b", sourcePdfBytes: BYTES_B })]),
    ).toBeNull();
  });

  it("refuses fewer than two sheets — there is nothing to align to", () => {
    expect(canvasProbeSet([tile({ id: "a" })])).toBeNull();
    expect(canvasProbeSet([])).toBeNull();
  });

  it("ignores scale stamps and non-sheet tiles", () => {
    const set = canvasProbeSet([
      tile({ id: "a", sourcePageIndex: 0 }),
      tile({ id: "b", sourcePageIndex: 1 }),
      tile({ id: "stamp", sourcePageIndex: -1, isScaleStamp: true }),
    ])!;
    expect(set.tileIds).toEqual(["a", "b"]);
  });
});

describe("movedSinceCheck", () => {
  const tiles = [tile({ id: "a", sourcePageIndex: 0 }), tile({ id: "b", sourcePageIndex: 1, x: 200 })];
  const set = canvasProbeSet(tiles)!;

  it("an untouched canvas is not stale", () => {
    expect(movedSinceCheck(set, tiles)).toBe(false);
  });

  it("a dragged sheet is stale — applying absolute placements would undo the drag", () => {
    expect(movedSinceCheck(set, [tiles[0], { ...tiles[1], x: 260 }])).toBe(true);
  });

  it("a resized or rotated sheet is stale too", () => {
    expect(movedSinceCheck(set, [tiles[0], { ...tiles[1], width: 140 }])).toBe(true);
    expect(movedSinceCheck(set, [tiles[0], { ...tiles[1], rotation: 90 }])).toBe(true);
  });

  it("a DELETED sheet is stale — the offer must never resurrect it", () => {
    expect(movedSinceCheck(set, [tiles[0]])).toBe(true);
  });

  it("a sheet added since the check is stale — the composite would leave it out", () => {
    expect(movedSinceCheck(set, [...tiles, tile({ id: "c", sourcePageIndex: 2 })])).toBe(true);
  });

  it("a swapped-in tile with a new id is stale even at the same position", () => {
    expect(movedSinceCheck(set, [tiles[0], { ...tiles[1], id: "b2" }])).toBe(true);
  });
});

describe("hasMixedSources", () => {
  it("names the canvas one solve cannot span", () => {
    expect(
      hasMixedSources([tile({ id: "a" }), tile({ id: "b", sourcePdfBytes: BYTES_B })])
    ).toBe(true);
  });

  it("is false for one document, however many sheets", () => {
    expect(hasMixedSources([tile({ id: "a" }), tile({ id: "b" }), tile({ id: "c" })])).toBe(false);
  });

  it("is false when there are not two sheets to compare", () => {
    expect(hasMixedSources([tile({ id: "a" })])).toBe(false);
    expect(hasMixedSources([])).toBe(false);
  });

  it("ignores scale stamps, which have no document of their own", () => {
    expect(
      hasMixedSources([
        tile({ id: "a" }),
        tile({ id: "b" }),
        tile({ id: "stamp", isScaleStamp: true, sourcePdfBytes: BYTES_B, sourcePageIndex: -1 }),
      ])
    ).toBe(false);
  });
});

describe("movedSinceCheck: edits, not just placements", () => {
  const checked = [tile({ id: "a" }), tile({ id: "b", x: 200 })];
  const set = canvasProbeSet(checked)!;

  it("a clean-up region hidden during the check is stale — the replace would drop it", () => {
    const edited = [{ ...checked[0], hiddenRegions: [{ x: 0, y: 0, w: 0.2, h: 0.1 }] }, checked[1]];
    expect(movedSinceCheck(set, edited)).toBe(true);
  });

  it("a relocated region is stale", () => {
    const edited = [
      { ...checked[0], relocatedRegions: [{ rect: { x: 0, y: 0, w: 0.1, h: 0.1 }, dx: 0.05, dy: 0 }] },
      checked[1],
    ];
    expect(movedSinceCheck(set, edited)).toBe(true);
  });

  it("an erase override (imageDataUrl) is stale", () => {
    const edited = [{ ...checked[0], imageDataUrl: "blob:erased", imageModified: true }, checked[1]];
    expect(movedSinceCheck(set, edited)).toBe(true);
  });

  it("re-creating the same regions is NOT stale — this is a change test, not identity", () => {
    const withRegions = [
      { ...checked[0], hiddenRegions: [{ x: 0, y: 0, w: 0.2, h: 0.1 }] },
      checked[1],
    ];
    const sameAgain = canvasProbeSet(withRegions)!;
    expect(
      movedSinceCheck(sameAgain, [
        { ...checked[0], hiddenRegions: [{ x: 0, y: 0, w: 0.2, h: 0.1 }] },
        checked[1],
      ])
    ).toBe(false);
  });
});
