import { describe, it, expect } from "vitest";
import {
  planEntriesForTiles,
  siteSheetTitlePreview,
  hiddenPagesSentence,
  autoAlignExplanation,
  AUTO_ALIGN_CHECKING,
  autoAlignButtonLabel,
  autoAlignUnavailableNote,
  autoAlignUnavailableTitle,
  type TileForPlan,
} from "./addToProjectCopy";

const SOURCE = "Site sheet source 12345678.pdf";

function tile(sourcePageIndex: number, extra: Partial<TileForPlan> = {}): TileForPlan {
  return { sourcePageIndex, sourceFileName: SOURCE, ...extra };
}

function plan(entries: unknown[], version: unknown = 1): unknown {
  return { version, mode: "auto", entries };
}

const takeoff = (label: string | null, pageNumber?: number) => ({
  kind: "takeoff",
  pageUuid: `uuid-${label}`,
  scaleFeetPerInch: 20,
  label,
  ...(pageNumber === undefined ? {} : { pageNumber }),
});

describe("planEntriesForTiles", () => {
  it("maps tiles to plan entries by sourcePageIndex, in tile order", () => {
    const raw = plan([takeoff("C-3.1", 5), takeoff("C-3.2", 6), takeoff("C-3.3", 7)]);
    // Tiles are deliberately out of index order — the basket order is the tile
    // order, and that is what the title reads.
    const got = planEntriesForTiles(raw, [tile(2), tile(0)], SOURCE);
    expect(got).toEqual([
      { kind: "takeoff", label: "C-3.3", pageNumber: 7 },
      { kind: "takeoff", label: "C-3.1", pageNumber: 5 },
    ]);
  });

  it("skips scale stamps and promoted tiles (no PDF source)", () => {
    const raw = plan([takeoff("C-3.1", 5), takeoff("C-3.2", 6)]);
    const got = planEntriesForTiles(
      raw,
      [tile(-1, { isScaleStamp: true }), tile(-1), tile(1)],
      SOURCE,
    );
    expect(got).toEqual([{ kind: "takeoff", label: "C-3.2", pageNumber: 6 }]);
  });

  it("reports a page placed twice only once, at its first tile", () => {
    const raw = plan([takeoff("C-3.1", 5), takeoff("C-3.2", 6)]);
    const got = planEntriesForTiles(raw, [tile(1), tile(0), tile(1)], SOURCE);
    expect(got.map((e) => e.label)).toEqual(["C-3.2", "C-3.1"]);
  });

  it("ignores tiles that came from a different PDF", () => {
    const raw = plan([takeoff("C-3.1", 5), takeoff("C-3.2", 6)]);
    const got = planEntriesForTiles(
      raw,
      [tile(0), tile(1, { sourceFileName: "Some other plans.pdf" })],
      SOURCE,
    );
    expect(got.map((e) => e.label)).toEqual(["C-3.1"]);
  });

  it("keeps every tile when no expected file name is given", () => {
    const raw = plan([takeoff("C-3.1", 5), takeoff("C-3.2", 6)]);
    const tiles = [{ sourcePageIndex: 0 }, { sourcePageIndex: 1 }];
    expect(planEntriesForTiles(raw, tiles).map((e) => e.label)).toEqual(["C-3.1", "C-3.2"]);
    expect(planEntriesForTiles(raw, tiles, "").map((e) => e.label)).toEqual(["C-3.1", "C-3.2"]);
  });

  it("carries document entries through with a null page number", () => {
    const raw = plan([
      takeoff("C-3.1", 5),
      { kind: "document", documentId: "d1", documentPage: 6, scaleFeetPerInch: null, label: "Bid docs — p.7" },
    ]);
    expect(planEntriesForTiles(raw, [tile(1)], SOURCE)).toEqual([
      { kind: "document", label: "Bid docs — p.7", pageNumber: null },
    ]);
  });

  it("normalises a blank, missing or unusable label and page number to null", () => {
    const raw = plan([
      takeoff("   ", 5),
      { kind: "takeoff", scaleFeetPerInch: 20 },
      takeoff("C-3.3", 0),
      { kind: "takeoff", label: "C-3.4", pageNumber: "6" },
    ]);
    const got = planEntriesForTiles(raw, [tile(0), tile(1), tile(2), tile(3)], SOURCE);
    expect(got).toEqual([
      { kind: "takeoff", label: null, pageNumber: 5 },
      { kind: "takeoff", label: null, pageNumber: null },
      { kind: "takeoff", label: "C-3.3", pageNumber: null },
      { kind: "takeoff", label: "C-3.4", pageNumber: null },
    ]);
  });

  it("skips a tile whose index is past the end of the plan", () => {
    const raw = plan([takeoff("C-3.1", 5)]);
    expect(planEntriesForTiles(raw, [tile(0), tile(4)], SOURCE).map((e) => e.label)).toEqual(["C-3.1"]);
  });

  it("returns nothing for a missing, foreign or malformed plan", () => {
    const tiles = [tile(0)];
    expect(planEntriesForTiles(null, tiles, SOURCE)).toEqual([]);
    expect(planEntriesForTiles(undefined, tiles, SOURCE)).toEqual([]);
    expect(planEntriesForTiles("nope", tiles, SOURCE)).toEqual([]);
    expect(planEntriesForTiles(plan([takeoff("C-3.1", 5)], 2), tiles, SOURCE)).toEqual([]);
    expect(planEntriesForTiles({ version: 1, mode: "auto" }, tiles, SOURCE)).toEqual([]);
  });
});

