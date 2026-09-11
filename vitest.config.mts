import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for the BBB web application.
 *
 * This is the project's shared test harness. Unit tests and fast-check
 * property tests live next to the code they cover (e.g.
 * `lib/scoring/scoring.property.test.ts`) and are discovered by the `include`
 * glob below. Node is the default environment because the foundation logic is
 * framework-free; component tests that need a DOM can opt into `jsdom` locally.
 *
 * Property tests use fast-check with a minimum of 100 iterations (numRuns: 100)
 * per the spec's testing strategy.
 */
export default defineConfig({
  // Mirror the `@/*` -> `./*` path alias from tsconfig.json so tests can import
  // modules that use the project's `@/lib/...` import style (e.g.
  // lib/gameend/transition.ts) the same way the app does.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", ".next/**", "out/**", "build/**", "v0/**"],
  },
});
