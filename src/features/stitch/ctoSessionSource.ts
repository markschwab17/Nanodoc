/**
 * The "session source" is the initial PDF a Civiltakeoff takeoff panel hands to
 * stitch mode (the "site sheet source" built from the user's selected takeoff
 * sheets). It's consumed once via `useCtoStitchInitialStore.takeInitial()` to
 * open the Add-pages modal, but the user may then switch to the "From
 * Civiltakeoff" tab and load a different project document — at which point the
 * initial PDF would otherwise be gone for good.
 *
 * `withSessionSource` prepends a synthetic entry representing that retained
 * PDF to a From-Civiltakeoff document list, so it stays choosable for the life
 * of the stitch session without ever being sent to the CTO document-list
 * request (it's purely local).
 */

export type CtoDocLike = { type: string; displayName: string; token: string };

export type SessionSourcePdf = { pdfBytes: Uint8Array; fileName: string };

/** Sentinel `type` used to mark the synthetic session-source entry so callers
 *  can distinguish it from a real CTO document (which always carries a token
 *  usable against the CTO document-fetch endpoint). */
export const SESSION_SOURCE_DOC_TYPE = "session-source";

/** Marker suffix appended to the session source's file name in its list label. */
export const SESSION_SOURCE_HINT = "Selected takeoff sheets";

/** Build the label shown for the session-source list entry. */
export function sessionSourceLabel(fileName: string): string {
  return `${fileName} — ${SESSION_SOURCE_HINT}`;
}

/** Prepend a synthetic entry for `session` (when present) to `list`. Does not
 *  mutate `list`. When `session` is absent, returns `list` unchanged (by
 *  reference) so callers can rely on referential equality when nothing changed. */
export function withSessionSource<T extends CtoDocLike>(
  list: T[],
  session: SessionSourcePdf | null | undefined
): T[] {
  if (!session) return list;
  const entry = {
    type: SESSION_SOURCE_DOC_TYPE,
    displayName: sessionSourceLabel(session.fileName),
    token: "",
  } as T;
  return [entry, ...list];
}

/** Copy for the reloaded-iframe case. */
export const STITCH_SESSION_LOST =
  "Session lost — close this window and reopen from Pursuit.";

/**
 * Has the embedded session lost its handoff?
 *
 * The takeoff panel hands the source PDF over in memory (`ctoStitchInitialStore`), so
 * reloading the iframe — a browser refresh, a devtools reload, an errored frame
 * recovering — leaves stitch running inside CTO with no source, no plan and no sheets.
 * What it showed then was the marketing hero ("Stitch PDFs Together… Add PDF"), which
 * invites the user to start a standalone session that CTO can never save back.
 *
 * True only in the embed, only when nothing arrived AND nothing is on the canvas AND
 * nothing is in flight — outside the embed the hero is exactly right, and mid-commit
 * the canvas is about to fill.
 */
export function isStitchSessionLost(opts: {
  embed: boolean;
  /** An initial handoff was present on this mount. */
  hasInitial: boolean;
  tileCount: number;
  /** A plan commit is running, or the page picker is open. */
  busy: boolean;
}): boolean {
  return opts.embed && !opts.hasInitial && opts.tileCount === 0 && !opts.busy;
}

/**
 * Can a stitch session that lost its in-memory handoff recover from the URL?
 *
 * The takeoff panel hands the PDF over in memory and then navigates to `/stitch`. A
 * reload of that page has no handoff — but if the CTO parameters are still on the URL,
 * the document can simply be fetched again: `/view` owns that fetch, so the recovery is
 * to bounce back through it and let it hand over and navigate here a second time.
 *
 * Pure so the condition is testable: everything it needs is in the query string.
 */
export function stitchHandoffRecovery(search: string): { search: string } | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }
  // The same three the fetch needs, plus the flag that says this was a stitch open.
  const enough =
    params.get("stitch") === "1" &&
    !!params.get("project") &&
    !!params.get("doc") &&
    !!params.get("token");
  return enough ? { search: params.toString() } : null;
}

// ─── the server-computed auto-align verdict ──────────────────────────────────
//
// CTO combines the selected sheets into one PDF and, on the droplet, hands that PDF
// and the stitch plan to a Lambda running THIS repo's engine bundle. The verdict lands
// on `site_sheet_sources.probe` and travels here next to the plan
// (`GET /api/nanodoc/pdf` → `probe`), with `GET /api/nanodoc/probe?token=` to re-read a
// row that was still computing when the editor opened.
//
// Everything below is the editor's half of ONE rule: a server verdict is usable only
// when it answers the SAME question this build's browser probe would have asked. Same
// engine commit, same plan, same page set. Anything else — an older row, a different
// build, a plan edited since, a canvas that has moved — is not a verdict at all, and
// the browser probe runs exactly as it does today. Never a gate, only a shortcut.

