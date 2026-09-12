import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for LIVE integration runs (the `test:integration`
 * script).
 *
 * Identical to the base `vitest.config.mts` except it adds a setup file that
 * loads `.env.local` into `process.env` first, so the environment-gated
 * integration suites under `supabase/__tests__/integration/` actually run
 * against the configured Supabase project instead of skipping.
 *
 * The default `npm test` still uses `vitest.config.mts` (no env loading), so it
 * stays hermetic and never touches a live backend.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      // Neutralize the `server-only` build guard under Vitest so integration
      // suites can use lib/db/server.ts (the transactional DB helper) server-
      // side, where it is meant to run. Does not affect the Next.js build.
      "server-only": fileURLToPath(
        new URL("./vitest.stub.server-only.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", ".next/**", "out/**", "build/**", "v0/**"],
    setupFiles: ["./vitest.setup.integration.ts"],
    // The integration suites all share ONE live Supabase project. Running them
    // in parallel causes two problems: (1) suites that assert "writes nothing"
    // via GLOBAL row counts (createGameLifecycle) see counts drift as other
    // suites insert concurrently, and (2) the many simultaneous auth/DB
    // connections overwhelm the Supabase pooler ("Gateway Timeout" during
    // fixture seeding). Run the suites sequentially against the shared backend:
    // `fileParallelism: false` serializes files and `maxWorkers: 1` caps
    // concurrency to one worker (the Vitest 4 replacement for the removed
    // `poolOptions.forks.singleFork`). The default `npm test` config is
    // unaffected and stays fully parallel/hermetic.
    fileParallelism: false,
    maxWorkers: 1,
  },
});
