-- Migration: 0008_players_team_nullable
-- Feature: game-setup-lobby (Task 12)
-- Makes players.team_id nullable so a joined Player can be teamless until they pick a side.
--
-- The lobby flow is join-first, team-select-second (R3.9): a Player exists in a Game before
-- choosing a Team. The foundation schema (0001) declared players.team_id `not null`, which
-- cannot represent that intermediate teamless state. This migration drops that `not null`
-- constraint so a null team reference is a valid Player row (R10.1).
--
-- Forward-only and non-destructive:
--   * NO FK change is needed. The existing composite FK `players_team_fk (team_id, game_id)`
--     -> teams (id, game_id) already permits a null team_id — Postgres does not FK-check a row
--     whose referencing columns are null (MATCH SIMPLE). WHERE a Player IS associated with a
--     Team, that FK still requires the Team to belong to the Player's own Game (R10.2). This
--     matches the pattern already used by card_instances.holder_team_id and
--     card_plays.target_team_id (nullable + composite FK to teams (id, game_id)).
--   * NO data change. Dropping a `not null` constraint neither reads nor rewrites existing
--     rows, so every existing Player keeps its current Team association (R10.3).
--
-- Requirements covered: 10.1, 10.2, 10.3.

begin;

alter table players
  alter column team_id drop not null;

commit;
