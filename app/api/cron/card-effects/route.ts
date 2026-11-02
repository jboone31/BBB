/**
 * Optional Cron_Route for card-effect settlement (design.md "Settlement";
 * Task 12.3).
 *
 * A server-only endpoint that runs the Timer_Sweep across **all** live games for
 * an external scheduler, so games with no connected board still get their due
 * activation / expiry transitions announced (Req 20.3d, 20.4). It calls the one
 * idempotent settlement function, `bbb_settle_card_effects(null, false)`:
 *
 *   - `p_game_id = null` — sweep every live game with due transitions, not one
 *     specific game.
 *   - `p_wait = false` — lock each game's row `for update skip locked`, so a game
 *     currently held by a mutation or a Settle_Nudge is skipped rather than
 *     blocked; that game's transitions are picked up by whoever holds the lock,
 *     or by the next sweep. `p_now` is left null, so the function reads
 *     `clock_timestamp()` after each lock and only appends transitions already
 *     due at that instant.
 *
 * Runtime: `nodejs`, because the sweep opens a real Postgres transaction through
 * `lib/db/server.ts` (`withTransaction`), which the Edge runtime cannot do.
 *
 * Protection: the request must present the shared cron secret in the
 * `authorization: Bearer <secret>` header (matching Vercel Cron's convention and
 * the sibling `auto-timeout` route), compared against the `CRON_SECRET`
 * environment variable using a constant-time comparison (SHA-256 digests fed to
 * `crypto.timingSafeEqual`). The secret is read on demand (never a `NEXT_PUBLIC_*`
 * var) so it stays server-only, and if it is unset/empty the route **fails
 * closed** — it refuses to settle rather than running unauthenticated (Req
 * 20.5a). This route is intentionally **not** registered in `vercel.json` crons;
 * it has no schedule and is invoked manually/externally only.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/server";

/** Node.js runtime: a real Postgres transaction cannot be opened on Edge. */
export const runtime = "nodejs";

/** The environment variable holding the shared cron secret (server-only). */
const CRON_SECRET_VAR = "CRON_SECRET";

/**
 * Sweep every live game with due transitions, locking each `for update skip
 * locked` (so a game held by a mutation / Settle_Nudge is skipped, not blocked)
 * and reading the server clock after each lock. Returns the number of transition
 * events appended across all swept games.
 */
const SETTLE_ALL_SQL = `
select bbb_settle_card_effects(null, false) as appended
`;

/** Extract a `Bearer <token>` value from an authorization header, if present. */
function bearerToken(authorization: string | null): string | null {
  if (!authorization) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match ? match[1].trim() : null;
}

/**
 * Compare a presented token to the configured secret in constant time.
 *
 * Both values are SHA-256 hashed first so the buffers handed to
 * `timingSafeEqual` always have equal length; this avoids leaking the secret's
 * length through an early length-mismatch return.
 */
function secretMatches(presented: string, configured: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(configured, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * Authorize the request against `CRON_SECRET`.
 *
 * @returns `null` if authorized, or a JSON error response describing why not.
 *   When the secret is unset/empty we fail closed with 500 rather than settling
 *   unauthenticated (Req 20.5a).
 */
function authorize(request: Request): NextResponse | null {
  const configured = process.env[CRON_SECRET_VAR]?.trim();
  if (!configured) {
    // Fail closed: without a configured secret we cannot authenticate the caller,
    // so we refuse to run the sweep rather than exposing it unauthenticated.
    return NextResponse.json(
      { ok: false, error: `${CRON_SECRET_VAR} is not configured` },
      { status: 500 },
    );
  }

  const presented = bearerToken(request.headers.get("authorization"));
  if (presented === null || !secretMatches(presented, configured)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }
  return null;
}

/**
 * Handle an invocation: authorize, then run the all-games settle in one
 * transaction and return the appended transition count. Any failure rolls back
 * and responds `unavailable` (Req 20.4).
 */
async function handle(request: Request): Promise<NextResponse> {
  const unauthorized = authorize(request);
  if (unauthorized) {
    return unauthorized;
  }

  try {
    const appended = await withTransaction(async (tx) => {
      const { rows } = await tx.query(SETTLE_ALL_SQL);
      return Number(rows[0]?.appended ?? 0);
    });

    return NextResponse.json({ ok: true, appended }, { status: 200 });
  } catch {
    // The transaction rolled back (any appended transitions included). Report a
    // transient failure without echoing internal database error text.
    return NextResponse.json(
      { ok: false, error: "unavailable" },
      { status: 503 },
    );
  }
}

/**
 * GET /api/cron/card-effects — invoked by schedulers that issue GET (e.g. Vercel
 * Cron). Requires the `CRON_SECRET` bearer token; fails closed when unset.
 */
export async function GET(request: Request): Promise<NextResponse> {
  return handle(request);
}

/**
 * POST /api/cron/card-effects — invoked by schedulers that issue POST. Requires
 * the `CRON_SECRET` bearer token; fails closed when unset. Same behavior as GET.
 */
export async function POST(request: Request): Promise<NextResponse> {
  return handle(request);
}
