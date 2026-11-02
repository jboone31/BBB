-- Migration: 0014_card_effect_sweep
-- Feature: card-behavior (Task 12.1)
-- Defines the idempotent timer-settlement function bbb_settle_card_effects, the
-- ONLY database-side driver of effect activation/expiry announcements. It mirrors
-- the pure planEffectTransitions model in lib/cards/effects.ts (Task 2.5): for a
-- live game it claims each due activation/expiry transition with a conditional
-- update under the game lock, then appends exactly one effect_activated /
-- effect_expired game_events row per claimed transition, ordered
-- activation-before-expiry then by effectId.
--
-- Follows the 0001-0013 convention: committed, sequence-prefixed .sql applied in
-- ascending order inside one begin/commit. Depends on 0001 (games, game_lifecycle),
-- 0003 (game_events, actor kind, the atomic append rule), 0007 (the auto-timeout
-- sweep redefined below), and 0013 (card_effects, the four engine tables, and the
-- game_events_effect_transition_once partial unique index that backstops this
-- function).
--
-- Deliberately creates NO database-side schedule of any kind: there is no
-- cron.schedule call and no reference to the cron schema here. The function runs
-- ONLY when invoked -- by the member-scoped Settle_Nudge, lazily inside every
-- Card_Behavior_Mutation (pipeline step 3, same tx and game lock), or by the
-- optional Cron_Route. (design.md "Migration 0014_card_effect_sweep.sql".)
--
-- Requirements covered: 19.6, 19.9, 19.10, 20.3b, 20.3c, 20.4, 20.5c, 20.6.

begin;

