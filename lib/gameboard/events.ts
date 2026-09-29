/**
 * Game_Board event types + pure reducer (design.md §Components 1, §Data Models).
 *
 * Like the lobby (`lib/lobby/events.ts`), the Game_Board does not maintain a
 * separate "current state" table: its view of the world is derived by folding the
 * append-only `game_events` log (see `supabase/migrations/0003_game_events.sql`)
 * in ascending `seq` order. This module supplies:
 *
 *   1. The Game_Board `event_type` string constants ({@link GAME_BOARD_EVENT_TYPES})
 *      the board interprets — a superset of the lobby types it needs plus the one
 *      new `wireframe_card_played` type this feature writes.
 *   2. A pure fold ({@link applyGameBoardEvent} / {@link foldGameBoardEvents}) that
 *      turns a game's event log into a {@link GameBoardView} the Game_Board_Client
 *      renders, plus {@link dismissTargetedNotice} for the notification dismissal
 *      (R7.5).
 *
 * It mirrors the lobby reducer's idempotence guard (ignore any event with
 * `seq <= lastSeenSequence`) and single-game isolation (reject a foreign
 * `gameId`), so re-delivery from the realtime transport never double-applies an
 * event (R8.3) and a board view only ever folds its own game's events (R8.4).
 *
 * The module is pure and framework-free (no I/O, no Next.js) so it is the
 * property-test target for Properties 4, 5, 9, and 10. It reuses the
 * {@link GameEvent} shape from `lib/events` so the reducer consumes exactly the
 * rows the event backbone produces.
 *
 * Requirements: 1.4, 4.1, 4.2, 7.5, 7.8, 8.2, 8.3, 8.4.
 */

import type { GameEvent } from "@/lib/events";

/**
 * The Game_Board `event_type` string constants (design.md §Components 1).
 *
 * A superset of the lobby event types the board needs to fold (`game_created` /
 * `team_created` for scoreboard Team identities/colors, `game_started` /
 * `game_ended` for the lifecycle gate) plus the one new type this feature writes:
 *
 *   - `game_created`         — a Game was created (carries Team-less game facts).
 *   - `team_created`         — a Team was created with a name + color (R4.1, R4.2).
 *   - `game_started`         — the Game transitioned `lobby → live`.
 *   - `game_ended`           — the Game transitioned to `ended` (R1.4).
 *   - `wireframe_card_played`— a wireframe targeting card play; folded into a
 *     {@link TargetedNotice} for the target Team (R7).
 */
export const GAME_BOARD_EVENT_TYPES = {
  gameCreated: "game_created",
  teamCreated: "team_created",
  gameStarted: "game_started",
  gameEnded: "game_ended",
  deckSeeded: "deck_seeded",
  cardsDrawn: "cards_drawn",
  cardKept: "card_kept",
  cardDiscarded: "card_discarded",
  cardPlayed: "card_played",
  challengeIssued: "challenge_issued",
  challengeConfirmed: "challenge_confirmed",
  challengeRejected: "challenge_rejected",
  effectCreated: "effect_created",
  effectActivated: "effect_activated",
  effectExpired: "effect_expired",
  claimBlocked: "claim_blocked",
  claimRecorded: "claim_recorded",
  claimRemoved: "claim_removed",
  scoreAwarded: "score_awarded",
  scoreModifierApplied: "score_modifier_applied",
  notificationCreated: "notification_created",
  wireframeCardPlayed: "wireframe_card_played",
} as const;

/** A Game_Board `event_type` string (one of {@link GAME_BOARD_EVENT_TYPES}'s values). */
export type GameBoardEventType =
  (typeof GAME_BOARD_EVENT_TYPES)[keyof typeof GAME_BOARD_EVENT_TYPES];

/** The lifecycle phases a Game moves through (mirrors `games.lifecycle`). */
export type GameBoardLifecycle = "lobby" | "live" | "ended";

/**
 * A Team as seen on the Game_Board: its id, display name, and assigned color
 * (design.md §Components 1). Drives the Scoreboard_Region rows (R4.1, R4.2) and
 * the Card_Play_Wireframe target list (R6.2).
 */
export interface BoardTeamView {
  readonly id: string;
  readonly name: string;
  readonly color: string;
}

/**
 * One pending targeted notification folded from a `wireframe_card_played` event
 * (design.md §Components 1; R7).
 */
export interface TargetedNotice {
  /** The event `seq` that produced it — the stable identity for de-dup + dismissal. */
  readonly seq: number;
  readonly castingTeamId: string;
  readonly targetTeamId: string;
  readonly cardId: string;
}

