-- Row Level Security for every table (§10).
--
-- All membership/ownership checks go through `security definer` helpers in the
-- `private` schema. They run as the function owner, so reading group_members
-- from inside a group_members policy does not recurse, and each helper is a
-- single indexed existence check rather than a correlated subquery.
--
-- Every helper wraps auth.uid() in a scalar subselect so Postgres evaluates it
-- once per statement (initplan) instead of once per row.

-- ---------------------------------------------------------------- helpers ---

-- The traveler rows that belong to the calling user (normally exactly one).
create or replace function private.my_traveler_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id
  from public.travelers t
  where t.user_id = (select auth.uid());
$$;

-- True when the calling user and p_traveler_id are both active members of at
-- least one common group.
create or replace function private.is_active_co_member(p_traveler_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.group_members gm_self
    join public.travelers self_t on self_t.id = gm_self.traveler_id
    join public.group_members gm_other on gm_other.group_id = gm_self.group_id
    where self_t.user_id = (select auth.uid())
      and gm_self.status = 'active'
      and gm_other.status = 'active'
      and gm_other.traveler_id = p_traveler_id
  );
$$;

-- True when the calling user is an active member of p_group_id.
create or replace function private.is_active_group_member(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.group_members gm
    join public.travelers t on t.id = gm.traveler_id
    where gm.group_id = p_group_id
      and gm.status = 'active'
      and t.user_id = (select auth.uid())
  );
$$;

-- True when the calling user owns p_group_id.
create or replace function private.is_group_owner(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.groups g
    join public.travelers t on t.id = g.owner_traveler_id
    where g.id = p_group_id
      and t.user_id = (select auth.uid())
  );
$$;

-- True when p_trip_id hangs off one of the calling user's own travelers.
create or replace function private.owns_trip(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.trips tr
    join public.travelers t on t.id = tr.traveler_id
    where tr.id = p_trip_id
      and t.user_id = (select auth.uid())
  );
$$;

-- Own trips, plus trips of active co-members.
create or replace function private.can_read_trip(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.trips tr
    join public.travelers t on t.id = tr.traveler_id
    where tr.id = p_trip_id
      and (t.user_id = (select auth.uid()) or private.is_active_co_member(t.id))
  );
$$;

-- A flight is readable when the caller subscribes to it through a trip_segment
-- on one of their own trips, or on an active co-member's trip.
create or replace function private.can_read_flight(p_flight_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.trip_segments ts
    join public.trips tr on tr.id = ts.trip_id
    join public.travelers t on t.id = tr.traveler_id
    where ts.flight_id = p_flight_id
      and (t.user_id = (select auth.uid()) or private.is_active_co_member(t.id))
  );
$$;

-- ------------------------------------------------------------- enable RLS ---

alter table public.profiles               enable row level security;
alter table public.travelers              enable row level security;
alter table public.flights                enable row level security;
alter table public.trips                  enable row level security;
alter table public.trip_segments          enable row level security;
alter table public.groups                 enable row level security;
alter table public.group_members          enable row level security;
alter table public.notification_prefs     enable row level security;
alter table public.flight_events          enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.provider_credit_log    enable row level security;

-- ---------------------------------------------------------------- profiles --
-- Self only.

create policy "profiles_select_self" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

create policy "profiles_insert_self" on public.profiles
  for insert to authenticated
  with check (id = (select auth.uid()));

create policy "profiles_update_self" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- --------------------------------------------------------------- travelers --
-- Readable: yourself, anyone you created, and active co-members.
-- Writable: by created_by while unclaimed, by user_id once claimed.

create policy "travelers_select_visible" on public.travelers
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or created_by = (select auth.uid())
    or private.is_active_co_member(id)
  );

create policy "travelers_insert_own" on public.travelers
  for insert to authenticated
  with check (created_by = (select auth.uid()));

create policy "travelers_update_own" on public.travelers
  for update to authenticated
  using (
    user_id = (select auth.uid())
    or (user_id is null and created_by = (select auth.uid()))
  )
  with check (
    user_id = (select auth.uid())
    or (user_id is null and created_by = (select auth.uid()))
  );

create policy "travelers_delete_unclaimed_own" on public.travelers
  for delete to authenticated
  using (user_id is null and created_by = (select auth.uid()));

-- ----------------------------------------------------------------- flights --
-- Read-only for users, and only for flights they subscribe to.
-- No insert/update/delete policy exists at all: the service role bypasses RLS
-- and is the only writer (ADR 0001, §12 rule 7).

create policy "flights_select_subscribed" on public.flights
  for select to authenticated
  using (private.can_read_flight(id));