-- ---------------------------------------------------------------------------
-- bbb_settle_card_effects(p_game_id, p_wait, p_now) -> integer
-- ---------------------------------------------------------------------------
-- Settle the effect transitions that are due at p_now for one live game (or all
-- live games when p_game_id is null), appending exactly one game_events row per
-- transition. Returns the number of events appended.
--
-- This is the SQL twin of planEffectTransitions (lib/cards/effects.ts). The pure
-- planner decides, for a live game and a server instant now:
--   * activation is due when the effect is unannounced (start_announced_at null),
--     has started (starts_at <= now), and was NOT cancelled strictly before its
--     start (cancelled_at null or cancelled_at >= starts_at);
--   * expiry is due when the effect is unannounced (end_announced_at null), has a
--     bounded end that has passed (ends_at not null and ends_at <= now), was never
--     consumed (consumed_at null), and was NOT cancelled strictly before its end
--     (cancelled_at null or cancelled_at >= ends_at);
--   * a delayed effect's activation is ordered before its own expiry;
--   * transitions are ordered by boundary time (at), then effectId, then
--     activation before expiry.
-- This function reproduces those predicates and that order exactly.
--
-- Idempotency / concurrency: each transition is CLAIMED with a conditional update
-- (`set start_announced_at = clock_timestamp() where id = $1 and
-- start_announced_at is null returning id`, and the analogous end_announced_at).
-- The announcement event is appended ONLY when the claiming update returned a row,
-- so a transition announced by an earlier call (concurrent Settle_Nudge, a
-- mutation's lazy settle, or the Cron_Route) is skipped here. All callers are
-- serialized on the game-row lock, so two settles can never both claim the same
-- transition; the game_events_effect_transition_once partial unique index (0013)
-- is the database-level backstop if that lock were ever bypassed.
--
-- No-op for non-live games: a game that is not 'live' contributes no transitions,
-- so a lobby/ended game returns 0 and writes nothing (matches planEffectTransitions
-- returning [] off the live path).
--
-- p_now: mutations pass their own clock_timestamp() read so the sweep and the
-- plan agree on one instant; the Settle_Nudge and Cron_Route pass null and the
-- function reads clock_timestamp() AFTER taking the lock, so only already-due
-- transitions are claimed (20.5c).
--
-- p_wait: true inside a mutation (the caller already holds the lock, so `for
-- update` is a re-entrant no-op) / the Settle_Nudge (wait for the lock); false for
-- the Cron_Route, which uses `for update skip locked` to skip games another writer
-- is already settling rather than block on them.
create or replace function bbb_settle_card_effects(
  p_game_id uuid default null,
  p_wait boolean default false,
  p_now timestamptz default null
)
returns integer
language plpgsql
as $$
declare
  appended_count integer := 0;
  v_game_id      uuid;
  v_now          timestamptz;
  t              record;
  claimed_id     uuid;
begin
  -- Iterate the targeted live games, locking each row as we go, honoring p_wait:
  -- `for update` when the caller asked to wait (Settle_Nudge, or a mutation that
  -- already holds the lock -- a re-entrant no-op), else `for update skip locked`
  -- so the Cron_Route skips games another writer is already settling rather than
  -- blocking on them. The locking clause cannot be parameterized in a static
  -- query, so the selection is built dynamically and driven with FOR ... IN
  -- EXECUTE; Postgres forbids FOR UPDATE under an aggregate/subquery, so we loop
  -- the locking select directly rather than collecting ids first. Each row lock
  -- persists for the whole transaction. Locking per game keeps the seq assignment
  -- below (max(seq)+1) race-free: no other settle or mutation for that game can
  -- interleave between claiming a transition and appending its event. A game that
  -- is not 'live' is never selected, so a lobby/ended game is a no-op (matching
  -- planEffectTransitions returning [] off the live path).
  for v_game_id in execute
    'select g.id
     from games g
     where g.lifecycle = ''live''
       and ($1 is null or g.id = $1)
     order by g.id
     for update ' || case when p_wait then '' else 'skip locked' end
    using p_game_id
  loop
    -- Server instant for THIS game: the caller's own `now` when supplied (so the
    -- sweep and the plan share one instant), else read after taking the lock.
    v_now := coalesce(p_now, clock_timestamp());

    -- Due transitions for this game, in the planEffectTransitions order:
    --   order by at (boundary time), then effect id, then activation before expiry.
    -- `kind_rank` = 0 for activation, 1 for expiry realizes "activation before
    -- expiry" both across effects sharing a boundary time and for one delayed
    -- effect whose activation and expiry are both due in the same call.
    for t in
      -- Activations due now.
      select
        e.id        as effect_id,
        'activated' as kind,
        e.starts_at as at,
        0           as kind_rank
      from card_effects e
      where e.game_id = v_game_id
        and e.start_announced_at is null
        and e.starts_at <= v_now
        and (e.cancelled_at is null or e.cancelled_at >= e.starts_at)
      union all
      -- Expiries due now.
      select
        e.id      as effect_id,
        'expired' as kind,
        e.ends_at as at,
        1         as kind_rank
      from card_effects e
      where e.game_id = v_game_id
        and e.end_announced_at is null
        and e.ends_at is not null
        and e.ends_at <= v_now
        and e.consumed_at is null
        and (e.cancelled_at is null or e.cancelled_at >= e.ends_at)
      order by at asc, effect_id asc, kind_rank asc
    loop
      -- Claim this transition with a conditional update under the game lock. The
      -- `... is null` predicate makes the claim idempotent: if an earlier call
      -- already announced it, no row is returned and we skip the event. Stamp the
      -- announcement time with clock_timestamp() (the actual settle instant).
      claimed_id := null;

      if t.kind = 'activated' then
        update card_effects
        set start_announced_at = clock_timestamp()
        where id = t.effect_id
          and start_announced_at is null
        returning id into claimed_id;
      else
        update card_effects
        set end_announced_at = clock_timestamp()
        where id = t.effect_id
          and end_announced_at is null
        returning id into claimed_id;
      end if;

      -- Only append an event when THIS call claimed the transition.
      if claimed_id is not null then
        insert into game_events (
          game_id, seq, event_type, actor_kind, actor_team_id, payload, created_at
        )
        select
          e.game_id,
          -- seq = max(seq)+1 for this game -- the same contiguous, gap-free rule as
          -- APPEND_EVENT_SQL (lib/events) and the auto-timeout sweep (0007).
          coalesce(
            (select max(ge.seq) from game_events ge where ge.game_id = e.game_id),
            0
          ) + 1,
          case when t.kind = 'activated' then 'effect_activated' else 'effect_expired' end,
          'system'::event_actor_kind,
          null,
          -- Payload mirrors the design: identity fields plus the single effect
          -- record under `effects` (the projection folds it like any record
          -- section). A re-read of the row picks up the announced-at stamp just set.
          jsonb_build_object(
            'effectId',     e.id,
            'slug',         e.slug,
            'kind',         e.kind,
            'barKey',       e.target_bar_key,
            'ownerTeamId',  e.owner_team_id,
            'targetTeamId', e.target_team_id,
            'startsAt',     to_char(e.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'endsAt',
              case
                when e.ends_at is null then null
                else to_jsonb(to_char(e.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
              end,
            'effects', jsonb_build_array(
              jsonb_build_object(
                'effectId',       e.id,
                'slug',           e.slug,
                'kind',           e.kind,
                'sourcePlayId',   e.source_play_id,
                'sourceChallengeId', e.source_challenge_id,
                'ownerTeamId',    e.owner_team_id,
                'targetTeamId',   e.target_team_id,
                'targetBarKey',   e.target_bar_key,
                'startsAt',       to_char(e.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'endsAt',
                  case
                    when e.ends_at is null then null
                    else to_jsonb(to_char(e.ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
                  end,
                'params',         e.params,
                'attachedClaimId', e.attached_claim_id,
                -- The schema stores only attached_bar_id (a bars uuid); the pure
                -- EffectRecord's attachedBarKey is a bar key. Emit the uuid as text,
                -- which is a valid bar key (barResolver matches keys by uuid first).
                'attachedBarKey', e.attached_bar_id::text,
                'protectedPoints', e.protected_points,
                'consumedAt',
                  case
                    when e.consumed_at is null then null
                    else to_jsonb(to_char(e.consumed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
                  end,
                'cancelledAt',
                  case
                    when e.cancelled_at is null then null
                    else to_jsonb(to_char(e.cancelled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
                  end,
                'cancelReason',   e.cancel_reason,
                'startAnnounced', (e.start_announced_at is not null),
                'endAnnounced',   (e.end_announced_at is not null)
              )
            )
          ),
          date_trunc('milliseconds', clock_timestamp())
        from card_effects e
        where e.id = claimed_id;

        appended_count := appended_count + 1;
      end if;
    end loop;
  end loop;

  return appended_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- bbb_run_auto_timeout_sweep(): also cancel the ended games' effects
-- ---------------------------------------------------------------------------
-- The 0007 sweep ends every live game past the 12h window and appends one
-- game_ended event per game. Card behavior adds timed/persistent effects that must
-- not outlive their game: a game ending for any reason cancels its uncancelled,
-- unconsumed effects with cancel_reason = 'game_ended' (Requirement 20.6, matching
-- endGameEffects on the application end path). This redefinition adds a CTE that
-- performs that cancellation for exactly the games this sweep just ended, in the
-- same transaction as the end transition and its event, so state + event + effect
-- cancellation commit or roll back together.
create or replace function bbb_run_auto_timeout_sweep()
returns integer
language plpgsql
as $$
declare
  ended_count integer;
begin
  with due as (
    select g.id
    from games g
    where g.lifecycle = 'live'
      and g.live_started_at is not null
      and g.live_started_at <= now() - bbb_auto_timeout_interval()
    -- Lock each due game; skip any a concurrent writer already holds so the sweep never
    -- blocks on (or double-ends) a game being ended by the app route.
    for update skip locked
  ),
  ended as (
    update games g
    set lifecycle = 'ended',
        end_reason = 'auto_timeout'
    from due
    where g.id = due.id
      -- canEndGame guard: only ever transition from 'live' (Req 5.4/5.5).
      and g.lifecycle = 'live'
    returning g.id
  ),
  -- Cancel the just-ended games' live effects (Requirement 20.6). Mirrors
  -- endGameEffects: only effects not already cancelled or consumed are stamped,
  -- with cancel_reason = 'game_ended' at now(). Effects cancelled this way get NO
  -- end announcement (toastBoundaries / the settle function both ignore an effect
  -- cancelled at or before its end), matching the pure model.
  cancelled as (
    update card_effects c
    set cancelled_at = now(),
        cancel_reason = 'game_ended'
    from ended e
    where c.game_id = e.id
      and c.cancelled_at is null
      and c.consumed_at is null
    returning c.id
  ),
  inserted as (
    insert into game_events (game_id, seq, event_type, actor_kind, actor_team_id, payload, created_at)
    select
      e.id,
      -- seq = max(seq)+1 for this game (contiguous, gap-free) — same rule as APPEND_EVENT_SQL.
      coalesce(
        (select max(ge.seq) from game_events ge where ge.game_id = e.id),
        0
      ) + 1,
      'game_ended',
      'system'::event_actor_kind,
      null,
      jsonb_build_object('endReason', 'auto_timeout'),
      date_trunc('milliseconds', now())
    from ended e
    returning game_id
  )
  select count(*)::integer into ended_count from inserted;

  return ended_count;
end;
$$;

commit;

-- ---------------------------------------------------------------------------
-- Execution grants: server-only (design.md "Migration 0014", step 3)
-- ---------------------------------------------------------------------------
-- bbb_settle_card_effects writes game_events and mutates card_effects, so only the
-- trusted server role the routes use (service_role, which bypasses RLS) may call
-- it. We revoke execute from the browser roles so a client cannot invoke it via
-- PostgREST RPC. Guarded with a DO block so this migration also applies on a bare
-- Postgres (local test DB, CI) that lacks the Supabase default roles.
--
-- Postgres grants EXECUTE on every new function to PUBLIC by default, and anon /
-- authenticated inherit through PUBLIC, so revoking from those two roles alone is
-- not enough: revoke from PUBLIC first (the owner keeps its implicit right and
-- service_role gets an explicit grant below).
revoke execute on function bbb_settle_card_effects(uuid, boolean, timestamptz) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function bbb_settle_card_effects(uuid, boolean, timestamptz) to service_role;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function bbb_settle_card_effects(uuid, boolean, timestamptz) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function bbb_settle_card_effects(uuid, boolean, timestamptz) from authenticated;
  end if;
end;
$$;
