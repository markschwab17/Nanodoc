import { describe, expect, test } from "vitest";
import {
  SESSION_SOURCE_DOC_TYPE,
  STITCH_SESSION_LOST,
  isStitchSessionLost,
  stitchHandoffRecovery,
  sessionSourceLabel,
  withSessionSource,
  type CtoDocLike,
} from "./ctoSessionSource";

const realDoc: CtoDocLike = { type: "pdf", displayName: "Grading Plan.pdf", token: "tok-1" };

describe("withSessionSource", () => {
  test("prepends the session entry when a session source is present", () => {
    const session = { pdfBytes: new Uint8Array([1, 2, 3]), fileName: "Site sheet source 2089769e.pdf" };
    const result = withSessionSource([realDoc], session);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe(SESSION_SOURCE_DOC_TYPE);
    expect(result[0].displayName).toBe(sessionSourceLabel(session.fileName));
    expect(result[1]).toBe(realDoc);
  });

  test("returns the list unchanged (same reference) when no session source is present", () => {
    const list = [realDoc];
    expect(withSessionSource(list, null)).toBe(list);
    expect(withSessionSource(list, undefined)).toBe(list);
  });

  test("works against an empty list, producing only the session entry", () => {
    const session = { pdfBytes: new Uint8Array(), fileName: "Site sheet source abc.pdf" };
    const result = withSessionSource<CtoDocLike>([], session);
    expect(result).toHaveLength(1);
    expect(result[0].displayName).toContain("Selected takeoff sheets");
  });
});

describe("isStitchSessionLost", () => {
  const base = { embed: true, hasInitial: false, tileCount: 0, busy: false };

  test("is true when the embedded iframe reloaded: no handoff, no sheets, nothing running", () => {
    expect(isStitchSessionLost(base)).toBe(true);
    expect(STITCH_SESSION_LOST).toBe("Session lost — close this window and reopen from Pursuit.");
  });

  test("is false outside the embed — the standalone hero is exactly right there", () => {
    expect(isStitchSessionLost({ ...base, embed: false })).toBe(false);
  });

  test("is false while the handoff is being processed", () => {
    expect(isStitchSessionLost({ ...base, hasInitial: true })).toBe(false);
    expect(isStitchSessionLost({ ...base, busy: true })).toBe(false);
  });

  test("is false once there are sheets on the canvas", () => {
    expect(isStitchSessionLost({ ...base, tileCount: 3 })).toBe(false);
  });
});

describe("stitchHandoffRecovery", () => {
  const full = "?project=p1&doc=d1&token=t1&stitch=1&embed=1";

  test("recovers when the URL still carries everything the fetch needs", () => {
    const out = stitchHandoffRecovery(full);
    expect(out).not.toBeNull();
    expect(out!.search).toContain("project=p1");
    expect(out!.search).toContain("token=t1");
    expect(out!.search).toContain("embed=1");
  });

  test("does not recover a URL that was never a stitch open", () => {
    expect(stitchHandoffRecovery("?project=p1&doc=d1&token=t1")).toBeNull();
  });

  test("does not recover without the credentials the fetch needs", () => {
    expect(stitchHandoffRecovery("?stitch=1&project=p1&doc=d1")).toBeNull();
    expect(stitchHandoffRecovery("?stitch=1")).toBeNull();
    expect(stitchHandoffRecovery("")).toBeNull();
  });
});
