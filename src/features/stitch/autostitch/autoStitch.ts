import type { PageExtract, Label } from "./types";
import { capturePage } from "./captureDevice";
// NOTE: scale inference (inferScale) is deferred to Task 10 of the original
// roadmap. Do not import it yet.
import { stitchSheets, findEdgeStroke, oneSidedStrokeAnchor, seamCrossings, crossingConsensus, FT, type SheetInput, type StitchMethod, type StitchResult, type StitchAnchor, type Crossing, type SeamReportEntry, type AlignmentVerdict } from "./stitchCore";
import { detectKeymapGrid } from "./keymap";
import { sliceExtract, stripFrames, detectDrawingFrame, type Frame } from "./frameDetect";
import { layoutPlacements, type TilePlacement, type PlacedSheetPose } from "./layout";
import { pageEdgeBands, sheetNoBand, splitBand, dedupeLabels, rotateRaw, wordsToLabels, parseSheetNumber, type BandSpec } from "./ocrBands";
import { renderBand } from "./bandRender";
import { parseSheetRefs, parseScaleNotes, refSheetNumber, refSheetCode, normCode, type SheetRef } from "./tokens";
import { extractPageLabel, classifySheetRole, type SheetRole, type PageLabelResult } from "./pageLabels";
import type { OcrWord, RawImage } from "./ocrService";
// ocrPool.ts only — never ocrService.ts: this module also runs inside the probe
// worker and under vite-node, and the service pulls in Vite `?url` worker assets.
import { defaultOcrPoolSize } from "./ocrPool";
import { DEFAULT_SCALE_FT_PER_IN as DEFAULT_SCALE } from "../pageScales";

/** Drawing-density floor (geometry vector count). Used ONLY to prune the
 *  reciprocal anchor-search pass (a raster page has zero vector geometry and
 *  the anchor's segment vote needs vectors, so searching it is wasted). It is
 *  deliberately NOT a gate on OCR: raster/scanned pages have zero geometry and
 *  are exactly the pages OCR exists to rescue. */
export const PLAN_GEOMETRY_MIN = 5000;

/** Thrown by autoStitch when `opts.shouldAbort()` goes true mid-run (the user
 *  clicked plain "Add pages" and no longer needs the probe). Distinguishable so
 *  the caller can treat an abort as "skipped", not an error. */
export class AutoStitchAborted extends Error {
  constructor() { super("autostitch-aborted"); this.name = "AutoStitchAborted"; }
}

export interface AutoStitchOptions {
  userScale?: number | null;
  /** Per-page feet-per-inch (mixed-scale sets). Overrides userScale for that page. */
  pageScales?: ReadonlyMap<number, number>;
  /** Sheet identity the CALLER already knows, per page: a discipline code ("C5.00")
   *  or a bare printed number ("6"). CTO derives these from the sheet titles its
   *  extraction wrote, so they cost nothing and they are exactly what the OCR title-
   *  cell pass is trying to recover. Trusted ABOVE OCR and BELOW the PDF's own
   *  "SHEET n OF m" text. */
  pageCodes?: ReadonlyMap<number, string>;
  onProgress?: (done: number, total: number) => void;
  /** OCR callback (main thread: ocrService.recognize; worker: the RPC shim). Absent → no OCR channel.
   *  `signal` is the run's cooperative abort pushed down into the OCR transport: band
   *  reads are issued in a burst, so most are still QUEUED when an abort lands and a
   *  queued pool job has no deadline of its own.
   *  `onNoResult` is how a transport says "this read is a NON-ANSWER" — the pool's job
   *  budget expired — as opposed to "this crop holds no text", which is the same `[]`.
   *  A transport that never calls it simply never triggers the sub-clip retry below,
   *  which is the pre-existing behaviour. */
  ocr?: (image: RawImage, opts?: { signal?: AbortSignal; onNoResult?: () => void }) => Promise<OcrWord[]>;
  /** How many OCR reads the transport behind `ocr` can genuinely run at once — the
   *  width the reciprocal strip scan batches at. Defaults to `defaultOcrPoolSize()`,
   *  which is what `ocrService` sizes its pool by; a caller that builds its own pool
   *  at a fixed size (the Node eval harness: 3) passes that size here so the batch
   *  matches the pool actually doing the work. */
  ocrConcurrency?: number;
  /** Cooperative abort. Consulted at the top of each per-page iteration, before
   *  every OCR band call, and per pair in the anchor-search pass. When it returns
   *  true, autoStitch throws AutoStitchAborted at the next checkpoint so a plain
   *  "Add pages" click stops the probe near-instantly instead of waiting it out. */
  shouldAbort?: () => boolean;
  /** Called once, the first time OCR actually runs, so the UI can explain the
   *  longer wait ("reading outlined text — this can take a few minutes"). */
  onOcrStart?: () => void;
  /** Diagnostic hook: surfaces the raw solver inputs/result (pairs, anchors) for
   *  the Node stitch-diag harness. Never used in production. */
  onDebug?: (d: { anchors: StitchAnchor[]; result: StitchResult; inputs: SheetInput[]; unknownSheetNoPages: number[] }) => void;
}
/**
 * What the run's OCR channel actually did. `calls` and `nonAnswers` are counted
 * centrally, in the one `ocr` wrapper every read goes through; `retries` and
 * `unknown` are counted at the decisions that consume a read.
 *
 * `nonAnswers` is NOT "reads that found nothing". It is reads the transport could
 * not answer at all — the pool's per-job budget expired, or the reply was lost —
 * and they arrive as the same empty `OcrWord[]` a blank crop does. Collapsing the
 * two is why the browser probe can answer differently on two runs of the same
 * sheets (the harness never sees it: its tesseract finishes inside the budget), so
 * they are counted apart.
 *
 * `retries` counts RE-READ DECISIONS, not reads: one per strip re-read, one per
 * sheet-number cell re-read, one per band handed to the sub-clip retry (which issues
 * several reads of its own, each counted in `calls`), one per side band whose single
 * lost rotation is re-read whole.
 *
 * `unknown` counts READS that were still unanswered after their retry: a strip that
 * had to stop the scan rather than let a later strip be accepted, a sheet-number
 * cell that stays unread, an edge band that produced nothing whichever way it was
 * turned and nothing again when it was cut up, a side band whose lost rotation was
 * lost again. `unknown > 0` means the run reached its verdict with a hole in the
 * evidence, and it is the ONLY counter the probe gates and the hook's re-check read.
 *
 * `withheldVotes` counts SIDE BANDS whose rotation vote was withheld AFTER the
 * re-read — a rotation lost twice, or a sub-clip retry that did not come back whole.
 * A band repaired by its re-read votes normally and is not counted. This is a weaker
 * fault than `unknown` — the band still has a reading, and its labels are still used
 * — but it is not nothing: the vote decides `lockSideTextRot`, the lock decides which
 * rotations the reciprocal strip scan reads, so a withheld vote can move which strip
 * the scan returns. A band withheld because its ROTATION was lost twice is counted in
 * `unknown` as well, so the gates catch it; a band withheld because its sub-clip
 * retry came back only partly is not — it did read, just not wholly.
 */
export interface OcrStats { calls: number; nonAnswers: number; retries: number; unknown: number; withheldVotes: number }

export interface AutoStitchResult {
  placements: TilePlacement[];
  rootFtPerIn: number;
  alignedCount: number;
  unplacedCount: number;
  worstResidFt: number;
  method: StitchMethod;
  poses: PlacedSheetPose[];
  /** Page indices carrying a usable adjacency signal (an edge-band sheet ref,
   *  discipline code, strip callout, or matchline) AFTER the OCR merge. The
   *  feasibility gate rates aligned-count against these, not the whole
   *  selection, so selecting all pages of a set with many notes/details sheets
   *  (which carry no adjacency signal and can never align) doesn't read as
   *  "unstitchable". */
  refPageIndices: number[];
  /** Post-solve per-seam verification (geometric method). Absent for keymap/none. */
  seamReport?: SeamReportEntry[];
  /** Cannot-align honesty verdict from the seam report. Absent → old behavior. */
  alignmentVerdict?: AlignmentVerdict;
  /** Page indices pinned on the ALONG-matchline axis as well as across it. A placed
   *  page missing from this list is connected but free to slide along its seam by up
   *  to `worstAlongUncertaintyFt`. Absent for keymap/none. */
  alongAnchored?: number[];
  worstAlongUncertaintyFt?: number;
  /** Where that figure came from: `"sweep"`/`"vote"` are measured, `"bound"` is the
   *  geometric last resort and must not be quoted as a measurement. */
  worstAlongUncertaintySource?: "sweep" | "vote" | "bound";
  /** Pages deliberately kept OUT of the tiling (overall/key plans, notes, index,
   *  details). They are still laid out — below the tiles, unaligned — but they never
   *  take part in the pair search, so they cannot be collaged into it. */
  skipped: { pageIndex: number; role: SheetRole; reason: string }[];
  /** Pages whose own stated scale note disagrees with the scale being used by more
   *  than 25%. Advisory only — the scale in use is never overridden. */
  scaleWarnings: { pageIndex: number; usedFtPerIn: number; statedFtPerIn: number }[];
  /** What the OCR channel did, and how much of it could not be answered. See
   *  `OcrStats`: a run with `unknown > 0` reached this result without a read it
   *  wanted, and the caller must not present it as a settled verdict. */
  ocrStats: OcrStats;
}

/** Yield to the event loop so the tab stays responsive between page extractions. */
const yieldToMain = () => new Promise<void>((r) => setTimeout(r, 0));

/** True when the page carries a usable adjacency signal on an edge band: a sheet
 *  cross-ref, discipline code, strip callout, or matchline sitting at a page edge
 *  (not interior). Serves both uses: the OCR gate skips pages that already have
 *  one (`!hasEdgeRefs`), and the feasibility denominator counts pages that have
 *  one after the OCR merge (ref-bearing pages). */
function hasEdgeRefs(extract: PageExtract, frame?: [number, number, number, number] | null): boolean {
  const all = [...extract.shxLabels, ...extract.labels];
  return parseSheetRefs(all, extract.view, frame).some(
    (r) => r.edge !== "interior" && (r.sheet != null || r.sheetCode != null || r.strip != null || r.matchline)
  );
}

/**
 * Resolve each page's printed sheet number, sanity-checking OCR reads and
 * repairing collisions. Pure (no mupdf / no I/O) so it is unit-testable.
 *
 *  - Sanity: an OCR-sourced number that is null, non-integer, or outside
 *    [1, 2·pageCount] is a misread → fall back to page order (pageIndex+1).
 *    text/cto/fallback numbers are trusted as given (the range is an OCR-misread
 *    guard, and a 2-page commit out of a 30-sheet set is legitimately numbered 5
 *    and 6); a null of any source also falls back to page order.
 *  - Collision repair: a resolved number shared by ≥2 pages is a contradiction.
 *    Every page in the group whose source is shared with another member of it —
 *    two OCR reads, two text reads, two caller-supplied codes — is reset to its
 *    page-order fallback, as is any OCR read colliding with a stronger source.
 *    (Distinct pageIndex+1 per page, so the reset group cannot re-collide.)
 *  - Fallback repair: a page-order FALLBACK sitting on a number some other page
 *    actually READ loses too — but "reset it to pageIndex+1" is a no-op there,
 *    because pageIndex+1 IS the colliding value. It is moved to the lowest
 *    positive number no page claims instead. Leaving it put is the same fan-out
 *    the rule above exists to stop: `byPrinted.get(n)` would return the guessed
 *    page alongside the sheet that says it is n, and every "SEE SHEET n" would
 *    anchor both.
 *
 * Returns pageIndex → resolved printed number.
 */
