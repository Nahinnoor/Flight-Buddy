-- Account deletion, group ownership hand-over and flight garbage collection
-- (§3.4 / §6.3, decided 2026-09-13).
--
-- 1. Deleting an account deletes the person: travelers.user_id now cascades.
--    A traveller with a user_id is by definition that user's self-traveller
--    (travelers_self_traveler_uniq), and the cascade continues to their trips,
--    segments and memberships. Travellers they added for other people survive
--    (created_by is on delete set null, previous migration).
--
-- 2. A group whose owner is being deleted is handed to the earliest-joined
--    active member; with nobody left, the group is deleted. Without this,
--    groups.owner_traveler_id (no on-delete action) would refuse the delete —
--    the same class of bug travelers.created_by had.
--
-- 3. A flight nobody references any more is archived, not deleted: the row
--    still carries the provider alert subscription the poller must cancel,
--    and the 90-day purge removes it afterwards. This trigger is the one
--    writer of `flights` outside ingest/poller (rule 7 exception, documented
--    in the overview) and it touches archived_at only.

-- ------------------------------------------------------------ 1. cascade ---

alter table public.travelers
  drop constraint travelers_user_id_fkey;

alter table public.travelers
  add constraint travelers_user_id_fkey
    foreign key (user_id) references public.profiles (id) on delete cascade;

-- ----------------------------------------------- 2. group ownership ---------

create or replace function private.handover_groups_before_traveler_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  g record;
  heir record;
begin
  for g in
    select id from public.groups where owner_traveler_id = old.id
  loop
    select gm.id, gm.traveler_id
      into heir
      from public.group_members gm
     where gm.group_id = g.id
       and gm.status = 'active'
       and gm.traveler_id <> old.id
     order by gm.joined_at asc nulls last, gm.created_at asc
     limit 1;

    if heir.traveler_id is null then
      delete from public.groups where id = g.id;
    else
      update public.groups
         set owner_traveler_id = heir.traveler_id
       where id = g.id;
      update public.group_members
         set role = 'owner'
       where id = heir.id;
    end if;
  end loop;

  return old;
end;
$$;

create trigger travelers_handover_groups_before_delete
  before delete on public.travelers
  for each row
  execute function private.handover_groups_before_traveler_delete();

-- --------------------------------------------- 3. orphaned flights ----------

create or replace function private.archive_flight_if_orphaned()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.trip_segments s where s.flight_id = old.flight_id
  ) then
    update public.flights
       set archived_at = coalesce(archived_at, now())
     where id = old.flight_id;
  end if;
  return old;
end;
$$;

create trigger trip_segments_archive_orphaned_flight_after_delete
  after delete on public.trip_segments
  for each row
  execute function private.archive_flight_if_orphaned();

revoke all on function private.handover_groups_before_traveler_delete() from public, anon, authenticated;
revoke all on function private.archive_flight_if_orphaned() from public, anon, authenticated;
