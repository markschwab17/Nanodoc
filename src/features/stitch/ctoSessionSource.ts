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