export type BoardCardState =
  "deck" | "pending" | "hand" | "played" | "discarded";

export interface BoardCardView {
  readonly cardId: string;
  readonly teamId: string;
  readonly slug: string;
  readonly state: BoardCardState;
}

export interface BoardChallengeView {
  readonly challengeId: string;
  readonly sourcePlayId: string;
  readonly casterTeamId: string;
  readonly targetTeamId: string;
  readonly status: string;
  readonly blocksClaims: boolean;
}

export interface BoardEffectView {
  readonly effectId: string;
  readonly sourcePlayId: string;
  readonly effectType: string;
  readonly ownerTeamId: string | null;
  readonly targetTeamId: string | null;
  readonly targetBarId: string | null;
  readonly active: boolean;
}

export interface BoardNotificationView {
  readonly notificationId: string;
  readonly sourcePlayId: string | null;
  readonly audience: string;
  readonly teamId: string | null;
  readonly display: Readonly<Record<string, unknown>>;
}

export interface BoardScoreEntryView {
  readonly entryId: string;
  readonly teamId: string;
  readonly category: string;
  readonly points: number;
  readonly sourceId: string | null;
}

/**
 * The folded Game_Board state the Game_Board_Client renders (design.md
 * §Components 1, §Data Models).
 *
 * Everything here is derived purely from the game's event log:
 *
 *   - `gameId`: the game this view describes.
 *   - `lifecycle`: `lobby` until `game_started` flips it to `live`, then `ended`
 *     on `game_ended` — drives the access gate (R1).
 *   - `teams`: the Team roster (id, name, color) built from `game_created` /
 *     `team_created`; the scoreboard rows + target list.
 *   - `targetedNotices`: one notice per `wireframe_card_played` event (R7.8);
 *     folded for all teams, filtered to the viewing Team by the client (R7.3).
 *   - `lastSeenSequence`: the highest `seq` folded in — the idempotence watermark
 *     (mirrors the lobby/realtime guard).
 */
export interface GameBoardView {
  readonly gameId: string;
  readonly lifecycle: GameBoardLifecycle;
  readonly teams: BoardTeamView[];
  /** Notices whose `targetTeamId` is the viewing team; one per targeting event (R7.8). */
  readonly targetedNotices: TargetedNotice[];
  readonly cards: BoardCardView[];
  readonly activeChallenges: BoardChallengeView[];
  readonly activeEffects: BoardEffectView[];
  readonly activeRestrictions: BoardEffectView[];
  readonly notifications: BoardNotificationView[];
  readonly scoreEntries: BoardScoreEntryView[];
  readonly lastSeenSequence: number;
}

/**
 * The `lastSeenSequence` of a view with no events folded in. Per-game `seq`
 * starts at 1 (see `FIRST_SEQ` in `lib/events`), so 0 unambiguously means
 * "nothing applied yet" — matching `NO_EVENTS_SEQ` in the generic snapshot fold.
 */
export const NO_EVENTS_SEQ = 0;

/**
 * The starting Game_Board view for a game before any event is applied (the base
 * case of the fold; design.md §Components 1).
 *
 * @param gameId the game the (empty) view describes.
 * @returns a fresh {@link GameBoardView} with no events folded in.
 */
export function initialGameBoardView(gameId: string): GameBoardView {
  return {
    gameId,
    lifecycle: "lobby",
    teams: [],
    targetedNotices: [],
    cards: [],
    activeChallenges: [],
    activeEffects: [],
    activeRestrictions: [],
    notifications: [],
    scoreEntries: [],
    lastSeenSequence: NO_EVENTS_SEQ,
  };
}

/**
 * Pure single-event reducer: fold one event into the running Game_Board view
 * (design.md §Components 1; R8.3, R8.4). Idempotent (ignores
 * `seq <= lastSeenSequence`) and single-game (rejects a foreign `gameId`).
 *
 * @param view the running Game_Board view to fold into.
 * @param event the next event to apply.
 * @returns the resulting {@link GameBoardView} (a new object; `view` is not mutated).
 * @throws {RangeError} if `event.gameId` does not match `view.gameId`.
 */