export function resolvePrintedNos(
  pages: { pageIndex: number; printedNo: number | null; source: PrintedNoSource }[],
  pageCount: number
): Map<number, number> {
  const resolved = new Map<number, { no: number; source: PrintedNoSource }>();
  for (const p of pages) {
    let no = p.printedNo;
    let source = p.source;
    // The [1, 2*pageCount] rule is an OCR-MISREAD guard and applies to OCR only. A
    // number the PDF states, or one the caller supplies from its own extraction, is
    // trusted as given: committing two pages out of a 30-sheet set legitimately
    // yields printed numbers 5 and 6, which this range would throw away.
    const validOcr = no != null && Number.isInteger(no) && no >= 1 && no <= pageCount * 2;
    if (source === "ocr" && !validOcr) { no = null; source = "fallback"; }
    if (no == null) { no = p.pageIndex + 1; source = "fallback"; }
    resolved.set(p.pageIndex, { no, source });
  }

  const byNo = new Map<number, { pageIndex: number; source: PrintedNoSource }[]>();
  for (const [pageIndex, r] of resolved) {
    if (!byNo.has(r.no)) byNo.set(r.no, []);
    byNo.get(r.no)!.push({ pageIndex, source: r.source });
  }
  for (const group of byNo.values()) {
    if (group.length < 2) continue;
    const reset = new Set<number>();
    // TWO pages claiming one number from the SAME source contradict each other, and
    // neither reading can be trusted over the other — whether the source is OCR, the
    // PDF's text or the caller. Leaving both is the worse failure: `byPrinted.get(n)`
    // then returns two pages and every "SEE SHEET n" anchors both of them. Distinct
    // page-order fallbacks are wrong in a way that cannot fan out.
    for (const src of ["ocr", "text", "cto"] as const) {
      const same = group.filter((g) => g.source === src);
      if (same.length >= 2) for (const g of same) reset.add(g.pageIndex);
    }
    // A weaker source colliding with a stronger one simply loses.
    if (group.some((g) => g.source === "text" || g.source === "cto")) {
      for (const g of group) if (g.source === "ocr") reset.add(g.pageIndex);
    }
    for (const g of group) {
      if (!reset.has(g.pageIndex)) continue;
      const fallback = g.pageIndex + 1;
      console.warn(`[autoStitch] printedNo collision on ${resolved.get(g.pageIndex)!.no}: page ${g.pageIndex} (${g.source}) resetting to page-order fallback ${fallback}`);
      resolved.set(g.pageIndex, { no: fallback, source: "fallback" });
    }
  }

  // A page-order guess that lands on a number another page actually read fans out
  // exactly like the collisions above, and the reset loop cannot fix it (its
  // page-order value is the collision). Move the GUESS — never the read — to the
  // lowest number nobody claims. Lowest, not "pageCount + n", so the numbers stay
  // small and readable in diagnostics, and deterministic in page order.
  const claimed = new Set<number>();
  for (const r of resolved.values()) if (r.source !== "fallback") claimed.add(r.no);
  const taken = new Set<number>([...resolved.values()].map((r) => r.no));
  for (const [pageIndex, r] of [...resolved].sort((a, b) => a[0] - b[0])) {
    if (r.source !== "fallback" || !claimed.has(r.no)) continue;
    let n = 1;
    while (taken.has(n)) n++;
    console.warn(`[autoStitch] printedNo collision on ${r.no}: page ${pageIndex} (page-order guess) moving to ${n}`);
    // r.no stays in `taken` — the page that READ it still holds it.
    taken.add(n);
    resolved.set(pageIndex, { no: n, source: "fallback" });
  }

  return new Map([...resolved].map(([k, v]) => [k, v.no]));
}

/** Where a page's printed number came from, best first: the PDF's own text, the
 *  caller (CTO's sheet identity), OCR of the title cell, then page order. */
export type PrintedNoSource = "text" | "cto" | "ocr" | "fallback";

/**
 * Decide each page's sheet CODE from two sources that disagree.
 *
 * A caller (CTO) can hand us a code per page, and it is the best identity we can get
 * for free — when it is right. It is not always right: a project's extraction had
 * written "A1" and "B3" for two sheets whose title blocks read CD102 and CD103, and
 * a wrong code is worse than none, because every "SEE SHEET X" that resolves through
 * it anchors the wrong pair of sheets. So a caller's code is TRUSTED only when the
 * drawings themselves corroborate it, in one of three ways:
 *   • the page's own title-block read agrees with it; or
 *   • another selected page's matchline callout names it; or
 *   • it appears as a code token somewhere on the page AND on no other page in the
 *     set. That last clause is the whole difference between evidence and noise: every
 *     CAD sheet prints a border coordinate grid — A1, B1, B2, B3 — so "A1" is found
 *     on a sheet the way the letter E is found in a paragraph. On the very set that
 *     motivated this, both sheets carry A1 AND B3, and only the sheet's real code
 *     (CD102 / CD103, which OCR reads out of the DWG path in the margin) is unique
 *     to one page.
 * Otherwise the supplied code is dropped, loudly.
 *
 * Then a second pass: a code claimed by TWO pages identifies neither. That happens
 * for real — the same two Coast Guard sheets both yield "A1" from the title-block
 * picker — and leaving it in place lets one callout anchor two different pages.
 * Both claimants lose it, exactly as a colliding printed number does.
 *
 * The two outcomes are NOT the same thing downstream, so both are returned. A page
 * with no code may still pick one up later from its own (strip-local) title-block read
 * — that is a fair second look. A page whose code was DROPPED FOR A COLLISION must
 * never get it back that way: the drop is a decision that the code identifies neither
 * sheet, and re-deriving it hands one arbitrary page a callout meant for two.
 *
 * Pure, and exported for tests.
 */
export interface SheetCodeResolution {
  /** pageIndex → code (absent = this page has no usable code). */
  codes: Map<number, string>;
  /** Pages whose code was dropped because another page claimed it too. Their code
   *  must not be re-derived anywhere downstream. */
  dropped: Set<number>;
}

export function resolveSheetCodes(
  pages: {
    pageIndex: number;
    /** The caller's code for this page, if any. */
    ctoCode: string | null;
    /** The page's own title-block read. */
    titleCode: string | null;
    /** Every code-shaped token in this page's text + recovered OCR. */
    ownTokens: readonly string[];
    /** Codes this page's matchline callouts point AT. */
    refTargets: readonly string[];
  }[],
  warn: (msg: string) => void = (m) => console.warn(m),
): SheetCodeResolution {
  const namedByAnother = new Set<string>();
  for (const p of pages) for (const t of p.refTargets) if (t) namedByAnother.add(normCode(t));
  // How many pages carry each code token: a token on more than one sheet is the
  // border grid or a boilerplate detail bubble, never this sheet's identity.
  const tokenPages = new Map<string, number>();
  for (const p of pages) {
    for (const t of new Set(p.ownTokens.map(normCode))) tokenPages.set(t, (tokenPages.get(t) ?? 0) + 1);
  }
  const chosen = new Map<number, string>();
  for (const p of pages) {
    let code = p.titleCode ? normCode(p.titleCode) : null;
    if (p.ctoCode) {
      const want = normCode(p.ctoCode);
      const titleAgrees = code === want;
      const uniqueOnThisPage = tokenPages.get(want) === 1 && p.ownTokens.some((t) => normCode(t) === want);
      const referenced = namedByAnother.has(want);
      if (titleAgrees || uniqueOnThisPage || referenced) code = want;
      else {
        warn(`[autoStitch] page ${p.pageIndex}: ignoring supplied sheet code "${p.ctoCode}" — it appears nowhere on the sheet and no other selected sheet references it`);
      }
    }
    if (code) chosen.set(p.pageIndex, code);
  }
  const holders = new Map<string, number[]>();
  for (const [pageIndex, code] of chosen) (holders.get(code) ?? holders.set(code, []).get(code)!).push(pageIndex);
  const dropped = new Set<number>();
  for (const [code, pgs] of holders) {
    if (pgs.length < 2) continue;
    warn(`[autoStitch] sheet code "${code}" is claimed by pages ${pgs.join(", ")} — dropping it from all of them`);
    for (const pageIndex of pgs) { chosen.delete(pageIndex); dropped.add(pageIndex); }
  }
  return { codes: chosen, dropped };
}

interface Unit {
  pageIndex: number;
  frame: Frame | null;      // null = whole page
  extract: PageExtract;     // frame-local when frame != null
  sizePt: { w: number; h: number }; // FULL page size
  scale: number;
  printedNo: number;
  key: number;              // unique numeric key (assigned after uniquify)
  /** Ruled drawing frame in the UNIT's own coordinates (recomputed per strip). */
  drawingFrame: [number, number, number, number] | null;
  role: SheetRole;
  sheetCode: string | null;
  sheetCodeDropped: boolean;
}

/** Per-page record collected in pass 1 (extract + printed number). */
interface PageRec {
  pageIndex: number; extract: PageExtract; printedNo: number; printedNoSource: PrintedNoSource;
  /** Discipline code supplied by the caller for this page, if any. */
  ctoCode: string | null;
  /** The code the engine will actually USE for this page: the caller's, once it has
   *  been corroborated, else the title-block read — and null when neither survives
   *  (see `resolveSheetCodes`). */
  sheetCode: string | null;
  /** True when this page HAD a code and it was dropped because another page claimed
   *  it too. Carried all the way to `stitchSheets` so its per-unit title-block read
   *  cannot quietly hand the code back. */
  sheetCodeDropped: boolean;
  /** The page's ruled DRAWING frame when one was detected — every edge rule (OCR
   *  band clips, edge-vs-interior classification) is measured against it. Null on a
   *  sheet drawn edge to edge. */
  drawingFrame: [number, number, number, number] | null;
  /** Title-block title, and the plan scale the sheet states for itself (its own
   *  scale note, NOT the scale in use). Both feed the sheet-role classification. */
  title: string | null;
  statedFtPerIn: number | null;
  role: SheetRole;
  /** The page's title-block read, done ONCE (it walks every label on the page and
   *  the reciprocal-anchor pass wants the same answer the role classification used). */
  pageLabel: PageLabelResult;
  /** Which way this sheet's VERTICAL text reads, as decided by the edge-band pass:
   *  the rotation (90 or 270) that carried the OCR confidence mass across the page's
   *  left/right bands, and only when that mass clears `lockSideTextRot`'s floor and
   *  margin. Undefined whenever the pass did not actually learn anything — the page
   *  took the no-OCR path, had no side bands, read nothing, read only noise, or read
   *  both directions about equally. The reciprocal strip scan reads it as "scan this
   *  rotation only", and falls back to both when it is undefined. */
  sideTextRot?: 90 | 270;
  /** The title-block cell was read and the read was a NON-ANSWER, twice — so this
   *  page's printed number is UNKNOWN, which is not the same as "this sheet prints
   *  no number". `printedNo` still falls back exactly as it does for a sheet that
   *  genuinely prints none; the flag is what says the fallback rests on a read that
   *  never happened. */
  unknownSheetNo?: boolean;
}

/** Reciprocal-label anchor before unit-key resolution: endpoints keyed by
 *  (pageIndex, label-y). `perp` is the axis the facing label pins precisely — "x"
 *  for a left/right (vertical-matchline) ref, "y" for a top/bottom (horizontal-
 *  matchline) ref; `dFt` is the offset on that axis, convention d = posFt_j -
 *  posFt_i (dx when perp "x", dy when perp "y"). `precise` marks anchors whose
 *  `dFt` was replaced by the physical-matchline-STROKE delta (sub-foot), not the
 *  ±17 ft label-position delta. */
interface RawAnchor { pageI: number; yI: number; pageJ: number; yJ: number; perp: "x" | "y"; dFt: number; precise?: boolean; along?: number; alongPrecise?: boolean; loDelta?: number; hiDelta?: number; crI?: Crossing[]; crJ?: Crossing[];
  /** The two matchline STROKE picks this anchor was registered from, as perp-axis
   *  cross-coordinates in each unit's own (frame-local) page points. Carried so the
   *  post-solve honesty gate verifies the facing bands against the seam's OWN
   *  matchline rather than re-picking each band's strongest line (failure J). */
  strokeI?: number; strokeJ?: number; }

/**
 * What one strip of the reciprocal scan turned out to be — and, for the same three
 * answers, what the scan over a page's strips turned out to be.
 *
 * `miss` is evidence — this strip was READ and holds no reciprocal label, so the
 * scan may move on to the next one. `unknown` is the absence of evidence: the read
 * was still a NON-ANSWER after its one immediate re-read, so nothing at all is
 * known about this strip and the scan may NOT quietly move on (see `scanStrips`).
 */
type StripRead =
  | { kind: "hit"; anchor: RawAnchor }
  | { kind: "miss" }
  | { kind: "unknown" };

/** One page's edge-band OCR recovery: synthetic labels, the title-cell number, and
 *  the rotation its side bands read best at (see `PageRec.sideTextRot`). */
interface PageOcrRead { recovered: Label[]; ocrNo: number | null; sideTextRot?: 90 | 270;
  /** The title-block cell was a non-answer even after its one re-read: `ocrNo` is
   *  null because nothing was READ, not because nothing was there. */
  unknownSheetNo: boolean }

