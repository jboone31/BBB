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
  },
});