export function applyGameBoardEvent(
  view: GameBoardView,
  event: GameEvent,
): GameBoardView {
  if (event.gameId !== view.gameId) {
    throw new RangeError(
      `applyGameBoardEvent: event for game ${event.gameId} cannot be applied to a Game_Board view for game ${view.gameId}`,
    );
  }

  // Ignore stale/duplicate events: a view only moves forward in seq. This keeps
  // the reducer idempotent so re-delivered events do not double-apply (R8.3),
  // matching the guard in lib/lobby/events.applyLobbyEvent.
  if (event.seq <= view.lastSeenSequence) {
    return view;
  }

  // Advance the watermark for every fresh event, then interpret the payload.
  const advanced: GameBoardView = { ...view, lastSeenSequence: event.seq };

  switch (event.eventType) {
    case GAME_BOARD_EVENT_TYPES.gameCreated:
    case GAME_BOARD_EVENT_TYPES.teamCreated:
      return applyTeamFromPayload(advanced, event.payload);
    case GAME_BOARD_EVENT_TYPES.gameStarted:
      return { ...advanced, lifecycle: "live" };
    case GAME_BOARD_EVENT_TYPES.gameEnded:
      return { ...advanced, lifecycle: "ended" };
    case GAME_BOARD_EVENT_TYPES.deckSeeded:
    case GAME_BOARD_EVENT_TYPES.cardsDrawn:
    case GAME_BOARD_EVENT_TYPES.cardKept:
    case GAME_BOARD_EVENT_TYPES.cardDiscarded:
    case GAME_BOARD_EVENT_TYPES.cardPlayed:
      return applyCardInventoryEvent(advanced, event);
    case GAME_BOARD_EVENT_TYPES.challengeIssued:
      return applyChallengeIssued(advanced, event.payload);
    case GAME_BOARD_EVENT_TYPES.challengeConfirmed:
    case GAME_BOARD_EVENT_TYPES.challengeRejected:
      return applyChallengeResolved(advanced, event.payload);
    case GAME_BOARD_EVENT_TYPES.effectCreated:
    case GAME_BOARD_EVENT_TYPES.effectActivated:
      return applyEffectCreated(advanced, event.payload);
    case GAME_BOARD_EVENT_TYPES.effectExpired:
      return removeExpiredEffect(advanced, event.payload);
    case GAME_BOARD_EVENT_TYPES.notificationCreated:
      return applyNotificationCreated(advanced, event.payload);
    case GAME_BOARD_EVENT_TYPES.scoreAwarded:
    case GAME_BOARD_EVENT_TYPES.scoreModifierApplied:
      return applyScoreEntry(advanced, event.payload);
    case GAME_BOARD_EVENT_TYPES.claimBlocked:
    case GAME_BOARD_EVENT_TYPES.claimRecorded:
    case GAME_BOARD_EVENT_TYPES.claimRemoved:
      return advanced;
    case GAME_BOARD_EVENT_TYPES.wireframeCardPlayed:
      return applyWireframeCardPlayed(advanced, event);
    default:
      // Unknown/foreign event type: the watermark has advanced so the fold stays
      // aligned with the generic snapshot, but the board domain fields are left
      // untouched.
      return advanced;
  }
}

/**
 * Fold a set of a game's events into a {@link GameBoardView} by applying them in
 * ascending `seq` order (design.md §Components 1; R8.2).
 *
 * @param gameId the game whose events are being folded.
 * @param events the events to fold (any arrival order; duplicates tolerated).
 * @returns the folded {@link GameBoardView}.
 */
export function foldGameBoardEvents(
  gameId: string,
  events: readonly GameEvent[],
): GameBoardView {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  return ordered.reduce(applyGameBoardEvent, initialGameBoardView(gameId));
}

/**
 * Remove a folded notice by its producing event `seq`, leaving all other notices
 * unchanged (design.md §Components 1; R7.5 dismissal).
 *
 * @param view the current Game_Board view.
 * @param seq the producing event `seq` of the notice to dismiss.
 * @returns a new {@link GameBoardView} without the named notice.
 */
export function dismissTargetedNotice(
  view: GameBoardView,
  seq: number,
): GameBoardView {
  const remaining = view.targetedNotices.filter((notice) => notice.seq !== seq);
  // Nothing matched: return the view unchanged so dismissal of an absent notice
  // is a no-op rather than allocating an equivalent view.
  if (remaining.length === view.targetedNotices.length) {
    return view;
  }
  return { ...view, targetedNotices: remaining };
}

// ---------------------------------------------------------------------------
// Payload interpreters
//
// The event `payload` is typed `unknown` on GameEvent (it round-trips through
// jsonb), so each interpreter narrows the fields it reads defensively: a missing
// or wrong-typed field leaves the corresponding view field unchanged rather than
// throwing, keeping the fold total over any stored payload. This mirrors the
// lobby reducer's defensive payload reads (lib/lobby/events.ts).
// ---------------------------------------------------------------------------