/** One band's reads. `rots` is [0] for a horizontal band and [90, 270] for a side
 *  band (both rotations are OCR'd and the better one wins); `words[k]` is the read
 *  at `rots[k]`. `w`/`h` are the PRE-rotation raster dims wordsToLabels needs.
 *  `noResult[k]` is set when that read came back a NON-ANSWER (the pool's job budget
 *  expired, or the transport lost the reply) rather than a crop with no text in it —
 *  the two are the same `[]`. Only a band where EVERY rotation is flagged is worth
 *  re-reading as SUB-CLIPS: one surviving rotation means the band already has a
 *  whole-raster reading, which always beats a cut one — that band's lost rotation is
 *  re-read whole instead (`rereadLostRotation`), and `noResult[k]` is cleared when
 *  the second read lands, so a repaired band votes like one that never faltered. */
interface BandRead {
  band: BandSpec; scale: number; w: number; h: number;
  rots: (0 | 90 | 270)[]; words: Promise<OcrWord[]>[]; noResult: boolean[];
}

/** One sub-clip of a retried band: its own clip, scale and PRE-rotation raster dims,
 *  its read per rotation, and whether each of those was itself a non-answer. */
interface RetryPart { band: BandSpec; scale: number; w: number; h: number; words: OcrWord[][]; noResult: boolean[] }

/** Confidence mass above the 50-point floor — the side-band rotation tie-break. */
const rotScore = (ws: OcrWord[]) => ws.reduce((s, w) => s + Math.max(0, w.confidence - 50), 0);

/**
 * Minimum `rotScore` mass the winning rotation must carry before a page's side
 * bands are allowed to LOCK the reciprocal strip scan to it, and the factor by
 * which it must beat the loser.
 *
 * Locking is not the same decision as the per-band pick. The per-band pick has to
 * choose SOMETHING, and picking the wrong way there costs one band's labels;
 * locking narrows a whole later scan, and picking the wrong way there can make it
 * return a different strip (see `searchReciprocal`). So it needs real evidence,
 * not merely more evidence than nothing.
 *
 * The FLOOR is calibrated off the scale `rotScore` produces. It is confidence mass
 * above 50, and `wordsToLabels` discards every word below confidence 60 — so a word
 * that could ever BECOME a label is worth at least 10, and 60 is six such words. A
 * lone misread fragment at confidence 55 is worth 5 and cannot clear it; neither can
 * one lucky 60.
 *
 * The MARGIN is what actually decides on real sheets, and the measurements say why.
 * Across the four eval sets both rotations score in the 800-9500 range on EVERY
 * page: a dense civil sheet rasterised sideways yields confident garbage whichever
 * way you turn it, so "one rotation scored higher" is nearly always true and nearly
 * always meaningless. Requiring 2x separates the pages whose side bands genuinely
 * hold upright text (ratios 2.35-3.01) from the pages where the two reads are the
 * same noise twice (1.02-1.96, with nothing at all in between). Only 3 of 22 PG_SITE pages and 3 of 4 Belcourt pages clear
 * it; the two PG_SITE pages that previously locked to 270 scored 1.32x and 1.14x and
 * now correctly lock to nothing.
 *
 * The floor is therefore never the binding test on these sets (the smallest winning
 * mass observed is ~836). It exists for the degenerate case the margin cannot judge:
 * a page that read almost nothing at all, where 5-vs-0 is a 5x ratio and still noise.
 */
const SIDE_ROT_LOCK_MIN_MASS = 60;
const SIDE_ROT_LOCK_MARGIN = 2;

/** The page-level rotation lock, or undefined for "the bands proved nothing". */
function lockSideTextRot(mass: Record<90 | 270, number>): 90 | 270 | undefined {
  const [win, lose]: [90 | 270, 90 | 270] = mass[270] > mass[90] ? [270, 90] : [90, 270];
  const hi = mass[win], lo = mass[lose];
  if (hi < SIDE_ROT_LOCK_MIN_MASS) return undefined;      // noise, or nothing read at all
  if (hi <= lo * SIDE_ROT_LOCK_MARGIN) return undefined;  // both directions read: not a decision
  return win;
}

/**
 * Render every OCR band of ONE page and issue ALL of its reads at once.
 *
 * Two shapes matter here.
 *
 * RENDERING IS SYNCHRONOUS and finished before this returns, because the caller
 * destroys the mupdf page the moment it does (`renderBand` needs the live page).
 * Only the reads are deferred, so a page's rasters are handed straight to the OCR
 * transport and never retained here: what survives the burst is the transport's
 * copy (a PNG blob / a transferred buffer), not the RGBA band.
 *
 * THE READS ARE CONCURRENT but consumed in exactly the sequential order: bands in
 * `pageEdgeBands` order, each side band's rotation pick unchanged (higher
 * confidence score wins, tie → the first of [90, 270], which `Array#sort`'s
 * stability guarantees), sheet-number band last. `Promise.all` preserves order, so
 * running the pool flat out cannot change which read wins.
 *
 * A LOST READ IS RE-READ ONCE, and HOW depends on how much of the band was lost:
 *  - every rotation a non-answer → the band is cut into overlapping sub-clips
 *    (`retryBandAsSubClips`). That is the only thing sub-clips are ever used for.
 *    Cutting bands up front was measured on the four eval sets and cost three of
 *    them: a callout that straddles a cut is truncated or misread into a different
 *    valid-looking target. So the cut is reserved for a band that produced nothing
 *    whichever way it was turned, where a degraded read beats none;
 *  - a SIDE band with one rotation lost and one answered → the lost rotation alone is
 *    re-read, WHOLE, at 200 dpi (`rereadLostRotation`). The two rotations' scores are
 *    compared against each other, so they must be reads of the same shape.
 * Either way, still lost after the one re-read = the band is `unknown`.
 * `reopenPage` is what makes the second pass possible at all: by the time a read
 * settles the caller has destroyed the page, so the retry loads its own.
 */