/** The inputs a probe ran with. Compared field-for-field against `canvasProbeSet`;
 *  the droplet derives it with `deriveProbeRequest` (a port of `parseStitchPlan` plus
 *  the commit's scale fill), which is what makes the two comparable at all. */
export interface ServerProbeRequest {
  pageIndices: number[];
  userScale: number | null;
  /** `[pageIndex, feetPerInch][]` — DENSE: the commit stamps a scale on every tile. */
  pageScales: Array<[number, number]>;
  /** `[pageIndex, sheetCode][]`, absent when the plan named none. */
  pageCodes?: Array<[number, string]> | null;
}

/** The stored `site_sheet_sources.probe` object, as the wire hands it over. Every
 *  field optional: this is untrusted JSON from a row a future droplet may extend. */
export interface ServerProbe {
  v?: number;
  engine?: string | null;
  status?: string;
  planHash?: string;
  request?: ServerProbeRequest | null;
  /** A `ProbeResult` when `status === 'ok'`. Left `unknown` here so this module stays
   *  free of the aligner's types; the hook narrows it. */
  result?: unknown;
  ocrStats?: { calls: number; nonAnswers: number; retries: number; unknown: number; withheldVotes: number } | null;
  ms?: number;
  computedAt?: string;
  error?: string;
  /** Pending rows only — how long the claim is believed. */
  ttlMs?: number;
  expiresAt?: string;
  startedAt?: string;
}

/** The shape of the stored object this build understands. Mirrors the droplet's
 *  `PROBE_VERSION`; a row stamped anything else is refused rather than guessed at. */
export const SERVER_PROBE_VERSION = 1;

/** What the editor should do about a stored verdict.
 *  - `use`  — it answers this canvas's question; take it and skip the worker.
 *  - `wait` — a probe is genuinely still running; poll before giving up on it.
 *  - `none` — no verdict here. Run the browser probe, as always. */
export type ServerProbeVerdict = "use" | "wait" | "none";

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `sha256(JSON.stringify(plan))`, hex — the third implementation of the dullest hash
 * that could work (CTO's `src/lib/site-sheet/plan-hash.ts` and the droplet's
 * `plan-hash.js` are the other two). Deliberately NOT canonical JSON: all three hash
 * the object `JSON.parse`d out of the same `site_sheet_sources.plan` jsonb, so the key
 * order is byte-for-byte identical, and anything smarter is a third place the three can
 * silently diverge.
 *
 * `null` — never a throw and never a hash of nothing — for a plan that will not
 * serialise, and for an environment with no `crypto.subtle` (an insecure origin). A
 * null hash matches no verdict, so the browser probe runs: failing closed is the only
 * safe reading of "I cannot bind this verdict to a plan".
 */
export async function planHashHex(plan: unknown): Promise<string | null> {
  let json: string | undefined;
  try {
    json = JSON.stringify(plan);
  } catch {
    return null;
  }
  if (typeof json !== "string") return null;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(json));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/** Floating-point equality for a scale that made a round trip through JSON. The two
 *  sides read the same numbers out of the same plan, so this is a guard against
 *  serialisation noise, not a tolerance anybody is meant to rely on. */
const SCALE_EPSILON = 1e-9;
const sameScale = (a: number | null, b: number | null): boolean =>
  a == null || b == null ? a == null && b == null : Math.abs(a - b) <= SCALE_EPSILON;

const sortedPairs = <T,>(pairs: Iterable<[number, T]>): Array<[number, T]> =>
  [...pairs].sort((x, y) => x[0] - y[0]);

/**
 * Did the stored probe ask the question this canvas is asking?
 *
 * `pageIndices` and `pageCodes` must be equal outright; scales are compared to
 * `SCALE_EPSILON`. `pageCodes` is normalised (`?? []` on both sides) because "the plan
 * named no sheet codes" reaches the two sides as an absent field and as an empty map —
 * and it IS compared, because a probe that knew the sheet numbers and one that had to
 * OCR them out of a title block can reach different answers about the same pages.
 */
