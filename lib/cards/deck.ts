import { CARD_SLUGS, type CardSlug } from "./catalog";
import { seededShuffle } from "./rng";

export type CardInstanceState =
  "deck" | "pending" | "hand" | "played" | "discarded";

export interface CardInstance {
  readonly id: string;
  readonly slug: CardSlug;
  readonly state: CardInstanceState;
  readonly position: number;
}

export interface DeckState {
  readonly teamId: string;
  readonly cards: readonly CardInstance[];
  readonly drawnBarIds: readonly string[];
  readonly pendingBarId: string | null;
  readonly powerHourUntil: number | null;
}

export type DeckRejection =
  | "finish_bar"
  | "duplicate_bar_draw"
  | "hand_full"
  | "pending_draw"
  | "deck_exhausted"
  | "card_not_pending"
  | "card_not_in_hand"
  | "unknown_card";

export type DeckResult =
  | {
      readonly ok: true;
      readonly state: DeckState;
      readonly cardIds?: readonly string[];
    }
  | {
      readonly ok: false;
      readonly state: DeckState;
      readonly reason: DeckRejection;
    };

function replaceCard(
  cards: readonly CardInstance[],
  cardId: string,
  state: CardInstanceState,
): CardInstance[] {
  return cards.map((card) => (card.id === cardId ? { ...card, state } : card));
}

function cardIds(
  cards: readonly CardInstance[],
  state: CardInstanceState,
): string[] {
  return cards.filter((card) => card.state === state).map((card) => card.id);
}

/** Options controlling how {@link seedDeck} orders the freshly seeded deck. */
export interface SeedDeckOptions {
  /**
   * When provided, the deck's draw order is a deterministic Fisher–Yates
   * shuffle of {@link slugs} keyed by this seed, so each team gets its own
   * unpredictable-but-reproducible order (a reload re-derives the SAME order).
   * When omitted, the deck keeps the catalog order — the stable default the
   * engine's property tests rely on. The server derives the seed from the
   * per-game global seed and the team id (`"${gameSeed}:${teamId}"`) so every
   * team in a game shuffles differently and every game shuffles differently.
   */
  readonly shuffleSeed?: string;
  /** The slug roster to seed from; defaults to the full catalog order. */
  readonly slugs?: readonly CardSlug[];
}

export function seedDeck(
  teamId: string,
  options: SeedDeckOptions = {},
): DeckState {
  const baseSlugs = options.slugs ?? CARD_SLUGS;
  const ordered =
    options.shuffleSeed === undefined
      ? baseSlugs
      : seededShuffle(baseSlugs, options.shuffleSeed);
  const cards = ordered.map((slug, position) => ({
    id: `${teamId}:${slug}`,
    slug,
    state: "deck" as const,
    position,
  }));
  return {
    teamId,
    cards,
    drawnBarIds: [],
    pendingBarId: null,
    powerHourUntil: null,
  };
}

export function activatePowerHour(
  state: DeckState,
  now: number,
  durationMs = 20 * 60 * 1000,
): DeckState {
  const until = now + durationMs;
  return {
    ...state,
    powerHourUntil: Math.max(state.powerHourUntil ?? 0, until),
  };
}

export function drawForBar(
  state: DeckState,
  barId: string,
  options: { readonly finishBar?: boolean; readonly now?: number } = {},
): DeckResult {
  if (options.finishBar === true) {
    return { ok: false, state, reason: "finish_bar" };
  }
  if (state.drawnBarIds.includes(barId)) {
    return { ok: false, state, reason: "duplicate_bar_draw" };
  }
  if (state.pendingBarId !== null) {
    return { ok: false, state, reason: "pending_draw" };
  }

  const handCount = cardIds(state.cards, "hand").length;

  const available = state.cards
    .filter((card) => card.state === "deck")
    .sort((left, right) => left.position - right.position);
  if (available.length === 0) {
    return { ok: false, state, reason: "deck_exhausted" };
  }

  // A draw ALWAYS reveals its cards into `pending`, even when the hand is full.
  // The hand-full case is handled at RESOLUTION time: `keepCard` refuses to
  // overflow the hand, so the player must first free a slot (play/discard a held
  // card) or forfeit the draw. This replaces the old pre-reveal `hand_full`
  // rejection, which silently dropped the draw and left the player with no way
  // to recover it (the once-per-bar rule blocked a re-draw).
  //
  // Power Hour is the one case that still keeps BOTH cards directly into the
  // hand with no choice — but only when the hand has room for both; otherwise it
  // falls back to the normal pending choice so nothing is silently dropped.
  const isPowerHourActive =
    state.powerHourUntil !== null && (options.now ?? 0) < state.powerHourUntil;
  const drawCount = Math.min(2, available.length);
  const keepBothDirectly = isPowerHourActive && handCount + drawCount <= 2;

  const selected = available.slice(0, drawCount);
  const nextCards = selected.reduce(
    (cards, card) =>
      replaceCard(cards, card.id, keepBothDirectly ? "hand" : "pending"),
    state.cards,
  );
  return {
    ok: true,
    state: {
      ...state,
      cards: nextCards,
      drawnBarIds: [...state.drawnBarIds, barId],
      pendingBarId: keepBothDirectly ? null : barId,
    },
    cardIds: selected.map((card) => card.id),
  };
}

