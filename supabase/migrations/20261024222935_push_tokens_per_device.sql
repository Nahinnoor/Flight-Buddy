-- Push tokens per device, sub-step (i): the database (ADR 0006; overview §6.2,
-- §6.3, §10).
--
-- Each account held one token, `profiles.expo_push_token`. A second device
-- replaced the first, and a sign-out on any device could leave the account with
-- none (2026-09-28: real departed/landed pushes skipped as `NoPushToken`, and
-- nothing recorded why). Now:
--
--   * `push_tokens`: one row per device; active = `invalidated_at is null`;
--     at most 10 active per user (the least recently registered is retired).
--   * `push_token_events`: a trace of every gain and loss, holding only the
--     token's SHA-256, so the next missing token can be explained.
--   * `register_push_token` / `unregister_push_token`: the app's only write
--     path, as before. They keep `profiles.expo_push_token` DUAL-WRITTEN (the
--     most recently registered active token), because the live worker reads it.
--   * A trigger mirrors the live worker's dead-token clear on `profiles` into
--     `push_tokens`, so a dead device is not recomputed back into the column.
--   * Worker grants for sub-step (ii), so its deploy needs no grant migration.
--
-- Purely additive: no existing column, constraint, index, grant or policy is
-- changed or dropped. The worker code is unchanged and keeps working.
--
-- Tokens are bearer credentials for a lock screen (§10). They live only in
-- `push_tokens.token` and the dual-written column; the trace, errors and
-- comments never carry one.

-- ------------------------------------------------------------- push_tokens --

create table public.push_tokens (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  -- Same shape as the functions and the worker (services/poller/src/push/tokens.ts).
  token              text not null unique
                     constraint push_tokens_token_shape_check
                     check (token ~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{1,200}\]$'),
  -- Lowercase hex SHA-256 of the token's bytes. `decode(…, 'escape')` is the
  -- immutable spelling of the worker's `convert_to(token, 'UTF8')`: the shape
  -- check allows only ASCII without backslashes, for which both give the same
  -- bytes. A generated column needs immutable functions; `convert_to` is stable.
  token_sha256       text generated always as (encode(sha256(decode(token, 'escape')), 'hex')) stored,
  created_at         timestamptz not null default now(),
  last_registered_at timestamptz not null default now(),
  invalidated_at     timestamptz,
  invalidated_reason text
                     constraint push_tokens_invalidated_reason_check
                     check (invalidated_reason in ('device_not_registered')),
  constraint push_tokens_invalidated_pair_check
    check ((invalidated_at is null) = (invalidated_reason is null))
);

comment on table public.push_tokens is
  'One row per device push token. Written only by register/unregister_push_token and the worker. No client access.';

-- Covers the FK, the per-user recompute (newest active first) and the worker's
-- per-recipient read in sub-step (ii).
create index push_tokens_user_id_last_registered_idx
  on public.push_tokens (user_id, last_registered_at desc);

alter table public.push_tokens enable row level security;
-- No policies, and no privileges for any API role: the app reaches this table
-- only through the two functions below.
revoke all on table public.push_tokens from public, anon, authenticated, service_role;

-- ------------------------------------------------------- push_token_events --

create table public.push_token_events (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  token_sha256 text not null
               constraint push_token_events_token_sha256_check
               check (token_sha256 ~ '^[0-9a-f]{64}$'),
  event        text not null
               constraint push_token_events_event_check
               check (event in ('registered', 'moved_to_other_account', 'signed_out',
                                'device_not_registered', 'retired_over_cap')),
  at           timestamptz not null default now()
);

comment on table public.push_token_events is
  'Trace of push token gains and losses per account. Holds only the token SHA-256. No client access.';

create index push_token_events_user_id_at_idx
  on public.push_token_events (user_id, at);

alter table public.push_token_events enable row level security;
revoke all on table public.push_token_events from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- backfill --

-- Every well-formed token becomes one row. The partial unique index on
-- `profiles.expo_push_token` already guarantees one holder per token. A
-- malformed legacy value (none on dev today) stays in the column, uncopied.
with backfilled as (
  insert into public.push_tokens (user_id, token)
  select p.id, p.expo_push_token
    from public.profiles p
   where p.expo_push_token ~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{1,200}\]$'
  returning user_id, token_sha256
)
insert into public.push_token_events (user_id, token_sha256, event)
select user_id, token_sha256, 'registered'
  from backfilled;

