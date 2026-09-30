-- Migration: 0010_claims_and_score_ledger
-- Feature: map-and-claiming Phase 1
-- Adds reversible claim history, active-claim uniqueness, and the append-only
-- score adjustment ledger used by the durable claim transaction.

begin;

-- ---------------------------------------------------------------------------
-- claims lifecycle
-- ---------------------------------------------------------------------------
-- The foundation migration used one unique row for the lifetime of a claim.
-- Section 2 needs both ordinary accidental undo and future card-driven removal,
-- while retaining the historical claim transition for audit and scoring.
alter table claims
  add column revoked_at timestamptz,
  add column revoked_reason text;

alter table claims
  add constraint claims_revocation_fields_valid
    check (revoked_at is null or revoked_reason is not null),
  add constraint claims_id_game_unique
    unique (id, game_id);

alter table claims
  drop constraint claims_game_team_bar_unique;

-- At most one current claim exists for a team/bar pair. Revoked history remains
-- queryable and a later claim gets a new row and a new claim id.
create unique index claims_active_game_team_bar_unique
  on claims (game_id, team_id, bar_id)
  where revoked_at is null;

create index claims_active_game_bar_idx
  on claims (game_id, bar_id)
  where revoked_at is null;

create index claims_active_game_team_idx
  on claims (game_id, team_id)
  where revoked_at is null;

-- ---------------------------------------------------------------------------
-- score_ledger_entries
-- ---------------------------------------------------------------------------
-- Scores are never rewritten. A claim or later claim-state transition appends
-- a signed adjustment, and the current score is the deterministic sum of the
-- applicable entries for that game/team.
create table score_ledger_entries (
  id                uuid primary key default gen_random_uuid(),
  game_id           uuid not null references games (id) on delete cascade,
  team_id           uuid not null,
  bar_id            uuid,
  source_claim_id   uuid,
  category          text not null,
  points            integer not null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default date_trunc('milliseconds', now()),

  constraint score_ledger_entries_team_fk
    foreign key (team_id, game_id)
    references teams (id, game_id)
    on delete cascade,

  constraint score_ledger_entries_bar_fk
    foreign key (bar_id, game_id)
    references bars (id, game_id)
    on delete cascade,

  constraint score_ledger_entries_claim_fk
    foreign key (source_claim_id, game_id)
    references claims (id, game_id)
    on delete cascade,

  constraint score_ledger_entries_category_valid
    check (length(btrim(category)) > 0),

  constraint score_ledger_entries_metadata_object
    check (jsonb_typeof(metadata) = 'object')
);

create index score_ledger_entries_game_team_idx
  on score_ledger_entries (game_id, team_id, created_at);

create index score_ledger_entries_game_bar_idx
  on score_ledger_entries (game_id, bar_id, created_at);

create index score_ledger_entries_source_claim_idx
  on score_ledger_entries (game_id, source_claim_id);

-- ---------------------------------------------------------------------------
-- RLS and server-only writes
-- ---------------------------------------------------------------------------
-- Members can read current claim history and score explanations. Mutations go
-- through the server route, which performs authorization, locking, ledger
-- updates, and event append in one transaction.
drop policy if exists claims_member_insert on claims;
drop policy if exists claims_member_update on claims;
drop policy if exists claims_member_delete on claims;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke insert, update, delete on table claims from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke insert, update, delete on table claims from authenticated;
  end if;
end;
$$;

alter table score_ledger_entries enable row level security;

create policy score_ledger_entries_member_select
  on score_ledger_entries
  for select
  using (bbb_is_game_member(game_id));

-- RLS protects browser roles; this trigger also protects the append-only
-- history from accidental mutation by any database role.
create or replace function score_ledger_entries_reject_modification()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'score_ledger_entries is append-only: % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger score_ledger_entries_no_update_delete
  before update or delete on score_ledger_entries
  for each row
  execute function score_ledger_entries_reject_modification();

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke insert, update, delete on table score_ledger_entries from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke insert, update, delete on table score_ledger_entries from authenticated;
  end if;
end;
$$;

commit;
