import { describe, expect, test } from "vitest";
import { SESSION_SOURCE_DOC_TYPE, sessionSourceLabel, withSessionSource, type CtoDocLike } from "./ctoSessionSource";

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
