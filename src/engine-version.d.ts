/**
 * Build-time identity of the stitch engine.
 *
 * Substituted by `scripts/build-probe-bundle.mjs` (esbuild `define`) with the nanodoc
 * commit the Lambda bundle was built from, so a server-computed auto-align verdict can
 * be checked against the editor's own build before it is trusted. NOT substituted in
 * any other build — vite, vitest and vite-node all leave the identifier undefined,
 * which is why every read goes through the `typeof` guard in `probeNode.ts` and lands
 * on `"dev"`.
 *
 * Declared `| undefined` so that guard is the only legal way to read it.
 */
declare const __ENGINE_VERSION__: string | undefined;
