import { defineConfig } from "vitest/config";
import path from "path";

const projectRoot = import.meta.dirname;

export default defineConfig({
  root: projectRoot,
  test: {
    root: projectRoot,
    globals: true,
    environment: "node",

    // Only run files explicitly opted in to the e2e suite.
    include: ["tests/e2e/**/*.e2e.test.ts"],

    // Boot shared infrastructure once per run (DB reset + MinIO start).
    globalSetup: ["tests/e2e/support/global-setup.ts"],

    // Set process.env before any src/ module is imported.
    setupFiles: ["tests/e2e/setup.ts"],

    // Generous timeouts — real network/disk I/O is slower than mocks.
    testTimeout: 30_000,
    hookTimeout: 60_000,

    // Single-worker execution: e2e tests share one database, so running files
    // in parallel would cause data races. fileParallelism: false forces
    // Vitest v4 to run with maxWorkers = 1.
    fileParallelism: false,

    server: {
      deps: {
        // Zod v4 requires inlining to avoid ESM/SSR transform issues in Vitest.
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