function readPageOcr(
  mupdf: any,
  page: any,
  view: [number, number, number, number],
  drawingFrame: [number, number, number, number] | null,
  ocr: (image: RawImage, opts?: { onNoResult?: () => void }) => Promise<OcrWord[]>,
  stats: OcrStats,
  signal?: AbortSignal,
  reopenPage?: () => any,
): Promise<PageOcrRead> {
  // Issue one read. The `.catch` goes on HERE, at the moment the promise exists,
  // not in a sweep afterwards: `renderBand` can throw part-way through the band
  // loop, and the reads issued before it would then be rejected with nobody
  // listening. The real awaits below still see every rejection.
  const issue = (image: RawImage, onNoResult?: () => void): Promise<OcrWord[]> => {
    const p = ocr(image, { onNoResult });
    p.catch(() => { /* surfaced below */ });
    return p;
  };
  const reads: BandRead[] = [];
  for (const band of pageEdgeBands(view, drawingFrame)) {
    // An abort mid-page must not raster the bands still to come: each is a pixmap
    // of tens of MB, and nothing downstream will ever read them.
    if (signal?.aborted) break;
    const { image, scale } = renderBand(mupdf, page, band.clip);
    const w = image.width, h = image.height;
    const noResult = [false, false];
    const mark = (k: number) => () => { noResult[k] = true; };
    if (band.edge === "left" || band.edge === "right") {
      // The rotated copies go straight into `issue` and are never bound to a local:
      // the side band's own raster is dead the moment both rotations exist.
      reads.push({ band, scale, w, h, rots: [90, 270], noResult,
        words: [issue(rotateRaw(image, 90), mark(0)), issue(rotateRaw(image, 270), mark(1))] });
    } else {
      reads.push({ band, scale, w, h, rots: [0], noResult, words: [issue(image, mark(0))] });
    }
  }
  /**
   * The title-block cell, issued with the bands and consumed after them.
   * resolvePrintedNos sanity-checks the range (a misread like "2"→"22" would
   * misroute byPrinted resolution).
   *
   * A NON-ANSWER here is not "this sheet has no number": it is the pool's budget
   * expiring on a cell that may well hold one, and "no number" sends the page to
   * the page-order fallback, which can misroute every `SEE SHEET n` on the set that
   * resolves byPrinted. So the cell is read a SECOND time, and if that is a
   * non-answer too the number stays UNKNOWN rather than quietly becoming "none".
   *
   * The second read RE-RENDERS the cell, through `reopenPage` exactly as
   * `retryBandAsSubClips` does — for the same two reasons. The caller destroyed its
   * page as soon as the reads were ISSUED, and the transport TRANSFERS the raster it
   * was given (`postMessage(…, [image.data.buffer])`), so by the time the first read
   * settles both the page and the pixels are gone. Re-reading the same husk would
   * throw, or come back `[]` with no non-answer reported at all — a clean miss, the
   * very failure being fixed. No `reopenPage` (a caller that cannot re-open) means
   * no second read, and the cell is unknown.
   */
  const readSheetNo = async (): Promise<{ words: OcrWord[]; unknown: boolean }> => {
    if (signal?.aborted) return { words: [], unknown: false };
    let lost = false;
    const first = await issue(renderBand(mupdf, page, sheetNoBand(view).clip).image, () => { lost = true; });
    if (!lost) return { words: first, unknown: false };
    // An aborted run re-renders and re-reads nothing: the answer would arrive for a
    // run that has already given up. The cell is unknown either way, and counted as
    // such — the same bookkeeping `readStrip` does on the same decision.
    if (signal?.aborted || !reopenPage) { stats.unknown++; return { words: [], unknown: true }; }
    stats.retries++;
    // Synchronous end to end, so nothing can interleave on the non-re-entrant mupdf
    // instance, and the handle is closed before the read is awaited.
    const page2 = reopenPage();
    let again: RawImage;
    try { again = renderBand(mupdf, page2, sheetNoBand(view).clip).image; }
    finally { page2.destroy?.(); }
    let lostAgain = false;
    const second = await issue(again, () => { lostAgain = true; });
    if (!lostAgain) return { words: second, unknown: false };
    stats.unknown++;
    return { words: [], unknown: true };
  };
  const sheetNo = readSheetNo();
  // Same reason the reads carry one: a rejection here must not go unobserved while
  // the band burst is still being awaited below.
  sheetNo.catch(() => { /* surfaced below */ });

  /**
   * Re-read ONE band as overlapping sub-clips, in order along the band.
   *
   * Rendering re-opens the page: `readPageOcr`'s caller destroys its page the
   * moment this function returns its promise, and this runs later. Loading a second
   * page handle is safe — mupdf's non-re-entrancy is about interleaving, and every
   * mupdf call here is synchronous, so nothing else can be mid-call — and the handle
   * is destroyed before the first await.
   *
   * The reads join the SAME page burst: same `ocr`, same abort signal, and they are
   * awaited inside this page's `ocrRead` promise, so the OCR_PAGES_IN_FLIGHT gate
   * still bounds everything a page has outstanding.
   */
  const retryBandAsSubClips = async (r: BandRead, subs: BandSpec[]): Promise<RetryPart[]> => {
    const pending: (Omit<RetryPart, "words"> & { words: Promise<OcrWord[]>[] })[] = [];
    const page2 = reopenPage!();
    try {
      for (const sub of subs) {
        // Defence in depth, not a live path: this loop is synchronous end to end, so
        // nothing can abort part-way through it, and the caller has already checked
        // the signal. It is kept because it is the honest guard to write here and
        // because `whole` below refuses to vote on the truncation it would produce.
        if (signal?.aborted) break;
        const { image, scale } = renderBand(mupdf, page2, sub.clip);
        const w = image.width, h = image.height;
        const nr = [false, false];
        const mark = (k: number) => () => { nr[k] = true; };
        pending.push({
          band: sub, scale, w, h, noResult: nr,
          words: r.rots.length === 2
            ? [issue(rotateRaw(image, 90), mark(0)), issue(rotateRaw(image, 270), mark(1))]
            : [issue(image, mark(0))],
        });
      }
    } finally {
      page2.destroy?.();
    }
    const got = await Promise.all(pending.map((p) => Promise.all(p.words)));
    return pending.map((p, j) => ({ ...p, words: got[j] }));
  };

  /**
   * Re-read ONE rotation of a side band — the one that came back a non-answer while
   * the other rotation answered.
   *
   * This is the last place a lost read could still change the verdict in silence. A
   * side band is TWO separate pool jobs, and the sub-clip retry above only fires when
   * both are lost; a band that lost exactly one was left alone and its vote withheld.
   * That withheld vote is not a harmless omission: it can move `lockSideTextRot` off
   * a real rotation, the lock decides which rotations the reciprocal strip scan
   * reads, and a narrower scan can return a different strip — a different anchor, a
   * different verdict, on the same sheets. The gates key on `unknown`, which this
   * case never touched. So the lost rotation now gets the same budget every other
   * decision-feeding read gets: ONE more try, and if that is lost too the band is
   * `unknown` as well as withheld, which the gates DO see.
   *
   * IT RE-RENDERS, for the reason `readStrip` and the sheet-number cell re-render:
   * both production transports TRANSFER the raster on the way out
   * (`postMessage(…, [image.data.buffer])`), so by the time a read settles its
   * `RawImage` is a husk with a detached buffer. Handing that back throws a
   * DataCloneError up through the page burst, or — on the path that swallows it —
   * returns `[]` with no non-answer reported at all, which is the bug wearing a
   * disguise. `reopenPage` is the way back to the pixels; a caller that cannot
   * re-open (or a run already aborted) gets no second try, and the band is unknown.
   *
   * The WHOLE band, at that one rotation, at the same dpi — never sub-clips. The pick
   * and the rotation tally compare the two rotations' scores, and a score only means
   * something between reads of the same shape; a cut re-read scored against an uncut
   * survivor would decide the lock on the cut. (The all-lost case has no such
   * asymmetry: it replaces BOTH rotations wholesale, which is exactly why sub-clips
   * are safe there and not here.)
   *
   * Returns the words, or null for "still a non-answer".
   */
  const rereadLostRotation = async (r: BandRead, k: number): Promise<OcrWord[] | null> => {
    // Synchronous end to end, so nothing can interleave on the non-re-entrant mupdf
    // instance, and the handle is closed before the read is awaited.
    const page2 = reopenPage!();
    let again: RawImage;
    try { again = renderBand(mupdf, page2, r.band.clip).image; }
    finally { page2.destroy?.(); }
    let lostAgain = false;
    const words = await issue(rotateRaw(again, r.rots[k] as 90 | 270), () => { lostAgain = true; });
    return lostAgain ? null : words;
  };

  return (async () => {
    const perBand = await Promise.all(reads.map((r) => Promise.all(r.words)));
    const recovered: Label[] = [];
    // Confidence mass per rotation, summed over the page's SIDE bands. Per band the
    // winner is picked exactly as before (this is only an extra tally); across the
    // page it answers "which way does this sheet's vertical text read?", which the
    // reciprocal strip scan then trusts instead of trying both.
    const rotMass: Record<90 | 270, number> = { 90: 0, 270: 0 };
    for (let i = 0; i < reads.length; i++) {
      const r = reads[i];
      // Per rotation: the words the band was read as, and whether that evidence can
      // be trusted enough to vote. `parts` is non-null once a retry has replaced the
      // whole-band evidence, and then the labels come from the sub-clips instead.
      let words: OcrWord[][] = perBand[i];
      let parts: RetryPart[] | null = null;
      // THE PARTIAL RE-READ: a side band that lost exactly ONE of its two rotations.
      //
      // Nothing here fires on a clean run — every branch is behind a non-answer that
      // actually happened. When one does: the lost rotation is re-read once at full
      // size (`rereadLostRotation`), and either it answers, `noResult[k]` is cleared
      // and the band votes exactly as an untroubled band would, or it is lost again
      // and the band is BOTH withheld (below) and `unknown` — the strong counter, the
      // one the probe gates and the hook's re-check actually read.
      //
      // Counted as unknown even when there is no re-read to make (no `reopenPage`, or
      // the run is aborting): "we could not find out" is the same fact whether the
      // budget expired twice or the second attempt was impossible. Same bookkeeping
      // the sheet-number cell and `readStrip` do on the same decision.
      const lostRots = r.rots.filter((_, k) => r.noResult[k]).length;
      if (r.rots.length === 2 && lostRots === 1) {
        const k = r.noResult.findIndex((v) => v);   // exactly one, given the guards
        if (!reopenPage || signal?.aborted) {
          stats.unknown++;
        } else {
          stats.retries++;   // one re-read DECISION, as everywhere else
          const again = await rereadLostRotation(r, k);
          if (again) {
            // `perBand[i]` is what `words` aliases; replace the rotation's evidence in
            // place so the pick, the score and `labelsAt` all see the read that landed.
            words[k] = again;
            r.noResult[k] = false;
          } else {
            stats.unknown++;
          }
        }
      }
      // THE RETRY, and it is deliberately hard to earn.
      //
      // Only a NON-ANSWER earns one — an empty read is an answer, and a band that
      // answered is read exactly as it always was. Beyond that, EVERY rotation of the
      // band must have been lost: a side band is read twice, and if one of those
      // rotations came back with words then the band HAS a whole-raster reading. A
      // whole read always beats a cut one (the cut truncates callouts and can misread
      // a fragment into a different valid-looking target — measured, see
      // task-6-report.md), so CUTTING a band with one survivor has nothing to gain and
      // real quality to lose. Only when the band produced nothing at all, whichever
      // way it was turned, is a degraded read better than none. (The one-survivor band
      // is not left alone either — it is re-read WHOLE at its lost rotation, just
      // above. Cut vs whole is the distinction here, not retry vs no retry.)
      //
      // The two other bars: a band short enough to be one job has nothing to retry
      // WITH (`splitBand` hands back the band itself), and an aborted run must raster
      // nothing more.
      const allLost = r.rots.every((_, k) => r.noResult[k]);
      const subs = allLost && reopenPage && !signal?.aborted ? splitBand(r.band) : [r.band];
      if (subs.length > 1) {
        stats.retries++;   // one re-read DECISION, however many sub-clips it issues
        parts = await retryBandAsSubClips(r, subs);
        // Every rotation is re-read, because every rotation was lost — and the pick
        // below compares their scores, which only means anything between reads of the
        // same shape. So the retry replaces the band's evidence wholesale.
        words = r.rots.map((_, k) => parts!.flatMap((p) => p.words[k] ?? []));
      }
      // A band's two rotations are two SEPARATE pool jobs, and one can time out while
      // the other returns. Counting the survivor UNOPPOSED is how a single 20 s
      // hiccup on one crop flips a page's rotation lock, so a band whose evidence is
      // not whole contributes nothing to the tally:
      //  - no retry: it votes only if NEITHER rotation was a non-answer (and the
      //    older "exactly one came back empty" guard still applies on top — an empty
      //    read is an answer, but an unopposed one is still not a decision);
      //  - retried: it votes only if the retry actually covered the WHOLE band —
      //    every sub-clip rastered (half a band's mass is not the band's mass) and no
      //    sub-clip of any rotation itself a non-answer. The length test pairs with
      //    the abort break in `retryBandAsSubClips`: neither is reachable today, and
      //    together they mean a truncated retry could never quietly vote as a whole
      //    one if it ever became so.
      const whole = parts
        ? parts.length === subs.length && r.rots.every((_, k) => parts!.every((p) => !p.noResult[k]))
        : !r.rots.some((_, k) => r.noResult[k]);
      // Withholding a vote is not a harmless omission — it can move
      // `lockSideTextRot` off a real rotation, and the lock decides which rotations
      // the reciprocal strip scan reads, so it can move which strip the scan returns.
      // But it is a WEAKER fault than an unread band: the band still has a reading and
      // its labels are still used. It gets its own counter, on the bands that actually
      // vote (only side bands do — see the `c.rot !== 0` guard below).
      //
      // WITHHELD MEANS WITHHELD AFTER THE RE-READ. `noResult[k]` has already been
      // cleared for a rotation the partial re-read recovered, so a band that faltered
      // once and then answered votes here exactly as a band that never faltered — and
      // is not counted. What is left in this counter is a band that stayed broken.
      if (!whole && r.rots.length === 2) stats.withheldVotes++;
      // UNKNOWN is the strong one: this band produced nothing readable at all —
      // every rotation a non-answer, and then either no cut to make (too short, no
      // page handle, aborted) or every sub-clip of the cut a non-answer too. A band
      // in that state is a hole in the evidence, not a band that read blank.
      if (allLost && (!parts || r.rots.every((_, k) => parts!.every((p) => p.noResult[k])))) stats.unknown++;
      // wordsToLabels wants each raster's OWN clip and PRE-rotation dims (it inverts
      // the rotation itself). A retried band emits its sub-clips in order along the
      // band, then drops what the overlap read twice.
      const labelsAt = (k: number, rot: 0 | 90 | 270): Label[] => {
        if (!parts) return wordsToLabels(words[k], r.band, r.scale, r.w, r.h, rot);
        const out: Label[] = [];
        for (const p of parts) out.push(...wordsToLabels(p.words[k] ?? [], p.band, p.scale, p.w, p.h, rot));
        return dedupeLabels(out);
      };
      if (r.rots.length === 1) {
        recovered.push(...labelsAt(0, r.rots[0]));
        continue;
      }
      // Score ONCE per candidate: the tally below and the pick both want it, and
      // `sort` would otherwise re-run it O(n log n) times over the same words.
      const cands = r.rots.map((rot, k) => ({ rot, k, score: rotScore(words[k]) }));
      const blank = cands.reduce((n, c) => n + (words[c.k].length === 0 ? 1 : 0), 0);
      if (whole && blank !== 1) for (const c of cands) if (c.rot !== 0) rotMass[c.rot] += c.score;
      // Unchanged pick: highest score wins, and a tie keeps the first of [90, 270]
      // because `Array#sort` is stable. The PICK always has to choose something, so
      // it is made on whatever evidence there is, trusted or not.
      const best = cands.sort((a, b) => b.score - a.score)[0];
      recovered.push(...labelsAt(best.k, best.rot));
    }
    const sn = await sheetNo;
    return { recovered, ocrNo: parseSheetNumber(sn.words), unknownSheetNo: sn.unknown, sideTextRot: lockSideTextRot(rotMass) };
  })();
}

/**
 * Run the aligner, and guarantee that no OCR read outlives the run.
 *
 * The controller is owned HERE rather than inside the run so that the `finally`
 * is unconditional. `checkAbort()` trips it on a cooperative abort, but that is
 * only one of the ways a run ends: a `renderBand`/mupdf throw, a solver error, or
 * simply returning normally with the tail of the last page's burst still queued
 * all used to leave up to two pages of reads grinding through the pool for a
 * result nobody will read. Aborting a signal whose jobs have all settled is a
 * no-op, so the success path pays nothing for it.
 */
export async function autoStitch(
  mupdf: any,
  doc: any,
  pageIndices: number[],
  opts: AutoStitchOptions = {}
): Promise<AutoStitchResult> {
  const ocrAbort = typeof AbortController === "function" ? new AbortController() : null;
  try {
    return await runAutoStitch(mupdf, doc, pageIndices, opts, ocrAbort);
  } finally {
    ocrAbort?.abort();
  }
}

