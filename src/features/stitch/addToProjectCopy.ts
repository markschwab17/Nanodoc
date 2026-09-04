/**
 * Copy for the takeoff-v2 "Add to project" dialog — the three pure pieces the
 * dialog needs, kept out of the component so they can be tested on their own.
 *
 * The dialog is a PREVIEW of what CTO will create. Its page title therefore has
 * to be derived the same way CTO's `siteSheetTitle` derives the real one
 * (`src/lib/site-sheet/manifest.ts`): unique, non-empty source labels in TILE
 * order, `A` alone, `A…Z` for many, and a plain sheet count when nothing is
 * labeled. The two implementations are deliberately parallel — if one changes,
 * the other must.
 *
 * The labels and page numbers themselves come out of the CTO stitch plan, which
 * nanodoc keeps raw (see `stitchPlan.ts` for why): entry `i` of the plan
 * describes page `i` of the combined PDF, and a tile's `sourcePageIndex` is that
 * same `i`. `planEntriesForTiles` is the join — it answers "which plan entries
 * still have a sheet on the canvas, in the order those sheets were placed",
 * which is what both the title and the hidden-pages sentence are built from.
 */

/** The only fields of a stitch tile this module reads. */
export interface TileForPlan {
  sourcePageIndex: number;
  isScaleStamp?: boolean;
  sourceFileName?: string;
}

/** One CTO stitch-plan entry, reduced to what the dialog shows. */
export interface PlanEntrySummary {
  /** `'takeoff'` for a project page, `'document'` for a project document page. */
  kind: string;
  /** CTO's display label for the sheet, or null when it sent none. */
  label: string | null;
  /** 1-based page-list number — takeoff entries only; null otherwise. */
  pageNumber: number | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The plan entries whose page is still on the canvas, in tile order.
 *
 * Tiles that are not sheets (scale stamps, promoted clean-up crops — both carry
 * `sourcePageIndex === -1`) are skipped, and a page placed twice is reported
 * once, at its FIRST tile's position. When `expectedFileName` is given, only
 * tiles from that source PDF count: a page index means nothing across documents,
 * so a sheet the user added later from some other PDF must not be read as an
 * entry of this plan. An empty/absent `expectedFileName` disables that guard
 * rather than filtering everything out (the commit leaves `sourceFileName`
 * undefined when it was handed no filename).
 *
 * Returns `[]` for a plan this build can't read — the dialog then falls back to
 * its count-only copy, exactly as it does for a planless session.
 */
export function planEntriesForTiles(
  rawPlan: unknown,
  tiles: readonly TileForPlan[],
  expectedFileName?: string | null,
): PlanEntrySummary[] {
  if (!isRecord(rawPlan) || rawPlan.version !== 1) return [];
  const entries = rawPlan.entries;
  if (!Array.isArray(entries)) return [];

  const want = typeof expectedFileName === "string" && expectedFileName !== "" ? expectedFileName : null;
  const seen = new Set<number>();
  const out: PlanEntrySummary[] = [];
  for (const tile of tiles) {
    if (tile.isScaleStamp) continue;
    const i = tile.sourcePageIndex;
    if (!Number.isInteger(i) || i < 0) continue;
    if (want !== null && tile.sourceFileName !== want) continue;
    if (seen.has(i)) continue;
    seen.add(i);
    const entry: unknown = entries[i];
    if (!isRecord(entry)) continue;
    out.push({
      kind: typeof entry.kind === "string" ? entry.kind : "",
      label: typeof entry.label === "string" && entry.label.trim() !== "" ? entry.label.trim() : null,
      pageNumber:
        typeof entry.pageNumber === "number" && Number.isInteger(entry.pageNumber) && entry.pageNumber > 0
          ? entry.pageNumber
          : null,
    });
  }
  return out;
}

/**
 * The title CTO will give the new page: unique non-empty labels in the order
 * given, as `A` (one) or `A…Z` (first…last, Unicode ellipsis), falling back to
 * `sheetCount` when nothing is labeled. Mirrors CTO's `siteSheetTitle`.
 */
export function siteSheetTitlePreview(
  labels: readonly (string | null | undefined)[],
  sheetCount: number,
): string {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of labels) {
    const label = typeof raw === "string" ? raw.trim() : "";
    if (label === "" || seen.has(label)) continue;
    seen.add(label);
    ordered.push(label);
  }
  if (ordered.length === 0) {
    return `Site sheet — ${sheetCount} sheet${sheetCount === 1 ? "" : "s"}`;
  }
  if (ordered.length === 1) {
    return `Site sheet — ${ordered[0]}`;
  }
  return `Site sheet — ${ordered[0]}…${ordered[ordered.length - 1]}`;
}

