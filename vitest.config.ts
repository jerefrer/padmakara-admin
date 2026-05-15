import { defineConfig, configDefaults } from "vitest/config";
import path from "path";

const projectRoot = import.meta.dirname;

export default defineConfig({
  root: projectRoot,
  test: {
    root: projectRoot,
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Exclude e2e files from the unit run — they live in their own config.
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
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
