-- Migration: 0009_card_inventory
-- Feature: card-implementation Phase 1.3
-- Adds durable per-team deck state, server-generated draw order, draw records,
-- and lifecycle fields for the existing card_instances table.

begin;

alter table card_instances
  add column owner_team_id uuid,
  add column draw_position integer,
  add column discard_reason text,
  add column held_at timestamptz,
  add column played_at timestamptz,
  add column discarded_at timestamptz;

-- Preserve any instances created by the foundation schema before the lifecycle
-- fields existed. Existing ownership is the holder, and created_at is the only
-- trustworthy historical timestamp available for those rows.
update card_instances
set owner_team_id = holder_team_id,
    held_at = case when state = 'in_hand' then created_at else held_at end,
    played_at = case when state = 'played' then created_at else played_at end,
    discarded_at = case when state = 'discarded' then created_at else discarded_at end;

-- The owner never changes when a card moves between deck, hand, played, and
-- discarded states. The composite foreign key prevents cross-game ownership.
alter table card_instances
  add constraint card_instances_owner_team_fk
    foreign key (owner_team_id, game_id)
    references teams (id, game_id)
    on delete cascade,
  add constraint card_instances_owner_definition_unique
    unique (game_id, owner_team_id, definition_id),
  add constraint card_instances_draw_position_unique
    unique (game_id, owner_team_id, draw_position),
  add constraint card_instances_draw_position_valid
    check (draw_position is null or draw_position >= 0),
  add constraint card_instances_lifecycle_fields_valid
    check (
      (state = 'in_hand' and holder_team_id is not null and held_at is not null)
      or (state = 'played' and holder_team_id is null and played_at is not null)
      or (state = 'discarded' and holder_team_id is null and discarded_at is not null)
    );

create index card_instances_owner_state_position_idx
  on card_instances (game_id, owner_team_id, state, draw_position);
create index card_instances_holder_state_idx
  on card_instances (game_id, holder_team_id, state);

create table team_decks (
  game_id              uuid not null references games (id) on delete cascade,
  team_id              uuid not null,
  next_draw_position   integer not null default 0,
  draw_override_until  timestamptz,
  seeded_at            timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  constraint team_decks_pk primary key (game_id, team_id),
  constraint team_decks_team_fk
    foreign key (team_id, game_id)
    references teams (id, game_id)
    on delete cascade,
  constraint team_decks_next_position_valid
    check (next_draw_position >= 0)
);

create index team_decks_draw_override_idx
  on team_decks (game_id, draw_override_until);

create table card_draws (
  id             uuid primary key default gen_random_uuid(),
  game_id        uuid not null references games (id) on delete cascade,
  team_id        uuid not null,
  bar_id         uuid not null,
  cards_drawn   integer not null,
  drawn_at       timestamptz not null default now(),
  constraint card_draws_team_fk
    foreign key (team_id, game_id)
    references teams (id, game_id)
    on delete cascade,
  constraint card_draws_bar_fk
    foreign key (bar_id, game_id)
    references bars (id, game_id)
    on delete cascade,
  constraint card_draws_cards_valid check (cards_drawn between 1 and 2),
  constraint card_draws_team_bar_unique unique (game_id, team_id, bar_id)
);

create index card_draws_team_lookup_idx
  on card_draws (game_id, team_id, drawn_at);
create index card_draws_bar_lookup_idx
  on card_draws (game_id, bar_id);

-- Client roles may read only their own team's inventory and deck state. There
-- are deliberately no client INSERT/UPDATE/DELETE policies: inventory writes
-- are server-only and must occur with the canonical transaction plus event.
create or replace function bbb_is_team_member(target_team_id uuid, target_game_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from players p
    where p.team_id = target_team_id
      and p.game_id = target_game_id
      and p.session_id = bbb_current_session_id()
  );
$$;

alter table team_decks enable row level security;
create policy team_decks_team_select on team_decks
  for select using (bbb_is_team_member(team_id, game_id));

alter table card_draws enable row level security;
create policy card_draws_team_select on card_draws
  for select using (bbb_is_team_member(team_id, game_id));

alter table card_instances enable row level security;
drop policy if exists card_instances_member_insert on card_instances;
drop policy if exists card_instances_member_update on card_instances;
drop policy if exists card_instances_member_delete on card_instances;
drop policy if exists card_instances_member_select on card_instances;
create policy card_instances_team_select on card_instances
  for select using (
    bbb_is_team_member(owner_team_id, game_id)
    or bbb_is_team_member(holder_team_id, game_id)
  );

commit;