/**
 * "Pages 5, 6 and 9 will be hidden from the page list" — or null when there is
 * nothing to hide, so the caller omits the row entirely. Numbers are
 * de-duplicated and read out ascending: this names entries in the project's
 * page list, which the reader will scan in that order.
 */
export function hiddenPagesSentence(numbers: readonly number[]): string | null {
  const list = Array.from(
    new Set(numbers.filter((n) => Number.isInteger(n) && n > 0)),
  ).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const joined =
    list.length === 1
      ? String(list[0])
      : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  return `${list.length === 1 ? "Page" : "Pages"} ${joined} will be hidden from the page list`;
}

/**
 * Why an auto-align run did not place everything, in the words the user needs.
 *
 * The run drops what it cannot match below the composition rather than failing,
 * which on its own reads as "it didn't work" with no clue why. Each reason names a
 * DIFFERENT thing to do about it: nothing to match by (the sheets carry no readable
 * identity — nothing the user can drag will fix that), nothing shared (the sheets
 * simply are not neighbours), or matched but unproven (it may well be right; look at
 * the seams). Pages are named 1-based, ascending, because that is the order the user
 * will scan them in.
 *
 * Returns null when there is nothing to explain — a clean run, or a caller that has
 * no outcome to report.
 */
export type AutoAlignReason = "ok" | "no_refs" | "not_adjacent" | "unverified";

export interface AutoAlignOutcome {
  reason: AutoAlignReason;
  /** 1-based page numbers with no readable sheet number or matchline callout. */
  pagesWithoutRefs?: readonly number[];
  /** 1-based page numbers deliberately kept out of the tiling, with their role. */
  skipped?: readonly { pageNumber: number; role: string }[];
}

function pageList(numbers: readonly number[]): string {
  const list = Array.from(new Set(numbers.filter((n) => Number.isInteger(n) && n > 0))).sort((a, b) => a - b);
  if (list.length === 0) return "";
  if (list.length === 1) return `page ${list[0]}`;
  return `pages ${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

const ROLE_NOUN: Record<string, string> = {
  overall: "an overall plan",
  keyplan: "a key plan",
  index: "a sheet index",
  notes: "a notes sheet",
  details: "a details sheet",
};

export function autoAlignExplanation(outcome: AutoAlignOutcome | null | undefined): string | null {
  if (!outcome) return null;
  const parts: string[] = [];
  switch (outcome.reason) {
    case "no_refs": {
      const where = outcome.pagesWithoutRefs?.length ? ` on ${pageList(outcome.pagesWithoutRefs)}` : "";
      parts.push(`No sheet numbers or matchline callouts were found${where}, so there was nothing to line these sheets up by.`);
      break;
    }
    case "not_adjacent":
      parts.push("These sheets don't share a matchline, so there is nothing to line them up along.");
      break;
    case "unverified":
      parts.push("Alignment could not be verified — check the seams before adding.");
      break;
    case "ok":
      break;
  }
  const skipped = outcome.skipped ?? [];
  if (skipped.length) {
    const roles = new Set(skipped.map((s) => ROLE_NOUN[s.role]).filter(Boolean));
    const what = roles.size === 1 ? [...roles][0] : "not a tiled plan sheet";
    const nums = pageList(skipped.map((s) => s.pageNumber));
    parts.push(`${nums.charAt(0).toUpperCase()}${nums.slice(1)} ${skipped.length === 1 ? "is" : "are"} ${what} and ${skipped.length === 1 ? "was" : "were"} left out of the alignment.`);
  }
  return parts.length ? parts.join(" ") : null;
}
