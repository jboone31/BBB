-- Migration: 0004_cards
-- Feature: web-app-foundation (Task 7.3)
-- Creates the card layer: card_definitions (static catalog), card_instances (concrete
-- cards within a game), and card_plays (a record of an instance being played).
--
-- Follows the 0001/0002 convention: committed, sequence-prefixed .sql applied in ascending
-- order against Supabase Postgres (Req 3.14). Depends on 0001 (games, teams). This is 0004
-- because 0002 (claims) and 0003 (game_events) are created concurrently by other tasks;
-- using 0004 avoids a filename collision.
--
-- This migration defines schema only. The v1 card catalog is SEEDED separately (Task 7.4),
-- and tests live in Task 7.5.
--
-- Requirements covered: 3.1, 3.10, 3.11, 3.12, 3.14.

begin;

-- pgcrypto (gen_random_uuid) is enabled in 0001; re-declaring keeps this migration
-- self-contained and idempotent.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums (Req 3.10, 3.11)
-- ---------------------------------------------------------------------------

-- Card category (Req 3.10). opponent_slowing cards penalize a target team, economy_boost
-- cards benefit the casting/self team, and reactive cards respond to another play.
create type card_type as enum ('opponent_slowing', 'economy_boost', 'reactive');

-- Card instance lifecycle (Req 3.11): a concrete card is in a team's hand, has been played,
-- or has been discarded. A team's hand = instances with state = 'in_hand'; the played and
-- discarded piles are the other two states, so all three piles are representable.
create type card_instance_state as enum ('in_hand', 'played', 'discarded');

-- ---------------------------------------------------------------------------
-- card_definitions (Req 3.10)
-- ---------------------------------------------------------------------------
-- Static, GAME-INDEPENDENT catalog (Req 3.10): one row per finalized v1 card, seeded once
-- and referenced by every game's instances. There is intentionally no game_id here.
--
-- The nullable metadata columns (validation_modality, casting_cost, timer_seconds) are
-- included now so later card-logic features EXTEND this catalog rather than migrate it,
-- per the "model the full game" requirement.
create table card_definitions (
  id                   uuid primary key default gen_random_uuid(),
  -- Stable identifier used by the seed and app code (e.g., 'go-piss-girl').
  slug                 text not null unique,
  name                 text not null,
  -- Req 3.10: opponent_slowing | economy_boost | reactive.
  card_type            card_type not null,
  -- Req 3.10: whether the card targets a team. False for no-target cards (Crop Dusting,
  -- Cancel Culture) and self/economy cards.
  requires_target      boolean not null,
  -- Nullable: how a play is validated (photo | location | timer | none). Free text now to
  -- leave room for F3.3 validation without locking an enum prematurely.
  validation_modality  text,
  -- Nullable: per-card cost/precondition metadata for cards with playing conditions
  -- (e.g., Voted Off the Island's "all four teams have claimed a non-starting bar").
  casting_cost         jsonb,
  -- Nullable: duration for timed cards (Cancel Culture, Power Hour, Happy Hour).
  timer_seconds        integer,
  effect_summary       text not null,

  -- A validation modality, if present, must be one of the known kinds. Nullable = unset.
  constraint card_definitions_validation_modality_valid
    check (validation_modality is null
           or validation_modality in ('photo', 'location', 'timer', 'none')),

  -- A timer, if present, must be positive.
  constraint card_definitions_timer_seconds_positive
    check (timer_seconds is null or timer_seconds > 0)
);

-- ---------------------------------------------------------------------------
-- card_instances (Req 3.11)
-- ---------------------------------------------------------------------------
-- A concrete card within a specific game (Req 3.11). Game-scoped via game_id; templated by a
-- card_definitions row via definition_id.
--
-- holder_team_id is nullable: a card in a team's hand names its holder; once played or
-- discarded out of hand it may have no holder. The composite FK (matching the 0001/0002
-- teams_id_game_unique pattern) forces the holder team to belong to THIS instance's game.
create table card_instances (
  id             uuid primary key default gen_random_uuid(),
  game_id        uuid not null references games (id) on delete cascade,
  -- Which catalog card this instance is. RESTRICT: a catalog entry can't be deleted while
  -- instances of it exist (the catalog is static seed data, not deleted in normal play).
  definition_id  uuid not null references card_definitions (id) on delete restrict,
  holder_team_id uuid,
  -- Req 3.11: in_hand | played | discarded.
  state          card_instance_state not null default 'in_hand',
  created_at     timestamptz not null default now(),

  -- Req 3.11: the holding team (when set) must belong to this instance's game.
  constraint card_instances_holder_team_fk
    foreign key (holder_team_id, game_id)
    references teams (id, game_id)
    on delete set null,

  -- Enables the composite FK from card_plays.(card_instance_id, game_id) so a play's
  -- instance is provably in the play's game.
  constraint card_instances_id_game_unique unique (id, game_id)
);

create index card_instances_game_id_idx on card_instances (game_id);
create index card_instances_definition_id_idx on card_instances (definition_id);
create index card_instances_holder_team_id_idx on card_instances (holder_team_id);

-- ---------------------------------------------------------------------------
-- card_plays (Req 3.12)
-- ---------------------------------------------------------------------------
-- A record that a card instance was played (Req 3.12): who cast it, an optional target, and
-- when. target_team_id is null for no-target/self cards and set for targeting cards; F3.2
-- will use the events log (not this table) to notify/block the target in real time.
--
-- Every FK is composite against game_id so the played instance, the casting team, and the
-- target team all provably belong to THIS play's game (the 0001/0002 game-scoping pattern).
create table card_plays (
  id               uuid primary key default gen_random_uuid(),
  game_id          uuid not null references games (id) on delete cascade,
  card_instance_id uuid not null,
  casting_team_id  uuid not null,
  target_team_id   uuid,
  -- Req 3.12: when the card was played.
  played_at        timestamptz not null default now(),

  -- Req 3.12: the played instance must belong to this play's game.
  constraint card_plays_instance_fk
    foreign key (card_instance_id, game_id)
    references card_instances (id, game_id)
    on delete cascade,

  -- Req 3.12: the casting team must belong to this play's game.
  constraint card_plays_casting_team_fk
    foreign key (casting_team_id, game_id)
    references teams (id, game_id)
    on delete cascade,

  -- Req 3.12: the target team (when set) must belong to this play's game.
  constraint card_plays_target_team_fk
    foreign key (target_team_id, game_id)
    references teams (id, game_id)
    on delete cascade,

  -- A card cannot target the team that cast it (targeting is opponent-directed; self/economy
  -- cards leave target_team_id null).
  constraint card_plays_target_differs_from_caster
    check (target_team_id is null or target_team_id <> casting_team_id)
);

create index card_plays_game_id_idx on card_plays (game_id);
create index card_plays_card_instance_id_idx on card_plays (card_instance_id);
create index card_plays_casting_team_id_idx on card_plays (casting_team_id);
create index card_plays_target_team_id_idx on card_plays (target_team_id);

commit;
