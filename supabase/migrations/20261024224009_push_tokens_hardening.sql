-- Push tokens per device: review hardening (ADR 0006, "Hardening"; overview
-- §6.3). Follows 20261024222935_push_tokens_per_device, which is not edited
-- (rule 13). Five changes:
--
-- 1. The trace is bounded: each call that writes `push_token_events` for a user
--    then keeps only that user's newest 200 rows (by id, i.e. insertion order).
-- 2. No deadlock between cross-moves (B registers A's device while A registers
--    B's): every call locks all the `profiles` rows it will write, in `id`
--    order, before touching `push_tokens` or `profiles`. Proof in ADR 0006.
-- 3. The worker bridge re-points the column: when the deployed worker clears a
--    dead token and the user still has another active device, the column is
--    set to the newest one, so alerts keep flowing until sub-step (ii).
-- 4. `service_role` loses EXECUTE on both functions (nothing server-side calls
--    them), matching the tables.
-- 5. (Tests only.)
--
-- Function signatures are unchanged, so the generated types do not change.

-- ------------------------------------------------------------ trace bound --

-- Keeps one user's newest 200 trace rows. Called only from the definer
-- functions below (it runs as the owner); the worker never deletes.
create or replace function private.trim_push_token_events(p_user uuid)
returns void
language sql
security invoker
set search_path = ''
as $$
  delete from public.push_token_events e
   where e.user_id = p_user
     and e.id < (select k.id
                   from public.push_token_events k
                  where k.user_id = p_user
                  order by k.id desc
                 offset 199
                  limit 1);
$$;

revoke all on function private.trim_push_token_events(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- register --

create or replace function public.register_push_token(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := (select auth.uid());
  v_now        timestamptz := clock_timestamp();
  v_prev_owner uuid;
  v_was_active boolean;
  v_sha        text;
  v_cleared    uuid[];
  v_other      uuid;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  -- Same shape the worker accepts. The value is never echoed back in the error.
  if p_token is null
     or p_token !~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{1,200}\]$' then
    raise exception 'invalid push token' using errcode = '22023';
  end if;

  -- Two accounts registering one device at once take turns. This is the only
  -- advisory lock the call takes, and it is taken before any row lock.
  perform pg_advisory_xact_lock(hashtextextended(p_token, 0));

  -- The device's current owner. Stable from here on: only this function and
  -- unregister change a row's owner, and both hold this token's lock.
  select t.user_id
    into v_prev_owner
    from public.push_tokens t
   where t.token = p_token;

  -- Lock every profile this call writes — the caller, the previous owner, and
  -- any profile whose column holds this token — in id order, before any other
  -- write. Two cross-moves therefore queue on the lower id instead of each
  -- holding one profile and waiting for the other's (ADR 0006).
  perform 1
     from public.profiles p
    where p.id = v_uid
       or p.id = v_prev_owner
       or p.expo_push_token = p_token
    order by p.id
      for update;

  -- 1–3. This device's row: create, move from another account, or re-activate.
  select t.user_id, t.invalidated_at is null
    into v_prev_owner, v_was_active
    from public.push_tokens t
   where t.token = p_token
     for update;

  if not found then
    insert into public.push_tokens (user_id, token, created_at, last_registered_at)
    values (v_uid, p_token, v_now, v_now)
    returning token_sha256 into v_sha;

    insert into public.push_token_events (user_id, token_sha256, event)
    values (v_uid, v_sha, 'registered');
  elsif v_prev_owner <> v_uid then
    update public.push_tokens
       set user_id = v_uid,
           created_at = v_now,
           last_registered_at = v_now,
           invalidated_at = null,
           invalidated_reason = null
     where token = p_token
    returning token_sha256 into v_sha;

    insert into public.push_token_events (user_id, token_sha256, event)
    values (v_prev_owner, v_sha, 'moved_to_other_account'),
           (v_uid, v_sha, 'registered');
  else
    update public.push_tokens
       set last_registered_at = v_now,
           invalidated_at = null,
           invalidated_reason = null
     where token = p_token
    returning token_sha256 into v_sha;

    -- An ordinary relaunch only bumps `last_registered_at`.
    if not v_was_active then
      insert into public.push_token_events (user_id, token_sha256, event)
      values (v_uid, v_sha, 'registered');
    end if;
  end if;

  -- 4. At most 10 active devices: retire the least recently registered.
  with retired as (
    delete from public.push_tokens t
     where t.id in (select r.id
                      from public.push_tokens r
                     where r.user_id = v_uid
                       and r.invalidated_at is null
                     order by r.last_registered_at desc, r.id desc
                    offset 10)
    returning t.token_sha256
  )
  insert into public.push_token_events (user_id, token_sha256, event)
  select v_uid, token_sha256, 'retired_over_cap'
    from retired;

  -- 5. Dual-write the legacy column the live worker reads: remove this token
  -- from every other profile (all locked above), then set it on the caller's.
  with cleared as (
    update public.profiles
       set expo_push_token = null
     where expo_push_token = p_token
       and id <> v_uid
    returning id
  )
  select coalesce(array_agg(id), '{}') into v_cleared from cleared;

  -- A profile that held this token only in the column (a legacy direct write)
  -- also lost it to another account.
  insert into public.push_token_events (user_id, token_sha256, event)
  select c, v_sha, 'moved_to_other_account'
    from unnest(v_cleared) as c
   where c is distinct from v_prev_owner;

  -- Accounts that just lost this device fall back to their own other devices,
  -- and their trace is trimmed too (they just gained a row).
  foreach v_other in array
    array(select distinct x
            from unnest(v_cleared || v_prev_owner) as x
           where x is not null
             and x <> v_uid)
  loop
    perform private.sync_profile_push_token(v_other);
    perform private.trim_push_token_events(v_other);
  end loop;

  update public.profiles
     set expo_push_token = p_token
   where id = v_uid
     and expo_push_token is distinct from p_token;

  perform private.trim_push_token_events(v_uid);
end;
$$;

comment on function public.register_push_token(text) is
  'Registers this device''s push token to the caller (moving it from any other account) and dual-writes profiles.expo_push_token. Returns nothing.';

revoke all on function public.register_push_token(text) from public, anon, service_role;
grant execute on function public.register_push_token(text) to authenticated;

-- -------------------------------------------------------------- unregister --

create or replace function public.unregister_push_token(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_sha  text;
  v_held boolean;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  if p_token is null then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_token, 0));

  -- Same lock order as register: the profile row first, then push_tokens.
  perform 1
     from public.profiles
    where id = v_uid
      for update;

  delete from public.push_tokens
   where user_id = v_uid
     and token = p_token
  returning token_sha256 into v_sha;

  select exists (select 1
                   from public.profiles
                  where id = v_uid
                    and expo_push_token = p_token)
    into v_held;

  if v_sha is null and not v_held then
    return;
  end if;

  insert into public.push_token_events (user_id, token_sha256, event)
  values (v_uid,
          coalesce(v_sha, encode(sha256(convert_to(p_token, 'UTF8')), 'hex')),
          'signed_out');

  -- The account's other devices stay registered; the column follows the newest.
  perform private.sync_profile_push_token(v_uid);
  perform private.trim_push_token_events(v_uid);
end;
$$;

comment on function public.unregister_push_token(text) is
  'Removes the caller''s own registration of this device''s push token and recomputes profiles.expo_push_token. Returns nothing.';

revoke all on function public.unregister_push_token(text) from public, anon, service_role;
grant execute on function public.unregister_push_token(text) to authenticated;

-- ------------------------------------------- interim bridge: worker clears --

-- As before, plus the re-point: after invalidating the dead device, the column
-- is set to the user's newest remaining active token that no other profile
-- holds, so the deployed worker (which sends to the column) keeps notifying.
-- The re-point runs in its own subtransaction: if the unique index refuses
-- the value (a concurrent writer), the column simply stays NULL — the worker's
-- own clear can never fail because of this trigger. Still `security invoker`,
-- running as the worker on its existing grants (`profiles(id, expo_push_token)`
-- select/update; `push_tokens` select + update(invalidated_*);
-- `push_token_events` insert). The nested update sets a non-NULL value, so the
-- trigger's WHEN clause does not fire again. The worker holds this profile row's
-- lock (it is updating it), which is the lock register/unregister take first.
create or replace function private.push_tokens_mirror_worker_clear()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_sha  text;
  v_next text;
begin
  if current_user <> 'flightbuddy_worker' then
    return null;
  end if;

  update public.push_tokens
     set invalidated_at = now(),
         invalidated_reason = 'device_not_registered'
   where user_id = old.id
     and token = old.expo_push_token
     and invalidated_at is null
  returning token_sha256 into v_sha;

  if v_sha is not null then
    insert into public.push_token_events (user_id, token_sha256, event)
    values (old.id, v_sha, 'device_not_registered');
  end if;

  select t.token
    into v_next
    from public.push_tokens t
   where t.user_id = old.id
     and t.invalidated_at is null
     and t.token <> old.expo_push_token
     and not exists (select 1
                       from public.profiles o
                      where o.expo_push_token = t.token
                        and o.id <> old.id)
   order by t.last_registered_at desc, t.id desc
   limit 1;

  if v_next is not null then
    begin
      update public.profiles
         set expo_push_token = v_next
       where id = old.id
         and expo_push_token is null;
    exception when unique_violation then
      null;
    end;
  end if;

  return null;
end;
$$;

revoke all on function private.push_tokens_mirror_worker_clear() from public, anon, authenticated, service_role;
