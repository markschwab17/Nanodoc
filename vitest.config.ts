import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Web Workers + mupdf wasm cannot run in jsdom. Worker integration is
    // validated manually via the /dev/tile-smoke route, NOT in Vitest.
    exclude: ["src/**/*.worker.test.ts", "**/node_modules/**"],
  },
});
