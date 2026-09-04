import { describe, it, expect } from "vitest";
import { parseCiviltakeoffViewParams } from "./civiltakeoffViewParams";

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
