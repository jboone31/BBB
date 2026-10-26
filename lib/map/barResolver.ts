/**
 * Shared server-side bar resolution (design.md section 5).
 *
 * The live-game map keys every pin by a candidate **slug** (see `slug()` in
 * `lib/map/bars.ts`), while the database stores bars as UUID rows in the
 * game-scoped `bars` table. Older games only persisted their designated
 * start/finish bars, so most catalog pins have no row until a team first touches
 * them. Several card-behavior routes — claims, play, and host overrides — need
 * the same lookup: turn a board-facing key into a concrete `bars.id`,
 * materializing a candidate bar on first touch, and surface the bar's
 * coordinates and kind for distance-based card rules.
 *
 * This module extracts that logic out of the claim route's inline lookup into
 * one helper so every caller resolves bars identically and every event payload
 * can carry the same stable `barKey`.
 *
 * Matching order (section 5):
 *   1. by UUID (`bars.id::text = key`);
 *   2. otherwise by the exported TypeScript `slug(name)` from `lib/map/bars.ts`.
 *      The claim route's legacy SQL regex keeps apostrophes as `-s-`, so it
 *      disagrees with the candidate slugs; matching in TypeScript against the
 *      canonical `slug()` is the single source of truth.
 *
 * On a miss, if the key names a known `CANDIDATE_BARS` entry, a row is inserted
 * for this game (name + `"lat,lng"` location) and returned; an unknown key
 * resolves to `null` rather than accepting an arbitrary client-supplied bar.
 *
 * Coordinates are read from `bars.location` via `parseBarLocation`; when that is
 * null (or unparseable) the bar is matched to `CANDIDATE_BARS` by key. A bar
 * with no resolvable coordinates yields `coords: null`.
 *
 * This is a server module: it issues SQL through the caller's {@link QueryRunner}
 * (the same transaction that writes the mutation and appends events), so a freshly
 * materialized bar and the claim/effect that referenced it commit or roll back
 * together.
 *
 * Requirements: 10.4, 12.1, 12.4.
 */
import type { QueryRunner } from "@/lib/events";
import { CANDIDATE_BARS, slug } from "@/lib/map/bars";
import { parseBarLocation, type LatLng } from "@/lib/map/geo";

/** A bar resolved to its durable row, board-facing key, coordinates, and kind. */
export interface ResolvedBar {
  /** `bars.id` (uuid) — the foreign-keyed identity for claims, ledger, effects. */
  readonly barId: string;
  /** Board-facing key used in every event payload: candidate slug, else the uuid. */
  readonly barKey: string;
  /** Human-readable bar name (`bars.name`). */
  readonly name: string;
  /** Resolved coordinates, or null when the bar has no usable location. */
  readonly coords: LatLng | null;
  /** Role in this game: `start`, `finish`, or an ordinary `scoring` bar. */
  readonly kind: "start" | "finish" | "scoring";
}

/**
 * The game's lifecycle-independent bar designations, read once so {@link kindOf}
 * can classify a resolved bar without a second round trip.
 */
interface GameBars {
  readonly startBarId: string | null;
  readonly finishBarId: string | null;
}

const GAME_BARS_SQL = `
select start_bar_id, finish_bar_id
from games
where id = $1
`;

/**
 * Match by UUID first, then by the TypeScript `slug(name)` of every bar in the
 * game. The slug comparison happens in SQL via a parameterized equality against
 * a precomputed candidate slug (see {@link resolveGameBar}); this statement only
 * fetches the candidate rows so the match can be done in TypeScript against the
 * canonical `slug()`.
 */
const BAR_ROWS_SQL = `
select id, name, location
from bars
where game_id = $1
`;

const INSERT_CANDIDATE_BAR_SQL = `
insert into bars (game_id, name, location)
values ($1, $2, $3)
returning id, name, location
`;

/** Classify a bar id against the game's designated start/finish bars. */
function kindOf(game: GameBars, barId: string): ResolvedBar["kind"] {
  if (game.startBarId === barId) return "start";
  if (game.finishBarId === barId) return "finish";
  return "scoring";
}

/**
 * The board-facing key for a bar: its candidate slug when `slug(name)` names a
 * known `CANDIDATE_BARS` entry, otherwise the uuid. A materialized candidate bar
 * therefore always round-trips to the same key its map pin used.
 */
function keyFor(barId: string, name: string): string {
  const candidateSlug = slug(name);
  const isCandidate = CANDIDATE_BARS.some((bar) => bar.id === candidateSlug);
  return isCandidate ? candidateSlug : barId;
}

/**
 * Resolve coordinates for a bar, preferring the stored `location` and falling
 * back to the candidate catalog keyed by slug. Returns null when neither yields
 * a usable coordinate.
 */
function coordsFor(name: string, location: string | null): LatLng | null {
  const stored = parseBarLocation(location);
  if (stored !== null) return stored;
  const candidate = CANDIDATE_BARS.find((bar) => bar.id === slug(name));
  return candidate ? { lat: candidate.lat, lng: candidate.lng } : null;
}

/**
 * Resolve a board-facing bar `key` for a game into its durable row, coordinates,
 * and kind, materializing a candidate bar on first touch (section 5).
 *
 * @param tx a query runner bound to the caller's open transaction.
 * @param gameId the game whose bars are searched.
 * @param key a `bars.id` uuid or a candidate `slug`.
 * @returns the {@link ResolvedBar}, or null when `key` matches no existing bar
 *   and names no known candidate bar.
 */
export async function resolveGameBar(
  tx: QueryRunner,
  gameId: string,
  key: string,
): Promise<ResolvedBar | null> {
  const { rows: gameRows } = await tx.query(GAME_BARS_SQL, [gameId]);
  if (gameRows.length === 0) return null;
  const game: GameBars = {
    startBarId:
      gameRows[0].start_bar_id == null
        ? null
        : String(gameRows[0].start_bar_id),
    finishBarId:
      gameRows[0].finish_bar_id == null
        ? null
        : String(gameRows[0].finish_bar_id),
  };

  const { rows: barRows } = await tx.query(BAR_ROWS_SQL, [gameId]);

  // 1. Match by uuid, then by the canonical TypeScript slug(name).
  const match =
    barRows.find((row) => String(row.id) === key) ??
    barRows.find((row) => slug(String(row.name)) === key);

  if (match) {
    const barId = String(match.id);
    const name = String(match.name);
    const location = match.location == null ? null : String(match.location);
    return {
      barId,
      barKey: keyFor(barId, name),
      name,
      coords: coordsFor(name, location),
      kind: kindOf(game, barId),
    };
  }

  // 2. Materialize a candidate bar on first touch. An unknown key is a miss, so
  //    arbitrary client-supplied ids never create rows.
  const candidate = CANDIDATE_BARS.find((bar) => bar.id === key);
  if (candidate === undefined) return null;

  const { rows: insertedRows } = await tx.query(INSERT_CANDIDATE_BAR_SQL, [
    gameId,
    candidate.name,
    `${candidate.lat},${candidate.lng}`,
  ]);
  const inserted = insertedRows[0];
  if (inserted === undefined) return null;

  const barId = String(inserted.id);
  const name = String(inserted.name);
  const location = inserted.location == null ? null : String(inserted.location);
  return {
    barId,
    barKey: keyFor(barId, name),
    name,
    coords: coordsFor(name, location),
    kind: kindOf(game, barId),
  };
}
