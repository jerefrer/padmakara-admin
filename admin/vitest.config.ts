import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

// Mirrors the `@slides` alias in vite.config.ts — the pure slide-document
// and rich-text helpers under test import the shared model/renderer through
// it, the same way the running admin app does.
export default defineConfig({
  resolve: {
    alias: {
      "@slides": path.resolve(here, "../src/lib/slides"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
