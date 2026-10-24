-- Contract test for migrations 20261024224009_push_tokens_hardening and
-- 20261024224515_push_tokens_lock_strength (ADR 0006,
-- "Hardening"). Same harness as push_tokens_per_device.test.sql: one
-- transaction, always rolled back; throwaway users; PostgREST-style
-- impersonation. Every token is a fabricated test value.
--
-- The cross-move deadlock fix (item 2) needs two sessions and is argued in
-- ADR 0006; here only the lock-free outcomes of the same moves are checked.

\set ON_ERROR_STOP 1
begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000f1', 'hardening-f@example.test'),
  ('00000000-0000-4000-8000-0000000000f2', 'hardening-g@example.test');

create function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  execute 'set local role authenticated';
end $$;

create function pg_temp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then
    raise exception 'FAILED: %', p_what;
  end if;
  raise notice 'ok - %', p_what;
end $$;

create function pg_temp.column_of(p_user uuid) returns text language sql as $$
  select expo_push_token from public.profiles where id = p_user;
$$;

create function pg_temp.events_count(p_user uuid) returns bigint language sql as $$
  select count(*) from public.push_token_events where user_id = p_user;
$$;

create function pg_temp.worker_clear(p_user uuid, p_token text) returns void language plpgsql as $$
begin
  execute 'set local role flightbuddy_worker';
  -- services/poller/src/push/pushSend.ts CLEAR_DEAD_TOKEN_SQL, same shape.
  update public.profiles
     set expo_push_token = null
   where id = p_user
     and expo_push_token is not null
     and encode(sha256(convert_to(expo_push_token, 'UTF8')), 'hex')
         = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  execute 'reset role';
end $$;

-- ------------------------------------------------------ 4. service_role --

select pg_temp.check(
  not has_function_privilege('service_role', 'public.register_push_token(text)', 'execute')
  and not has_function_privilege('service_role', 'public.unregister_push_token(text)', 'execute')
  and has_function_privilege('authenticated', 'public.register_push_token(text)', 'execute')
  and has_function_privilege('authenticated', 'public.unregister_push_token(text)', 'execute'),
  'service_role cannot execute either function; authenticated still can');
select pg_temp.check(
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=""']
                   and p.prosrc ~ 'order by p\.id\s+for no key update'
                   or p.proname = 'unregister_push_token'
                      and p.prosecdef and p.proconfig @> array['search_path=""']
                      and p.prosrc ~ 'where id = v_uid\s+for no key update')
     from pg_proc p
    where p.oid in ('public.register_push_token(text)'::regprocedure,
                    'public.unregister_push_token(text)'::regprocedure)),
  'both lock profile rows with for no key update; still definer with an empty search_path');

-- ------------------------------------------------ 1. the trace is bounded --

-- G has a trace of its own before F floods.
select pg_temp.act_as('00000000-0000-4000-8000-0000000000f2');
select public.register_push_token('ExponentPushToken[g-before-flood]');
select public.unregister_push_token('ExponentPushToken[g-before-flood]');  -- trace stays, device goes
reset role;
create temp table g_before as
  select pg_temp.events_count('00000000-0000-4000-8000-0000000000f2') as n;

select pg_temp.act_as('00000000-0000-4000-8000-0000000000f1');
do $$
begin
  -- 150 new devices (registered + retired_over_cap each, past the cap) plus
  -- 60 register/sign-out cycles of one device: ~470 events without the bound.
  for i in 1..150 loop
    perform public.register_push_token(format('ExponentPushToken[flood-%s]', i));
  end loop;
  for i in 1..60 loop
    perform public.register_push_token('ExponentPushToken[flood-cycle]');
    perform public.unregister_push_token('ExponentPushToken[flood-cycle]');
  end loop;
end $$;
reset role;
select pg_temp.check(
  pg_temp.events_count('00000000-0000-4000-8000-0000000000f1') = 200,
  'a flood of registers and sign-outs keeps exactly the newest 200 trace rows');
select pg_temp.check(
  (select event from public.push_token_events
    where user_id = '00000000-0000-4000-8000-0000000000f1'
    order by id desc limit 1) = 'signed_out',
  'the newest row survives the trim');
select pg_temp.check(
  pg_temp.events_count('00000000-0000-4000-8000-0000000000f2') = (select n from g_before)
  and (select n from g_before) > 0,
  'another user''s trace is untouched by one user''s flood');

-- ---------------------------------- 3. the bridge re-points the column --

