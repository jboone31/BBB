/**
 * Brawl Deck Architecture — Task 3: server deck persistence helper (hermetic).
 *
 * These tests exercise the load -> engine transition -> persist contract against
 * an in-memory fake {@link QueryRunner} that models just enough of
 * `card_instances` / `team_decks` / `card_draws` / `card_definitions` /
 * `game_events` for a faithful round-trip. No live Postgres is required, so this
 * runs in the default hermetic suite.
 *
 * Coverage: seed-on-first-touch, draw, keep, discard, and play round-trips, each
 * proving (a) the engine state the helper reloads equals the state it persisted,
 * and (b) the matching canonical event is appended with the changed cards.
 *
 * The live schema (the 0011 check constraints, RLS, FK wiring) is exercised
 * separately by the integration suite under `supabase/__tests__/integration`.
 */

import { describe, expect, it } from "vitest";

import { CARD_SLUGS } from "./catalog";
import {
  seedDeck,
  drawForBar,
  keepCard,
  discardCard,
  playCard,
  type DeckState,
} from "./deck";
import {
  applyDeckTransition,
  engineCardId,
  injectCardToHand,
  loadDeckState,
  slugFromEngineCardId,
} from "./persistence";

// ---------------------------------------------------------------------------
// In-memory fake database
// ---------------------------------------------------------------------------

interface InstanceRow {
  id: string;
  game_id: string;
  definition_id: string;
  owner_team_id: string;
  draw_position: number;
  deck_state: string | null;
  state: string;
  holder_team_id: string | null;
  pending_bar_id: string | null;
  held_at: string | null;
  played_at: string | null;
  discarded_at: string | null;
}

interface DeckRow {
  game_id: string;
  team_id: string;
  next_draw_position: number;
  draw_override_until: string | null;
}

interface DrawRow {
  game_id: string;
  team_id: string;
  bar_id: string;
  cards_drawn: number;
  drawn_at: number;
}

interface AppendedEvent {
  seq: number;
  eventType: string;
  payload: unknown;
}

/**
 * A tiny SQL-shaped store. It does not interpret arbitrary SQL; it recognizes
 * the specific statements the persistence helper and appendEvent issue (matched
 * by a stable substring) and applies them to the in-memory tables.
 */
class FakeDb {
  readonly definitions = new Map<string, string>(); // slug -> definition uuid
  readonly instances = new Map<string, InstanceRow>(); // id -> row
  readonly decks = new Map<string, DeckRow>(); // `${game}:${team}` -> row
  readonly draws: DrawRow[] = [];
  readonly events: AppendedEvent[] = [];
  private seq = 0;
  private drawClock = 0;

  constructor() {
    // Seed the static catalog exactly like 0005.
    CARD_SLUGS.forEach((slug, index) => {
      this.definitions.set(slug, `def-${String(index).padStart(2, "0")}`);
    });
  }