/** Read a string field from an unknown payload, or `undefined` if absent/wrong-typed. */
function readString(payload: unknown, key: string): string | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(payload: unknown, key: string): number | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readBoolean(payload: unknown, key: string): boolean | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

function readRecords(payload: unknown, key: string): Record<string, unknown>[] {
  if (payload === null || typeof payload !== "object") {
    return [];
  }
  const value = (payload as Record<string, unknown>)[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry),
  );
}

function readRecord(payload: unknown): Record<string, unknown> | undefined {
  return payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
}

function cardFromRecord(
  record: Record<string, unknown>,
  fallbackState: BoardCardState,
): BoardCardView | undefined {
  const cardId = typeof record.cardId === "string" ? record.cardId : undefined;
  const teamId = typeof record.teamId === "string" ? record.teamId : undefined;
  const slug = typeof record.slug === "string" ? record.slug : undefined;
  const state = typeof record.state === "string" ? record.state : fallbackState;
  if (
    cardId === undefined ||
    teamId === undefined ||
    slug === undefined ||
    !["deck", "pending", "hand", "played", "discarded"].includes(state)
  ) {
    return undefined;
  }
  return { cardId, teamId, slug, state: state as BoardCardState };
}

function upsertCard(
  cards: readonly BoardCardView[],
  card: BoardCardView,
): BoardCardView[] {
  const withoutCard = cards.filter((entry) => entry.cardId !== card.cardId);
  return [...withoutCard, card];
}

function applyCardInventoryEvent(
  view: GameBoardView,
  event: GameEvent,
): GameBoardView {
  const fallbackState: BoardCardState =
    event.eventType === GAME_BOARD_EVENT_TYPES.cardsDrawn
      ? "pending"
      : event.eventType === GAME_BOARD_EVENT_TYPES.cardKept
        ? "hand"
        : event.eventType === GAME_BOARD_EVENT_TYPES.cardDiscarded
          ? "discarded"
          : event.eventType === GAME_BOARD_EVENT_TYPES.cardPlayed
            ? "played"
            : "deck";
  const payloadRecord = readRecord(event.payload);
  const records = readRecords(event.payload, "cards");
  if (records.length === 0 && payloadRecord !== undefined) {
    records.push(payloadRecord);
  }
  const cards = records
    .map((record) => cardFromRecord(record, fallbackState))
    .filter((card): card is BoardCardView => card !== undefined)
    .reduce(upsertCard, view.cards);
  return cards.length === view.cards.length &&
    cards.every((card, index) => card === view.cards[index])
    ? view
    : { ...view, cards };
}

function applyChallengeIssued(
  view: GameBoardView,
  payload: unknown,
): GameBoardView {
  const challengeId = readString(payload, "challengeId");
  const sourcePlayId = readString(payload, "sourcePlayId");
  const casterTeamId = readString(payload, "casterTeamId");
  const targetTeamId = readString(payload, "targetTeamId");
  if (
    challengeId === undefined ||
    sourcePlayId === undefined ||
    casterTeamId === undefined ||
    targetTeamId === undefined
  ) {
    return view;
  }
  if (
    view.activeChallenges.some(
      (challenge) => challenge.challengeId === challengeId,
    )
  ) {
    return view;
  }
  const challenge: BoardChallengeView = {
    challengeId,
    sourcePlayId,
    casterTeamId,
    targetTeamId,
    status: readString(payload, "status") ?? "awaiting_confirmation",
    blocksClaims: readBoolean(payload, "blocksClaims") ?? true,
  };
  return { ...view, activeChallenges: [...view.activeChallenges, challenge] };
}

function applyChallengeResolved(
  view: GameBoardView,
  payload: unknown,
): GameBoardView {
  const challengeId = readString(payload, "challengeId");
  if (challengeId === undefined) {
    return view;
  }
  return {
    ...view,
    activeChallenges: view.activeChallenges.filter(
      (challenge) => challenge.challengeId !== challengeId,
    ),
  };
}

function applyEffectCreated(
  view: GameBoardView,
  payload: unknown,
): GameBoardView {
  const effectId = readString(payload, "effectId");
  const sourcePlayId = readString(payload, "sourcePlayId");
  const effectType = readString(payload, "effectType");
  if (
    effectId === undefined ||
    sourcePlayId === undefined ||
    effectType === undefined
  ) {
    return view;
  }
  const effect: BoardEffectView = {
    effectId,
    sourcePlayId,
    effectType,
    ownerTeamId: readString(payload, "ownerTeamId") ?? null,
    targetTeamId: readString(payload, "targetTeamId") ?? null,
    targetBarId: readString(payload, "targetBarId") ?? null,
    active: readBoolean(payload, "active") ?? true,
  };
  const effects = view.activeEffects.filter(
    (entry) => entry.effectId !== effectId,
  );
  const activeEffects = [...effects, effect];
  const activeRestrictions = activeEffects.filter(isRestrictionEffect);
  return { ...view, activeEffects, activeRestrictions };
}

