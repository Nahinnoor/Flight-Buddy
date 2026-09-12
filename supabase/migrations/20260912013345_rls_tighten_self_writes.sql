-- Review fix (wave 1): self-writes must not grant what only the owner can grant.
--
-- 1. group_members: a joiner could insert/update their own row with
--    status = 'active' (or role = 'owner') and bypass owner approval (§3.3, §10).
--    Self-writes are now limited to status = 'pending', role = 'member'.
--    The owner clause is unchanged: the owner inserts their own active row on
--    group creation and approves/denies everyone else.
-- 2. travelers: insert only checked created_by, so a user could plant a row
--    with user_id = <someone else>, which the partial unique index then turns
--    into a permanent block on that person's self-traveller. user_id must now
--    be null (unclaimed) or the caller's own id.

drop policy if exists "group_members_insert_self_or_owner" on public.group_members;
create policy "group_members_insert_self_or_owner" on public.group_members
  for insert to authenticated
  with check (
    private.is_group_owner(group_id)
    or (
      traveler_id in (select private.my_traveler_ids())
      and status = 'pending'
      and role = 'member'
    )
  );

drop policy if exists "group_members_update_self_or_owner" on public.group_members;
create policy "group_members_update_self_or_owner" on public.group_members
  for update to authenticated
  using (
    traveler_id in (select private.my_traveler_ids())
    or private.is_group_owner(group_id)
  )
  with check (
    private.is_group_owner(group_id)
    or (
      traveler_id in (select private.my_traveler_ids())
      and status = 'pending'
      and role = 'member'
    )
  );

drop policy if exists "travelers_insert_own" on public.travelers;
create policy "travelers_insert_own" on public.travelers
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (user_id is null or user_id = (select auth.uid()))
  );
