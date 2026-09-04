import { describe, it, expect, vi } from "vitest";
import { resolveCtoTarget, postToCto } from "./ctoBridge";

describe("resolveCtoTarget", () => {
  it("returns parent when framed (parent differs from self)", () => {
    const self = {} as Window;
    const parent = {} as Window;
    const opener = {} as Window;
    expect(resolveCtoTarget({ parent, opener, self })).toBe(parent);
  });

  it("falls back to opener when not framed (parent === self, e.g. a popup)", () => {
    const self = {} as Window;
    const opener = {} as Window;
    expect(resolveCtoTarget({ parent: self, opener, self })).toBe(opener);
  });

  it("returns null when neither framed nor a popup", () => {
    const self = {} as Window;
    expect(resolveCtoTarget({ parent: self, opener: null, self })).toBeNull();
  });

  it("prefers parent over opener when both are present", () => {
    const self = {} as Window;
    const parent = {} as Window;
    const opener = {} as Window;
    expect(resolveCtoTarget({ parent, opener, self })).toBe(parent);
  });
});

describe("postToCto", () => {
  it("no-ops when there is no parent frame and no opener", () => {
    // Top-level window: window.parent === window.self, window.opener is null in jsdom by default.
    expect(() => postToCto({ type: "nanodoc-stitch-cancel" })).not.toThrow();
  });

  it("posts to window.opener with the api_origin as target origin when present", () => {
    const postMessage = vi.fn();
    vi.stubGlobal("opener", { postMessage });
    try {
      postToCto({ type: "nanodoc-stitch-cancel" }, "https://app.vertigraph.com/");
      expect(postMessage).toHaveBeenCalledWith(
        { type: "nanodoc-stitch-cancel" },
        "https://app.vertigraph.com",
        undefined
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to '*' target origin when api_origin is malformed", () => {
    const postMessage = vi.fn();
    vi.stubGlobal("opener", { postMessage });
    try {
      postToCto({ type: "nanodoc-stitch-cancel" }, "not a url");
      expect(postMessage).toHaveBeenCalledWith({ type: "nanodoc-stitch-cancel" }, "*", undefined);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("swallows a postMessage throw (e.g. closed opener) instead of throwing", () => {
    vi.stubGlobal("opener", {
      postMessage: () => {
        throw new Error("window closed");
      },
    });
    try {
      expect(() => postToCto({ type: "nanodoc-stitch-cancel" }, "https://app.vertigraph.com")).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
