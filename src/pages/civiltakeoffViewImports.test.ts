import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The CTO-embedded viewer must boot without the stitch feature. A static import of
 * anything under features/stitch (or the stitch store) pulls the stitch chunks into
 * the /view boot path. This guard is insurance against that, not a diagnosis: the
 * Jul-2026 render stall's actual cause was never confirmed, and this check only
 * scans CiviltakeoffView.tsx itself — a static import IT adds is caught, but a
 * stitch import reached transitively through some other module it imports is not.
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

    // Match whole static import/re-export statements, not individual lines — a line-by-line
    // scan is blind to Prettier-wrapped multi-line imports like
    //   import {
    //     useCtoStitchInitialStore,
    //   } from "@/shared/stores/ctoStitchInitialStore";
    // where no single line matches both "starts with import" and "mentions the specifier".
    // Two patterns, not one: a lazy `[\s\S]*?from` would swallow forward past a
    // semicolon-less side-effect import (`import "./x";`, no `from`) looking for the
    // NEXT statement's `from`, silently merging two statements into one match and
    // potentially hiding a stitch import that sits between them. `[^;]*?from` stops at
    // the first semicolon so it can't cross statements, and side-effect imports (which
    // never have `from`) get their own pattern.
    // Dynamic `import(...)` calls are intentionally not matched by either pattern (they
    // don't start a line with the `import`/`export` keyword followed by whitespace
    // before the braces/specifier).
    const fromImportStatements =
      src.match(/^\s*(?:import|export)\s[^;]*?\sfrom\s*["'][^"']+["']\s*;?/gm) ?? [];
    const sideEffectImportStatements =
      src.match(/^\s*import\s*["'][^"']+["']\s*;?/gm) ?? [];
    const staticImportStatements = [...fromImportStatements, ...sideEffectImportStatements];
    const stitchImports = staticImportStatements.filter((stmt) =>
      /features\/stitch|stitchStore|ctoStitchInitialStore/.test(stmt)
    );
    expect(stitchImports).toEqual([]);
  });
});
