/**
 * Next.js instrumentation hook.
 *
 * Next.js runs {@link register} once at server startup, before the HTTP server
 * begins accepting requests. We use it to invoke the fail-fast environment
 * validation (Requirement 2.9): if any required variable is missing or empty,
 * `loadEnv()` throws a {@link MissingEnvError} enumerating every offending name,
 * which aborts startup and leaves the app in a not-started state — so a
 * misconfigured deployment never serves a single request.
 *
 * The check is guarded to the Node.js runtime. The server-only service-role key
 * (Requirement 7.3) only exists there; running the full required-variable check
 * on the Edge runtime would fail spuriously, so we skip it off-Node.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { loadEnv } = await import("@/lib/env");
    // Throwing here halts startup before the server accepts any request.
    loadEnv();
  }
}