function isRestrictionEffect(effect: BoardEffectView): boolean {
  return /block|restriction|lock/i.test(effect.effectType);
}

function removeExpiredEffect(
  view: GameBoardView,
  payload: unknown,
): GameBoardView {
  const id = readString(payload, "effectId");
  if (id === undefined) {
    return view;
  }
  return {
    ...view,
    activeEffects: view.activeEffects.filter((entry) => entry.effectId !== id),
    activeRestrictions: view.activeRestrictions.filter(
      (entry) => entry.effectId !== id,
    ),
  };
}

function applyNotificationCreated(
  view: GameBoardView,
  payload: unknown,
): GameBoardView {
  const notificationId = readString(payload, "notificationId");
  const audience = readString(payload, "audience");
  if (notificationId === undefined || audience === undefined) {
    return view;
  }
  if (
    view.notifications.some(
      (notification) => notification.notificationId === notificationId,
    )
  ) {
    return view;
  }
  const display = readRecord(payload)?.display;
  const notification: BoardNotificationView = {
    notificationId,
    sourcePlayId: readString(payload, "sourcePlayId") ?? null,
    audience,
    teamId: readString(payload, "teamId") ?? null,
    display:
      display !== null && typeof display === "object" && !Array.isArray(display)
        ? (display as Readonly<Record<string, unknown>>)
        : {},
  };
  return { ...view, notifications: [...view.notifications, notification] };
}

function applyScoreEntry(view: GameBoardView, payload: unknown): GameBoardView {
  const entryId = readString(payload, "entryId");
  const teamId = readString(payload, "teamId");
  const category = readString(payload, "category");
  const points = readNumber(payload, "points");
  if (
    entryId === undefined ||
    teamId === undefined ||
    category === undefined ||
    points === undefined
  ) {
    return view;
  }
  if (view.scoreEntries.some((entry) => entry.entryId === entryId)) {
    return view;
  }
  const entry: BoardScoreEntryView = {
    entryId,
    teamId,
    category,
    points,
    sourceId: readString(payload, "sourceId") ?? null,
  };
  return { ...view, scoreEntries: [...view.scoreEntries, entry] };
}

/**
 * Fold a `game_created` / `team_created` event into the Team roster
 * (design.md §Components 1; R4.1, R4.2).
 *
 * Both event types carry the same `{ teamId, name, color }` Team-identifying
 * payload the lobby routes append, so the scoreboard has real Team
 * identities/colors to render. A payload missing any of those fields (e.g. a
 * `game_created` event that carries only game-level facts) adds no Team, and a
 * repeat for the same team id is a no-op.
 */
function applyTeamFromPayload(
  view: GameBoardView,
  payload: unknown,
): GameBoardView {
  const id = readString(payload, "teamId");
  const name = readString(payload, "name");
  const color = readString(payload, "color");
  if (id === undefined || name === undefined || color === undefined) {
    return view;
  }
  if (view.teams.some((team) => team.id === id)) {
    return view;
  }
  const team: BoardTeamView = { id, name, color };
  return { ...view, teams: [...view.teams, team] };
}

/**
 * Fold a `wireframe_card_played` event into a {@link TargetedNotice}
 * (design.md §Components 1; R7.8).
 *
 * The notice's identity is the producing event `seq` (stable for de-dup +
 * dismissal). Because the reducer is fed only the game's own events and the
 * idempotence guard drops any `seq <= lastSeenSequence`, each targeting event
 * yields exactly one notice and re-delivery never duplicates it. Notices are
 * folded for all teams; the client filters to the current Team when deciding
 * what to present (R7.3). A payload missing any of the required ids adds no
 * notice.
 */
function applyWireframeCardPlayed(
  view: GameBoardView,
  event: GameEvent,
): GameBoardView {
  const castingTeamId = readString(event.payload, "castingTeamId");
  const targetTeamId = readString(event.payload, "targetTeamId");
  const cardId = readString(event.payload, "cardId");
  if (
    castingTeamId === undefined ||
    targetTeamId === undefined ||
    cardId === undefined
  ) {
    return view;
  }
  const notice: TargetedNotice = {
    seq: event.seq,
    castingTeamId,
    targetTeamId,
    cardId,
  };
  return { ...view, targetedNotices: [...view.targetedNotices, notice] };
}
