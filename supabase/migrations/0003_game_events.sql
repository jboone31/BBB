-- Migration: 0003_game_events
-- Feature: web-app-foundation (Task 8.1)
-- Creates the append-only `game_events` backbone: the authoritative, immutable, insert-only
-- log that is both the real-time propagation source and the game history (Req 4).
--
-- Applied after 0001 (core schema) and 0002 (claims). Uses 0003 to avoid colliding with the
-- concurrently-authored claims migration (0002).
--
-- Requirements covered: 3.1, 4.1, 4.2, 4.5, 4.6, 3.14.

begin;

-- ---------------------------------------------------------------------------
-- Actor kind (Req 4.2)
-- ---------------------------------------------------------------------------
-- An event's actor is either a team, the admin/host, or the system (e.g. the auto-timeout
-- sweep). Team actors are identified by `actor_team_id`; `admin`/`system` carry no team id.
-- Splitting the discriminator (`actor_kind`) from the team id keeps a real FK on the team
-- reference instead of stuffing a uuid-or-literal into a single text column.
create type event_actor_kind as enum ('team', 'admin', 'system');

-- ---------------------------------------------------------------------------
-- game_events (Req 3.1, 4.1, 4.2, 4.5, 4.6)
-- ---------------------------------------------------------------------------
create table game_events (
  id            uuid primary key default gen_random_uuid(),
  -- Req 4.1: exactly one game per event. Cascade so removing a game removes its log.
  game_id       uuid not null references games (id) on delete cascade,
  -- Req 4.5: per-game strictly-increasing, gap-free sequence. Assigned inside the appending
  -- transaction under a per-game lock (Task 9.1); the unique constraint below is the
  -- database-level guarantee of no duplicates.
  seq           bigint not null,
  -- e.g. claim_recorded, card_played, score_updated. Kept as text so new event types do not
  -- require a migration; validated in the event backbone (Task 9.1).
  event_type    text not null,
  -- Req 4.2: actor is a team id, or the literal `admin`, or `system`.
  actor_kind    event_actor_kind not null,
  actor_team_id uuid,
  -- Req 4.2: arbitrary event body, capped at 16 KB (see check below).
  payload       jsonb not null default '{}'::jsonb,
  -- Req 4.2: UTC, millisecond precision. now() is UTC (timestamptz); ms precision is applied
  -- via date_trunc so stored timestamps never carry sub-millisecond noise.
  created_at    timestamptz not null default date_trunc('milliseconds', now()),

  -- Req 4.5: no duplicate seq within a game. This is the ordering backbone's key invariant.
  constraint game_events_game_seq_unique unique (game_id, seq),

  -- Req 4.5: seq is a positive, monotonic counter (first event is 1).
  constraint game_events_seq_positive check (seq >= 1),

  -- Req 4.2: payload must be <= 16 KB. pg_column_size measures the on-disk (TOAST-aware)
  -- size of the jsonb value in bytes; 16 KB = 16384 bytes.
  constraint game_events_payload_max_16kb check (pg_column_size(payload) <= 16384),

  -- Actor integrity: a `team` actor must carry a team id; `admin`/`system` must not.
  constraint game_events_actor_kind_matches_team
    check (
      (actor_kind = 'team' and actor_team_id is not null)
      or (actor_kind <> 'team' and actor_team_id is null)
    ),

  -- When present, the actor team must belong to THIS event's game (composite FK against the
  -- teams.(id, game_id) unique key established in 0001).
  constraint game_events_actor_team_fk
    foreign key (actor_team_id, game_id)
    references teams (id, game_id)
    on delete restrict
);

-- Read/subscribe path: clients fetch events for a game in ascending seq order (snapshot fold,
-- catch-up after Last_Seen_Sequence). This index serves those ordered per-game scans.
create index game_events_game_seq_idx on game_events (game_id, seq);

-- ---------------------------------------------------------------------------
-- Immutability / insert-only (Req 4.1, 4.6)
-- ---------------------------------------------------------------------------
-- Two layers enforce append-only:
--   1. A BEFORE UPDATE OR DELETE trigger that always raises, so no modification can ever
--      succeed regardless of role, RLS, or how the statement is issued.
--   2. REVOKE of UPDATE/DELETE from the app-facing roles (defense in depth).
-- INSERT remains allowed; committed rows are permanent while the game is not ended, and this
-- spec does not archive/clean up post-end (out of scope).

create or replace function game_events_reject_modification()
returns trigger
language plpgsql
as $$
begin
  -- TG_OP is UPDATE or DELETE here (trigger is scoped to those events).
  raise exception
    'game_events is append-only: % is not permitted (Req 4.1, 4.6)', tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger game_events_no_update_delete
  before update or delete on game_events
  for each row
  execute function game_events_reject_modification();

-- Defense in depth (Req 4.1): the app's anon/authenticated roles get INSERT (and SELECT for
-- the read path) but never UPDATE/DELETE. Trusted server writes use the service role, which
-- is likewise blocked from modifying rows by the trigger above. Roles are Supabase defaults;
-- guarded with a DO block so this migration also applies on a bare Postgres without them.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke update, delete on table game_events from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke update, delete on table game_events from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke update, delete on table game_events from service_role;
  end if;
end;
$$;

commit;
