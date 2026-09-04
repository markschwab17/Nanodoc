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
