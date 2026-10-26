-- Migration: 0013_card_behavior
-- Feature: card-behavior (Task 5.1)
-- Adds the durable schema the card-behavior engine persists against: card-driven
-- claim revocation, the enriched card_plays play record, Power Hour keep-all deck
-- mode, and the four new engine tables (card_challenges, card_effects,
-- fairest_offers, card_effect_awards). Links the score ledger to its source
-- effect, and adds the defense-in-depth exactly-once timer-announcement index on
-- game_events.
--
-- Follows the 0001-0012 convention: committed, sequence-prefixed .sql applied in
-- ascending order inside one begin/commit. Depends on 0001 (games, teams, bars),
-- 0002 (claims), 0003 (game_events), 0004 (card_plays), 0009 (team_decks),
-- 0010 (claims revocation fields + score_ledger_entries). The companion timer
-- settlement function lives in 0014.
--
-- Access control matches 0010: members read the new tables; all client
-- INSERT/UPDATE/DELETE is server-only (trusted routes write through the canonical
-- transaction plus event, using the RLS-bypassing service role).
--
-- Requirements covered: 4.1, 4.6, 6.5, 13.6, 18.4, 20.4, 23.1.

begin;

-- ---------------------------------------------------------------------------
-- claims: card-driven revocation reason
-- ---------------------------------------------------------------------------
-- 0010 added revoked_at / revoked_reason for accidental undo. Card behavior adds
-- Voted Off the Island, a second legitimate revocation cause. Constrain the
-- reason to the two known causes so the projection can distinguish them.
alter table claims
  add constraint claims_revoked_reason_valid
    check (revoked_reason is null
           or revoked_reason in ('ordinary_unclaim', 'voted_off'));

-- ---------------------------------------------------------------------------
-- card_plays: the durable play record
-- ---------------------------------------------------------------------------
-- 0004 recorded only who played and an optional target team. The engine needs
-- the played card's slug, an optional target bar (Crop Dusting, Cancel Culture,
-- Happy Hour, Party Crasher, Voted Off), and the validated parameters captured
-- at play time (colors, durations, cuisines, announced bar). The composite bar
-- FK keeps a targeted bar inside this play's game; the (id, game_id) unique key
-- lets the new tables reference a play with the same game-scoping pattern.
alter table card_plays
  add column slug text,
  add column target_bar_id uuid,
  add column target_bar_key text,
  add column params jsonb not null default '{}'::jsonb,
  add constraint card_plays_target_bar_fk
    foreign key (target_bar_id, game_id)
    references bars (id, game_id) on delete cascade,
  add constraint card_plays_params_object
    check (jsonb_typeof(params) = 'object'),
  add constraint card_plays_id_game_unique
    unique (id, game_id);

-- ---------------------------------------------------------------------------
-- team_decks: Power Hour keep-all pending mode
-- ---------------------------------------------------------------------------
-- The ordinary draw keeps one of two pending cards (choose_one). While a Power
-- Hour draw-override effect is live, a team keeps both (keep_all). The legacy
-- draw_override_until column (0009) is left in place but unused.
alter table team_decks
  add column pending_mode text not null default 'choose_one'
    check (pending_mode in ('choose_one', 'keep_all'));