  readonly runner = {
    query: async (
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<{ rows: Record<string, unknown>[] }> => {
      return { rows: this.dispatch(sql, params) };
    },
  };

  private dispatch(
    sql: string,
    params: readonly unknown[],
  ): Record<string, unknown>[] {
    if (sql.includes("from card_definitions") && !sql.includes("join")) {
      return [...this.definitions.entries()].map(([slug, id]) => ({
        id,
        slug,
      }));
    }
    if (sql.includes("from card_instances ci")) {
      const [gameId, teamId] = params as [string, string];
      return [...this.instances.values()]
        .filter((row) => row.game_id === gameId && row.owner_team_id === teamId)
        .sort((a, b) => a.draw_position - b.draw_position)
        .map((row) => ({
          id: row.id,
          definition_id: row.definition_id,
          slug: this.slugForDefinition(row.definition_id),
          deck_state: row.deck_state,
          state: row.state,
          draw_position: row.draw_position,
          pending_bar_id: row.pending_bar_id,
        }));
    }
    if (sql.includes("from card_draws")) {
      const [gameId, teamId] = params as [string, string];
      return this.draws
        .filter((d) => d.game_id === gameId && d.team_id === teamId)
        .sort((a, b) => a.drawn_at - b.drawn_at)
        .map((d) => ({ bar_id: d.bar_id }));
    }
    if (sql.includes("deck_seed") && sql.includes("from games")) {
      // The fake game carries no stored deck seed, so the persistence layer
      // falls back to deriving the per-team shuffle seed from the game id.
      return [{ deck_seed: null }];
    }
    if (sql.includes("from team_decks")) {
      const [gameId, teamId] = params as [string, string];
      const row = this.decks.get(`${gameId}:${teamId}`);
      return row ? [{ draw_override_until: row.draw_override_until }] : [];
    }
    if (sql.includes("insert into team_decks")) {
      const [gameId, teamId, nextPos, override] = params as [
        string,
        string,
        number,
        string | null,
      ];
      this.decks.set(`${gameId}:${teamId}`, {
        game_id: gameId,
        team_id: teamId,
        next_draw_position: nextPos,
        draw_override_until: override,
      });
      return [];
    }
    if (sql.includes("insert into card_instances")) {
      const [
        id,
        gameId,
        definitionId,
        ownerTeamId,
        drawPosition,
        deckState,
        state,
        holderTeamId,
        pendingBarId,
        heldAt,
        playedAt,
        discardedAt,
      ] = params as [
        string,
        string,
        string,
        string,
        number,
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
      ];
      this.instances.set(id, {
        id,
        game_id: gameId,
        definition_id: definitionId,
        owner_team_id: ownerTeamId,
        draw_position: drawPosition,
        deck_state: deckState,
        state,
        holder_team_id: holderTeamId,
        pending_bar_id: pendingBarId,
        held_at: heldAt,
        played_at: playedAt,
        discarded_at: discardedAt,
      });
      return [];
    }
    if (sql.includes("insert into card_draws")) {
      const [gameId, teamId, barId, count] = params as [
        string,
        string,
        string,
        number,
      ];
      const exists = this.draws.some(
        (d) =>
          d.game_id === gameId && d.team_id === teamId && d.bar_id === barId,
      );
      if (!exists) {
        this.draws.push({
          game_id: gameId,
          team_id: teamId,
          bar_id: barId,
          cards_drawn: count,
          drawn_at: this.drawClock++,
        });
      }
      return [];
    }
    if (sql.includes("insert into game_events")) {
      // appendEvent: $2 event_type, $5 payload json.
      const eventType = String(params[1]);
      const payload = JSON.parse(String(params[4]));
      this.seq += 1;
      this.events.push({ seq: this.seq, eventType, payload });
      return [
        {
          id: `evt-${this.seq}`,
          game_id: String(params[0]),
          seq: this.seq,
          event_type: eventType,
          actor_kind: String(params[2]),
          actor_team_id: params[3] ?? null,
          payload,
          created_at: new Date(this.seq).toISOString(),
        },
      ];
    }
    throw new Error(`FakeDb: unhandled SQL: ${sql.slice(0, 60)}`);
  }

  private slugForDefinition(definitionId: string): string {
    for (const [slug, id] of this.definitions) {
      if (id === definitionId) return slug;
    }
    throw new Error(`no slug for definition ${definitionId}`);
  }
}

const GAME = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";
const BAR_A = "33333333-3333-4333-8333-333333333333";
const BAR_B = "44444444-4444-4444-8444-444444444444";

function ctx() {
  return { gameId: GAME, teamId: TEAM };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deck persistence: id mapping", () => {
  it("engineCardId / slugFromEngineCardId round-trip for every slug", () => {
    for (const slug of CARD_SLUGS) {
      const id = engineCardId(TEAM, slug);
      expect(id).toBe(`${TEAM}:${slug}`);
      expect(slugFromEngineCardId(id)).toBe(slug);
    }
  });
});

describe("deck persistence: load (R4.1)", () => {
  it("seeds a fresh deck on first touch via the engine", async () => {
    const db = new FakeDb();
    const loaded = await loadDeckState(db.runner, ctx());
    // First touch shuffles with the per-game, per-team seed (no stored
    // deck_seed -> the game id is the global seed).
    const seeded = seedDeck(TEAM, { shuffleSeed: `${GAME}:${TEAM}` });
    expect(loaded).toEqual(seeded);
    // Nothing was written just by loading.
    expect(db.instances.size).toBe(0);
    expect(db.events).toHaveLength(0);
  });
});

