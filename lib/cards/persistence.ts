/**
 * Server-side deck persistence (brawl-deck-architecture Task 3).
 *
 * The pure deck engine (`lib/cards/deck.ts`) owns every transition; this module
 * is the thin, transactional bridge between that engine's {@link DeckState} and
 * the durable rows in `card_instances` / `team_decks` / `card_draws`
 * (`supabase/migrations/0009_card_inventory.sql`, `0011_card_deck_state.sql`).
 *
 * The contract for one deck operation, all inside the caller's open transaction
 * (R4.1, R4.2):
 *
 *   1. {@link loadDeckState} rebuilds the team's {@link DeckState} from durable
 *      rows, seeding it (via the engine's {@link seedDeck}) on first touch.
 *   2. The caller applies exactly one pure engine transition
 *      ({@link drawForBar} / {@link keepCard} / {@link discardCard} /
 *      {@link playCard}).
 *   3. {@link persistDeckTransition} writes the row diff between the before- and
 *      after-states and appends the matching canonical `game_events` row via the
 *      shared {@link appendEvent}, so inventory state and the authoritative event
 *      log commit together.
 *
 * {@link applyDeckTransition} wires those three steps together for the common
 * case. The engine stays the single source of truth for *what* changes; this
 * module only maps that change onto rows and records it (R4.1).
 *
 * Power Hour seam (R4.3): the engine reads/writes `powerHourUntil` and
 * `team_decks.draw_override_until` already exists for it, so a future effect can
 * set the override without any schema change. {@link loadDeckState} hydrates it
 * and {@link persistDeckTransition} writes it back.
 */

import { appendEvent, type QueryRunner } from "@/lib/events";
import { GAME_BOARD_EVENT_TYPES } from "@/lib/gameboard/events";

import { CARD_SLUGS, type CardSlug } from "./catalog";
import {
  seedDeck,
  type CardInstance,
  type CardInstanceState,
  type DeckState,
} from "./deck";

/**
 * The engine state values persisted in `card_instances.deck_state`. Mirrors
 * {@link CardInstanceState} exactly; declared here so the row mapping is a
 * compile-time-checked total map over the engine's lifecycle.
 */
const DECK_STATE_VALUES: readonly CardInstanceState[] = [
  "deck",
  "pending",
  "hand",
  "played",
  "discarded",
];

/** The canonical event type appended for a given engine transition kind. */
export type DeckTransitionKind = "draw" | "keep" | "discard" | "play";

const EVENT_TYPE_FOR: Record<DeckTransitionKind, string> = {
  draw: GAME_BOARD_EVENT_TYPES.cardsDrawn,
  keep: GAME_BOARD_EVENT_TYPES.cardKept,
  discard: GAME_BOARD_EVENT_TYPES.cardDiscarded,
  play: GAME_BOARD_EVENT_TYPES.cardPlayed,
};

// ---------------------------------------------------------------------------
// Row <-> engine mapping
// ---------------------------------------------------------------------------

const DEFINITIONS_SQL = `
select id, slug
from card_definitions
`;

const TEAM_DECK_SQL = `
select next_draw_position, draw_override_until, seeded_at
from team_decks
where game_id = $1 and team_id = $2
`;

const INSTANCES_SQL = `
select ci.id,
       ci.definition_id,
       cd.slug,
       ci.deck_state,
       ci.state,
       ci.draw_position,
       ci.pending_bar_id
from card_instances ci
join card_definitions cd on cd.id = ci.definition_id
where ci.game_id = $1 and ci.owner_team_id = $2
order by ci.draw_position
`;

const DRAWN_BARS_SQL = `
select bar_id
from card_draws
where game_id = $1 and team_id = $2
order by drawn_at, id
`;

const UPSERT_TEAM_DECK_SQL = `
insert into team_decks (game_id, team_id, next_draw_position, draw_override_until)
values ($1, $2, $3, $4)
on conflict (game_id, team_id) do update
  set next_draw_position = excluded.next_draw_position,
      draw_override_until = excluded.draw_override_until
`;

const UPSERT_INSTANCE_SQL = `
insert into card_instances
  (id, game_id, definition_id, owner_team_id, draw_position,
   deck_state, state, holder_team_id, pending_bar_id,
   held_at, played_at, discarded_at)
values
  ($1, $2, $3, $4, $5,
   $6, $7::card_instance_state, $8, $9,
   $10, $11, $12)
on conflict (id) do update
  set deck_state = excluded.deck_state,
      state = excluded.state,
      holder_team_id = excluded.holder_team_id,
      pending_bar_id = excluded.pending_bar_id,
      held_at = excluded.held_at,
      played_at = excluded.played_at,
      discarded_at = excluded.discarded_at
`;

