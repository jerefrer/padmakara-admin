import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));
// The shared slide document model + renderer live in the backend package
// (`padmakara-api/src/lib/slides`), not under `admin/`. The admin preview
// imports them directly through this alias so it renders with the exact
// same code path as the burn container — see docs/superpowers/specs/
// 2026-08-21-video-slides-burn-in-design.md.
const slidesLibDir = path.resolve(here, "../src/lib/slides");

export default defineConfig({
  plugins: [react()],
  base: "/",
  resolve: {
    alias: {
      "@slides": slidesLibDir,
    },
  },
  build: {
    outDir: "dist",
  },
  server: {
    fs: {
      // Vite's dev server otherwise restricts filesystem reads to `admin/`
      // (its own project root); the aliased import above reaches outside
      // that root into the parent `padmakara-api/src`.
      allow: [here, path.resolve(here, "..")],
    },
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        timeout: 120000,
      },
    },
  },
});