describe("siteSheetTitlePreview", () => {
  it("falls back to the sheet count when nothing is labeled", () => {
    expect(siteSheetTitlePreview([], 3)).toBe("Site sheet — 3 sheets");
    expect(siteSheetTitlePreview([null, undefined, "", "  "], 4)).toBe("Site sheet — 4 sheets");
  });

  it("says 'sheet' for a single unlabeled sheet", () => {
    expect(siteSheetTitlePreview([], 1)).toBe("Site sheet — 1 sheet");
  });

  it("names the one label when only one distinct label resolves", () => {
    expect(siteSheetTitlePreview(["C-3.1"], 1)).toBe("Site sheet — C-3.1");
    expect(siteSheetTitlePreview(["C-3.1", "C-3.1"], 2)).toBe("Site sheet — C-3.1");
  });

  it("spans first…last, de-duplicated, in the order given", () => {
    expect(siteSheetTitlePreview(["C-3.1", "C-3.2", "C-3.2", "C-3.4"], 4)).toBe(
      "Site sheet — C-3.1…C-3.4",
    );
    // Tile order, not sorted order: the last TILE names the end of the span.
    expect(siteSheetTitlePreview(["C-3.4", "C-3.1"], 2)).toBe("Site sheet — C-3.4…C-3.1");
  });

  it("uses a Unicode ellipsis, not three dots", () => {
    expect(siteSheetTitlePreview(["A", "Z"], 2)).toBe("Site sheet — A…Z");
    expect(siteSheetTitlePreview(["A", "Z"], 2)).not.toContain("...");
  });
});

describe("hiddenPagesSentence", () => {
  it("omits the row when nothing will be hidden", () => {
    expect(hiddenPagesSentence([])).toBeNull();
    expect(hiddenPagesSentence([0, -1, 1.5, NaN])).toBeNull();
  });

  it("reads one page in the singular", () => {
    expect(hiddenPagesSentence([5])).toBe("Page 5 will be hidden from the page list");
  });

  it("joins two pages with 'and'", () => {
    expect(hiddenPagesSentence([5, 6])).toBe("Pages 5 and 6 will be hidden from the page list");
  });

  it("comma-separates three or more, 'and' before the last", () => {
    expect(hiddenPagesSentence([5, 6, 9])).toBe(
      "Pages 5, 6 and 9 will be hidden from the page list",
    );
  });

  it("de-duplicates and reads ascending regardless of tile order", () => {
    expect(hiddenPagesSentence([9, 5, 6, 5])).toBe(
      "Pages 5, 6 and 9 will be hidden from the page list",
    );
  });
});