describe("deck persistence: round-trips (R4.1, R4.2)", () => {
  it("draw persists two pending cards and appends cards_drawn", async () => {
    const db = new FakeDb();
    const result = await applyDeckTransition(db.runner, {
      ctx: ctx(),
      kind: "draw",
      transition: (state) => drawForBar(state, BAR_A),
      barId: BAR_A,
    });
    expect(result.ok).toBe(true);

    // Reloading reproduces exactly the engine's post-draw state.
    const reloaded = await loadDeckState(db.runner, ctx());
    if (!result.ok) throw new Error("expected ok");
    expect(reloaded).toEqual(result.state);

    const pending = reloaded.cards.filter((c) => c.state === "pending");
    expect(pending).toHaveLength(2);
    expect(reloaded.pendingBarId).toBe(BAR_A);
    expect(reloaded.drawnBarIds).toEqual([BAR_A]);

    const drawn = db.events.find((e) => e.eventType === "cards_drawn");
    expect(drawn).toBeDefined();
    const payload = drawn?.payload as { cards: { state: string }[] };
    expect(payload.cards).toHaveLength(2);
    expect(payload.cards.every((c) => c.state === "pending")).toBe(true);
  });

  it("keep moves one pending card to hand, discards the other, appends card_kept", async () => {
    const db = new FakeDb();
    const draw = await applyDeckTransition(db.runner, {
      ctx: ctx(),
      kind: "draw",
      transition: (state) => drawForBar(state, BAR_A),
      barId: BAR_A,
    });
    if (!draw.ok) throw new Error("draw failed");
    const keptId = draw.cardIds?.[0];
    expect(keptId).toBeDefined();

    const keep = await applyDeckTransition(db.runner, {
      ctx: ctx(),
      kind: "keep",
      transition: (state) => keepCard(state, keptId as string),
    });
    expect(keep.ok).toBe(true);

    const reloaded = await loadDeckState(db.runner, ctx());
    if (!keep.ok) throw new Error("keep failed");
    expect(reloaded).toEqual(keep.state);

    expect(reloaded.cards.filter((c) => c.state === "hand")).toHaveLength(1);
    expect(reloaded.cards.filter((c) => c.state === "discarded")).toHaveLength(
      1,
    );
    expect(reloaded.cards.find((c) => c.id === keptId)?.state).toBe("hand");
    expect(reloaded.pendingBarId).toBeNull();

    expect(db.events.some((e) => e.eventType === "card_kept")).toBe(true);
  });

  it("discard frees a held card and appends card_discarded", async () => {
    const db = new FakeDb();
    const draw = await applyDeckTransition(db.runner, {
      ctx: ctx(),
      kind: "draw",
      transition: (state) => drawForBar(state, BAR_A),
      barId: BAR_A,
    });
    if (!draw.ok) throw new Error("draw failed");
    const keptId = draw.cardIds?.[0] as string;
    await applyDeckTransition(db.runner, {
      ctx: ctx(),
      kind: "keep",
      transition: (state) => keepCard(state, keptId),
    });

    const discard = await applyDeckTransition(db.runner, {
      ctx: ctx(),
      kind: "discard",
      transition: (state) => discardCard(state, keptId),
    });
    expect(discard.ok).toBe(true);

    const reloaded = await loadDeckState(db.runner, ctx());
    if (!discard.ok) throw new Error("discard failed");
    expect(reloaded).toEqual(discard.state);
    expect(reloaded.cards.find((c) => c.id === keptId)?.state).toBe(
      "discarded",
    );
    expect(db.events.some((e) => e.eventType === "card_discarded")).toBe(true);
  });

  it("play removes a held card from hand and appends card_played with extras", async () => {
    const db = new FakeDb();
    const draw = await applyDeckTransition(db.runner, {
      ctx: ctx(),
      kind: "draw",
      transition: (state) => drawForBar(state, BAR_A),
      barId: BAR_A,
    });
    if (!draw.ok) throw new Error("draw failed");
    const keptId = draw.cardIds?.[0] as string;
    await applyDeckTransition(db.runner, {
      ctx: ctx(),
      kind: "keep",
      transition: (state) => keepCard(state, keptId),
    });

    const play = await applyDeckTransition(db.runner, {
      ctx: ctx(),
      kind: "play",
      transition: (state) => playCard(state, keptId),
      eventExtra: { targetTeamId: "99999999-9999-4999-8999-999999999999" },
    });
    expect(play.ok).toBe(true);

    const reloaded = await loadDeckState(db.runner, ctx());
    if (!play.ok) throw new Error("play failed");
    expect(reloaded).toEqual(play.state);
    expect(reloaded.cards.find((c) => c.id === keptId)?.state).toBe("played");

    const played = db.events.find((e) => e.eventType === "card_played");
    expect(played).toBeDefined();
    const payload = played?.payload as {
      targetTeamId: string;
      cards: { state: string }[];
    };
    expect(payload.targetTeamId).toBe("99999999-9999-4999-8999-999999999999");
    expect(payload.cards[0].state).toBe("played");
  });

  it("a rejected transition persists nothing", async () => {
    const db = new FakeDb();
    // Drawing on the finish bar is rejected by the engine.
    const result = await applyDeckTransition(db.runner, {
      ctx: ctx(),
      kind: "draw",
      transition: (state) => drawForBar(state, BAR_A, { finishBar: true }),
      barId: BAR_A,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toBe("finish_bar");
    expect(db.instances.size).toBe(0);
    expect(db.events).toHaveLength(0);
    expect(db.draws).toHaveLength(0);
  });

  it("the once-per-bar rule survives a reload (drawnBarIds persisted)", async () => {
    const db = new FakeDb();
    await applyDeckTransition(db.runner, {
      ctx: ctx(),
      kind: "draw",
      transition: (state) => drawForBar(state, BAR_A),
      barId: BAR_A,
    });
    // Resolve the pending draw so the next draw is not blocked by pending_draw.
    const reloaded: DeckState = await loadDeckState(db.runner, ctx());
    const keptId = reloaded.cards.find((c) => c.state === "pending")
      ?.id as string;
    await applyDeckTransition(db.runner, {
      ctx: ctx(),
      kind: "keep",
      transition: (state) => keepCard(state, keptId),
    });

    // A fresh load still knows BAR_A was drawn, so re-drawing it is rejected.
    const afterReload = await loadDeckState(db.runner, ctx());
    expect(afterReload.drawnBarIds).toContain(BAR_A);
    const redraw = drawForBar(afterReload, BAR_A);
    expect(redraw.ok).toBe(false);
    if (redraw.ok) throw new Error("expected duplicate rejection");
    expect(redraw.reason).toBe("duplicate_bar_draw");

    // And a different bar can still be drawn after the reload.
    const other = await applyDeckTransition(db.runner, {
      ctx: ctx(),
      kind: "draw",
      transition: (state) => drawForBar(state, BAR_B),
      barId: BAR_B,
    });
    expect(other.ok).toBe(true);
  });
});

describe("deck persistence: dev inject (Task 10; R5.2)", () => {
  it("forces a slug into hand and bypasses the hand-size limit", async () => {
    const db = new FakeDb();
    const inject = await injectCardToHand(db.runner, ctx(), "go-piss-girl");
    expect(inject.ok).toBe(true);
    if (!inject.ok) throw new Error("expected ok");

    const reloaded = await loadDeckState(db.runner, ctx());
    expect(reloaded.cards.find((c) => c.slug === "go-piss-girl")?.state).toBe(
      "hand",
    );
    expect(db.events.some((e) => e.eventType === "card_kept")).toBe(true);

    // Inject two MORE distinct cards — three in hand, over the normal max of 2.
    await injectCardToHand(db.runner, ctx(), "moneybags");
    await injectCardToHand(db.runner, ctx(), "wired");
    const full = await loadDeckState(db.runner, ctx());
    expect(full.cards.filter((c) => c.state === "hand")).toHaveLength(3);
  });

  it("rejects a slug that is not in the catalog", async () => {
    const db = new FakeDb();
    const result = await injectCardToHand(
      db.runner,
      ctx(),
      "not-a-real-card" as never,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.reason).toBe("unknown_card");
    expect(db.events).toHaveLength(0);
  });
});
