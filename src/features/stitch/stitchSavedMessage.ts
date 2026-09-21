/**
 * The `nanodoc-stitch-saved` message — built from CTO's save response.
 *
 * CTO's takeoff panel listens for this to know a site sheet landed (it parses it in
 * `src/lib/takeoff-v2/site-sheet/messages.ts`): `pageUuid` tells it which page to
 * refresh onto, and `documentFileId` — new — is the id of the stitched PDF's copy in
 * the project's Documents. That copy is BEST-EFFORT on the server: `commit-save`
 * returns the field only when the copy actually landed, and CTO's toast appends
 * "· PDF copy in Documents" on the same condition. So the field is forwarded when
 * present and OMITTED when not — never `null`, never an empty string, because
 * "absent" is what CTO reads as "no copy was made", and a present-but-empty value
 * would have it promise a file that isn't there.
 *
 * Pure, so the field's presence can be tested without a save.
 */

export type StitchSaveDestination = "overwrite" | "new_file" | "project_page";

export interface StitchSavedMessage {
  type: "nanodoc-stitch-saved";
  success: true;
  destination: StitchSaveDestination;
  manifest: unknown;
  /** Null when the response carried none (an overwrite, or an older CTO). */
  pageUuid: string | null;
  documentFileId?: string;
}

/** A non-empty string field, or undefined. The response is JSON off the wire. */
function str(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function buildStitchSavedMessage(args: {
  destination: StitchSaveDestination;
  manifest: unknown;
  /** The parsed JSON body of CTO's save response, or null when it had none. */
  response: unknown;
}): StitchSavedMessage {
  const { destination, manifest, response } = args;
  const documentFileId = str(response, "documentFileId");
  return {
    type: "nanodoc-stitch-saved",
    success: true,
    destination,
    manifest,
    pageUuid: str(response, "pageUuid") ?? null,
    ...(documentFileId && { documentFileId }),
  };
}
