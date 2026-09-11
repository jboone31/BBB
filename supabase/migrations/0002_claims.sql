-- Migration: 0002_claims
-- Feature: web-app-foundation (Task 7.2)
-- Creates the claims table: one row per (game, team, bar) claim.
--
-- Follows the 0001 convention: committed, sequence-prefixed .sql applied in ascending order
-- against Supabase Postgres (Req 3.14). Depends on 0001 (games, teams, bars).
--
-- Requirements covered: 3.8, 3.9, 3.13, 3.14.

begin;

-- ---------------------------------------------------------------------------
-- claims (Req 3.8, 3.9, 3.13)
-- ---------------------------------------------------------------------------
-- A claim records that a team has claimed a bar (Req 3.8). Claiming is trusted: writing this
-- row is the claim; no drink-completion check happens at the DB layer (design.md `claims`).
--
-- The set of teams currently claiming a bar (Req 3.13) is derived by counting claims rows for
-- a given bar_id; non-finish bar shares come from `computeShares`, and the finish bar awards a
-- solo 12 (guaranteed because claiming the finish bar ends the game, so no second claim can
-- occur).
--
-- Composite FKs (matching the 0001 pattern with teams_id_game_unique / bars_id_game_unique)
-- force the referenced team AND bar to belong to THIS claim's game: the second column of each
-- FK is claims.game_id, so the referenced row's game_id must equal it. This prevents a claim
-- that mixes a team from one game with a bar from another (Req 3.8).
create table claims (
  id          uuid primary key default gen_random_uuid(),
  game_id     uuid not null references games (id) on delete cascade,
  team_id     uuid not null,
  bar_id      uuid not null,
  -- Req 3.8: when the claim was recorded.
  claimed_at  timestamptz not null default now(),

  -- Req 3.8: the claiming team must belong to this claim's game.
  constraint claims_team_fk
    foreign key (team_id, game_id)
    references teams (id, game_id)
    on delete cascade,

  -- Req 3.8: the claimed bar must belong to this claim's game.
  constraint claims_bar_fk
    foreign key (bar_id, game_id)
    references bars (id, game_id)
    on delete cascade,

  -- Req 3.9: a team cannot claim the same bar twice. This uniqueness is the schema-level
  -- "no re-claiming" guarantee.
  constraint claims_game_team_bar_unique unique (game_id, team_id, bar_id)
);

-- Supports "which teams claim this bar" (Req 3.13 share derivation) and game-scoped queries.
create index claims_game_id_idx on claims (game_id);
create index claims_bar_id_idx on claims (bar_id);
create index claims_team_id_idx on claims (team_id);

commit;
