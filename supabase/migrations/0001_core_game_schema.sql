-- Migration: 0001_core_game_schema
-- Feature: web-app-foundation (Task 7.1)
-- Creates the core game schema: games, teams, players, bars.
--
-- This is the FIRST migration and establishes the supabase/migrations/ convention:
-- committed, timestamp/sequence-prefixed .sql files applied in ascending order against
-- Supabase Postgres (Req 3.14). Later migrations add claims (7.2), the card tables (7.3),
-- and the append-only game_events backbone (8.1).
--
-- Requirements covered: 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 3.14, 3.15.

begin;

-- Needed for gen_random_uuid(). Supabase enables pgcrypto by default, but declaring it
-- keeps this migration self-contained and idempotent.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums (Req 3.2, 3.4)
-- ---------------------------------------------------------------------------

-- Game lifecycle (Req 3.2): a game is in the lobby, live, or ended.
create type game_lifecycle as enum ('lobby', 'live', 'ended');

-- Why an ended game ended (Req 3.4). Set once on the transition to `ended`; the
-- immutability guard for this column is enforced in application/route logic (Task 10.2).
create type game_end_reason as enum ('finish_bar_claimed', 'admin_ended', 'auto_timeout');

-- ---------------------------------------------------------------------------
-- games (Req 3.1, 3.2, 3.3, 3.4, 3.7)
-- ---------------------------------------------------------------------------
-- games references bars (start_bar_id / finish_bar_id) and bars references games
-- (game_id). To break that circular dependency the games.* bar FKs are added AFTER
-- bars is created (see ALTER TABLE below). This lets us use a COMPOSITE FK so the
-- referenced bar is guaranteed to belong to THIS game (Req 3.7).
create table games (
  id                uuid primary key default gen_random_uuid(),
  -- Req 3.2: lobby | live | ended.
  lifecycle         game_lifecycle not null default 'lobby',
  -- Req 3.7: exactly one start bar and one finish bar per game. Nullable until designated;
  -- FKs added below once `bars` exists.
  start_bar_id      uuid,
  finish_bar_id     uuid,
  -- Req 3.3: UTC time the game went live, so elapsed-since-live is computable for the
  -- 12h auto-end. Null until the game transitions to `live`.
  live_started_at   timestamptz,
  -- Req 3.4: only set when ended.
  end_reason        game_end_reason,
  -- Identity_Model: per-game admin identity is session-based (Req 3.15 -> no cross-game
  -- identity records).
  admin_session_id  text not null,
  -- Players join via this code/link; unique across games.
  join_code         text not null unique,
  created_at        timestamptz not null default now(),

  -- Req 3.7: start and finish bars must differ. NULLs are allowed (undesignated), and the
  -- check only fails when both are set and equal.
  constraint games_start_finish_differ
    check (start_bar_id is null or finish_bar_id is null or start_bar_id <> finish_bar_id),

  -- An ended game has an end_reason; a non-ended game does not (Req 3.4).
  constraint games_end_reason_matches_lifecycle
    check (
      (lifecycle = 'ended' and end_reason is not null)
      or (lifecycle <> 'ended' and end_reason is null)
    ),

  -- A live or ended game has recorded when it went live (Req 3.3).
  constraint games_live_started_at_when_started
    check (
      (lifecycle = 'lobby' and live_started_at is null)
      or (lifecycle <> 'lobby' and live_started_at is not null)
    )
);

-- ---------------------------------------------------------------------------
-- bars (Req 3.1)
-- ---------------------------------------------------------------------------
create table bars (
  id          uuid primary key default gen_random_uuid(),
  -- Bars are game-scoped.
  game_id     uuid not null references games (id) on delete cascade,
  name        text not null,
  -- Nullable now; reserved for later map/claim features (F2.x). Kept as text (lon/lat or
  -- address) to avoid a PostGIS dependency in the foundation; a later migration can widen
  -- this to a geography type without a data redesign.
  location    text,
  created_at  timestamptz not null default now(),

  -- Enables the COMPOSITE FK from games.(start|finish)_bar_id below so the referenced bar
  -- is provably in THIS game (Req 3.7).
  constraint bars_id_game_unique unique (id, game_id)
);

create index bars_game_id_idx on bars (game_id);

-- ---------------------------------------------------------------------------
-- games <-> bars FKs (Req 3.7): "bar in this game"
-- ---------------------------------------------------------------------------
-- Composite FKs reference bars.(id, game_id) with the local (bar_id, id) pair, which forces
-- the designated start/finish bar to belong to the same game row (Req 3.7): the second
-- column of each FK is the game's own primary key, so the referenced bar's game_id must
-- equal this game's id.
--
-- ON DELETE RESTRICT: a bar that is currently designated as start or finish cannot be
-- deleted while designated. (ON DELETE SET NULL is not usable here because the FK is
-- composite and includes games.id, which is NOT NULL; Postgres would attempt to null the
-- whole tuple. Callers clear the designation first, then delete the bar.)
--
-- DEFERRABLE INITIALLY DEFERRED: deleting a game cascade-deletes its bars (bars.game_id ->
-- games.id ON DELETE CASCADE). Deferring these checks to commit lets the whole game +
-- its bars be removed in one transaction without the RESTRICT firing mid-statement.
alter table games
  add constraint games_start_bar_fk
    foreign key (start_bar_id, id)
    references bars (id, game_id)
    on delete restrict
    deferrable initially deferred,
  add constraint games_finish_bar_fk
    foreign key (finish_bar_id, id)
    references bars (id, game_id)
    on delete restrict
    deferrable initially deferred;

-- ---------------------------------------------------------------------------
-- teams (Req 3.1, 3.5)
-- ---------------------------------------------------------------------------
-- Req 3.6 (2-4 teams per game) is a whole-game invariant that cannot be expressed as a row
-- constraint; it is enforced by application validation + the pure start guard (Task 5.1).
create table teams (
  id          uuid primary key default gen_random_uuid(),
  game_id     uuid not null references games (id) on delete cascade,  -- Req 3.5
  name        text not null,
  color       text not null,
  created_at  timestamptz not null default now(),

  -- Enables the composite FK from players.(team_id, game_id) so a player's team belongs to
  -- the player's game.
  constraint teams_id_game_unique unique (id, game_id)
);

create index teams_game_id_idx on teams (game_id);

-- ---------------------------------------------------------------------------
-- players (Req 3.1, 3.5, 3.15)
-- ---------------------------------------------------------------------------
-- Identity is session-based, not account-based (Req 3.15): no persistent cross-game identity
-- records exist. A player exists only within its game, keyed by a per-game session_id.
create table players (
  id            uuid primary key default gen_random_uuid(),
  team_id       uuid not null,
  game_id       uuid not null references games (id) on delete cascade,  -- denormalized for RLS/filtering
  session_id    text not null,
  display_name  text not null,
  created_at    timestamptz not null default now(),

  -- Req 3.5 + integrity: the player's team must belong to the player's game.
  constraint players_team_fk
    foreign key (team_id, game_id)
    references teams (id, game_id)
    on delete cascade,

  -- One player row per session within a game (session-based identity).
  constraint players_game_session_unique unique (game_id, session_id)
);

create index players_team_id_idx on players (team_id);
create index players_game_id_idx on players (game_id);

commit;
