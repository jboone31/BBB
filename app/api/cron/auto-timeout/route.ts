/**
 * Protected auto-timeout cron route (design.md "Auto-timeout trigger mechanism";
 * Task 10.3).
 *
 * A server-only endpoint that runs the auto-timeout sweep: it ends every live
 * game whose `live_started_at` is more than 12h old (Req 5.2), each via the
 * shared atomic end transition `endGame` (Task 10.2), so the `ended` +
 * `end_reason` write and its single `game_event` commit together per game
 * (Req 5.3).
 *
 * This route is the Node-side trigger for the sweep. Point a scheduler at it —
 * a Supabase scheduled Edge Function, Vercel Cron, or any external cron — instead
 * of (or alongside) the pg_cron job in
 * `supabase/migrations/0007_auto_timeout_sweep.sql`. Only one trigger needs to be
 * active; both drive the identical end transition.
 *
 * Runtime: `nodejs`, because the sweep opens a real Postgres transaction through
 * `lib/db/server.ts` (`withTransaction`), which the Edge runtime cannot do.
 *
 * Protection: the request must present the shared CRON secret in the
 * `authorization: Bearer <secret>` header (matching Vercel Cron's convention),
 * compared against the `CRON_SECRET` environment variable. The secret is read
 * on demand (never a `NEXT_PUBLIC_*` var) so it stays server-only, and if it is
 * unconfigured the route refuses to run rather than sweeping unauthenticated.
 */
import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";
import { endGame } from "@/lib/gameend/transition";

import {
  createDbDueLiveGamesLoader,
  runAutoTimeoutSweep,
} from "@/lib/gameend/autoTimeoutSweep";

/** Node.js runtime: a real Postgres transaction cannot be opened on Edge. */
export const runtime = "nodejs";

/** The environment variable holding the shared cron secret (server-only). */
const CRON_SECRET_VAR = "CRON_SECRET";

/** Extract a `Bearer <token>` value from an authorization header, if present. */
function bearerToken(authorization: string | null): string | null {
  if (!authorization) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match ? match[1].trim() : null;
}

/**
 * Authorize the request against `CRON_SECRET`.
 *
 * @returns `null` if authorized, or a JSON error response describing why not.
 */
function authorize(request: Request): NextResponse | null {
  const configured = process.env[CRON_SECRET_VAR]?.trim();
  if (!configured) {
    // Fail closed: without a configured secret we cannot authenticate the caller,
    // so we refuse to run the sweep rather than exposing it unauthenticated.
    return NextResponse.json(
      { ran: false, error: `${CRON_SECRET_VAR} is not configured` },
      { status: 500 },
    );
  }

  const presented = bearerToken(request.headers.get("authorization"));
  if (presented !== configured) {
    return NextResponse.json(
      { ran: false, error: "unauthorized" },
      { status: 401 },
    );
  }
  return null;
}

/**
 * Handle a scheduled invocation: authorize, then run the sweep with the real
 * database-backed dependencies and return a summary of what was ended.
 */
async function handle(request: Request): Promise<NextResponse> {
  const unauthorized = authorize(request);
  if (unauthorized) {
    return unauthorized;
  }

  try {
    const result = await runAutoTimeoutSweep({
      listDueLiveGames: createDbDueLiveGamesLoader(withTransaction),
      withTransaction,
      endGame,
    });

    return NextResponse.json(
      {
        ran: true,
        dueCount: result.dueCount,
        endedGameIds: result.endedGameIds,
        failures: result.failures,
      },
      { status: 200 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "sweep failed";
    return NextResponse.json({ ran: false, error: message }, { status: 500 });
  }
}

/**
 * GET /api/cron/auto-timeout — invoked by schedulers that issue GET (e.g. Vercel
 * Cron). Requires the `CRON_SECRET` bearer token.
 */
export async function GET(request: Request): Promise<NextResponse> {
  return handle(request);
}

/**
 * POST /api/cron/auto-timeout — invoked by schedulers that issue POST. Requires
 * the `CRON_SECRET` bearer token. Same behavior as GET.
 */
export async function POST(request: Request): Promise<NextResponse> {
  return handle(request);
}