-- ------------------------------------------------------------------- trips --
-- Full CRUD on your own, read for active co-members.

create policy "trips_select_visible" on public.trips
  for select to authenticated
  using (
    traveler_id in (select private.my_traveler_ids())
    or private.is_active_co_member(traveler_id)
  );

create policy "trips_insert_own" on public.trips
  for insert to authenticated
  with check (traveler_id in (select private.my_traveler_ids()));

create policy "trips_update_own" on public.trips
  for update to authenticated
  using (traveler_id in (select private.my_traveler_ids()))
  with check (traveler_id in (select private.my_traveler_ids()));

create policy "trips_delete_own" on public.trips
  for delete to authenticated
  using (traveler_id in (select private.my_traveler_ids()));

-- ----------------------------------------------------------- trip_segments --

create policy "trip_segments_select_visible" on public.trip_segments
  for select to authenticated
  using (private.can_read_trip(trip_id));

create policy "trip_segments_insert_own" on public.trip_segments
  for insert to authenticated
  with check (private.owns_trip(trip_id));

create policy "trip_segments_update_own" on public.trip_segments
  for update to authenticated
  using (private.owns_trip(trip_id))
  with check (private.owns_trip(trip_id));

create policy "trip_segments_delete_own" on public.trip_segments
  for delete to authenticated
  using (private.owns_trip(trip_id));

-- ------------------------------------------------------------------ groups --
-- Readable by active members (and the owner). Settings are owner-only.

create policy "groups_select_member" on public.groups
  for select to authenticated
  using (
    private.is_active_group_member(id)
    or owner_traveler_id in (select private.my_traveler_ids())
  );

create policy "groups_insert_own_traveler" on public.groups
  for insert to authenticated
  with check (owner_traveler_id in (select private.my_traveler_ids()));

create policy "groups_update_owner" on public.groups
  for update to authenticated
  using (owner_traveler_id in (select private.my_traveler_ids()))
  with check (owner_traveler_id in (select private.my_traveler_ids()));

create policy "groups_delete_owner" on public.groups
  for delete to authenticated
  using (owner_traveler_id in (select private.my_traveler_ids()));

-- ----------------------------------------------------------- group_members --
-- Active members see the roster; you always see your own row (so a pending
-- join request is visible to its requester). Owners manage every row.

create policy "group_members_select_visible" on public.group_members
  for select to authenticated
  using (
    traveler_id in (select private.my_traveler_ids())
    or private.is_active_group_member(group_id)
    or private.is_group_owner(group_id)
  );

create policy "group_members_insert_self_or_owner" on public.group_members
  for insert to authenticated
  with check (
    traveler_id in (select private.my_traveler_ids())
    or private.is_group_owner(group_id)
  );

create policy "group_members_update_self_or_owner" on public.group_members
  for update to authenticated
  using (
    traveler_id in (select private.my_traveler_ids())
    or private.is_group_owner(group_id)
  )
  with check (
    traveler_id in (select private.my_traveler_ids())
    or private.is_group_owner(group_id)
  );

create policy "group_members_delete_self_or_owner" on public.group_members
  for delete to authenticated
  using (
    traveler_id in (select private.my_traveler_ids())
    or private.is_group_owner(group_id)
  );

-- ------------------------------------------------------ notification_prefs --
-- Your own mutes, plus owner-set mutes inside a group you own.

create policy "notification_prefs_select_own_or_owner" on public.notification_prefs
  for select to authenticated
  using (user_id = (select auth.uid()) or private.is_group_owner(group_id));

create policy "notification_prefs_insert_own_or_owner" on public.notification_prefs
  for insert to authenticated
  with check (user_id = (select auth.uid()) or private.is_group_owner(group_id));

create policy "notification_prefs_update_own_or_owner" on public.notification_prefs
  for update to authenticated
  using (user_id = (select auth.uid()) or private.is_group_owner(group_id))
  with check (user_id = (select auth.uid()) or private.is_group_owner(group_id));

create policy "notification_prefs_delete_own_or_owner" on public.notification_prefs
  for delete to authenticated
  using (user_id = (select auth.uid()) or private.is_group_owner(group_id));

-- ----------------------------------------------------------- flight_events --
-- Readable when you can read the flight. Written by the poller only.

create policy "flight_events_select_readable_flight" on public.flight_events
  for select to authenticated
  using (private.can_read_flight(flight_id));

-- ------------------------------------------- notification_deliveries / ops --
-- notification_deliveries and provider_credit_log carry no policies at all:
-- RLS is on, so every non-service-role request is denied. The service role
-- bypasses RLS.
