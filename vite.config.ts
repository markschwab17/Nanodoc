import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
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
    headers: {
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

