import { CARD_SLUGS, type CardSlug } from "./catalog";

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

export function seedDeck(
  teamId: string,
  slugs: readonly CardSlug[] = CARD_SLUGS,
): DeckState {
  const cards = slugs.map((slug, position) => ({
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
  if (handCount >= 2) {
    return { ok: false, state, reason: "hand_full" };
  }

  const available = state.cards
    .filter((card) => card.state === "deck")
    .sort((left, right) => left.position - right.position);
  if (available.length === 0) {
    return { ok: false, state, reason: "deck_exhausted" };
  }

  const isPowerHourActive =
    state.powerHourUntil !== null && (options.now ?? 0) < state.powerHourUntil;
  const drawCount = Math.min(2, available.length);
  if (isPowerHourActive && handCount + drawCount > 2) {
    return { ok: false, state, reason: "hand_full" };
  }

  const selected = available.slice(0, drawCount);
  const nextCards = selected.reduce(
    (cards, card) =>
      replaceCard(cards, card.id, isPowerHourActive ? "hand" : "pending"),
    state.cards,
  );
  return {
    ok: true,
    state: {
      ...state,
      cards: nextCards,
      drawnBarIds: [...state.drawnBarIds, barId],
      pendingBarId: isPowerHourActive ? null : barId,
    },
    cardIds: selected.map((card) => card.id),
  };
}

export function keepCard(state: DeckState, cardId: string): DeckResult {
  if (state.pendingBarId === null) {
    return { ok: false, state, reason: "pending_draw" };
  }
  const card = state.cards.find((candidate) => candidate.id === cardId);
  if (card === undefined || card.state !== "pending") {
    return { ok: false, state, reason: "card_not_pending" };
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
    const resolved = remainingPending.reduce(
      (cards, pending) => replaceCard(cards, pending.id, "hand"),
      discarded,
    );
    return {
      ok: true,
      state: { ...state, cards: resolved, pendingBarId: null },
    };
  }
  const nextState = {
    ...state,
    cards: replaceCard(state.cards, cardId, "discarded"),
  };
  return { ok: true, state: nextState };
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