const INSERT_CARD_DRAW_SQL = `
insert into card_draws (game_id, team_id, bar_id, cards_drawn)
values ($1, $2, $3, $4)
on conflict (game_id, team_id, bar_id) do nothing
`;

/** A durable `card_instances` row joined to its catalog slug. */
interface InstanceRow {
  readonly id: string;
  readonly definitionId: string;
  readonly slug: CardSlug;
  readonly deckState: CardInstanceState | null;
  readonly drawPosition: number | null;
  readonly pendingBarId: string | null;
}

/** Context identifying which team's deck is being persisted, within a game. */
export interface DeckContext {
  readonly gameId: string;
  readonly teamId: string;
}

/** The durable `card_instance_state` enum value for an engine lifecycle state. */
function enumStateFor(state: CardInstanceState): string {
  switch (state) {
    case "played":
      return "played";
    case "discarded":
      return "discarded";
    // deck / pending / hand all map onto the holding enum value; the
    // authoritative distinction lives in deck_state. The 0011 lifecycle check
    // permits deck/pending rows to carry no holder, so this stays consistent.
    case "deck":
    case "pending":
    case "hand":
      return "in_hand";
  }
}

/**
 * The engine instance id for a `(teamId, slug)` pair. Must match
 * {@link seedDeck}'s id scheme so a hydrated state is identical to a freshly
 * seeded one (keeping the engine's equality/lookup behavior stable).
 */
export function engineCardId(teamId: string, slug: CardSlug): string {
  return `${teamId}:${slug}`;
}

/**
 * Map an engine instance id back to its catalog slug, i.e. the inverse of
 * {@link engineCardId}. The id is `${teamId}:${slug}`; the team id is a UUID
 * (no colon), so the slug is everything after the first colon.
 */
