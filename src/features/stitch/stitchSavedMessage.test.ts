/**
 * What CTO is told when a stitch save lands. The rule that matters: `documentFileId`
 * is forwarded when the server made a Documents copy and is ABSENT when it did not —
 * CTO reads its presence as "the copy exists" and says so in its toast.
 */
import { describe, it, expect } from "vitest";
import { buildStitchSavedMessage } from "./stitchSavedMessage";

const manifest = { tiles: [] };

describe("buildStitchSavedMessage", () => {
  it("forwards documentFileId when the save response carried one", () => {
    const msg = buildStitchSavedMessage({
      destination: "project_page",
      manifest,
      response: { ok: true, pageUuid: "page-1", documentFileId: "doc-9" },
    });
    expect(msg).toEqual({
      type: "nanodoc-stitch-saved",
      success: true,
      destination: "project_page",
      manifest,
      pageUuid: "page-1",
      documentFileId: "doc-9",
    });
  });

  it("OMITS the key entirely when the copy did not land", () => {
    const msg = buildStitchSavedMessage({
      destination: "project_page",
      manifest,
      response: { ok: true, pageUuid: "page-1" },
    });
    expect(msg.pageUuid).toBe("page-1");
    expect("documentFileId" in msg).toBe(false);
  });

  it("treats a null/empty/non-string documentFileId as absent, never as an id", () => {
    // A present-but-empty value would have CTO promise a file that isn't there.
    for (const documentFileId of [null, "", 7, {}]) {
      const msg = buildStitchSavedMessage({
        destination: "project_page",
        manifest,
        response: { pageUuid: "p", documentFileId },
      });
      expect("documentFileId" in msg).toBe(false);
    }
  });

  it("pageUuid is null when the response has none — an overwrite, or an older CTO", () => {
    expect(buildStitchSavedMessage({ destination: "overwrite", manifest, response: { ok: true } }).pageUuid).toBeNull();
    expect(buildStitchSavedMessage({ destination: "overwrite", manifest, response: null }).pageUuid).toBeNull();
  });

  it("survives a response that is not an object at all", () => {
    const msg = buildStitchSavedMessage({ destination: "new_file", manifest, response: "not json" });
    expect(msg).toEqual({
      type: "nanodoc-stitch-saved",
      success: true,
      destination: "new_file",
      manifest,
      pageUuid: null,
    });
  });
});
