-- Migration: 0011_card_deck_state
-- Feature: brawl-deck-architecture (Task 3)
-- Gives card_instances / team_decks a durable representation of the FULL deck
-- engine lifecycle (lib/cards/deck.ts), so the server-side persistence helper
-- can round-trip a team's DeckState without a schema rewrite.
--
-- Why a new column instead of extending the card_instance_state enum:
--   * The 0004 `card_instance_state` enum intentionally names only the three
--     terminal/holding piles (in_hand | played | discarded); a schema test pins
--     it to exactly those members.
--   * The deck engine has FIVE states — deck, pending, hand, played, discarded —
--     plus a transient pending-draw. `deck` and `pending` have no enum member.
--   * Postgres `alter type ... add value` cannot be used in the same transaction
--     that adds it, and enum values can never be removed — so extending the enum
--     would break this repo's single begin/commit migration convention and would
--     be an irreversible one-way door.
--
-- Instead we add a dedicated, reversible `deck_state` text column that carries
-- the engine's five-state lifecycle, keep the existing enum owning the terminal
-- piles, and widen the 0009 lifecycle check so pre-hand (deck/pending) rows are
-- representable. The Power Hour draw-override seam already exists on
-- team_decks.draw_override_until and is left untouched.
--
-- Follows the 0001-0010 convention: committed, sequence-prefixed .sql applied in
-- ascending order inside one begin/commit (Req 3.14). Depends on 0004 + 0009.
--
-- Requirements covered: 4.1, 4.2, 4.3.

begin;

-- ---------------------------------------------------------------------------
-- card_instances: full engine lifecycle marker
-- ---------------------------------------------------------------------------
-- `deck_state` carries the deck engine's five-state lifecycle for an instance.
-- It is the authoritative state the persistence helper reads/writes; the legacy
-- `state` enum is kept in lockstep for the three overlapping terminal/holding
-- piles so existing policies/indexes keyed on `state` keep working.
--
--   deck      -> seeded, not yet drawn            (enum state in_hand, not held)
--   pending   -> drawn into the current draw      (enum state in_hand, not held)
--   hand      -> kept into the team's hand         (enum state in_hand, held)
--   played    -> played out of hand                (enum state played)
--   discarded -> discarded out of hand/pending     (enum state discarded)
alter table card_instances
  add column deck_state text,
  -- The bar whose draw produced a pending card (null unless deck_state=pending),
  -- so a reconstructed DeckState can tie pending cards back to their draw.
  add column pending_bar_id uuid;

alter table card_instances
  add constraint card_instances_deck_state_valid
    check (
      deck_state is null
      or deck_state in ('deck', 'pending', 'hand', 'played', 'discarded')
    ),
  -- pending_bar_id is set only for cards currently pending from a draw.
  add constraint card_instances_pending_bar_only_when_pending
    check (
      pending_bar_id is null
      or deck_state = 'pending'
    ),
  add constraint card_instances_pending_bar_fk
    foreign key (pending_bar_id, game_id)
    references bars (id, game_id)
    on delete set null;

-- Replace the 0009 lifecycle check so pre-hand (deck/pending) engine rows are
-- representable: those carry no holder and none of the terminal timestamps. The
-- three terminal/holding branches are unchanged. When deck_state is null (rows
-- the engine does not manage) the original three-branch rule still applies.
alter table card_instances
  drop constraint if exists card_instances_lifecycle_fields_valid;

alter table card_instances
  add constraint card_instances_lifecycle_fields_valid
    check (
      -- Pre-hand engine states: no holder, no terminal timestamps.
      (deck_state in ('deck', 'pending')
         and holder_team_id is null
         and held_at is null
         and played_at is null
         and discarded_at is null)
      -- Held in hand.
      or (state = 'in_hand' and holder_team_id is not null and held_at is not null)
      -- Played out of hand.
      or (state = 'played' and holder_team_id is null and played_at is not null)
      -- Discarded out of hand/pending.
      or (state = 'discarded' and holder_team_id is null and discarded_at is not null)
    );

create index card_instances_owner_deck_state_idx
  on card_instances (game_id, owner_team_id, deck_state, draw_position);

commit;
