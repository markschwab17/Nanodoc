import { execFileSync } from "node:child_process";

import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

/**
 * `__ENGINE_VERSION__` — the commit this editor build came from.
 *
 * The Lambda that pre-computes an auto-align verdict stamps the SAME constant into
 * every verdict it stores (`scripts/build-probe-bundle.mjs`, same rule, same `-dirty`
 * suffix), and the editor only trusts a stored verdict whose `engine` equals this. So
 * the two builds have to derive it identically — see
 * `src/features/stitch/autostitch/engineVersion.ts`.
 *
 * A DEV SERVER gets `"dev"`, not the working tree's hash: a `vite dev` bundle is
 * whatever is on disk this second, which is not the commit the Lambda was built from
 * even when `git rev-parse` agrees. `"dev"` never matches, so local dev always runs the
 * browser probe — which is the correct default and also what makes the fallback path
 * the one that gets exercised daily. `VITE_ENGINE_VERSION=<hash> npm run dev` overrides
 * it, which is how the server path is driven against a real stored verdict at :1420.
 *
 * `git` failing (a tarball, a shallow CI checkout) is not a build failure: it falls
 * back to `"dev"`, i.e. to the browser probe.
 */
function engineVersion(command: string): string {
  const override = process.env.VITE_ENGINE_VERSION?.trim();
  if (override) return override;
  if (command !== "build") return "dev";
  try {
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: __dirname, encoding: "utf8" }).trim();
    const head = git(["rev-parse", "--short", "HEAD"]);
    if (!head) return "dev";
    // Untracked files excluded, exactly as the bundle build does it: a scratch file
    // beside the repo is not a change to the engine.
    const dirty = git(["status", "--porcelain", "--untracked-files=no"]) !== "";
    return dirty ? `${head}-dirty` : head;
  } catch {
    return "dev";
  }
}

/**
 * Inject a `<link rel="preload">` for the (hash-named) mupdf WASM blob into
 * index.html at build time. The 9+ MB WASM dominates time-to-first-page on
 * cold loads; the preload starts its download in parallel with JS parsing
 * instead of waiting for the first `import("mupdf")` to reach it.
 */
function preloadMupdfWasm(): Plugin {
  return {
    name: "preload-mupdf-wasm",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return html; // dev server — nothing to preload
        const wasmFile = Object.keys(bundle).find(
          (f) => f.includes("mupdf") && f.endsWith(".wasm"),
        );
        if (!wasmFile) return html;
        return {
          html,
          tags: [
            {
              tag: "link",
              attrs: {
                rel: "preload",
                as: "fetch",
                href: `/${wasmFile}`,
                crossorigin: "anonymous",
              },
              injectTo: "head",
            },
          ],
        };
      },
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(async ({ command }) => ({
  plugins: [react(), preloadMupdfWasm()],
  define: {
    __ENGINE_VERSION__: JSON.stringify(engineVersion(command)),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    target: "esnext", // Support top-level await
  },
  worker: {
    format: "es", // ES modules for workers (required for dynamic import of mupdf WASM)
  },
  optimizeDeps: {
    exclude: ["mupdf"], // Don't pre-bundle mupdf
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  clearScreen: false,
  // Tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    // Cross-origin isolation enables `globalThis.crossOriginIsolated`, which is
    // required for SharedArrayBuffer. The tile-render WorkerPool uses SAB to
    // share PDF bytes across workers (one buffer instead of N structured-clone
    // copies). Without these headers SAB is unavailable and the pool transparently
    // falls back to the per-worker copy path.
    //
    // NO_ISOLATION=1 disables them: COOP's browsing-context-group swap breaks
    // browser-automation harnesses (puppeteer loses its target on load), and
    // the SAB fallback path makes the app fully functional without isolation.
    headers: process.env.NO_ISOLATION
      ? {}
      : {
          "Cross-Origin-Opener-Policy": "same-origin",
          // `credentialless` (not `require-corp`) so cross-origin subresources
          // — third-party images, scripts, etc. — load without forcing them to
          // send CORP headers, which most public CDNs (PayPal, Google, etc.)
          // do not. crossOriginIsolated still becomes true (SharedArrayBuffer
          // works), but cross-origin requests are sent without credentials.
          "Cross-Origin-Embedder-Policy": "credentialless",
        },
    watch: {
      // Tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));

