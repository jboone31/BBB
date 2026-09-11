-- Migration: 0006_rls_policies
-- Feature: web-app-foundation (Task 11.1)
-- Enables Row-Level Security (RLS) on every game-scoped table and adds per-game
-- isolation policies: a session may read/write a row only when the session's game
-- membership matches that row's game_id (Req 7.2).
--
-- Applied after 0001 (games, teams, players, bars), 0002 (claims), 0003 (game_events),
-- and 0004 (card_definitions, card_instances, card_plays). Uses 0006 to avoid colliding
-- with the concurrently-authored 0005 seed migration (Task 7.4).
--
-- This migration defines access control only; the live cross-game denial is exercised by
-- integration Task 18.5 (no tests are added here).
--
-- Requirements covered: 7.2.

begin;

-- ===========================================================================
-- Session / membership mechanism
-- ===========================================================================
-- Identity_Model (design.md, Req 1.7 / 3.15) is *session-based*, not account-based:
-- there are no cross-game identity records. Supabase Auth issues a per-game session
-- token (JWT) and RLS keys off it. The session identifier used throughout BBB is the
-- session_id stored on `players.session_id` and `games.admin_session_id`.
--
-- We resolve "the current session id" from two sources, in order:
--   1. The Supabase JWT `sub` claim, i.e. auth.jwt() ->> 'sub' — the request's session
--      subject when the anon/authenticated role serves a browser request. This is the
--      normal production path.
--   2. A GUC fallback, current_setting('bbb.session_id', true) — usable on a bare Postgres
--      (or from a trusted server route that wants to impersonate a session with
--      `set local`) where the Supabase auth.jwt() helper is not installed.
--
-- A session is a MEMBER of a game if either:
--   * a players row exists for (game_id, session_id) — a joined player, OR
--   * the game's admin_session_id equals the session id — the host/admin.
--
-- The membership lookup is wrapped in a SECURITY DEFINER function. This is required so the
-- policies on `players` and `games` can consult those same tables WITHOUT triggering
-- infinite RLS recursion: the function runs as its owner and reads the base tables
-- directly, returning only a boolean. It is marked STABLE (same result within a
-- statement) and its search_path is pinned for safety.

-- Returns the current session id from the JWT `sub` claim, falling back to the
-- bbb.session_id GUC. Returns NULL when neither is present (e.g. an unauthenticated
-- anon request), which makes every membership check below fail closed.
create or replace function bbb_current_session_id()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  sid text;
begin
  -- auth.jwt() is provided by Supabase (GoTrue). Guard the reference so this migration
  -- also applies on a bare Postgres that lacks the auth schema.
  begin
    sid := nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '');
  exception
    when others then
      sid := null;
  end;

  if sid is null then
    sid := nullif(current_setting('bbb.session_id', true), '');
  end if;

  return sid;
end;
$$;

comment on function bbb_current_session_id() is
  'Resolves the current BBB session id from the Supabase JWT sub claim '
  '(request.jwt.claims -> sub), falling back to the bbb.session_id GUC. '
  'NULL when unauthenticated, so membership checks fail closed.';