/** The maximum number of cards a team may hold in hand at once (R2.3). */
export const MAX_HAND = 2;

export function keepCard(state: DeckState, cardId: string): DeckResult {
  if (state.pendingBarId === null) {
    return { ok: false, state, reason: "pending_draw" };
  }
  const card = state.cards.find((candidate) => candidate.id === cardId);
  if (card === undefined || card.state !== "pending") {
    return { ok: false, state, reason: "card_not_pending" };
  }
  // Keeping a card moves it into the hand; refuse if the hand has no room
  // (R2.4). The player must first free a slot by playing/discarding a held card
  // or forfeit the whole draw. A draw can reach `pending` with a full hand now,
  // so this guard is what actually enforces the two-card limit at keep time.
  if (cardIds(state.cards, "hand").length >= MAX_HAND) {
    return { ok: false, state, reason: "hand_full" };
  }
  const pending = cardIds(state.cards, "pending");
  const nextCards = pending.reduce(
    (cards, pendingId) =>
      replaceCard(
        cards,
        pendingId,
        pendingId === cardId ? "hand" : "discarded",
      ),
    state.cards,
  );
  return {
    ok: true,
    state: { ...state, cards: nextCards, pendingBarId: null },
  };
}

export function discardCard(state: DeckState, cardId: string): DeckResult {
  const card = state.cards.find((candidate) => candidate.id === cardId);
  if (card === undefined) {
    return { ok: false, state, reason: "unknown_card" };
  }
  if (card.state !== "pending" && card.state !== "hand") {
    return { ok: false, state, reason: "card_not_in_hand" };
  }
  if (card.state === "pending") {
    const remainingPending = state.cards.filter(
      (candidate) => candidate.state === "pending" && candidate.id !== cardId,
    );
    const discarded = replaceCard(state.cards, cardId, "discarded");
    // Promote the remaining pending card(s) into the hand to resolve the draw —
    // but only while the hand has room (R2.4). With a full hand, discarding one
    // pending card leaves the other(s) pending: the player still has to free a
    // slot or keep/forfeit, so the draw stays open rather than overflowing the
    // hand. The draw is only resolved (pendingBarId cleared) once nothing stays
    // pending.
    let handRoom = MAX_HAND - cardIds(state.cards, "hand").length;
    const resolved = remainingPending.reduce((cards, pending) => {
      if (handRoom <= 0) {
        return cards;
      }
      handRoom -= 1;
      return replaceCard(cards, pending.id, "hand");
    }, discarded);
    const stillPending = resolved.some((entry) => entry.state === "pending");
    return {
      ok: true,
      state: {
        ...state,
        cards: resolved,
        pendingBarId: stillPending ? state.pendingBarId : null,
      },
    };
  }
  const nextState = {
    ...state,
    cards: replaceCard(state.cards, cardId, "discarded"),
  };
  return { ok: true, state: nextState };
}

/**
 * Forfeit the current pending draw (R2.4 hand-full flow): discard EVERY pending
 * card and clear the pending bar, keeping the hand untouched. This is the
 * explicit "I don't want either of these" escape a player uses when the hand is
 * full and they would rather not free a slot. Rejected when there is no pending
 * draw to forfeit.
 *
 * The forfeited cards are gone for the rest of the game (same as a discard), and
 * the bar remains recorded in `drawnBarIds`, so the once-per-bar rule still
 * holds — a forfeited bar cannot be re-drawn.
 */
export function forfeitDraw(state: DeckState): DeckResult {
  if (state.pendingBarId === null) {
    return { ok: false, state, reason: "pending_draw" };
  }
  const pending = cardIds(state.cards, "pending");
  const nextCards = pending.reduce(
    (cards, pendingId) => replaceCard(cards, pendingId, "discarded"),
    state.cards,
  );
  return {
    ok: true,
    state: { ...state, cards: nextCards, pendingBarId: null },
  };
}

export function playCard(state: DeckState, cardId: string): DeckResult {
  const card = state.cards.find((candidate) => candidate.id === cardId);
  if (card === undefined) {
    return { ok: false, state, reason: "unknown_card" };
  }
  if (card.state !== "hand") {
    return { ok: false, state, reason: "card_not_in_hand" };
  }
  return {
    ok: true,
    state: { ...state, cards: replaceCard(state.cards, cardId, "played") },
  };
}
