import { describe, expect, test, beforeEach } from "vitest";
import { parseUrlTheme, applyUrlTheme } from "./urlTheme";

describe("parseUrlTheme", () => {
  test("reads dark and light", () => {
    expect(parseUrlTheme("?theme=dark")).toBe("dark");
    expect(parseUrlTheme("?theme=light")).toBe("light");
  });

  test("anything else is null (host said nothing)", () => {
    expect(parseUrlTheme("")).toBeNull();
    expect(parseUrlTheme("?embed=1")).toBeNull();
    expect(parseUrlTheme("?theme=")).toBeNull();
    expect(parseUrlTheme("?theme=DARK")).toBeNull();
    expect(parseUrlTheme("?theme=solarized")).toBeNull();
  });
});

describe("applyUrlTheme", () => {
  beforeEach(() => {
    document.documentElement.classList.remove("dark");
  });

  test("theme=dark adds .dark to <html>", () => {
    expect(applyUrlTheme("?theme=dark")).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  test("theme=light removes .dark", () => {
    document.documentElement.classList.add("dark");
    expect(applyUrlTheme("?theme=light")).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  test("no theme param leaves the applied theme alone", () => {
    document.documentElement.classList.add("dark");
    expect(applyUrlTheme("?embed=1")).toBeNull();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
