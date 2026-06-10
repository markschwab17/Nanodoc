import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

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
export default defineConfig(async () => ({
  plugins: [react(), preloadMupdfWasm()],
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