async function runAutoStitch(
  mupdf: any,
  doc: any,
  pageIndices: number[],
  opts: AutoStitchOptions,
  ocrAbort: AbortController | null,
): Promise<AutoStitchResult> {
  const total = pageIndices.length;
  const units: Unit[] = [];
  // Scale inference is deferred; uniform scale (user-entered or default), with an
  // optional per-page override for mixed-scale sets.
  const uniformScale = opts.userScale && opts.userScale > 0 ? opts.userScale : DEFAULT_SCALE;
  const scaleOf = (pageIndex: number): number => {
    const own = opts.pageScales?.get(pageIndex);
    return own != null && own > 0 ? own : uniformScale;
  };

  // Cooperative-abort checkpoint. Throwing a distinguishable error lets the
  // worker report `{aborted:true}` (not an error) when a plain add supersedes the probe.
  //
  // `ocrAbort` (owned by the wrapper above) carries the SAME abort down into the
  // OCR transport. It matters now that reads are issued in a burst: most of a
  // page's bands are still sitting in the pool's QUEUE when an abort lands, and a
  // queued job has no deadline of its own — unsignalled, every one of them would
  // be OCR'd in full for a run that has already given up.
  const checkAbort = () => {
    if (!opts.shouldAbort?.()) return;
    ocrAbort?.abort();
    throw new AutoStitchAborted();
  };
  // Guard every OCR call: abort BEFORE the (slow) recognize, and fire onOcrStart
  // once so the UI can explain the wait. All OCR below goes through `ocr`.
  let ocrStarted = false;
  // Every read the run makes goes through the wrapper below, so `calls` and
  // `nonAnswers` are counted in ONE place rather than at each call site — a site
  // that forgets to count is exactly the bug this change exists to fix (the strip
  // scan and the sheet-number cell used to forget to ASK). `retries` and `unknown`
  // belong to the decisions that consume the reads, and are counted there.
  const ocrStats: OcrStats = { calls: 0, nonAnswers: 0, retries: 0, unknown: 0, withheldVotes: 0 };
  const rawOcr = opts.ocr;
  const ocr = rawOcr
    ? async (image: RawImage, o?: { onNoResult?: () => void }): Promise<OcrWord[]> => {
        checkAbort();
        if (!ocrStarted) { ocrStarted = true; opts.onOcrStart?.(); }
        ocrStats.calls++;
        // `onNoResult` is wrapped, not passed straight through: the transport is the
        // only thing that can tell an expired job budget from a crop with no text in
        // it, the run wants that counted whether or not this particular caller cares,
        // and the caller's own hook still fires. The run's abort is added here, which
        // is why the two opts shapes are the same but not the same object.
        return rawOcr(image, {
          signal: ocrAbort?.signal,
          onNoResult: () => { ocrStats.nonAnswers++; o?.onNoResult?.(); },
        });
      }
    : undefined;
  // How wide the reciprocal strip scan (pass 2) batches its reads. Sized off the
  // concurrency of the transport behind `ocr` — the browser pool's own derivation
  // by default, the harness's fixed 3 when it says so — because a chunk exists to
  // fill that pool exactly once: narrower leaves workers idle, wider only queues
  // strips whose answers a hit in the same chunk will discard.
  const OCR_CHUNK = Math.max(1, Math.floor(opts.ocrConcurrency ?? defaultOcrPoolSize()));

  // ── PASS 1: per-page capture + edge-band OCR recovery ───────────────────────
  // Collect each page's extract + printed number FIRST (page released after
  // capture); unit construction is deferred to pass 3 so the reciprocal-anchor
  // pass (pass 2) can run against the whole set between them.
  //
  // Pass 1 is itself in two steps. The EXTRACT step below walks the pages in order
  // on the single mupdf document (mupdf is not re-entrant, so that stays strictly
  // sequential), rasters each page's OCR bands while the page is alive, fires all
  // of its reads at once and moves on WITHOUT waiting for them. The RESOLVE step
  // that follows consumes those reads in page order, before anything downstream
  // reads `recovered`/`ocrNo`/`printedNo`. Net effect: the OCR pool is kept fed
  // both within a page (its ~7 band reads overlap) and across pages (page i+1 is
  // being extracted while page i is still being read).
  const pending: {
    pageIndex: number; extract: PageExtract;
    drawingFrame: [number, number, number, number] | null;
    title: string | null; statedFtPerIn: number | null; pageLabel: PageLabelResult;
    /** null when this page took the no-OCR path (its text channels had edge refs). */
    ocrRead: Promise<PageOcrRead> | null;
  }[] = [];
  // Backpressure. Extraction is far cheaper than OCR, so left alone it would run
  // the whole selection ahead of the reads and pile every page's band rasters into
  // the pool's queue at once. Two pages in flight is enough to keep every pool
  // worker busy across a page boundary (one page alone already queues ~7 reads)
  // while bounding what is outstanding to the page being read plus the one being
  // extracted.
  const OCR_PAGES_IN_FLIGHT = 2;
  const inFlight: Promise<PageOcrRead>[] = [];

  for (let i = 0; i < pageIndices.length; i++) {
    checkAbort(); // top of each per-page iteration
    while (inFlight.length >= OCR_PAGES_IN_FLIGHT) await inFlight.shift();
    const pageIndex = pageIndices[i];
    await yieldToMain();
    // Re-checked after BOTH awaits above: an abort landing while this iteration
    // waited for the backpressure gate (which can be a whole page of OCR long)
    // would otherwise still capture the page and raster its 5-9 band pixmaps —
    // ~110 MB on a large sheet — before the next iteration's checkpoint fired.
    checkAbort();
    const page = doc.loadPage(pageIndex);
    let extract: PageExtract;
    let ocrRead: Promise<PageOcrRead> | null = null;
    let drawingFrame: [number, number, number, number] | null = null;
    let title: string | null = null;
    let statedFtPerIn: number | null = null;
    let pageLabel: PageLabelResult | null = null;
    try {
      extract = capturePage(mupdf, page);
      // The sheet's ruled drawing frame (null when it draws edge to edge). Every
      // edge rule below is measured against it: on a set with a notes column the
      // drawing's own right border sits at ~72% of the page width, and a matchline
      // callout there is neither rasterised by a page-relative band nor classified
      // as an edge ref (failure D).
      drawingFrame = detectDrawingFrame(extract.geometry, extract.view);
      // Title-block title + the sheet's OWN stated scale, read from the PDF's text
      // channels BEFORE the OCR merge below. Deliberately pre-merge: OCR recovers
      // edge-band text ("… ON SHEET 3. CASE PER PLAN" and the like), and letting that
      // reach the title picker mislabels plan sheets — it cost PG_SITE four
      // alignments in testing. Title-block reading is a text-channel job.
      pageLabel = extractPageLabel({ labels: extract.labels, shxLabels: extract.shxLabels, view: extract.view });
      title = pageLabel.title;
      const baseNotes = parseScaleNotes([...extract.labels, ...extract.shxLabels]);
      statedFtPerIn = baseNotes.length ? baseNotes[0].ftPerIn : null;
      // OCR recovery: OCR the PAGE-EDGE bands (no frame needed) when the text
      // channels are starved of edge refs. Strip refs recovered here declare a
      // two-strip page AND locate the split (see stripFrames) — geometry border
      // detection is not used (it misfires on dense civil sheets). No density
      // gate here: raster/scanned pages carry zero vector geometry and are
      // exactly the pages OCR exists to rescue, so gating on geometry would
      // disable OCR precisely where it is needed.
      if (ocr && !hasEdgeRefs(extract, drawingFrame)) {
        // Rasters every band NOW (the page dies in the `finally` below) and issues
        // every read at once; the answers are consumed in the resolve step.
        // `() => doc.loadPage(pageIndex)` is the retry's way back to the pixels: the
        // `finally` below destroys this page as soon as the reads are ISSUED, long
        // before any of them settles, so a band that answers with nothing has to
        // load its own handle to be re-read. Never called unless that happens.
        ocrRead = readPageOcr(mupdf, page, extract.view, drawingFrame, ocr, ocrStats, ocrAbort?.signal,
          () => doc.loadPage(pageIndex));
      }
    } finally {
      page.destroy?.();
    }
    if (ocrRead) {
      // Marked handled here too: the resolve step below is the real await, but a
      // rejection between now and then (an abort on an earlier page) must not
      // surface as an unhandled promise.
      ocrRead.catch(() => { /* surfaced by the resolve step */ });
      inFlight.push(ocrRead);
    }
    pending.push({
      pageIndex, extract, drawingFrame, title, statedFtPerIn, ocrRead,
      pageLabel: pageLabel ?? { sheetCode: null, discipline: null, title: null, sheetNo: null, sheetOf: null, confidence: "none", source: "none" },
    });
    // Progress counts pages EXTRACTED. Backpressure keeps that within
    // OCR_PAGES_IN_FLIGHT pages of pages finished, and the bar was always ahead of
    // the run as a whole anyway (the solve still follows the last page).
    opts.onProgress?.(i + 1, total);
  }

  // ── PASS 1, RESOLVE: consume each page's OCR reads, in page order ────────────
  const pages: PageRec[] = [];
  const refPageIndices: number[] = [];
  for (const p of pending) {
    checkAbort(); // …so an abort during the read burst drops the jobs still queued
    const { pageIndex, drawingFrame } = p;
    let extract = p.extract;
    let ocrNo: number | null = null;
    let sideTextRot: 90 | 270 | undefined;
    let unknownSheetNo = false;
    if (p.ocrRead) {
      const read = await p.ocrRead;
      ocrNo = read.ocrNo;
      unknownSheetNo = read.unknownSheetNo;
      sideTextRot = read.sideTextRot;
      if (read.recovered.length) extract = { ...extract, labels: [...extract.labels, ...read.recovered] };
    }

    // Printed sheet number candidate, best source first: the PDF's own
    // "SHEET n OF m" text > the caller's sheet identity > OCR of the title cell >
    // page order. The PDF's text is what the sheet literally says; the caller's
    // identity was read once, off-line, from the same title block; OCR of a
    // rasterised band is the last resort. (This is the CTO hand-off: a code like
    // "C5.00" is not a printed NUMBER, so it feeds `sheetCode` instead — see below.)
    // The final number (sanity + collision repair) is resolved after the loop.
    let textNo: number | null = null;
    for (const l of [...extract.shxLabels, ...extract.labels]) {
      const m = l.text.match(/SHEET\s+(?:NO\.?\s*)?(\d+)\s+OF\s+\d+/i);
      if (m) { textNo = Number(m[1]); break; }
    }
    const ctoRaw = opts.pageCodes?.get(pageIndex) ?? null;
    const ctoNo = ctoRaw != null && /^\d{1,3}$/.test(ctoRaw) ? Number(ctoRaw) : null;
    const ctoCode = ctoRaw != null && ctoNo == null ? ctoRaw : null;
    let printedNo: number | null = null;
    let printedNoSource: PrintedNoSource = "fallback";
    if (textNo != null) { printedNo = textNo; printedNoSource = "text"; }
    else if (ctoNo != null) { printedNo = ctoNo; printedNoSource = "cto"; }
    else if (ocrNo != null) { printedNo = ocrNo; printedNoSource = "ocr"; }

    pages.push({
      pageIndex, extract, printedNo: printedNo ?? pageIndex + 1, printedNoSource, drawingFrame,
      title: p.title, statedFtPerIn: p.statedFtPerIn, role: "tile", ctoCode,
      sheetCode: null, sheetCodeDropped: false, pageLabel: p.pageLabel, sideTextRot, unknownSheetNo,
    });
    // Ref-bearing after the OCR merge: does the page carry any usable adjacency
    // signal? This is the feasibility denominator (see refPageIndices).
    if (hasEdgeRefs(extract, drawingFrame)) refPageIndices.push(pageIndex);
  }

  // Sanity-check OCR reads and repair printedNo collisions, then apply.
  const resolvedNos = resolvePrintedNos(
    pages.map((p) => ({ pageIndex: p.pageIndex, printedNo: p.printedNo, source: p.printedNoSource })),
    pageIndices.length
  );
  for (const p of pages) p.printedNo = resolvedNos.get(p.pageIndex)!;

  // ── SHEET CODES: the caller's, but only where the drawings agree ────────────
  // Code-shaped tokens. No leading letter and no trailing letter/digit, so "CD102"
  // is found inside the DWG path CAD stamps in the margin ("…5072024CD102.DWG") —
  // often the only place a sheet's real code survives — without "CADD" or "C5000"
  // matching.
  const CODE_TOKEN_RE = /(?<![A-Z])[A-Z]{1,3}[-\s]?\d{1,3}(?:\.\d{1,3})?(?![A-Z0-9])/gi;
  const { codes, dropped: codesDropped } = resolveSheetCodes(pages.map((p) => {
    const text = [...p.extract.shxLabels, ...p.extract.labels];
    const ownTokens: string[] = [];
    for (const l of text) for (const m of l.text.matchAll(CODE_TOKEN_RE)) ownTokens.push(m[0]);
    const refTargets = parseSheetRefs(text, p.extract.view, p.drawingFrame)
      .map((r) => r.sheetCode).filter((c): c is string => c != null);
    return { pageIndex: p.pageIndex, ctoCode: p.ctoCode, titleCode: p.pageLabel.sheetCode, ownTokens, refTargets };
  }));
  for (const p of pages) {
    p.sheetCode = codes.get(p.pageIndex) ?? null;
    p.sheetCodeDropped = codesDropped.has(p.pageIndex);
  }

  // ── SHEET ROLE + SCALE-NOTE CROSS-CHECK ─────────────────────────────────────
  // Which pages are TILES. An overall/key plan covers the tiles' ground at a
  // different scale (it overlays them rather than abutting them) and a notes/index/
  // details sheet shares no ground with anything; both are kept out of the pair
  // search, then reported so the UI can say WHICH pages were left out and why.
  // The scale test is against the set's own median stated scale, so it needs every
  // page's note first.
  const stated = pages.map((p) => p.statedFtPerIn).filter((v): v is number => v != null && v > 0).sort((a, b) => a - b);
  const medianStated = stated.length ? stated[Math.floor(stated.length / 2)] : null;
  const skipped: { pageIndex: number; role: SheetRole; reason: string }[] = [];
  const ROLE_REASON: Record<string, string> = {
    overall: "an overall plan — it covers the same ground as the tiles, at a different scale",
    keyplan: "a key plan",
    index: "a sheet index",
    notes: "a notes sheet",
    details: "a details sheet",
  };
  for (const p of pages) {
    p.role = classifySheetRole(p.title, { scaleFtPerIn: p.statedFtPerIn, medianScaleFtPerIn: medianStated });
    if (p.role !== "tile") skipped.push({ pageIndex: p.pageIndex, role: p.role, reason: ROLE_REASON[p.role] ?? p.role });
  }
  // Advisory only: the sheet's own scale note vs the scale actually in use. Never an
  // override — the user's scale (or the CTO plan's) stays authoritative.
  const scaleWarnings: { pageIndex: number; usedFtPerIn: number; statedFtPerIn: number }[] = [];
  for (const p of pages) {
    const used = scaleOf(p.pageIndex);
    if (p.statedFtPerIn == null || !(used > 0)) continue;
    if (Math.abs(p.statedFtPerIn - used) / used > 0.25) {
      scaleWarnings.push({ pageIndex: p.pageIndex, usedFtPerIn: used, statedFtPerIn: p.statedFtPerIn });
    }
  }

  // ── PASS 2: reciprocal interior-matchline anchor search ─────────────────────
  // A one-sided edge ref on page j ("SEE SHEET n" on its left/right edge) has no
  // reciprocal edge ref on the referenced page i, because i's matching label sits
  // INTERIOR (~75% width, beside the notes column) — outside every edge band. We
  // targeted-OCR that interior region of i for the reciprocal "SEE SHEET <j's #>"
  // label; the search is EXPECTED-NUMBER gated so an unrelated interior matchline
  // label can never anchor. The facing pair pins dx to ±17ft (stitchCore then runs
  // a ±30ft windowed segment vote in the true basin).
  const rawAnchors: RawAnchor[] = [];
  if (ocr) {
    const byPrinted = new Map<number, PageRec[]>();
    for (const p of pages) (byPrinted.get(p.printedNo) || byPrinted.set(p.printedNo, []).get(p.printedNo)!).push(p);
    // ── DISCIPLINE-CODE identity ("MATCH LINE SEE SHEET C-302") ────────────────
    // The reciprocal-anchor pass used to be NUMERIC-only, so a set that references
    // its neighbours by discipline code never reached the strong anchor channels at
    // all. Each page's own code comes from its title block (`extractPageLabel`),
    // exactly as stitchCore already resolves `SEE SHEET C2.01` cross-references.
    // Codes are compared with separators stripped so "C-302" ≡ "C302" ≡ "C 302".
    const codeOf = new Map<number, string | null>();
    const byCode = new Map<string, PageRec[]>();
    for (const p of pages) {
      const code = p.sheetCode;
      const n = code ? normCode(code) : null;
      codeOf.set(p.pageIndex, n);
      if (n) (byCode.get(n) || byCode.set(n, []).get(n)!).push(p);
    }
    // Cached per page: the mutual-facing and reciprocal-search loops call this
    // O(pages²) times, and a fresh concatenated array each time would defeat
    // parseSheetRefs' own memo.
    const edgeRefCache = new Map<number, SheetRef[]>();
    const edgeRefsOf = (p: PageRec): SheetRef[] => {
      const hit = edgeRefCache.get(p.pageIndex);
      if (hit) return hit;
      const refs = parseSheetRefs([...p.extract.shxLabels, ...p.extract.labels], p.extract.view, p.drawingFrame)
        .filter((r) => r.edge !== "interior" && (r.sheet != null || r.sheetCode != null));
      edgeRefCache.set(p.pageIndex, refs);
      return refs;
    };
    /** The pages a ref points at — by printed number, or by discipline code. */
    const refTargets = (r: SheetRef): PageRec[] =>
      r.sheet != null ? (byPrinted.get(r.sheet) ?? [])
        : r.sheetCode ? (byCode.get(normCode(r.sheetCode)) ?? [])
        : [];
    /** Does ref `r` (on some other page) name page `p`? */
    const refNames = (r: SheetRef, p: PageRec): boolean =>
      (r.sheet != null && r.sheet === p.printedNo) ||
      (r.sheetCode != null && codeOf.get(p.pageIndex) != null && normCode(r.sheetCode) === codeOf.get(p.pageIndex));
    const OPP: Record<string, string> = { left: "right", right: "left", top: "bottom", bottom: "top" };
    /** Does an OCR-recovered interior label reference page `p`? Number first, then
     *  the discipline code. Both readings tolerate the OCR spellings of the callout
     *  vocabulary ("SEE SHEEET 6", "SE. SHEET 7") — see tokens.ts. */
    const ocrRefNames = (text: string, p: PageRec): boolean => {
      const no = refSheetNumber(text);
      if (no != null && no === p.printedNo) return true;
      const c = refSheetCode(text);
      const own = codeOf.get(p.pageIndex);
      return !!(c && own && normCode(c) === own);
    };

    /**
     * Register a matchline seam on BOTH axes from geometry. (1) PERP axis: both
     * sheets DRAW the shared matchline as a long (usually dashed) stroke, whose
     * cross-position is EXACT geometry, so `perpDelta = FT(strokeI) − FT(strokeJ)`
     * pins the perpendicular axis to sub-foot (unlike the ±17 ft LABEL delta). (2)
     * ALONG axis: real linework (streets, curbs, lot lines) CROSSES the matchline at
     * identical world stations on both sheets, so a 1-D consensus of the crossing
     * deltas (`seamCrossings` + `crossingConsensus`, windowed around the label along-
     * delta) pins the along axis exactly too — the axis that otherwise carried 10-60
     * ft of segVote/label slop and slid streets sideways across the seam.
     *
     * `crossI`/`crossJ` are the facing labels' PERP cross-coordinates; `alongI`/
     * `alongJ` their ALONG coordinates — both in each page's whole-page coordinate
     * space, so every returned delta obeys d(i→j) = posFt_j − posFt_i. A vertical
     * matchline (perp "x") scans axis "v"; horizontal (perp "y") scans "h". Returns
     * perpDelta null (falls back to the label delta) unless a stroke is found on both
     * sheets; along null unless the crossing consensus is decisive. `loDelta`/
     * `hiDelta` are the matchline dash-extent endpoint deltas (diag cross-check). */
    const seamRegister = (
      pi: PageRec, crossI: number, alongI: number,
      pj: PageRec, crossJ: number, alongJ: number, perp: "x" | "y",
    ): { perpDelta: number | null; along: number | null; loDelta: number | null; hiDelta: number | null; crI: Crossing[]; crJ: Crossing[]; strokeI: number | null; strokeJ: number | null } => {
      const axis = perp === "x" ? "v" : "h";
      // Rebase each endpoint to its strip's frame-local coordinates (no-op for whole
      // pages / a top strip): stroke deltas and crossing stations then key to the same
      // space as the unit's view/placement downstream.
      const fi = frameLocal(pi, crossI, alongI, perp), fj = frameLocal(pj, crossJ, alongJ, perp);
      const extI = { lo: 0, hi: 0 }, extJ = { lo: 0, hi: 0 };
      const si = findEdgeStroke(fi.geometry, axis, fi.cross, fi.view, 100, 0.3, extI);
      const sj = findEdgeStroke(fj.geometry, axis, fj.cross, fj.view, 100, 0.3, extJ);
      if (si == null || sj == null) return { perpDelta: null, along: null, loDelta: null, hiDelta: null, crI: [], crJ: [], strokeI: null, strokeJ: null };
      const scaleI = scaleOf(pi.pageIndex), scaleJ = scaleOf(pj.pageIndex);
      const perpDelta = FT(si, scaleI) - FT(sj, scaleJ);
      // Along-axis seam-crossing consensus, windowed around the label along-delta so
      // far-off pairings can't flood the histogram. Crossings are collected at each
      // sheet's OWN stroke cross-position (si / sj), and carry an orientation signature
      // so crossingConsensus (and the downstream JOINT sweep) can gate street↔street.
      const center = FT(fi.along, scaleI) - FT(fj.along, scaleJ);
      const ci = seamCrossings(fi.geometry, axis, si, scaleI);
      const cj = seamCrossings(fj.geometry, axis, sj, scaleJ);
      // Window (±60 ft @20) and bin (2 ft @20) are page-point-derived so the vote
      // makes identical decisions at any scale (values just scale linearly). Shared
      // window/bin use the i-side scale; the cached-probe reuse gate lives in
      // AddPdfModal (isUniform) — inside autoStitch, this IS the live path.
      const cons = crossingConsensus(ci, cj, center, { window: FT(216, scaleI), bin: FT(7.2, scaleI) });
      return {
        perpDelta, along: cons ? cons.along : null,
        loDelta: FT(extI.lo, scaleI) - FT(extJ.lo, scaleJ),
        hiDelta: FT(extI.hi, scaleI) - FT(extJ.hi, scaleJ),
        crI: ci, crJ: cj, strokeI: si, strokeJ: sj,
      };
    };

    // Frame-local view of a split-page endpoint. When `p` is a two-strip page and the
    // label point (x,y) falls in a strip frame, returns that frame's sliceExtract plus
    // the label's cross/along coords REBASED to the frame origin — so the stroke search
    // and crossing stations key to the strip's OWN coordinates (view [0,0,w,h]),
    // matching how the strip UNIT's view and placement are keyed downstream. Whole-page
    // otherwise (a no-op frame origin (0,0) for a full-page unit or a top strip). This
    // is the strip-local rebase the prior round flagged as required: seamRegister used
    // whole-page coords, harmless for a full-width row seam's along-x but wrong once a
    // strip becomes a floating unit whose posFt is its frame origin.
    const frameLocal = (p: PageRec, cross: number, along: number, perp: "x" | "y") => {
      const frames = stripFrames([...p.extract.shxLabels, ...p.extract.labels], p.extract.view) ?? [];
      const px = perp === "y" ? along : cross, py = perp === "y" ? cross : along;
      const f = frames.find((fr) => fr.bbox[0] <= px && px <= fr.bbox[2] && fr.bbox[1] <= py && py <= fr.bbox[3]);
      if (!f) return { geometry: p.extract.geometry, view: p.extract.view, cross, along };
      const ext = sliceExtract(p.extract, f);
      const foCross = perp === "y" ? f.bbox[1] : f.bbox[0];
      const foAlong = perp === "y" ? f.bbox[0] : f.bbox[1];
      return { geometry: ext.geometry, view: ext.view, cross: cross - foCross, along: along - foAlong };
    };

    /**
     * ONE-SIDED stroke anchor fallback. When j references i but the reciprocal OCR
     * search below recovers NO label on i, both sheets may still DRAW the shared
     * matchline; `oneSidedStrokeAnchor` (stitchCore) locates j's stroke near its ref and
     * i's as the matchline border in i's facing outer band. Restricted to refs
     * originating on a split-page STRIP (jFrame != null) — the units the reciprocal path
     * cannot anchor — and computed on the strip's FRAME-LOCAL slice so its deltas/
     * stations key to the strip's coordinates. Keeps whole-page seams untouched.
     */
    const oneSidedAnchor = (iPage: PageRec, jPage: PageRec, refJ: SheetRef): RawAnchor | null => {
      const frames = stripFrames([...jPage.extract.shxLabels, ...jPage.extract.labels], jPage.extract.view) ?? [];
      const jFrame = frames.find((f) => f.bbox[1] <= refJ.at.y && refJ.at.y <= f.bbox[3] && f.bbox[0] <= refJ.at.x && refJ.at.x <= f.bbox[2]);
      if (!jFrame) return null; // strip-only
      const jExtract = sliceExtract(jPage.extract, jFrame);
      const jAt = { x: refJ.at.x - jFrame.bbox[0], y: refJ.at.y - jFrame.bbox[1] };
      // This channel applies ONE scale (i's) to both sheets — stitchCore itself is
      // untouched/scale-agnostic. A no-op for uniform sets (i and j share a scale); for a
      // mixed-scale pair it's a known limitation (Phase 3) since j's geometry is measured
      // in i's feet-per-inch instead of its own.
      const r = oneSidedStrokeAnchor(iPage.extract.geometry, iPage.extract.view, jExtract.geometry, jExtract.view, jAt, refJ.edge, scaleOf(iPage.pageIndex));
      if (!r) return null;
      const [, iy0, , iy1] = iPage.extract.view;
      return {
        pageI: iPage.pageIndex, yI: r.perp === "y" ? r.siCross : (iy0 + iy1) / 2,
        pageJ: jPage.pageIndex, yJ: refJ.at.y,
        perp: r.perp, dFt: r.dFt, precise: true, along: undefined, alongPrecise: false,
        loDelta: r.loDelta, hiDelta: r.hiDelta, crI: r.crI, crJ: r.crJ,
        strokeI: r.siCross, strokeJ: r.sjCross,
      };
    };

    /**
     * Run `probe` over `starts` (strip origins, in scan order) in chunks of
     * `OCR_CHUNK` and return the FIRST hit — first meaning LOWEST strip index, which
     * is exactly what the old strip-at-a-time loop returned.
     *
     * Why it is still the same answer: chunks are consumed in order, and a chunk's
     * results are walked in INDEX order, so the winner is the globally lowest index
     * that hits. Chunks are only ISSUED until one hits, so the scan still stops
     * early — it just overshoots by at most `OCR_CHUNK - 1` strips instead of
     * stopping dead. That overshoot is the whole trade: those strips would otherwise
     * have been OCR'd one at a time behind an idle pool.
     *
     * `allSettled`, not `all`, and the walk is by index for the same two reasons.
     * The old loop rendered strip k+1 only once strip k had missed, so (a) a throw
     * on a LATER strip could not exist at all once an earlier one had hit — with
     * `all`, one such throw sank the whole chunk and, since nothing catches
     * `searchReciprocal`, the whole run; and (b) any error it did raise was always
     * the lowest-index one, where `all` surfaces whichever rejected FIRST in time.
     * So: return the first fulfilled non-null result, and rethrow a rejection only
     * when it is reached before any hit.
     *
     * `probe` rasters synchronously before its first await (mupdf is not re-entrant,
     * and a chunk's strips must be rendered in index order on the way in), so a
     * chunk holds `OCR_CHUNK` strip rasters, each released when its probe returns —
     * plus, at the moment a non-answer is re-read, that strip's SECOND raster
     * (`readStrip` re-renders; the first is a husk by then, its buffer transferred).
     * The ceiling is therefore 2 × `OCR_CHUNK` rasters, and only in the pathological
     * case where every strip of a chunk blew its budget at once.
     *
     * AN UNKNOWN STRIP ENDS THE SCAN. The first-hit argument above rests on every
     * strip before the winner having been READ and missed; a strip whose read was
     * still a non-answer after its re-read was not read at all, so a hit found after
     * it is not "the lowest-index hit", it is "the lowest-index hit among the strips
     * that happened to answer this run". Taking it is exactly the flip this whole
     * change exists to stop: the same four sheets anchored on a different physical
     * matchline because one 20 s job budget expired. So the walk is in index order,
     * and the first `unknown` it reaches — before any hit — makes the whole scan
     * unknown. No further chunk is issued.
     */
    const scanStrips = async (
      starts: number[],
      probe: (start: number) => Promise<StripRead>,
    ): Promise<StripRead> => {
      for (let s = 0; s < starts.length; s += OCR_CHUNK) {
        // `allSettled` attaches its handlers synchronously to every promise in the
        // array, so no rejection here can ever go unobserved.
        const settled = await Promise.allSettled(starts.slice(s, s + OCR_CHUNK).map((start) => probe(start)));
        for (const r of settled) {
          if (r.status === "rejected") throw r.reason;
          if (r.value.kind === "unknown") return { kind: "unknown" };
          if (r.value.kind === "hit") return r.value;
        }
      }
      return { kind: "miss" };
    };

    /**
     * One strip read, and the ONE immediate re-read a non-answer earns.
     *
     * THE RE-READ RE-RENDERS THE CLIP, and it has to. Both production transports
     * TRANSFER the raster on the way out — `postMessage(…, [image.data.buffer])` in
     * the probe worker's `ocrViaMain`, and the conversion worker in `ocrService` —
     * so the moment a read is issued its `RawImage` is a husk with a detached
     * buffer. Handing that same object back would throw a DataCloneError up through
     * `scanStrips` (killing the whole probe), or, on the path that swallows it,
     * return `[]` with no `onNoResult` at all — a clean miss, which is the exact bug
     * this change exists to remove, wearing a disguise. Rendering again costs one
     * raster of one strip; the page handle is already open for the scan.
     *
     * The re-read is awaited inside the probe, so it goes out before the next CHUNK
     * is issued rather than after the whole scan. One is the whole budget: a second
     * expired job on the same crop is a crop this run is not going to read, and
     * spending 20 s more to learn that again is what made the probe feel broken.
     *
     * Returns null for "still a non-answer" — the strip is UNKNOWN, which is not the
     * `[]` a strip with no label in it returns.
     */
    const readStrip = async (image: RawImage, rerender: () => RawImage): Promise<OcrWord[] | null> => {
      let lost = false;
      const first = await ocr!(image, { onNoResult: () => { lost = true; } });
      if (!lost) return first;
      // No re-read after an abort: the answer would arrive for a run that has already
      // given up, and the strip is unknown either way.
      if (opts.shouldAbort?.()) return null;
      ocrStats.retries++;
      let lostAgain = false;
      const second = await ocr!(rerender(), { onNoResult: () => { lostAgain = true; } });
      return lostAgain ? null : second;
    };

    /**
     * Band-search page i's interior for the reciprocal "SEE SHEET <expected>"
     * label. A left/right ref on j drives a VERTICAL interior band scan on i (side
     * opposite the ref edge; text is vertical → OCR at rot 90/270, or at the ONE
     * rotation page i's edge bands already proved it reads at) and anchors dx.
     * A top/bottom ref drives a HORIZONTAL interior band scan (opposite half's
     * y-range; text is horizontal → no rotation) and anchors dy. Same world-line
     * reasoning either way: the two facing labels lie on the shared matchline, so
     * the offset on the perpendicular axis is d = FT(pos_i) - FT(pos_j).
     *
     * Strips go through `scanStrips` above: `OCR_CHUNK` at a time, lowest-index hit
     * wins, no further chunk issued once one has.
     */
    const searchReciprocal = async (iPage: PageRec, jPage: PageRec, refJ: SheetRef): Promise<RawAnchor | null> => {
      const [x0, y0, x1, y1] = iPage.extract.view;
      const W = x1 - x0, H = y1 - y0;
      // The reciprocal label may name j by printed NUMBER or by discipline CODE.
      const horiz = refJ.edge === "left" || refJ.edge === "right"; // vertical matchline → pins x
      // A ref that ORIGINATES on a split-page STRIP is the case the narrow one-sided
      // band gets wrong: the strip's neighbour carries its "SEE SHEET n" at the FAR
      // interior (opposite the half the row-seam geometry assumes — verified on
      // PG_SITE: p9/p10 carry "SEE SHEET 2" at their SOUTH matchline). For those we scan
      // i's FULL interior; the expected-number gate + abutment floor keep it safe. Every
      // other (whole-page) ref keeps the original targeted band so no resolved seam
      // shifts. Strip anchors also leave the ALONG axis FREE (the per-seam crossing
      // consensus aliases on the periodic module) for the joint sweep to resolve.
      const jStripFrames = stripFrames([...jPage.extract.shxLabels, ...jPage.extract.labels], jPage.extract.view) ?? [];
      const jIsStrip = jStripFrames.some((f) => f.bbox[0] <= refJ.at.x && refJ.at.x <= f.bbox[2] && f.bbox[1] <= refJ.at.y && refJ.at.y <= f.bbox[3]);
      const page = doc.loadPage(iPage.pageIndex);
      try {
        if (horiz) {
          // Region = the side of i OPPOSITE the ref's edge (whole-page ref), or i's FULL
          // interior for a strip ref (either side may carry the reciprocal label).
          const [rx0, rx1] = jIsStrip ? [x0 + 0.02 * W, x0 + 0.98 * W]
            : refJ.edge === "left" ? [x0 + 0.45 * W, x0 + 0.98 * W] : [x0 + 0.02 * W, x0 + 0.55 * W];
          // The text on these strips is the SAME vertical matchline text the edge-band
          // pass already read on this sheet, so when that pass LOCKED a rotation (see
          // `lockSideTextRot`) scan only that one and halve the reads. Both rotations
          // whenever it did not — the page took the no-OCR path, had no side bands, or
          // the evidence was too thin or too even to decide.
          //
          // This is the one narrowing in the scan that can change an ANSWER, and not
          // only by missing a label: if strip k matches solely at 90, a later strip m
          // matches solely at 270, and the lock says 270, the scan now returns m where
          // it used to return k — a different anchor, not a lost one. It is gated on
          // the lock needing real mass and a clear margin for exactly that reason, and
          // verified against the four eval sets' placements.
          const rots: readonly (90 | 270)[] = iPage.sideTextRot ? [iPage.sideTextRot] : [90, 270];
          const starts: number[] = [];
          for (let bx0 = rx0; bx0 < rx1; bx0 += 120) starts.push(bx0);
          const scan = await scanStrips(starts, async (bx0): Promise<StripRead> => {
            const bx1 = Math.min(bx0 + 160, rx1);
            const clip: [number, number, number, number] = [bx0, y0, bx1, y1];
            // Synchronous, and before this probe's first await: see `scanStrips`.
            const { image, scale: bandScale } = renderBand(mupdf, page, clip, 150);
            // Rotations stay strictly ordered and strictly sequential WITHIN a strip:
            // 90 first, 270 only if 90 found nothing — the old loop's order, and the
            // reason a strip costs one OCR call rather than two when 90 hits.
            for (const rot of rots) {
              const words = await readStrip(
                rotateRaw(image, rot),
                () => rotateRaw(renderBand(mupdf, page, clip, 150).image, rot),
              );
              // A rotation still lost after its re-read makes the whole STRIP unknown,
              // and the rotation after it is not read: what earns the 270 read is "90
              // found nothing", and a non-answer never said that.
              if (words == null) return { kind: "unknown" };
              const labels = wordsToLabels(words, { edge: "left", clip }, bandScale, image.width, image.height, rot);
              for (const lab of labels) {
                if (ocrRefNames(lab.text, jPage)) {
                  const cx = (lab.x + lab.endX) / 2, cy = (lab.y + lab.endY) / 2;
                  // i's reciprocal label is INTERIOR (no outer edge → strongest); j's is at refJ.edge.
                  const reg = seamRegister(iPage, cx, cy, jPage, refJ.at.x, refJ.at.y, "x");
                  return { kind: "hit", anchor: { pageI: iPage.pageIndex, yI: cy, pageJ: jPage.pageIndex, yJ: refJ.at.y, perp: "x",
                    dFt: reg.perpDelta ?? FT(cx, scaleOf(iPage.pageIndex)) - FT(refJ.at.x, scaleOf(jPage.pageIndex)), precise: reg.perpDelta != null,
                    along: jIsStrip ? undefined : (reg.along ?? undefined), alongPrecise: jIsStrip ? false : reg.along != null, loDelta: reg.loDelta ?? undefined, hiDelta: reg.hiDelta ?? undefined, crI: reg.crI, crJ: reg.crJ, strokeI: reg.strokeI ?? undefined, strokeJ: reg.strokeJ ?? undefined } };
                }
              }
            }
            return { kind: "miss" };
          });
          if (scan.kind === "hit") return scan.anchor;
          // Unknown claims NOTHING — the same as a miss, which is why it falls through
          // to the one-sided stroke anchor below exactly as a miss does. What it must
          // not do is pass for a clean "no reciprocal label on i", so it is counted:
          // the run's verdict now rests on a read that never happened, and the caller
          // is the one who decides whether to show a verdict like that.
          if (scan.kind === "unknown") ocrStats.unknown++;
        } else {
          // Top/bottom ref: horizontal matchline, horizontal text (no rotation). Ref on
          // j's top edge → i's matching label near i's south interior; bottom → north.
          // A strip ref scans i's FULL interior (either side may carry the label).
          const [ry0, ry1] = jIsStrip ? [y0 + 0.02 * H, y0 + 0.98 * H]
            : refJ.edge === "top" ? [y0 + 0.45 * H, y0 + 0.98 * H] : [y0 + 0.02 * H, y0 + 0.55 * H];
          const starts: number[] = [];
          for (let by0 = ry0; by0 < ry1; by0 += 120) starts.push(by0);
          // Horizontal text — one read per strip, so no rotation rule applies here;
          // the chunking is the only change.
          const scan = await scanStrips(starts, async (by0): Promise<StripRead> => {
            const by1 = Math.min(by0 + 160, ry1);
            const clip: [number, number, number, number] = [x0, by0, x1, by1];
            const { image, scale: bandScale } = renderBand(mupdf, page, clip, 150);
            const words = await readStrip(image, () => renderBand(mupdf, page, clip, 150).image);
            if (words == null) return { kind: "unknown" };
            const labels = wordsToLabels(words, { edge: "top", clip }, bandScale, image.width, image.height, 0);
            for (const lab of labels) {
              if (ocrRefNames(lab.text, jPage)) {
                const cx = (lab.x + lab.endX) / 2, cy = (lab.y + lab.endY) / 2;
                const reg = seamRegister(iPage, cy, cx, jPage, refJ.at.y, refJ.at.x, "y");
                return { kind: "hit", anchor: { pageI: iPage.pageIndex, yI: cy, pageJ: jPage.pageIndex, yJ: refJ.at.y, perp: "y",
                  dFt: reg.perpDelta ?? FT(cy, scaleOf(iPage.pageIndex)) - FT(refJ.at.y, scaleOf(jPage.pageIndex)), precise: reg.perpDelta != null,
                  along: jIsStrip ? undefined : (reg.along ?? undefined), alongPrecise: jIsStrip ? false : reg.along != null, loDelta: reg.loDelta ?? undefined, hiDelta: reg.hiDelta ?? undefined, crI: reg.crI, crJ: reg.crJ, strokeI: reg.strokeI ?? undefined, strokeJ: reg.strokeJ ?? undefined } };
              }
            }
            return { kind: "miss" };
          });
          if (scan.kind === "hit") return scan.anchor;
          if (scan.kind === "unknown") ocrStats.unknown++;   // see the vertical branch
        }
      } finally {
        page.destroy?.();
      }
      // No reciprocal label recovered on i → fall back to the one-sided STROKE anchor
      // for a strip ref (both sheets still DRAW the shared matchline; locate i's stroke
      // by its facing edge band, not by a label). Returns null when i has no such
      // matchline stroke, leaving behaviour unchanged for non-adjacent references.
      return oneSidedAnchor(iPage, jPage, refJ);
    };

    // ── MUTUAL facing edge refs: anchor directly, no OCR search ────────────────
    // When BOTH sheets carry the reciprocal edge label (common for top/bottom
    // matchlines, which sit at the page edge on both sheets — e.g. p4 top "SEE
    // SHEET 7" ↔ p7 bottom "SEE SHEET 4"), the two labels lie on the shared
    // matchline, so they anchor the perpendicular offset outright: dx for a left/
    // right (vertical-matchline) pair, dy for a top/bottom (horizontal-matchline)
    // pair. This is the reciprocal signal for pairs the interior OCR search skips
    // (it skips i when i already has the opposite-edge ref). Each unordered pair is
    // emitted once (guard jPage < iPage); a coarse label-position dy/dx is enough —
    // stitchSheets' ±30ft-equivalent windowed segment vote refines it in the true
    // basin, and a wrong sign simply yields no segment inliers (anchor dropped).
    for (const jPage of pages) {
      for (const r of edgeRefsOf(jPage)) {
        for (const iPage of refTargets(r)) {
          if (iPage.pageIndex >= jPage.pageIndex) continue; // emit each unordered pair once
          const ri = edgeRefsOf(iPage).find((x) => refNames(x, jPage) && x.edge === OPP[r.edge]);
          if (!ri) continue;
          const horiz = r.edge === "left" || r.edge === "right";
          if (horiz) {
            const reg = seamRegister(iPage, ri.at.x, ri.at.y, jPage, r.at.x, r.at.y, "x");
            rawAnchors.push({ pageI: iPage.pageIndex, yI: ri.at.y, pageJ: jPage.pageIndex, yJ: r.at.y, perp: "x",
              dFt: reg.perpDelta ?? FT(ri.at.x, scaleOf(iPage.pageIndex)) - FT(r.at.x, scaleOf(jPage.pageIndex)), precise: reg.perpDelta != null,
              along: reg.along ?? undefined, alongPrecise: reg.along != null, loDelta: reg.loDelta ?? undefined, hiDelta: reg.hiDelta ?? undefined, crI: reg.crI, crJ: reg.crJ, strokeI: reg.strokeI ?? undefined, strokeJ: reg.strokeJ ?? undefined });
          } else {
            const reg = seamRegister(iPage, ri.at.y, ri.at.x, jPage, r.at.y, r.at.x, "y");
            rawAnchors.push({ pageI: iPage.pageIndex, yI: ri.at.y, pageJ: jPage.pageIndex, yJ: r.at.y, perp: "y",
              dFt: reg.perpDelta ?? FT(ri.at.y, scaleOf(iPage.pageIndex)) - FT(r.at.y, scaleOf(jPage.pageIndex)), precise: reg.perpDelta != null,
              along: reg.along ?? undefined, alongPrecise: reg.along != null, loDelta: reg.loDelta ?? undefined, hiDelta: reg.hiDelta ?? undefined, crI: reg.crI, crJ: reg.crJ, strokeI: reg.strokeI ?? undefined, strokeJ: reg.strokeJ ?? undefined });
          }
        }
      }
    }

    let searched = 0;
    outer:
    for (const jPage of pages) {
      for (const r of edgeRefsOf(jPage)) {
        // Every physical edge drives a reciprocal search: left/right pins dx, top/
        // bottom pins dy. Both are one-sided (the referenced sheet's matching label
        // sits interior, outside every edge band) and need the targeted interior scan.
        if (r.edge !== "left" && r.edge !== "right" && r.edge !== "top" && r.edge !== "bottom") continue;
        for (const iPage of refTargets(r)) {
          if (iPage.pageIndex === jPage.pageIndex) continue;
          // Skip if i ALREADY has a reciprocal edge ref (opposite edge → j's #).
          if (edgeRefsOf(iPage).some((ri) => refNames(ri, jPage) && ri.edge === OPP[r.edge])) continue;
          // Prune raster/low-geometry pages here (unlike the OCR gate): the anchor
          // confirms via a vector segment vote, which a page with no geometry can't feed.
          if ((iPage.extract.geometry?.length ?? 0) < PLAN_GEOMETRY_MIN) continue;
          if (searched >= 16) break outer;
          checkAbort(); // per pair in the anchor-search pass
          searched++;
          const anchor = await searchReciprocal(iPage, jPage, r);
          if (anchor) rawAnchors.push(anchor);
        }
      }
    }
  }

  // ── PASS 3: unit construction ───────────────────────────────────────────────
  for (const p of pages) {
    // Two-strip detection from strip refs (recovered refs count). A matched
    // below/above pair splits the page; otherwise it is one whole-page unit.
    const frames: Frame[] = stripFrames([...p.extract.shxLabels, ...p.extract.labels], p.extract.view) ?? [];
    const w = p.extract.view[2] - p.extract.view[0];
    const h = p.extract.view[3] - p.extract.view[1];
    if (frames.length >= 2) {
      for (const f of frames.slice(0, 2)) {
        // A strip's extract is frame-LOCAL, so its drawing frame is recomputed in
        // those coordinates rather than inherited from the page.
        const ex = sliceExtract(p.extract, f);
        units.push({ pageIndex: p.pageIndex, frame: f, extract: ex, sizePt: { w, h }, scale: scaleOf(p.pageIndex), printedNo: p.printedNo, key: 0, drawingFrame: detectDrawingFrame(ex.geometry, ex.view), role: p.role, sheetCode: p.sheetCode, sheetCodeDropped: p.sheetCodeDropped });
      }
    } else {
      units.push({ pageIndex: p.pageIndex, frame: null, extract: p.extract, sizePt: { w, h }, scale: scaleOf(p.pageIndex), printedNo: p.printedNo, key: 0, drawingFrame: p.drawingFrame, role: p.role, sheetCode: p.sheetCode, sheetCodeDropped: p.sheetCodeDropped });
    }
  }

  if (!units.length) return { placements: [], rootFtPerIn: 0, alignedCount: 0, unplacedCount: 0, worstResidFt: 0, method: "none", poses: [], refPageIndices, skipped, scaleWarnings, ocrStats };

  // Unique numeric keys, stable order.
  units.forEach((u, i) => { u.key = i + 1; });
  // For a mixed-scale set, the reference is the first selected page's own scale.
  // Callers (AddPdfModal) sort the selection ascending before passing it in as
  // `pageIndices`, and units are built in that same order, so `units[0]` is always
  // that same lowest-page-index selection, making this deterministic across runs.
  const rootFtPerIn = units[0].scale;

  // Resolve each raw anchor's (pageIndex, labelY) endpoints to unit keys. On a
  // two-strip page the label's y selects the containing frame; single-unit pages
  // are trivial. Anchors whose endpoints collapse to one unit are dropped.
  const keyForLabel = (pageIndex: number, y: number): number | null => {
    const us = units.filter((u) => u.pageIndex === pageIndex);
    if (!us.length) return null;
    if (us.length === 1) return us[0].key;
    const hit = us.find((u) => u.frame && u.frame.bbox[1] <= y && y <= u.frame.bbox[3]);
    return (hit ?? us[0]).key;
  };
  const anchors: StitchAnchor[] = rawAnchors
    .map((a): StitchAnchor | null => {
      const ki = keyForLabel(a.pageI, a.yI), kj = keyForLabel(a.pageJ, a.yJ);
      if (ki == null || kj == null || ki === kj) return null;
      const common = {
        precise: a.precise, along: a.along, alongPrecise: a.alongPrecise,
        strokeLoDelta: a.loDelta, strokeHiDelta: a.hiDelta,
        crossI: a.crI, crossJ: a.crJ,
        strokeI: a.strokeI, strokeJ: a.strokeJ,
      };
      return a.perp === "y"
        ? { i: ki, j: kj, dy: a.dFt, perp: "y", ...common }
        : { i: ki, j: kj, dx: a.dFt, perp: "x", ...common };
    })
    .filter((a): a is StitchAnchor => a != null);

  let placementsByKey = new Map<number, { x: number; y: number }>();
  let worstResidFt = 0;
  let method: StitchMethod = "none";
  let seamReport: SeamReportEntry[] | undefined;
  let alignmentVerdict: AlignmentVerdict | undefined;
  let alongAnchored: number[] | undefined;
  let worstAlongUncertaintyFt: number | undefined;
  let worstAlongUncertaintySource: "sweep" | "vote" | "bound" | undefined;
  if (units.length >= 2) {
    const byPage = new Map<number, Unit[]>();
    for (const u of units) (byPage.get(u.pageIndex) || byPage.set(u.pageIndex, []).get(u.pageIndex)!).push(u);
    const inputs: SheetInput[] = units.map((u) => ({
      id: `p${u.pageIndex}f${u.frame ? "1" : "0"}k${u.key}`, no: u.key, scale: u.scale,
      view: u.extract.view, extract: u.extract,
      printedNo: u.printedNo, pageIndex: u.pageIndex,
      siblingKey: byPage.get(u.pageIndex)!.find((o) => o.key !== u.key)?.key,
      frame: u.frame?.bbox, drawingFrame: u.drawingFrame, role: u.role, sheetCode: u.sheetCode, sheetCodeDropped: u.sheetCodeDropped,
    }));
    // Key-map site grid (whole-page sets only; stitchSheets ignores it when
    // any page produced two units). Grid is keyed by unit key here.
    let grid: Map<number, { col: number; row: number }> | undefined;
    try {
      const byPageGrid = detectKeymapGrid(mupdf, doc, pageIndices);
      if (byPageGrid) {
        grid = new Map();
        for (const u of units) { const g = byPageGrid.get(u.pageIndex); if (g) grid.set(u.key, g); }
        if (grid.size < 2) grid = undefined;
      }
    } catch (e) {
      console.warn("[autoStitch] key-map detection failed:", e);
    }
    const res = stitchSheets(inputs, grid, anchors);
    opts.onDebug?.({ anchors, result: res, inputs, unknownSheetNoPages: pages.filter((p) => p.unknownSheetNo).map((p) => p.pageIndex) });
    placementsByKey = res.placements;
    worstResidFt = res.worstResidFt;
    method = res.method;
    seamReport = res.seamReport;
    alignmentVerdict = res.alignmentVerdict;
    alongAnchored = res.alongAnchored;
    worstAlongUncertaintyFt = res.worstAlongUncertaintyFt;
    worstAlongUncertaintySource = res.worstAlongUncertaintySource;
  }

  // Per-unit poses for placed units; ONE whole-page null pose per fully-unplaced page.
  const poses: PlacedSheetPose[] = [];
  const pagesEmitted = new Set<number>();
  for (const u of units) {
    const pos = placementsByKey.get(u.key) ?? null;
    if (pos) {
      poses.push({ pageIndex: u.pageIndex, scale: u.scale, sizePt: u.sizePt, posFt: pos, frame: u.frame?.bbox });
      pagesEmitted.add(u.pageIndex);
    }
  }
  for (const u of units) {
    if (pagesEmitted.has(u.pageIndex)) continue;
    pagesEmitted.add(u.pageIndex);
    poses.push({ pageIndex: u.pageIndex, scale: u.scale, sizePt: u.sizePt, posFt: null });
  }

  const placements = layoutPlacements(poses, rootFtPerIn);
  const alignedCount = placements.filter((p) => p.aligned).length;
  return { placements, rootFtPerIn, alignedCount, unplacedCount: placements.length - alignedCount, worstResidFt, method, poses, refPageIndices, seamReport, alignmentVerdict, alongAnchored, worstAlongUncertaintyFt, worstAlongUncertaintySource, skipped, scaleWarnings, ocrStats };
}