-- ---------------------------------------------------------------------------
-- card_challenges
-- ---------------------------------------------------------------------------
-- An open obligation on a target team created by a challenge play, resolved by
-- the target team, the host, or the system. mirrored_from_* records a challenge
-- produced by Fairest of Them All. failure_effect_id links a failure penalty
-- effect (e.g. Everyone's a Critic claim block) once materialized.
create table card_challenges (
  id                          uuid primary key default gen_random_uuid(),
  game_id                     uuid not null references games (id) on delete cascade,
  source_play_id              uuid not null,
  slug                        text not null,
  caster_team_id              uuid not null,
  target_team_id              uuid not null,
  params                      jsonb not null default '{}'::jsonb,
  mirrored_from_challenge_id  uuid,
  mirrored_from_play_id       uuid,
  status                      text not null default 'open'
    check (status in ('open', 'completed', 'failed', 'cleared_by_host')),
  created_at                  timestamptz not null,
  resolved_at                 timestamptz,
  resolved_by_kind            text check (resolved_by_kind in ('team', 'host', 'system')),
  resolved_by_team_id         uuid,
  resolved_by_session_id      text,
  failure_effect_id           uuid,
  constraint card_challenges_play_fk
    foreign key (source_play_id, game_id)
    references card_plays (id, game_id) on delete cascade,
  constraint card_challenges_caster_fk
    foreign key (caster_team_id, game_id)
    references teams (id, game_id) on delete cascade,
  constraint card_challenges_target_fk
    foreign key (target_team_id, game_id)
    references teams (id, game_id) on delete cascade,
  constraint card_challenges_distinct_teams
    check (caster_team_id <> target_team_id),
  constraint card_challenges_resolution_fields
    check ((status = 'open') = (resolved_at is null)),
  constraint card_challenges_id_game_unique
    unique (id, game_id)
);

create index card_challenges_open_target_idx
  on card_challenges (game_id, target_team_id) where status = 'open';

-- ---------------------------------------------------------------------------
-- card_effects
-- ---------------------------------------------------------------------------
-- A durable, timed or persistent effect produced by a play or challenge: bar /
-- radius / team claim blocks, next-claim restrictions, score protection, bonus
-- windows, phantom shares, claim counters, and the Power Hour draw override.
-- Lifecycle markers (start/end announced, consumed, cancelled) drive the timer
-- settlement function (0014) and the exactly-once announcement events.
create table card_effects (
  id                    uuid primary key default gen_random_uuid(),
  game_id               uuid not null references games (id) on delete cascade,
  source_play_id        uuid,
  source_challenge_id   uuid,
  slug                  text not null,
  kind                  text not null check (kind in (
    'bar_lock', 'radius_lock', 'team_claim_block', 'next_claim_restriction',
    'score_protection', 'bonus_window', 'phantom_share', 'claim_counter', 'draw_override')),
  owner_team_id         uuid,
  target_team_id        uuid,
  target_bar_id         uuid,
  target_bar_key        text,
  starts_at             timestamptz not null,
  ends_at               timestamptz,
  params                jsonb not null default '{}'::jsonb,
  attached_claim_id     uuid,
  attached_bar_id       uuid,
  protected_points      integer,
  consumed_at           timestamptz,
  consumed_by_claim_id  uuid,
  cancelled_at          timestamptz,
  cancel_reason         text check (cancel_reason in ('host', 'game_ended', 'protection_released')),
  start_announced_at    timestamptz,
  end_announced_at      timestamptz,
  created_at            timestamptz not null,
  constraint card_effects_window_valid
    check (ends_at is null or ends_at > starts_at),
  constraint card_effects_cancel_fields
    check ((cancelled_at is null) = (cancel_reason is null)),
  constraint card_effects_owner_fk
    foreign key (owner_team_id, game_id)
    references teams (id, game_id) on delete cascade,
  constraint card_effects_target_team_fk
    foreign key (target_team_id, game_id)
    references teams (id, game_id) on delete cascade,
  constraint card_effects_target_bar_fk
    foreign key (target_bar_id, game_id)
    references bars (id, game_id) on delete cascade,
  constraint card_effects_attached_claim_fk
    foreign key (attached_claim_id, game_id)
    references claims (id, game_id) on delete cascade,
  constraint card_effects_id_game_unique
    unique (id, game_id)
);

create index card_effects_live_idx on card_effects (game_id, kind)
  where cancelled_at is null and consumed_at is null;
create index card_effects_due_idx on card_effects (starts_at, ends_at)
  where cancelled_at is null and (start_announced_at is null or end_announced_at is null);

-- ---------------------------------------------------------------------------
-- fairest_offers
-- ---------------------------------------------------------------------------
-- A pending option for a team holding Fairest of Them All to mirror a challenge
-- or a next-claim restriction back onto the original caster. Exactly one of
-- challenge_id / restriction_effect_id names the mirrored subject. The offer is
-- unique per (source play, holder team).
create table fairest_offers (
  id                      uuid primary key default gen_random_uuid(),
  game_id                 uuid not null references games (id) on delete cascade,
  source_play_id          uuid not null,
  slug                    text not null,
  holder_team_id          uuid not null,
  original_caster_team_id uuid not null,
  challenge_id            uuid,
  restriction_effect_id   uuid,
  status                  text not null default 'pending'
    check (status in ('pending', 'played', 'declined', 'void')),
  decided_at              timestamptz,
  decided_by_session_id   text,
  mirrored_challenge_id   uuid,
  mirrored_effect_id      uuid,
  created_at              timestamptz not null,
  constraint fairest_offers_once
    unique (source_play_id, holder_team_id),
  constraint fairest_offers_subject
    check ((challenge_id is not null) <> (restriction_effect_id is not null))
);

-- ---------------------------------------------------------------------------
-- card_effect_awards
-- ---------------------------------------------------------------------------
-- A scoring award attributed to an effect (Happy Hour bonus, Patient Investor
-- award). Each award points at the ledger entry that applied it and, when
-- reversed, the ledger entry that undid it. The partial unique index enforces at
-- most one live (un-reversed) award per (effect, team).
create table card_effect_awards (
  id                        uuid primary key default gen_random_uuid(),
  game_id                   uuid not null references games (id) on delete cascade,
  effect_id                 uuid not null,
  team_id                   uuid not null,
  kind                      text not null check (kind in ('happy_hour_bonus', 'patient_investor_award')),
  claim_id                  uuid,          -- null for Bonus_Claim
  ledger_entry_id           uuid not null references score_ledger_entries (id) on delete cascade,
  reversed_at               timestamptz,
  reversal_ledger_entry_id  uuid references score_ledger_entries (id) on delete cascade,
  created_at                timestamptz not null,
  constraint card_effect_awards_effect_fk
    foreign key (effect_id, game_id)
    references card_effects (id, game_id) on delete cascade
);

create unique index card_effect_awards_one_live
  on card_effect_awards (effect_id, team_id) where reversed_at is null;

-- ---------------------------------------------------------------------------
-- score_ledger_entries: link card-effect entries to their source effect
-- ---------------------------------------------------------------------------
-- Card-driven ledger entries (happy_hour_bonus, patient_investor_award, and
-- their reversals) name the effect that produced them so the projection can
-- attribute and reconcile them. The composite FK keeps the effect in the same
-- game as the entry.
alter table score_ledger_entries
  add column source_effect_id uuid;
alter table score_ledger_entries
  add constraint score_ledger_entries_effect_fk
    foreign key (source_effect_id, game_id)
    references card_effects (id, game_id) on delete cascade;

-- ---------------------------------------------------------------------------
-- game_events: exactly-once timer announcements (defense in depth)
-- ---------------------------------------------------------------------------
-- The timer settlement function (0014) appends at most one effect_activated and
-- one effect_expired event per effect, claiming each transition under the game
-- lock. This partial unique index is the database-level backstop: a second
-- transition event for the same effect can never be inserted.
create unique index game_events_effect_transition_once
  on game_events (game_id, (payload->>'effectId'), event_type)
  where event_type in ('effect_activated', 'effect_expired');

-- ---------------------------------------------------------------------------
-- RLS and server-only writes (same pattern as 0010)
-- ---------------------------------------------------------------------------
-- Members may read the new tables for the live projection. There are
-- deliberately no client INSERT/UPDATE/DELETE policies: every write happens in a
-- trusted server route inside the canonical transaction plus event, using the
-- RLS-bypassing service role. We also revoke those grants from the browser roles
-- for defense in depth.
alter table card_challenges enable row level security;
create policy card_challenges_member_select on card_challenges
  for select using (bbb_is_game_member(game_id));

alter table card_effects enable row level security;
create policy card_effects_member_select on card_effects
  for select using (bbb_is_game_member(game_id));

alter table fairest_offers enable row level security;
create policy fairest_offers_member_select on fairest_offers
  for select using (bbb_is_game_member(game_id));

alter table card_effect_awards enable row level security;
create policy card_effect_awards_member_select on card_effect_awards
  for select using (bbb_is_game_member(game_id));

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke insert, update, delete on table card_challenges from anon;
    revoke insert, update, delete on table card_effects from anon;
    revoke insert, update, delete on table fairest_offers from anon;
    revoke insert, update, delete on table card_effect_awards from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke insert, update, delete on table card_challenges from authenticated;
    revoke insert, update, delete on table card_effects from authenticated;
    revoke insert, update, delete on table fairest_offers from authenticated;
    revoke insert, update, delete on table card_effect_awards from authenticated;
  end if;
end;
$$;

commit;
