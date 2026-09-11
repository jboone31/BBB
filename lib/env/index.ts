/**
 * Environment configuration with fail-fast validation.
 *
 * `loadEnv()` validates that every required environment variable is present and
 * non-empty, then returns a typed, frozen configuration object. If any required
 * variable is missing or empty it throws a {@link MissingEnvError} that enumerates
 * *every* offending variable by name (not just the first), leaving the application
 * in a not-started state.
 *
 * Variable classes (Requirements 2.7, 7.3):
 *  - Public (browser-safe, `NEXT_PUBLIC_*`): the Supabase URL and anon key. These
 *    are exposed to the client.
 *  - Server-only (never sent to the browser): the Supabase service-role key. This
 *    value is only ever read on the server; it is never placed on the public config.
 */

/** Names of the public (browser-safe) required variables. */
export const PUBLIC_ENV_VARS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
] as const;

/** Names of the server-only required variables (never exposed to the browser). */
export const SERVER_ENV_VARS = ["SUPABASE_SERVICE_ROLE_KEY"] as const;

/** Every required variable name, public + server-only. */
export const REQUIRED_ENV_VARS = [
  ...PUBLIC_ENV_VARS,
  ...SERVER_ENV_VARS,
] as const;

export type PublicEnvVar = (typeof PUBLIC_ENV_VARS)[number];
export type ServerEnvVar = (typeof SERVER_ENV_VARS)[number];
export type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number];

/** Public, browser-safe configuration (only `NEXT_PUBLIC_*` values). */
export interface PublicEnvConfig {
  readonly NEXT_PUBLIC_SUPABASE_URL: string;
  readonly NEXT_PUBLIC_SUPABASE_ANON_KEY: string;
}

/** Server-only configuration. Never send this to the browser. */
export interface ServerEnvConfig {
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
}

/**
 * Fully resolved, frozen environment configuration.
 *
 * `public` holds only the browser-safe `NEXT_PUBLIC_*` values; `server` holds the
 * privileged service-role key and must stay server-side only (Requirement 7.3).
 */
export interface EnvConfig {
  readonly public: PublicEnvConfig;
  readonly server: ServerEnvConfig;
}

/**
 * Startup error thrown when one or more required environment variables are missing
 * or empty. Carries the full list of offending names so callers can report each one
 * (Requirement 2.9).
 */
export class MissingEnvError extends Error {
  /** Every missing/empty required variable name, in declaration order. */
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    const names = missing.join(", ");
    super(
      `Environment configuration invalid: the following required variable(s) are ` +
        `missing or empty: ${names}. The application will not start until they are set.`,
    );
    this.name = "MissingEnvError";
    this.missing = Object.freeze([...missing]);
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, MissingEnvError.prototype);
  }
}

/** A required variable is present only if it is a non-empty (after-trim) string. */
function isPresent(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The environment source to read from. Defaults to `process.env`. Accepting a source
 * keeps the function pure and testable (Property 15) without touching global state.
 */
export type EnvSource = Record<string, string | undefined>;

/**
 * Load and validate the environment configuration.
 *
 * @param source - The variables to read from. Defaults to `process.env`.
 * @returns A typed, deeply frozen {@link EnvConfig}.
 * @throws {MissingEnvError} If any required variable is missing or empty. The error
 *   enumerates *every* offending variable name, not just the first one.
 */
export function loadEnv(source: EnvSource = process.env): EnvConfig {
  const missing: string[] = [];
  for (const name of REQUIRED_ENV_VARS) {
    if (!isPresent(source[name])) {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    throw new MissingEnvError(missing);
  }

  const config: EnvConfig = {
    public: Object.freeze({
      NEXT_PUBLIC_SUPABASE_URL: source.NEXT_PUBLIC_SUPABASE_URL as string,
      NEXT_PUBLIC_SUPABASE_ANON_KEY:
        source.NEXT_PUBLIC_SUPABASE_ANON_KEY as string,
    }),
    server: Object.freeze({
      SUPABASE_SERVICE_ROLE_KEY: source.SUPABASE_SERVICE_ROLE_KEY as string,
    }),
  };

  return Object.freeze(config);
}

/**
 * The name of the **optional**, server-only direct-Postgres connection string.
 *
 * The Supabase service-role *key* (in {@link ServerEnvConfig}) authenticates the
 * Supabase JS/REST client, but server mutation routes need a *transaction-capable*
 * connection to run a domain write and an `appendEvent` in one transaction
 * (Task 10.1, Req 4.3/4.4). Supabase exposes that as a standard Postgres connection
 * string (the "connection pooler"/"session" URL from the project's database
 * settings), which the `postgres` (postgres.js) driver in `lib/db/server.ts`
 * consumes.
 *
 * This is intentionally kept **out of {@link REQUIRED_ENV_VARS}** so `loadEnv()`'s
 * fail-fast contract and Property 15 are unchanged: pure-logic, client, and the
 * existing scaffold do not need a database, so the app must still start without it.
 * It is validated on demand — only when a server route actually opens a database
 * connection — by {@link requireServerDbUrl}. Follow-up: once every server mutation
 * depends on it, promote it to the required set here and in `.env.example`.
 */
export const SERVER_DB_URL_VAR = "SUPABASE_DB_URL" as const;

/** Raised when a transaction-capable database connection is needed but unconfigured. */
export class MissingDbUrlError extends Error {
  constructor() {
    super(
      `Environment configuration invalid: ${SERVER_DB_URL_VAR} is missing or empty. ` +
        `A transaction-capable Postgres connection string is required for server ` +
        `mutation routes (atomic state-change + event write). Set it to the Supabase ` +
        `project's Postgres connection URL (server-only; never exposed to the browser).`,
    );
    this.name = "MissingDbUrlError";
    Object.setPrototypeOf(this, MissingDbUrlError.prototype);
  }
}

/**
 * Read and validate the optional server-only direct-Postgres connection string.
 *
 * Unlike {@link loadEnv}, this does not run at startup: it is called lazily by
 * `lib/db/server.ts` the first time a server route opens a database connection, so
 * a deployment that never exercises a DB-backed route is not forced to configure it.
 *
 * @param source - The variables to read from. Defaults to `process.env`.
 * @returns the non-empty connection string.
 * @throws {MissingDbUrlError} if the variable is missing or empty.
 */
export function requireServerDbUrl(source: EnvSource = process.env): string {
  const value = source[SERVER_DB_URL_VAR];
  if (!isPresent(value)) {
    throw new MissingDbUrlError();
  }
  return value;
}
