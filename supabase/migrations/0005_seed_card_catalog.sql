-- Migration: 0005_seed_card_catalog
-- Feature: web-app-foundation (Task 7.4)
-- Seeds card_definitions with the FULL finalized v1 card catalog from
-- .kiro/steering/cards.md. This is the static, game-independent catalog created by
-- 0004_cards.sql; it is seeded once and referenced by every game's card_instances.
--
-- Follows the 0001-0004 convention: committed, sequence-prefixed .sql applied in ascending
-- order against Supabase Postgres (Req 3.14). Depends on 0004 (card_definitions).
--
-- The catalog holds 23 finalized v1 cards:
--   * 17 opponent_slowing (15 targeting + 2 no-target: Crop Dusting, Cancel Culture)
--   *  5 economy_boost   (all self/economy -> requires_target = false)
--   *  1 reactive        (Fairest of Them All -> requires_target = false)
--
-- requires_target rule (Req 3.10): true only for opponent_slowing cards that let the
-- casting team choose a team to slow. It is false for the two no-target opponent_slowing
-- cards (Crop Dusting, Cancel Culture) and for every self/economy_boost and reactive card.
--
-- validation_modality / casting_cost / timer_seconds are filled only where cards.md gives a
-- clear hint; everything else is left null for later card-logic features to specify.
--
-- The insert is idempotent: ON CONFLICT (slug) DO NOTHING lets this migration be re-run
-- (or run after a partial seed) without duplicating or mutating existing rows.
--
-- Requirements covered: 3.10, 3.14.

begin;

insert into card_definitions
  (slug, name, card_type, requires_target, validation_modality, casting_cost, timer_seconds, effect_summary)
values
  -- ------------------------------------------------------------------
  -- opponent_slowing -- targeting (requires_target = true)
  -- ------------------------------------------------------------------
  ('go-piss-girl', 'Go Piss Girl', 'opponent_slowing', true, 'photo', null, null,
   'Target team: a member must use a public restroom not inside any bar.'),

  ('moneybags', 'Moneybags', 'opponent_slowing', true, 'photo', null, null,
   'Target team must photograph a retail price tag over $150.'),

  ('use-it-or-lose-it', 'Use It or Lose It', 'opponent_slowing', true, null, null, null,
   'Target team must immediately play every card in its hand.'),

  ('wired', 'Wired', 'opponent_slowing', true, 'photo', null, null,
   'Target team must order an espresso shot from a non-bar location.'),

  ('art-school-dropout', 'Art School Dropout', 'opponent_slowing', true, 'photo', null, null,
   'Target team must photograph a mural/graffiti/art showing 3 distinct ROYGBIV colors.'),

  ('broad-shoulders', 'Broad Shoulders', 'opponent_slowing', true, 'photo', null, null,
   'Target team must take a photo next to an official ATL Tiny Door installation.'),

  ('bird-guide', 'Bird Guide', 'opponent_slowing', true, 'photo', null, null,
   'Target team must film a continuous video keeping a single bird in frame.'),

  ('interested-buyer', 'Interested Buyer', 'opponent_slowing', true, 'photo', null, null,
   'Target team must obtain a souvenir/brochure from an apartment leasing office.'),

  ('different-tastes', 'Different Tastes', 'opponent_slowing', true, 'photo', null, null,
   'Target team must photograph a restaurant with cuisine from the same continent as the caster''s.'),

  ('everyones-a-critic', 'Everyone''s a Critic', 'opponent_slowing', true, 'photo', null, null,
   'Target team must photo at a 4.5+ star Google location (no research first) or be frozen 10 minutes.'),

  ('pioneer', 'Pioneer', 'opponent_slowing', true, null, null, null,
   'Target team''s next claimed bar must be an unclaimed bar that is not the finish bar.'),

  ('spin-cycle', 'Spin Cycle', 'opponent_slowing', true, null, null, null,
   'Target team must return to its most recently claimed bar before it can claim another.'),

  ('dirty-bird', 'Dirty Bird', 'opponent_slowing', true, 'photo', null, null,
   'Target team must photograph a non-team member wearing an Atlanta sports team logo before claiming another bar.'),

  ('scenic-route', 'Scenic Route', 'opponent_slowing', true, null, null, null,
   'Target team''s next claim must be a bar farther from the finish than the last bar their team claimed.'),

  ('voted-off-the-island', 'Voted Off the Island', 'opponent_slowing', true, null, null, null,
   'Only playable once all four teams have claimed a non-starting bar; target team must un-claim a bar all four teams claimed (may re-claim it).'),

  -- ------------------------------------------------------------------
  -- opponent_slowing -- no target (requires_target = false)
  -- ------------------------------------------------------------------
  ('crop-dusting', 'Crop Dusting', 'opponent_slowing', false, 'location', null, 900,
   'Played inside a non-finish bar; blocks all other teams from entering it for 15 minutes.'),

  ('cancel-culture', 'Cancel Culture', 'opponent_slowing', false, 'location', null, 900,
   'Publicly pick a bar; 15 minutes after casting, no bar within 0.25 miles can be claimed for the next 15 minutes.'),

  -- ------------------------------------------------------------------
  -- economy_boost -- self/economy (requires_target = false)
  -- ------------------------------------------------------------------
  ('insurance', 'Insurance', 'economy_boost', false, null, null, null,
   'Self: points from your next claimed bar cannot be reduced by later claimers (other teams still score normally, so the bar total can exceed 12).'),

  ('happy-hour', 'Happy Hour', 'economy_boost', false, 'location', null, 3600,
   'Pick a non-finish bar; any team that drinks there within the next hour gets +5 points for the first drink only.'),

  ('power-hour', 'Power Hour', 'economy_boost', false, null, null, 1200,
   'For the next 20 minutes, any team that claims a bar draws two cards and keeps both.'),

  ('party-crasher', 'Party Crasher', 'economy_boost', false, 'location', null, null,
   'Pick a non-finish bar claimed by fewer than four teams; claimers score as if sharing with one extra phantom team.'),

  ('patient-investor', 'Patient Investor', 'economy_boost', false, null, null, null,
   'Self: after your team claims four more bars, gain +6 points.'),

  -- ------------------------------------------------------------------
  -- reactive (requires_target = false)
  -- ------------------------------------------------------------------
  ('fairest-of-them-all', 'Fairest of Them All', 'reactive', false, null, null, null,
   'Reactive: when a team plays a card against your team, also force the playing team to complete the card''s requirements.')

on conflict (slug) do nothing;

commit;
