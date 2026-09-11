/**
 * No-op stub for the `server-only` package, aliased in for the integration test
 * config only.
 *
 * `lib/db/server.ts` starts with `import "server-only"`, a build-time guard that
 * throws if a server module is pulled into a client bundle. Under Vitest (plain
 * Node, no Next.js bundler) that import throws at load time, which breaks the
 * integration suites that legitimately need `lib/db/server.ts` (they run its
 * transactional DB helper server-side, exactly where it is meant to run).
 *
 * Aliasing `server-only` to this empty module in `vitest.config.integration.mts`
 * neutralizes the guard for tests without changing app behavior: the real
 * `server-only` guard still applies to the Next.js build.
 */
export {};
