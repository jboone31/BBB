-- Migration: 0007_auto_timeout_sweep
-- Feature: web-app-foundation (Task 10.3)
-- Sets up the AUTHORITATIVE auto-timeout trigger: a scheduled sweep that ends every live
-- game whose `live_started_at` is more than 12h in the past (design.md "Auto-timeout trigger
-- mechanism", scheduled sweep — recommended). This guarantees a game ends even if no client
-- ever touches it again, which is the whole point of a timeout for abandoned play (Req 5.2).
--
-- Applied after 0006 (RLS). Uses 0007 to avoid colliding with 0006.
--
-- Every end transition is a Game_State_Change (Req 5.3): per due game this sets
-- lifecycle='ended', end_reason='auto_timeout' AND inserts EXACTLY ONE game_events row in the
-- SAME transaction, mirroring the atomic append rule in `lib/events/index.ts`
-- (APPEND_EVENT_SQL: lock the game row, seq = max(seq)+1, single insert). The lifecycle guard
-- (`canEndGame`: only from 'live') and end_reason immutability (Req 5.4/5.5) are enforced by
-- the `where lifecycle = 'live'` predicate — an already-ended game is never re-ended, so its
-- end_reason never changes.
--
-- Requirements covered: 5.2, 5.3.

begin;

-- ---------------------------------------------------------------------------
-- The 12-hour window (Req 5.2)
-- ---------------------------------------------------------------------------
-- Kept as a single named constant via a SQL function so the SQL sweep and the documented
-- schedule share one definition. This mirrors AUTO_TIMEOUT_MS (12h) in `lib/gameend/index.ts`
-- and the `isDueForAutoTimeout` predicate (`now - live_started_at >= 12h`). The boundary is
-- inclusive: exactly 12h elapsed is due.
create or replace function bbb_auto_timeout_interval()
returns interval
language sql
immutable
as $$
  select interval '12 hours';
$$;

-- ---------------------------------------------------------------------------
-- The atomic per-game end transition, applied to every due live game (Req 5.3)
-- ---------------------------------------------------------------------------
-- Runs the SAME atomic rule as the application `endGame`/`appendEvent` path, but purely in
-- SQL so the scheduled job needs no external process:
--   * `due` selects live games past the 12h window, locking each row FOR UPDATE so a
--     concurrent app-side end (Task 10.2) and this sweep cannot both end the same game
--     (skip locked rows another writer already holds).
--   * `ended` flips lifecycle -> 'ended' and stamps end_reason='auto_timeout'. The
--     `and lifecycle = 'live'` predicate is the `canEndGame` guard: a game that another
--     transaction ended in the meantime is skipped, so end_reason is never overwritten
--     (immutability, Req 5.4/5.5).
--   * `insert into game_events ... select ... from ended` writes EXACTLY ONE event per
--     game just ended, at seq = max(seq)+1 for that game (same formula as APPEND_EVENT_SQL),
--     actor 'system' (the sweep is not a team or the admin), created_at at UTC-ms precision.
-- All three happen in one statement inside the function's transaction, so state change + event
-- commit or roll back together (Req 5.3, atomic write of Req 4).
--
-- Returns the number of games ended, so the schedule/log can report sweep activity.
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
-- Schedule the sweep (Req 5.2) — pg_cron, guarded for availability
-- ---------------------------------------------------------------------------
-- pg_cron is available on Supabase (enable in the dashboard / `create extension`). Where it is
-- present we schedule `bbb_run_auto_timeout_sweep()` to run every 5 minutes, so a game that
-- crosses the 12h line is ended within a few minutes of becoming due. The whole block is
-- guarded so this migration still applies cleanly on a bare Postgres (e.g. local test DB, CI)
-- that has no pg_cron: there we simply skip scheduling and rely on the server-side entrypoint
-- (`lib/gameend/autoTimeoutSweep.ts`) invoked by the cron route or an external scheduler.
--
-- ALTERNATIVE (documented, not enabled here): instead of pg_cron you may deploy a Supabase
-- scheduled Edge Function (or any external cron, e.g. Vercel Cron) that calls the protected
-- route `POST /api/cron/auto-timeout`, which invokes `runAutoTimeoutSweep` and reuses the
-- application `endGame` transition. Either trigger drives the identical atomic end write.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;

    -- Idempotent (re)scheduling: unschedule any prior job of the same name first so repeated
    -- migrations do not stack duplicate jobs, then (re)create it.
    if exists (select 1 from cron.job where jobname = 'bbb_auto_timeout_sweep') then
      perform cron.unschedule('bbb_auto_timeout_sweep');
    end if;

    perform cron.schedule(
      'bbb_auto_timeout_sweep',
      '*/5 * * * *',                 -- every 5 minutes
      $sweep$ select bbb_run_auto_timeout_sweep(); $sweep$
    );
  else
    raise notice
      'pg_cron not available: skipping scheduled auto-timeout sweep. Drive bbb_run_auto_timeout_sweep() (or POST /api/cron/auto-timeout) from an external scheduler instead.';
  end if;
end;
$$;