describe("autoAlignExplanation", () => {
  it("says nothing for a clean run", () => {
    expect(autoAlignExplanation({ reason: "ok" })).toBeNull();
    expect(autoAlignExplanation(null)).toBeNull();
  });

  it("no_refs names the pages that carry no identity", () => {
    expect(autoAlignExplanation({ reason: "no_refs", pagesWithoutRefs: [7, 5] })).toBe(
      "No sheet numbers or matchline callouts were found on pages 5 and 7, so there was nothing to line these sheets up by.",
    );
    expect(autoAlignExplanation({ reason: "no_refs", pagesWithoutRefs: [5] })).toContain("on page 5,");
    expect(autoAlignExplanation({ reason: "no_refs" })).toBe(
      "No sheet numbers or matchline callouts were found, so there was nothing to line these sheets up by.",
    );
  });

  it("not_adjacent says the sheets are simply not neighbours", () => {
    expect(autoAlignExplanation({ reason: "not_adjacent" })).toBe(
      "These sheets don't share a matchline, so there is nothing to line them up along.",
    );
  });

  it("unverified points at the seams rather than claiming failure", () => {
    expect(autoAlignExplanation({ reason: "unverified" })).toBe(
      "Alignment could not be verified — check the seams before adding.",
    );
  });

  it("names the sheets that were left out of the tiling, and what they are", () => {
    expect(autoAlignExplanation({ reason: "ok", skipped: [{ pageNumber: 2, role: "notes" }] })).toBe(
      "Page 2 is a notes sheet and was left out of the alignment.",
    );
    expect(autoAlignExplanation({
      reason: "ok",
      skipped: [{ pageNumber: 3, role: "notes" }, { pageNumber: 1, role: "notes" }],
    })).toBe("Pages 1 and 3 are a notes sheet and were left out of the alignment.");
    expect(autoAlignExplanation({
      reason: "ok",
      skipped: [{ pageNumber: 1, role: "notes" }, { pageNumber: 5, role: "overall" }],
    })).toBe("Pages 1 and 5 are not a tiled plan sheet and were left out of the alignment.");
  });

  it("a reason and a skip read as one explanation", () => {
    const s = autoAlignExplanation({
      reason: "not_adjacent",
      skipped: [{ pageNumber: 5, role: "overall" }],
    })!;
    expect(s.startsWith("These sheets don't share a matchline")).toBe(true);
    expect(s.endsWith("Page 5 is an overall plan and was left out of the alignment.")).toBe(true);
  });
});

describe("autoAlignExplanation — the along-matchline case", () => {
  it("says the sheets meet the line but not where along it, with the slide in feet", () => {
    expect(autoAlignExplanation({
      reason: "along_unresolved", alongUnresolvedPages: [9, 8], worstAlongUncertaintyFt: 42,
    })).toBe(
      "Pages 8 and 9 meet the matchline correctly, but nothing fixes where along it they sit — they could be up to 42 ft out along it.",
    );
  });

  it("omits the figure when nothing measured it", () => {
    expect(autoAlignExplanation({ reason: "along_unresolved", alongUnresolvedPages: [3] })).toBe(
      "Page 3 meets the matchline correctly, but nothing fixes where along it the sheet sits.",
    );
  });

  it("falls back to 'these sheets' when no page is named", () => {
    expect(autoAlignExplanation({ reason: "along_unresolved" })!).toContain("These sheets meet the matchline correctly");
  });
});

describe("the earned Auto-align copy", () => {
  it("the chip says what is being checked, not that something is loading", () => {
    expect(AUTO_ALIGN_CHECKING).toBe("Checking whether these sheets can be auto-aligned…");
  });

  it("the button names the sheet count and agrees in number", () => {
    expect(autoAlignButtonLabel(5)).toBe("Auto-align 5 sheets");
    expect(autoAlignButtonLabel(1)).toBe("Auto-align 1 sheet");
  });

  it("each reason completes the note as one sentence", () => {
    expect(autoAlignUnavailableNote("no_refs")).toBe(
      "Auto-align isn't available for these sheets — no sheet numbers or matchline callouts were found",
    );
    expect(autoAlignUnavailableNote("no_matchline")).toBe(
      "Auto-align isn't available for these sheets — they don't share a matchline",
    );
    expect(autoAlignUnavailableNote("unverified")).toBe(
      "Auto-align isn't available for these sheets — the seams couldn't be verified",
    );
  });

  it("the tooltip keeps the fuller sentence the short reason drops", () => {
    // The along-matchline case maps to "the seams couldn't be verified", which is
    // true and loses the fact the user would act on: they DO meet the line.
    const title = autoAlignUnavailableTitle(
      "unverified",
      "sheets can be lined up across the matchline but not along it — they may slide up to 48 ft",
    );
    expect(title).toContain("the seams couldn't be verified");
    expect(title).toContain("slide up to 48 ft");
  });

  it("the tooltip is just the note when there is nothing more to say", () => {
    expect(autoAlignUnavailableTitle("no_matchline")).toBe(
      "Auto-align isn't available for these sheets — they don't share a matchline.",
    );
  });
});