export function slugFromEngineCardId(cardId: string): CardSlug {
  const colon = cardId.indexOf(":");
  const slug = colon === -1 ? cardId : cardId.slice(colon + 1);
  return slug as CardSlug;
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Rebuild a team's {@link DeckState} from durable rows, inside the caller's
 * transaction. On first touch (no persisted instances) the state is produced by
 * the engine's {@link seedDeck} so a hydrated deck is byte-for-byte what the
 * engine would create fresh — the engine, not this module, defines the seed.
 *
 * The returned state is NOT yet persisted; the caller applies one engine
 * transition to it and hands the result to {@link persistDeckTransition}.
 *
 * @param tx transaction-scoped query runner.
 * @param ctx the game + team whose deck to load.
 * @returns the hydrated (or freshly seeded) {@link DeckState}.
 */
export async function loadDeckState(
  tx: QueryRunner,
  ctx: DeckContext,
): Promise<DeckState> {
  return (await loadDeckStateWithOrigin(tx, ctx)).state;
}

/**
 * Like {@link loadDeckState}, but also reports whether the state was freshly
 * seeded (no persisted rows) versus hydrated from durable rows.
 *
 * {@link persistDeckTransition} uses `seeded` to decide whether the first write
 * must materialize the whole 23-card roster (so the untouched `deck` cards
 * become durable) or only the diff against existing rows.
 */
export async function loadDeckStateWithOrigin(
  tx: QueryRunner,
  ctx: DeckContext,
): Promise<{ readonly state: DeckState; readonly seeded: boolean }> {
  const { gameId, teamId } = ctx;

  const { rows: instanceRows } = await tx.query(INSTANCES_SQL, [
    gameId,
    teamId,
  ]);

  // First touch: no instances persisted yet -> the engine defines the seed.
  if (instanceRows.length === 0) {
    return { state: seedDeck(teamId), seeded: true };
  }

  const instances = instanceRows.map(readInstanceRow);

  const cards: CardInstance[] = instances
    .map((row) => ({
      id: engineCardId(teamId, row.slug),
      slug: row.slug,
      state: (row.deckState ?? "deck") as CardInstanceState,
      position: row.drawPosition ?? 0,
    }))
    .sort((left, right) => left.position - right.position);

  const pendingRow = instances.find((row) => row.deckState === "pending");
  const pendingBarId = pendingRow?.pendingBarId ?? null;

  const { rows: drawRows } = await tx.query(DRAWN_BARS_SQL, [gameId, teamId]);
  const drawnBarIds = drawRows.map((row) => String(row.bar_id));

  const { rows: deckRows } = await tx.query(TEAM_DECK_SQL, [gameId, teamId]);
  const overrideRaw = deckRows[0]?.draw_override_until;
  const powerHourUntil =
    overrideRaw == null ? null : new Date(String(overrideRaw)).getTime();

  return {
    state: {
      teamId,
      cards,
      drawnBarIds,
      pendingBarId,
      powerHourUntil: Number.isNaN(powerHourUntil ?? NaN)
        ? null
        : powerHourUntil,
    },
    seeded: false,
  };
}

function readInstanceRow(row: Record<string, unknown>): InstanceRow {
  const deckState =
    typeof row.deck_state === "string" &&
    DECK_STATE_VALUES.includes(row.deck_state as CardInstanceState)
      ? (row.deck_state as CardInstanceState)
      : null;
  return {
    id: String(row.id),
    definitionId: String(row.definition_id),
    slug: String(row.slug) as CardSlug,
    deckState,
    drawPosition: row.draw_position == null ? null : Number(row.draw_position),
    pendingBarId:
      row.pending_bar_id == null ? null : String(row.pending_bar_id),
  };
}

// ---------------------------------------------------------------------------
// Persist
// ---------------------------------------------------------------------------

/** A board-projection card record, matching `applyCardInventoryEvent`'s shape. */
interface CardEventRecord {
  readonly cardId: string;
  readonly teamId: string;
  readonly slug: string;
  readonly state: CardInstanceState;
}

/** Extra fields merged into the appended event payload (e.g. play targets). */
export type DeckEventExtra = Readonly<Record<string, unknown>>;

/** Arguments to {@link persistDeckTransition}. */
export interface PersistDeckTransitionArgs {
  readonly ctx: DeckContext;
  /** The engine transition that was applied (selects the canonical event type). */
  readonly kind: DeckTransitionKind;
  /** The state before the transition (as returned by {@link loadDeckState}). */
  readonly before: DeckState;
  /** The state after the single engine transition. */
  readonly after: DeckState;
  /**
   * Whether `before` was freshly seeded (no persisted rows). On a seeded first
   * touch the whole 23-card roster is materialized so the untouched `deck`
   * cards become durable; otherwise only the changed cards are upserted.
   */
  readonly seeded?: boolean;
  /**
   * For a `draw`, the bar the draw was recorded against (writes `card_draws`).
   * Ignored for other kinds.
   */
  readonly barId?: string;
  /** Extra payload fields to merge into the appended event (e.g. targets). */
  readonly eventExtra?: DeckEventExtra;
}

/**
 * Persist the row diff between `before` and `after` and append the canonical
 * event for the transition, inside the caller's transaction (R4.1, R4.2).
 *
 * Only the cards whose engine state actually changed are upserted, plus the
 * `team_decks` deck-level fields (`next_draw_position`, `draw_override_until`)
 * and, for a draw, the `card_draws` record. The appended event carries the
 * changed cards in the board-projection shape so `applyCardInventoryEvent` folds
 * them without a parallel client source (R4.2).
 *
 * @returns the appended event's `seq`.
 */
export async function persistDeckTransition(
  tx: QueryRunner,
  args: PersistDeckTransitionArgs,
): Promise<number> {
  const { ctx, kind, before, after, barId, eventExtra, seeded } = args;
  const { gameId, teamId } = ctx;

  const definitionIdBySlug = await loadDefinitionIds(tx);

  // Cards whose engine state changed between before and after.
  const beforeById = new Map(before.cards.map((card) => [card.id, card]));
  const changed = after.cards.filter(
    (card) => beforeById.get(card.id)?.state !== card.state,
  );

  // On a seeded first touch the untouched `deck` cards have never been
  // persisted, so materialize the whole roster; otherwise only write the diff.
  // The appended event always carries just the changed cards (R4.2).
  const toUpsert = seeded === true ? after.cards : changed;

  for (const card of toUpsert) {
    await upsertInstance(tx, {
      gameId,
      teamId,
      card,
      pendingBarId: card.state === "pending" ? after.pendingBarId : null,
      definitionId: requireDefinitionId(definitionIdBySlug, card.slug),
    });
  }

  // Deck-level fields: next draw position tracks how many cards have ever left
  // the deck; the Power Hour override is written back verbatim (R4.3).
  const nextDrawPosition = after.cards.filter(
    (card) => card.state !== "deck",
  ).length;
  await tx.query(UPSERT_TEAM_DECK_SQL, [
    gameId,
    teamId,
    nextDrawPosition,
    after.powerHourUntil == null
      ? null
      : new Date(after.powerHourUntil).toISOString(),
  ]);

  // A draw records its bar so the once-per-bar rule survives a reload (R1.4).
  if (kind === "draw" && barId !== undefined) {
    const drawnCount = changed.length;
    await tx.query(INSERT_CARD_DRAW_SQL, [gameId, teamId, barId, drawnCount]);
  }

  const records: CardEventRecord[] = changed.map((card) => ({
    cardId: card.id,
    teamId,
    slug: card.slug,
    state: card.state,
  }));

  const event = await appendEvent(tx, {
    gameId,
    type: EVENT_TYPE_FOR[kind],
    actor: { kind: "team", teamId },
    payload: { teamId, cards: records, ...(eventExtra ?? {}) },
  });

  return event.seq;
}

async function upsertInstance(
  tx: QueryRunner,
  params: {
    readonly gameId: string;
    readonly teamId: string;
    readonly card: CardInstance;
    readonly pendingBarId: string | null;
    readonly definitionId: string;
  },
): Promise<void> {
  const { gameId, teamId, card, pendingBarId, definitionId } = params;
  const nowIso = new Date().toISOString();
  const isHeld = card.state === "hand";
  await tx.query(UPSERT_INSTANCE_SQL, [
    instanceRowId(gameId, teamId, card.slug),
    gameId,
    definitionId,
    teamId,
    card.position,
    card.state,
    enumStateFor(card.state),
    isHeld ? teamId : null,
    pendingBarId,
    isHeld ? nowIso : null,
    card.state === "played" ? nowIso : null,
    card.state === "discarded" ? nowIso : null,
  ]);
}

/**
 * The durable `card_instances.id` (a UUID) for a `(game, team, slug)`. It is
 * deterministic so repeated upserts of the same engine card target the same row:
 * a UUIDv5-style derivation over the stable triple. We use a name-based UUID so
 * the id is reproducible without a round-trip read.
 */
function instanceRowId(gameId: string, teamId: string, slug: CardSlug): string {
  // Deterministic v5-like derivation keyed on the stable triple. randomUUID is
  // not used here because the id must be reproducible across transitions; the
  // engine card id is itself unique per team+slug, so we hash it into a UUID.
  return deterministicUuid(`${gameId}:${teamId}:${slug}`);
}

async function loadDefinitionIds(
  tx: QueryRunner,
): Promise<ReadonlyMap<CardSlug, string>> {
  const { rows } = await tx.query(DEFINITIONS_SQL, []);
  const map = new Map<CardSlug, string>();
  for (const row of rows) {
    const slug = String(row.slug) as CardSlug;
    if (CARD_SLUGS.includes(slug)) {
      map.set(slug, String(row.id));
    }
  }
  return map;
}

function requireDefinitionId(
  map: ReadonlyMap<CardSlug, string>,
  slug: CardSlug,
): string {
  const id = map.get(slug);
  if (id === undefined) {
    throw new Error(
      `persistDeckTransition: no card_definitions row for slug "${slug}" ` +
        `(is the catalog seeded?)`,
    );
  }
  return id;
}

/**
 * Derive a stable UUID (v4-shaped) from a name string. Uses a small FNV-1a hash
 * expanded to 16 bytes so the same name always yields the same id; sufficient
 * for the per-(game,team,slug) key space, which is tiny and collision-free by
 * construction (distinct names never share a derivation here).
 */
function deterministicUuid(name: string): string {
  const bytes = new Uint8Array(16);
  let h = 0x811c9dc5;
  for (let i = 0; i < 16; i += 1) {
    for (let j = 0; j < name.length; j += 1) {
      h ^= name.charCodeAt(j) + i * 131;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    bytes[i] = h & 0xff;
  }
  // Set version (4) and variant bits so it is a syntactically valid UUID.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

// ---------------------------------------------------------------------------
// Convenience: load -> transition -> persist
// ---------------------------------------------------------------------------

/** The engine transition fn signature the convenience wrapper applies. */
export type DeckTransitionFn = (state: DeckState) => {
  readonly ok: boolean;
  readonly state: DeckState;
  readonly reason?: string;
  readonly cardIds?: readonly string[];
};

/** Result of {@link applyDeckTransition}. */
export type ApplyDeckResult =
  | {
      readonly ok: true;
      readonly seq: number;
      readonly state: DeckState;
      readonly cardIds?: readonly string[];
    }
  | { readonly ok: false; readonly reason: string; readonly state: DeckState };

/**
 * Load the deck, apply one pure engine transition, and persist the result with
 * its canonical event — the whole load/transition/persist contract in one call,
 * inside the caller's transaction.
 *
 * If the engine rejects the transition, nothing is persisted and the rejection
 * reason is returned (the caller maps it to an HTTP response).
 */
export async function applyDeckTransition(
  tx: QueryRunner,
  args: {
    readonly ctx: DeckContext;
    readonly kind: DeckTransitionKind;
    readonly transition: DeckTransitionFn;
    readonly barId?: string;
    readonly eventExtra?: DeckEventExtra;
  },
): Promise<ApplyDeckResult> {
  const { state: before, seeded } = await loadDeckStateWithOrigin(tx, args.ctx);
  const result = args.transition(before);
  if (!result.ok) {
    return { ok: false, reason: result.reason ?? "rejected", state: before };
  }
  const seq = await persistDeckTransition(tx, {
    ctx: args.ctx,
    kind: args.kind,
    before,
    after: result.state,
    barId: args.barId,
    eventExtra: args.eventExtra,
    seeded,
  });
  return { ok: true, seq, state: result.state, cardIds: result.cardIds };
}
