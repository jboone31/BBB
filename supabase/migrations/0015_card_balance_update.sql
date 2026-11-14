-- Migration: 0015_card_balance_update
-- Brings the static card_definitions catalog (seeded by 0005) in line with the final
-- v1 balance changes. The app reads card text and durations from lib/cards, so this
-- only keeps the database catalog descriptive columns accurate.
--
--   * Power Hour: 20 -> 15 minutes.
--   * Crop Dusting: may now be played inside the finish bar.
--   * Art School Dropout: indigo removed from the allowed colors.
--   * Everyone's a Critic: failure block 15 -> 10 minutes (0005 already said 10).
--
-- Idempotent: plain UPDATEs keyed by slug.

begin;

update card_definitions
   set timer_seconds = 900,
       effect_summary = 'For the next 15 minutes, any team that claims a bar draws two cards and keeps both.'
 where slug = 'power-hour';

update card_definitions
   set effect_summary = 'Played inside any bar (finish bar included); blocks all other teams from entering it for 15 minutes.'
 where slug = 'crop-dusting';

update card_definitions
   set effect_summary = 'Target team must photograph a mural/graffiti/art showing the caster''s 3 distinct colors (red, orange, yellow, green, blue, violet).'
 where slug = 'art-school-dropout';

update card_definitions
   set effect_summary = 'Target team must photo at a 4.5+ star Google location (no research first) or be frozen 10 minutes.'
 where slug = 'everyones-a-critic';

commit;
