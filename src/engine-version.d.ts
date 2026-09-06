/**
 * Build-time identity of the stitch engine.
 *
 * Substituted with the nanodoc commit the build came from by BOTH builds that have to
 * agree about it — `scripts/build-probe-bundle.mjs` (esbuild `define`, for the Lambda
 * bundle) and `vite.config.ts` (for the editor) — so a server-computed auto-align
 * verdict can be checked against the editor's own build before it is trusted.
 *
 * NOT substituted by vitest or vite-node, and not by the dev server unless
 * `VITE_ENGINE_VERSION` is set. Every read therefore goes through the `typeof` guard in
 * `src/features/stitch/autostitch/engineVersion.ts` and lands on `"dev"`, which can
 * never match a stamped verdict — the browser probe runs instead.
 *
 * Declared `| undefined` so that guard is the only legal way to read it.
 */
declare const __ENGINE_VERSION__: string | undefined;