export function serverProbeRequestMatches(
  request: ServerProbeRequest | null | undefined,
  canvas: {
    pageIndices: readonly number[];
    uniformScale: number | null;
    pageScales: ReadonlyMap<number, number>;
  },
  pageCodes?: ReadonlyMap<number, string> | null,
): boolean {
  if (!isPlainRecord(request)) return false;
  if (!Array.isArray(request.pageIndices) || !Array.isArray(request.pageScales)) return false;

  if (request.pageIndices.length !== canvas.pageIndices.length) return false;
  if (!request.pageIndices.every((i, n) => i === canvas.pageIndices[n])) return false;

  const wantScale = typeof request.userScale === "number" ? request.userScale : null;
  if (!sameScale(wantScale, canvas.uniformScale)) return false;

  const theirs = sortedPairs(request.pageScales as Array<[number, number]>);
  const ours = sortedPairs(canvas.pageScales);
  if (theirs.length !== ours.length) return false;
  if (!theirs.every(([i, s], n) => i === ours[n][0] && sameScale(s, ours[n][1]))) return false;

  const theirCodes = sortedPairs((request.pageCodes ?? []) as Array<[number, string]>);
  const ourCodes = sortedPairs(pageCodes ?? new Map<number, string>());
  if (theirCodes.length !== ourCodes.length) return false;
  if (!theirCodes.every(([i, c], n) => i === ourCodes[n][0] && c === ourCodes[n][1])) return false;

  return true;
}

/**
 * Is a `pending` row a probe that is still running, or one whose job died?
 *
 * The droplet writes `expiresAt` (and `startedAt` + `ttlMs`) precisely so a reader need
 * not know its constants. A pending row past its expiry is a droplet task that fell
 * over mid-job — the editor must treat it as no verdict at all rather than sit on a
 * spinner waiting for a Lambda nobody is running. A row carrying neither clock cannot
 * be believed either, so it expires immediately.
 */
export function isServerProbePending(probe: ServerProbe, nowMs: number): boolean {
  const explicit = Date.parse(probe.expiresAt ?? "");
  if (Number.isFinite(explicit)) return explicit > nowMs;
  const started = Date.parse(probe.startedAt ?? "");
  const ttl = typeof probe.ttlMs === "number" && Number.isFinite(probe.ttlMs) ? probe.ttlMs : null;
  if (!Number.isFinite(started) || ttl == null) return false;
  return started + ttl > nowMs;
}

/**
 * Everything the gate can decide WITHOUT the plan hash.
 *
 * Split out because the hash is the one asynchronous part of the rule (`crypto.subtle`),
 * and two callers need the synchronous half on its own: `classifyServerProbe` (which
 * adds the hash) and `serverProbeMayBeUsable` (which uses it to decide whether a row is
 * worth waiting one turn for before starting a worker it would immediately abort).
 */
function usableApartFromPlan(
  row: ServerProbe,
  engineVersion: string,
  canvas: { pageIndices: readonly number[]; uniformScale: number | null; pageScales: ReadonlyMap<number, number> },
  pageCodes: ReadonlyMap<number, string> | null | undefined,
): boolean {
  // `unknown` (the probe answered on evidence with a hole in it), `timeout`, `error`,
  // and anything a future droplet invents: not a verdict, and never presented as one.
  if (row.status !== "ok") return false;
  if (typeof row.engine !== "string" || row.engine !== engineVersion) return false;
  if (!isPlainRecord(row.result) || !Array.isArray((row.result as { placements?: unknown }).placements)) {
    return false;
  }
  if (!serverProbeRequestMatches(row.request, canvas, pageCodes)) return false;
  // NEVER A VERDICT ON UNKNOWN EVIDENCE — enforced here as well as on the droplet.
  //
  // The Lambda already stores an evidence-holed run as `status: 'unknown'`, so this
  // should be unreachable. It is checked anyway because it is the ONE rule the browser
  // enforces on its own replies (`useEarnedAutoAlign` re-checks, then refuses), and a
  // rule that lives only in the writer is a rule one droplet deploy can lose. A reply
  // whose counters say a read never came back is exactly the reply that makes two
  // probes of the same sheets disagree, whichever machine produced it.
  if ((row.ocrStats?.unknown ?? 0) > 0) return false;
  return true;
}