-- True iff the current session is a member of the given game: a joined player
-- (players.session_id) or the game admin (games.admin_session_id). SECURITY DEFINER so
-- it can read players/games without recursing through their own RLS policies.
create or replace function bbb_is_game_member(target_game_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  sid text;
begin
  sid := bbb_current_session_id();

  if sid is null or target_game_id is null then
    return false;  -- fail closed: no session or no game => no access
  end if;

  return exists (
           select 1 from players p
           where p.game_id = target_game_id
             and p.session_id = sid
         )
      or exists (
           select 1 from games g
           where g.id = target_game_id
             and g.admin_session_id = sid
         );
end;
$$;

comment on function bbb_is_game_member(uuid) is
  'True iff the current session (see bbb_current_session_id) belongs to target_game_id '
  'as a joined player or the game admin. Used by every per-game RLS policy.';

-- Lock the membership helpers down: only the app-facing roles may call them, and only
-- if those roles exist (Supabase defaults; guarded for bare Postgres).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    grant execute on function bbb_current_session_id() to anon;
    grant execute on function bbb_is_game_member(uuid) to anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function bbb_current_session_id() to authenticated;
    grant execute on function bbb_is_game_member(uuid) to authenticated;
  end if;
end;
$$;

-- ===========================================================================
-- service_role note (Req 7.2, trusted server writes)
-- ===========================================================================
-- In Supabase the service_role BYPASSES RLS by default (it has the BYPASSRLS attribute),
-- so the server-only routes that use the service key (Component 5 / Task 10) can perform
-- trusted writes across game rows without being blocked by the policies below. We do NOT
-- add FORCE ROW LEVEL SECURITY here: forcing RLS would also apply it to the table owner /
-- service_role and defeat that intentional bypass. The anon key (browser) has no such
-- attribute and is therefore always subject to the policies below.

-- ===========================================================================
-- games (keyed by id — the game's own primary key IS the game_id)
-- ===========================================================================
-- A session sees / mutates only games it is a member of. Membership for `games` is checked
-- against the row's own id.
alter table games enable row level security;

create policy games_member_select on games
  for select using (bbb_is_game_member(id));

create policy games_member_insert on games
  for insert with check (bbb_is_game_member(id));

create policy games_member_update on games
  for update using (bbb_is_game_member(id)) with check (bbb_is_game_member(id));

create policy games_member_delete on games
  for delete using (bbb_is_game_member(id));

-- ===========================================================================
-- Per-game tables: policy = "the row's game_id is one I'm a member of"
-- ===========================================================================
-- Each table below carries a game_id column. The SELECT/UPDATE/DELETE "using" clause and
-- the INSERT/UPDATE "with check" clause all reduce to bbb_is_game_member(game_id), so a
-- session can only touch rows in games it belongs to (Req 7.2). Cross-game reads and
-- writes are denied, leaving the other game's data unchanged.

-- --- bars ------------------------------------------------------------------
alter table bars enable row level security;

create policy bars_member_select on bars
  for select using (bbb_is_game_member(game_id));
create policy bars_member_insert on bars
  for insert with check (bbb_is_game_member(game_id));
create policy bars_member_update on bars
  for update using (bbb_is_game_member(game_id)) with check (bbb_is_game_member(game_id));
create policy bars_member_delete on bars
  for delete using (bbb_is_game_member(game_id));

-- --- teams -----------------------------------------------------------------
alter table teams enable row level security;

create policy teams_member_select on teams
  for select using (bbb_is_game_member(game_id));
create policy teams_member_insert on teams
  for insert with check (bbb_is_game_member(game_id));
create policy teams_member_update on teams
  for update using (bbb_is_game_member(game_id)) with check (bbb_is_game_member(game_id));
create policy teams_member_delete on teams
  for delete using (bbb_is_game_member(game_id));

-- --- players ---------------------------------------------------------------
-- players carries game_id (denormalized precisely for RLS, per 0001). Membership is checked
-- against that game_id; bbb_is_game_member reads players via SECURITY DEFINER so this is not
-- self-recursive.
alter table players enable row level security;

create policy players_member_select on players
  for select using (bbb_is_game_member(game_id));
create policy players_member_insert on players
  for insert with check (bbb_is_game_member(game_id));
create policy players_member_update on players
  for update using (bbb_is_game_member(game_id)) with check (bbb_is_game_member(game_id));
create policy players_member_delete on players
  for delete using (bbb_is_game_member(game_id));

-- --- claims ----------------------------------------------------------------
alter table claims enable row level security;

create policy claims_member_select on claims
  for select using (bbb_is_game_member(game_id));
create policy claims_member_insert on claims
  for insert with check (bbb_is_game_member(game_id));
create policy claims_member_update on claims
  for update using (bbb_is_game_member(game_id)) with check (bbb_is_game_member(game_id));
create policy claims_member_delete on claims
  for delete using (bbb_is_game_member(game_id));

-- --- game_events -----------------------------------------------------------
-- game_events is already append-only (0003): a BEFORE UPDATE/DELETE trigger rejects all
-- modification and UPDATE/DELETE are revoked from app roles. RLS adds per-game scoping on
-- top: a session reads only its game's events (the real-time subscribe/snapshot path) and
-- may insert only into its own game. We still declare update/delete policies scoped to the
-- game for completeness/defense-in-depth; the trigger remains the hard guarantee.
alter table game_events enable row level security;

create policy game_events_member_select on game_events
  for select using (bbb_is_game_member(game_id));
create policy game_events_member_insert on game_events
  for insert with check (bbb_is_game_member(game_id));
create policy game_events_member_update on game_events
  for update using (bbb_is_game_member(game_id)) with check (bbb_is_game_member(game_id));
create policy game_events_member_delete on game_events
  for delete using (bbb_is_game_member(game_id));

-- --- card_instances --------------------------------------------------------
alter table card_instances enable row level security;

create policy card_instances_member_select on card_instances
  for select using (bbb_is_game_member(game_id));
create policy card_instances_member_insert on card_instances
  for insert with check (bbb_is_game_member(game_id));
create policy card_instances_member_update on card_instances
  for update using (bbb_is_game_member(game_id)) with check (bbb_is_game_member(game_id));
create policy card_instances_member_delete on card_instances
  for delete using (bbb_is_game_member(game_id));

-- --- card_plays ------------------------------------------------------------
alter table card_plays enable row level security;

create policy card_plays_member_select on card_plays
  for select using (bbb_is_game_member(game_id));
create policy card_plays_member_insert on card_plays
  for insert with check (bbb_is_game_member(game_id));
create policy card_plays_member_update on card_plays
  for update using (bbb_is_game_member(game_id)) with check (bbb_is_game_member(game_id));
create policy card_plays_member_delete on card_plays
  for delete using (bbb_is_game_member(game_id));

-- ===========================================================================
-- card_definitions (GLOBAL catalog — NOT game-scoped)
-- ===========================================================================
-- card_definitions has no game_id: it is a static, game-independent catalog (0004) seeded
-- once (Task 7.4) and referenced by every game's instances. Per-game RLS does not apply.
-- We still ENABLE RLS (so it is not silently unrestricted) and add a read-all policy so any
-- client can render card metadata, while writes remain reserved for the migration/seed and
-- the service_role (which bypasses RLS). This keeps the catalog readable without leaking any
-- per-game data.
alter table card_definitions enable row level security;

create policy card_definitions_read_all on card_definitions
  for select using (true);
-- No insert/update/delete policy => under RLS, non-bypassing roles (anon/authenticated)
-- cannot modify the catalog; only the service_role (bypass) and the migration may seed it.

commit;
