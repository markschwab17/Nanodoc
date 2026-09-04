import { describe, it, expect } from "vitest";
import { parseCiviltakeoffViewParams, displayNameFor } from "./civiltakeoffViewParams";

describe("parseCiviltakeoffViewParams — embed", () => {
  it("is null when the embed param is absent", () => {
    const params = parseCiviltakeoffViewParams("?project=p1&doc=document_file&token=t1");
    expect(params.embed).toBeNull();
  });

  it("is '1' when embed=1 is present (Phase 1 iframe hosting)", () => {
    const params = parseCiviltakeoffViewParams("?project=p1&doc=document_file&token=t1&embed=1");
    expect(params.embed).toBe("1");
  });

  it("carries through any other value verbatim (raw string, not coerced to boolean)", () => {
    const params = parseCiviltakeoffViewParams("?embed=0");
    expect(params.embed).toBe("0");
  });
});

describe("displayNameFor", () => {
  it("uses file_name for doc=document_file, adding .pdf when missing", () => {
    const params = parseCiviltakeoffViewParams("?doc=document_file&file_name=Site+Plan");
    expect(displayNameFor(params)).toBe("Site Plan.pdf");
  });

  it("uses file_name for doc=document_file verbatim when already .pdf (case-insensitive)", () => {
    const params = parseCiviltakeoffViewParams("?doc=document_file&file_name=Sheet.PDF");
    expect(displayNameFor(params)).toBe("Sheet.PDF");
  });

  it("uses file_name for doc=site_sheet_source, adding .pdf when missing", () => {
    const params = parseCiviltakeoffViewParams("?doc=site_sheet_source&file_name=C-101+Site+Plan");
    expect(displayNameFor(params)).toBe("C-101 Site Plan.pdf");
  });

  it("falls back to document.pdf for site_sheet_source when file_name is blank", () => {
    const params = parseCiviltakeoffViewParams("?doc=site_sheet_source");
    expect(displayNameFor(params)).toBe("document.pdf");
  });

  it("falls back to document.pdf for document_file when file_name is blank", () => {
    const params = parseCiviltakeoffViewParams("?doc=document_file");
    expect(displayNameFor(params)).toBe("document.pdf");
  });

  it("uses the fixed name for soils_report regardless of file_name", () => {
    const params = parseCiviltakeoffViewParams("?doc=soils_report&file_name=ignored");
    expect(displayNameFor(params)).toBe("soils_report.pdf");
  });

  it("uses the fixed name for bid_docs regardless of file_name", () => {
    const params = parseCiviltakeoffViewParams("?doc=bid_docs&file_name=ignored");
    expect(displayNameFor(params)).toBe("bid_docs.pdf");
  });

  it("falls back to document.pdf for an unrecognized doc type", () => {
    const params = parseCiviltakeoffViewParams("?doc=something_else&file_name=ignored");
    expect(displayNameFor(params)).toBe("document.pdf");
  });
});
