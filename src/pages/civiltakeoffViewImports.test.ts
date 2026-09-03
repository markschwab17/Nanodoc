import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The CTO-embedded viewer must boot without the stitch feature. A static import of
 * anything under features/stitch (or the stitch store) pulls the stitch chunks into
 * the /view boot path; the Jul-2026 render stall coincided with exactly that.
 *
 * Note: resolving the sibling file via `new URL("./x", import.meta.url)` is intentionally
 * avoided here — Vite statically rewrites that exact pattern into an asset URL (pointing at
 * the dev server, not the filesystem), which breaks `readFileSync` under vitest. Going through
 * `fileURLToPath` + `path.join` sidesteps that transform.
 */
describe("CiviltakeoffView boot path", () => {
  test("has no static import of the stitch feature", () => {
    const here = fileURLToPath(import.meta.url);
    const target = path.join(path.dirname(here), "CiviltakeoffView.tsx");
    const src = readFileSync(target, "utf8");
    const staticImports = src
      .split("\n")
      .filter((l) => /^\s*import\s/.test(l))
      .filter((l) => /features\/stitch|stitchStore|ctoStitchInitialStore/.test(l));
    expect(staticImports).toEqual([]);
  });
});
