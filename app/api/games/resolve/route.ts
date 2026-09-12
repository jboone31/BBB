/**
 * Code → gameId resolution route (design.md Component 7; app-shell-navigation
 * Task 5.1).
 *
 * POST /api/games/resolve — maps a submitted Join_Code to the id of the single
 * non-`ended` Game that owns it, so a Player who only has a code (rather than a
 * game id / share link) can be routed to the correct lobby. This is the authority
 * behind the landing page's Join_Entry.
 *
 * Unlike the six lobby mutation routes, resolution is a **pre-join read-only
 * lookup**:
 *   - no `x-bbb-session-id` session is required (a visitor performs this before
 *     they have joined anything; there is nothing session-scoped to authorize);
 *   - no transaction and no `game_events` append (it writes nothing);
 *   - no rate limiting or extra enumeration hardening in this pass (deferred).
 *
 * Security posture — **uniform not-found** (R6.4): every miss returns the exact
 * same body (`{ resolved: false }`) and status (`404`), whether the code was
 * malformed, matched no game, or matched only an `ended` game. A caller cannot
 * distinguish those cases; the only observably different outcome is a successful
 * resolution. The query selects and the response returns **only** the game id —
 * never the Join_Code, lifecycle, or any other field (R6.5).
 *
 * Server-only + service connection:
 *   - `runtime = 'nodejs'` — the `postgres` driver in `lib/db/server.ts` needs a
 *     real Postgres socket, which the Edge runtime cannot open.
 *   - The lookup uses the privileged direct-Postgres connection via `getSql()`.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6.
 */
import { NextResponse } from "next/server";

import { getSql } from "@/lib/db/server";
import {
  isValidSubmittedCode,
  normalizeSubmittedCode,
} from "@/lib/lobby/joinCode";

/** Node.js runtime: a real Postgres connection cannot be opened on Edge. */
export const runtime = "nodejs";

/** Request body accepted by the resolution route. */
interface ResolveBody {
  /** The submitted Join_Code (6–12 alphanumeric after trim + upcase, R6.2/R6.6). */
  readonly joinCode?: unknown;
}

/**
 * Look up the id of the single non-`ended` game whose Join_Code matches the
 * normalized submitted code (R6.1). Selects **only** `id` (R6.5) and relies on
 * the existing unique index on `join_code`, so at most one non-`ended` game can
 * match. `limit 1` is defensive belt-and-suspenders on that guarantee.
 *
 * Positional parameter: $1 normalized_join_code.
 */
const RESOLVE_SQL = `
select id
from games
where join_code = $1 and lifecycle <> 'ended'
limit 1
`;

/**
 * Build the uniform not-found response (R6.4): the identical body and status for
 * every miss — malformed body, bad code shape, no match, or ended-only match.
 * Nothing about which case occurred is observable to the caller.
 */
function notFound(): NextResponse {
  return NextResponse.json({ resolved: false }, { status: 404 });
}

/**
 * POST /api/games/resolve
 *
 * Body: `{ joinCode: string }`.
 *
 * Responses:
 *   - 200 `{ resolved: true, gameId }` — the normalized code (6–12 alphanumeric)
 *     matched exactly one non-`ended` game; only its id is returned (R6.1/R6.5).
 *   - 404 `{ resolved: false }` — uniform not-found for every miss: malformed
 *     JSON body, a code that is not 6–12 alphanumeric after normalization
 *     (R6.2), a well-formed code with no non-`ended` match (R6.3), or a code
 *     belonging only to an `ended` game (R6.4). All are indistinguishable.
 *   - 500 — a genuine DB/connection fault (distinct from a not-found miss; does
 *     not leak game existence).
 */
export async function POST(request: Request): Promise<NextResponse> {
  // A malformed JSON body carries no valid code → uniform miss (R6.4).
  let body: ResolveBody;
  try {
    body = (await request.json()) as ResolveBody;
  } catch {
    return notFound();
  }

  // Submitted-code shape (R6.2), before any DB lookup.
  const rawCode = typeof body.joinCode === "string" ? body.joinCode : "";
  if (!isValidSubmittedCode(rawCode)) {
    return notFound();
  }

  // Normalize (trim + uppercase) so casing/whitespace never cause a miss (R6.6),
  // matching how codes are stored on the join path.
  const normalizedCode = normalizeSubmittedCode(rawCode);

  // Read-only lookup of the single non-`ended` game for this code (R6.1/R6.3).
  const rows = (await getSql().unsafe(RESOLVE_SQL, [normalizedCode])) as Array<{
    id: unknown;
  }>;
  const row = rows[0];
  if (!row) {
    // Well-formed but no non-`ended` match (or ended-only) → uniform miss (R6.3/R6.4).
    return notFound();
  }

  // Success: return ONLY the resolved id, nothing else (R6.1/R6.5).
  return NextResponse.json(
    { resolved: true, gameId: String(row.id) },
    { status: 200 },
  );
}
