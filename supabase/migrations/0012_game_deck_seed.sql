-- Migration: 0012_game_deck_seed
-- Feature: brawl-deck-architecture (UAT hotfix: per-team shuffle streams)
-- Adds a per-game global deck seed so each team's Brawl Deck is shuffled on its
-- own deterministic stream.
--
-- Why a per-game seed:
--   * Before this, every team's deck was seeded in the fixed catalog order, so
--     all teams in all games drew the SAME cards in the SAME order — not a
--     shuffle at all (the UAT finding).
--   * The deck engine now shuffles a freshly seeded deck with a Fisher–Yates
--     pass keyed by `"${deck_seed}:${teamId}"` (lib/cards/rng.ts). A single
--     per-game `deck_seed` therefore yields a DIFFERENT order per team, and a
--     new seed per game yields different orders across games, while a reload
--     re-derives the SAME order (the shuffle is pure in that key).
--
-- The column is nullable and the persistence layer falls back to the immutable
-- game id when it is null, so games created before this migration still shuffle
-- (deterministically per team) without a backfill. The start route populates it
-- with a fresh random value when a game goes live, making the global seed
-- explicit and auditable.
--
-- Follows the 0001-0011 convention: committed, sequence-prefixed .sql applied in
-- ascending order inside one begin/commit. Depends on 0001 (games).

begin;

-- A per-game global seed string. Null until the game goes live (or for games
-- created before this migration); the server derives per-team shuffle streams
-- from it, falling back to the game id when null.
alter table games
  add column deck_seed text;

commit;