/**
 * Could this stored row be usable, once its plan hash is confirmed?
 *
 * The editor now starts its browser probe IMMEDIATELY and races the server, because in
 * production the verdict is minutes away and a check that waits for it is a check that
 * waits for nothing. The one case that should not pay for a worker is the reopen: a row
 * that is already a finished verdict for this build and this page set, where the only
 * thing left to check is the hash. This predicate spots that case synchronously, so the
 * caller can spend ONE turn on `planHashHex` before deciding — rather than constructing
 * a worker, posting to it, and aborting it a microtask later.
 *
 * Never a substitute for `classifyServerProbe`: a row can pass this and still be for
 * another plan. It only says "worth confirming".
 */
export function serverProbeMayBeUsable(opts: {
  probe: unknown;
  engineVersion: string;
  canvas: { pageIndices: readonly number[]; uniformScale: number | null; pageScales: ReadonlyMap<number, number> };
  pageCodes?: ReadonlyMap<number, string> | null;
}): boolean {
  if (!isPlainRecord(opts.probe)) return false;
  const row = opts.probe as ServerProbe;
  if (row.v !== SERVER_PROBE_VERSION) return false;
  return usableApartFromPlan(row, opts.engineVersion, opts.canvas, opts.pageCodes);
}

/**
 * Is there any point polling this row again?
 *
 * `false` while the answer could still change: no row at all (the droplet has not
 * claimed it yet — the editor opens about a second after the combine kicks the job, so
 * this is the NORMAL first read), or a `pending` claim. `true` once the row holds a
 * final answer, is a shape this build will never use, or names a different plan — three
 * ways of saying that every later read returns the same thing.
 *
 * An EXPIRED pending is deliberately not exhausted: the droplet's claim predicate lets a
 * later request rescue a row whose job died, so the answer can still change.
 */
export function serverPollIsExhausted(probe: unknown, planHash: string | null): boolean {
  if (!isPlainRecord(probe)) return false;
  const row = probe as ServerProbe;
  if (row.v !== SERVER_PROBE_VERSION) return true;
  if (typeof row.planHash === "string" && planHash != null && row.planHash !== planHash) return true;
  return row.status !== "pending";
}

/**
 * The whole gate, as one pure decision.
 *
 * `planHash` is what the editor computed for the plan it loaded (`planHashHex`); `null`
 * means it could not compute one, which is a mismatch like any other. `engineVersion`
 * is this build's `ENGINE_VERSION`.
 *
 * Note what is NOT here: whether the canvas has moved since the check. That needs the
 * store, so the hook applies `movedSinceCheck` on top — a verdict's placements are
 * ABSOLUTE, and one taken over a canvas the user has since dragged would throw their
 * work away exactly as a stale browser probe would.
 */
export function classifyServerProbe(opts: {
  probe: unknown;
  engineVersion: string;
  planHash: string | null;
  canvas: {
    pageIndices: readonly number[];
    uniformScale: number | null;
    pageScales: ReadonlyMap<number, number>;
  };
  pageCodes?: ReadonlyMap<number, string> | null;
  nowMs: number;
}): ServerProbeVerdict {
  const { probe, engineVersion, planHash, canvas, pageCodes, nowMs } = opts;
  if (!isPlainRecord(probe)) return "none";
  const row = probe as ServerProbe;
  // A version this build does not know is refused outright — including for the pending
  // wait, because "pending" only means what this build thinks it means at v1.
  if (row.v !== SERVER_PROBE_VERSION) return "none";

  if (row.status === "pending") {
    // A pending row already carries the hash of the plan it is being computed for. If
    // that is not OUR plan, waiting twenty seconds to discover so is pure cost. A row
    // with no hash yet is given the benefit of the doubt.
    if (typeof row.planHash === "string" && row.planHash !== planHash) return "none";
    return isServerProbePending(row, nowMs) ? "wait" : "none";
  }

  if (typeof planHash !== "string" || row.planHash !== planHash) return "none";
  return usableApartFromPlan(row, engineVersion, canvas, pageCodes) ? "use" : "none";
}

/**
 * `GET /api/nanodoc/probe?token=…` for this session, or null when the session has no
 * usable credential.
 *
 * Deliberately the SAME token as the PDF fetch: the endpoint verifies it the same way,
 * and anyone holding it can already fetch the document the verdict is about. Null when
 * either half is missing, which the caller reads as "a pending row cannot be polled" —
 * so the editor stops waiting on it and probes in the browser.
 */
export function ctoProbeUrl(ctx: { api_origin?: string | null; token?: string | null } | null | undefined): string | null {
  const origin = ctx?.api_origin?.replace(/\/+$/, "");
  const token = ctx?.token;
  if (!origin || !token) return null;
  return `${origin}/api/nanodoc/probe?token=${encodeURIComponent(token)}`;
}
