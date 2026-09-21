/**
 * The nanodoc commit this build of the stitch engine came from.
 *
 * ONE definition, read by both sides of the server-probe bargain:
 *
 *  - the Lambda bundle (`scripts/build-probe-bundle.mjs`, via `probeNode.ts`) stamps it
 *    into every verdict it computes, and writes it beside the bundle as
 *    `dist-probe/ENGINE_VERSION`;
 *  - the editor (`vite.config.ts`) compares a stored verdict's `engine` against it
 *    before trusting one, because a verdict from a DIFFERENT commit is not
 *    interchangeable with what this build's browser probe would say.
 *
 * Both builds substitute `__ENGINE_VERSION__` with `git rev-parse --short HEAD` (plus
 * `-dirty` when the tree has uncommitted tracked changes). This file is deliberately
 * separate from `probeNode.ts`, which is Node-only (`node:zlib`, `Buffer`) and must
 * never be pulled into the browser bundle just to read a string.
 *
 * `"dev"` when the identifier was never substituted — vitest, vite-node, and the
 * `:1420` dev server unless `VITE_ENGINE_VERSION` is set. `"dev"` can never equal a
 * bundle's stamp, so an unversioned build always falls back to the browser probe.
 */
export const ENGINE_VERSION: string =
  typeof __ENGINE_VERSION__ !== "undefined" && __ENGINE_VERSION__ ? __ENGINE_VERSION__ : "dev";