-- F has 10 active flood devices; the column holds flood-150 (the newest).
select pg_temp.worker_clear('00000000-0000-4000-8000-0000000000f1', 'ExponentPushToken[flood-150]');
select pg_temp.check(
  pg_temp.column_of('00000000-0000-4000-8000-0000000000f1') = 'ExponentPushToken[flood-149]',
  'worker clear with other active devices re-points the column to the newest remaining');
select pg_temp.check(
  (select invalidated_reason from public.push_tokens where token = 'ExponentPushToken[flood-150]')
    = 'device_not_registered',
  'the dead device is invalidated');

-- G's only device dies: the column stays NULL, as before.
select pg_temp.act_as('00000000-0000-4000-8000-0000000000f2');
select public.register_push_token('ExponentPushToken[g-only]');
reset role;
select pg_temp.worker_clear('00000000-0000-4000-8000-0000000000f2', 'ExponentPushToken[g-only]');
select pg_temp.check(
  pg_temp.column_of('00000000-0000-4000-8000-0000000000f2') is null,
  'worker clear with no other active device leaves the column NULL');

-- ------------------- 5a. a legacy direct update does not fire the bridge --

select pg_temp.act_as('00000000-0000-4000-8000-0000000000f2');
select public.register_push_token('ExponentPushToken[g-legacy]');
-- An old app build clearing its own column directly, under RLS.
update public.profiles
   set expo_push_token = null
 where id = '00000000-0000-4000-8000-0000000000f2';
reset role;
select pg_temp.check(
  (select invalidated_at is null from public.push_tokens where token = 'ExponentPushToken[g-legacy]')
  and not exists (select 1 from public.push_token_events
                   where user_id = '00000000-0000-4000-8000-0000000000f2'
                     and event = 'device_not_registered'
                     and token_sha256 = encode(sha256(convert_to('ExponentPushToken[g-legacy]', 'UTF8')), 'hex'))
  and pg_temp.column_of('00000000-0000-4000-8000-0000000000f2') is null,
  'a direct update by authenticated neither invalidates, traces nor re-points');

-- --------------- 5b. moving a token invalidated on the other account --

-- flood-150 is invalidated on F. G registers it (Expo issued it again).
select pg_temp.act_as('00000000-0000-4000-8000-0000000000f2');
select public.register_push_token('ExponentPushToken[flood-150]');
reset role;
select pg_temp.check(
  (select user_id = '00000000-0000-4000-8000-0000000000f2'
          and invalidated_at is null and invalidated_reason is null
     from public.push_tokens where token = 'ExponentPushToken[flood-150]'),
  'an invalidated token moves to the new account and is active again');
select pg_temp.check(
  pg_temp.column_of('00000000-0000-4000-8000-0000000000f2') = 'ExponentPushToken[flood-150]'
  and pg_temp.column_of('00000000-0000-4000-8000-0000000000f1') = 'ExponentPushToken[flood-149]',
  'the new owner''s column holds it; the old owner keeps its own newest device');
select pg_temp.check(
  (select event from public.push_token_events
    where user_id = '00000000-0000-4000-8000-0000000000f1'
      and token_sha256 = encode(sha256(convert_to('ExponentPushToken[flood-150]', 'UTF8')), 'hex')
    order by id desc limit 1) = 'moved_to_other_account',
  'the move is traced against the old account');
-- F was at 200, gained device_not_registered from the worker (the bridge never
-- trims), then moved_to_other_account: the move's trim brings it back to 200.
select pg_temp.check(
  pg_temp.events_count('00000000-0000-4000-8000-0000000000f1') = 200,
  'the trim also applies to the account that lost the device');

-- -------------------- 2. cross-moves (outcome; locking argued in the ADR) --

select pg_temp.act_as('00000000-0000-4000-8000-0000000000f1');
select public.register_push_token('ExponentPushToken[g-only]');
reset role;
select pg_temp.act_as('00000000-0000-4000-8000-0000000000f2');
select public.register_push_token('ExponentPushToken[flood-149]');
reset role;
select pg_temp.check(
  (select count(*) from public.profiles where expo_push_token = 'ExponentPushToken[g-only]') = 1
  and (select count(*) from public.profiles where expo_push_token = 'ExponentPushToken[flood-149]') = 1
  and pg_temp.column_of('00000000-0000-4000-8000-0000000000f2') = 'ExponentPushToken[flood-149]',
  'cross-moves leave each token on exactly one profile');

select pg_temp.check(
  not exists (select 1 from public.push_token_events e
               where row_to_json(e)::text ~ '(Exponent|Expo)PushToken'),
  'no trace row contains a token value');

\warn PASS: push_tokens_hardening
rollback;
