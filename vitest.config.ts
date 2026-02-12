import { defineConfig } from "vitest/config";
import path from "path";

const projectRoot = import.meta.dirname;

export default defineConfig({
  root: projectRoot,
  test: {
    root: projectRoot,
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 10000,
    server: {
      deps: {
        inline: ["zod"],
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(projectRoot, "src"),
    },
  },
});
