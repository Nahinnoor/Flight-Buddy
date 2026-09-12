-- groups / group_members (§6.2).

create table public.groups (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  destination_iata     char(3),
  start_date           date,
  end_date             date,
  owner_traveler_id    uuid not null references public.travelers (id),
  join_code            char(6) not null unique,
  join_code_expires_at timestamptz,
  archived_at          timestamptz,
  created_at           timestamptz not null default now()
);

create index groups_owner_traveler_id_idx on public.groups (owner_traveler_id);

create table public.group_members (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.groups (id) on delete cascade,
  traveler_id uuid not null references public.travelers (id) on delete cascade,
  trip_id     uuid references public.trips (id) on delete set null,
  status      public.membership_status not null default 'pending',
  role        text not null default 'member',   -- 'owner' | 'member'
  joined_at   timestamptz,
  created_at  timestamptz not null default now(),
  unique (group_id, traveler_id)
);

-- group_id is covered by the leading column of the unique constraint above.
create index group_members_traveler_id_idx on public.group_members (traveler_id);
create index group_members_trip_id_idx on public.group_members (trip_id);
