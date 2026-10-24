-- Push tokens per device: profile-row lock strength (ADR 0006, "Hardening").
-- Follows 20261024224009_push_tokens_hardening, which is not edited (rule 13).
--
-- Both functions are re-created identically except that the profile-row lock
-- taken right after the token's advisory lock is `for no key update` instead
-- of `for update`. `for update` also conflicts with the `for key share` locks
-- that foreign-key checks take, so a register would have blocked (and been
-- blocked by) unrelated inserts referencing the profile. `for no key update`
-- is exactly what the worker's own `update profiles` takes, so every profile
-- writer is still serialised in the same order and the deadlock argument in
-- ADR 0006 is unchanged.
--
-- Security model unchanged and re-asserted below: security definer,
-- search_path = '', EXECUTE for `authenticated` only (revoked from public,
-- anon and service_role). Signatures unchanged, so the generated types do not
-- change.

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
  -- holding one profile and waiting for the other's (ADR 0006). `for no key
  -- update` is the lock an UPDATE that changes no key takes (the worker's, and
  -- this function's own), so it still serialises every profile writer but no
  -- longer blocks the FK `key share` locks taken by inserts that reference
  -- profiles (trips, travelers, notification_deliveries, …).
  perform 1
     from public.profiles p
    where p.id = v_uid
       or p.id = v_prev_owner
       or p.expo_push_token = p_token
    order by p.id
      for no key update;

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

alter function public.register_push_token(text) security definer;
alter function public.register_push_token(text) set search_path = '';
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
  -- `for no key update`: the same lock the worker's UPDATE takes.
  perform 1
     from public.profiles
    where id = v_uid
      for no key update;

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

alter function public.unregister_push_token(text) security definer;
alter function public.unregister_push_token(text) set search_path = '';
revoke all on function public.unregister_push_token(text) from public, anon, service_role;
grant execute on function public.unregister_push_token(text) to authenticated;