-- ----------------------------------------------------------------- recompute --

-- Sets `profiles.expo_push_token` for one user to their most recently
-- registered active token that no other profile's column holds, or NULL.
-- Called only from the definer functions below (so it runs as the owner). If
-- the unique index still refuses the value (a concurrent registration of that
-- token by another account), the column falls back to NULL — the pre-ADR-0006
-- behaviour — instead of failing the caller's request.
create or replace function private.sync_profile_push_token(p_user uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_token text;
begin
  select t.token
    into v_token
    from public.push_tokens t
   where t.user_id = p_user
     and t.invalidated_at is null
     and not exists (select 1
                       from public.profiles o
                      where o.expo_push_token = t.token
                        and o.id <> p_user)
   order by t.last_registered_at desc, t.id desc
   limit 1;

  begin
    update public.profiles
       set expo_push_token = v_token
     where id = p_user
       and expo_push_token is distinct from v_token;
  exception when unique_violation then
    update public.profiles
       set expo_push_token = null
     where id = p_user;
  end;
end;
$$;

revoke all on function private.sync_profile_push_token(uuid) from public, anon, authenticated, service_role;

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

  -- Two accounts registering one device at once take turns.
  perform pg_advisory_xact_lock(hashtextextended(p_token, 0));

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

    -- An ordinary relaunch only bumps `last_registered_at`; the trace records
    -- state changes, so it does not grow with every app start.
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

  -- 5. Dual-write the legacy column the live worker reads. As before: remove
  -- this token from every other profile, then set it on the caller's own.
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

  -- Accounts that just lost this device fall back to their own other devices.
  foreach v_other in array
    array(select distinct x
            from unnest(v_cleared || v_prev_owner) as x
           where x is not null
             and x <> v_uid)
  loop
    perform private.sync_profile_push_token(v_other);
  end loop;

  update public.profiles
     set expo_push_token = p_token
   where id = v_uid
     and expo_push_token is distinct from p_token;
end;
$$;

comment on function public.register_push_token(text) is
  'Registers this device''s push token to the caller (moving it from any other account) and dual-writes profiles.expo_push_token. Returns nothing.';

revoke all on function public.register_push_token(text) from public, anon;
grant execute on function public.register_push_token(text) to authenticated;

-- -------------------------------------------------------------- unregister --

-- Now `security definer` (was invoker): it must delete from `push_tokens`,
-- which has no client policies or privileges. Its reach is unchanged — the
-- caller's own row and own profile only. Never raises on an unknown or
-- malformed token: sign-out must not fail.
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
end;
$$;

comment on function public.unregister_push_token(text) is
  'Removes the caller''s own registration of this device''s push token and recomputes profiles.expo_push_token. Returns nothing.';

revoke all on function public.unregister_push_token(text) from public, anon;
grant execute on function public.unregister_push_token(text) to authenticated;

-- ------------------------------------------- interim bridge: worker clears --

-- Until sub-step (ii), the worker clears `profiles.expo_push_token` on
-- `DeviceNotRegistered` (CLEAR_DEAD_TOKEN_SQL). Mirror that into `push_tokens`
-- so the dead device is not recomputed back into the column by a later
-- sign-out or move, and so the trace explains the loss. `security invoker`:
-- it runs as the worker and uses exactly the worker grants below. Only the
-- worker's own clear fires it; the definer functions run as the owner, and a
-- legacy direct update runs as `authenticated`. It never alters the worker's
-- write, and it is a no-op once (ii) invalidates the row itself.
create or replace function private.push_tokens_mirror_worker_clear()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_sha text;
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

  return null;
end;
$$;

revoke all on function private.push_tokens_mirror_worker_clear() from public, anon, authenticated, service_role;

create trigger profiles_mirror_worker_push_token_clear
  after update of expo_push_token on public.profiles
  for each row
  when (old.expo_push_token is not null and new.expo_push_token is null)
  execute function private.push_tokens_mirror_worker_clear();

-- ----------------------------------------------- worker grants (sub-step ii) --

-- Style of 20260915021807_worker_role. No DELETE anywhere.
grant select on public.push_tokens to flightbuddy_worker;
grant update (invalidated_at, invalidated_reason) on public.push_tokens to flightbuddy_worker;
grant insert on public.push_token_events to flightbuddy_worker;
