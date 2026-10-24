-- Contract test for migration 20261024222935_push_tokens_per_device (ADR 0006).
--
-- Runs as the database owner inside one transaction that is always rolled back,
-- so it leaves nothing behind. Throwaway auth users (the `handle_new_user`
-- trigger makes their profiles) are impersonated the way PostgREST does:
-- `set local role authenticated` plus the JWT claims GUC that `auth.uid()` reads.
-- The worker is impersonated with `set local role flightbuddy_worker`.
--
--   Local, against a disposable cluster:  supabase/tests/run-local.sh
--   On the dev project (never production): psql "$DEV_DB_URL" -f supabase/tests/push_tokens_per_device.test.sql
--
-- Every check raises on failure; the last line prints PASS only if all ran.
-- Every token below is a fabricated test value, not a real device token.

\set ON_ERROR_STOP 1
begin;

-- --------------------------------------------------------------- fixtures --

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000c1', 'devices-test-c@example.test'),
  ('00000000-0000-4000-8000-0000000000d1', 'devices-test-d@example.test'),
  ('00000000-0000-4000-8000-0000000000e1', 'devices-test-e@example.test');

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

create function pg_temp.active_of(p_user uuid) returns text[] language sql as $$
  select coalesce(array_agg(token order by token), '{}')
    from public.push_tokens where user_id = p_user and invalidated_at is null;
$$;

create function pg_temp.sha(p_token text) returns text language sql as $$
  select encode(sha256(convert_to(p_token, 'UTF8')), 'hex');   -- the worker's formula
$$;

create function pg_temp.events_of(p_user uuid, p_token text) returns text[] language sql as $$
  select coalesce(array_agg(event order by at, id), '{}')
    from public.push_token_events
   where user_id = p_user and token_sha256 = pg_temp.sha(p_token);
$$;

-- -------------------------------------------------------------- privileges --

select pg_temp.check(
  not has_function_privilege('anon', 'public.register_push_token(text)', 'execute')
  and not has_function_privilege('anon', 'public.unregister_push_token(text)', 'execute'),
  'anon cannot execute either function');
select pg_temp.check(
  (select bool_and(c.relrowsecurity)
     from pg_class c
    where c.oid in ('public.push_tokens'::regclass, 'public.push_token_events'::regclass))
  and not exists (select 1 from pg_policies
                   where schemaname = 'public'
                     and tablename in ('push_tokens', 'push_token_events')),
  'both tables have RLS on and no policies');
select pg_temp.check(
  not exists (
    select 1
      from (values ('anon'), ('authenticated'), ('service_role')) r(role),
           (values ('public.push_tokens'), ('public.push_token_events')) t(tbl),
           (values ('select'), ('insert'), ('update'), ('delete')) p(priv)
     where has_table_privilege(r.role, t.tbl, p.priv)),
  'no API role holds any privilege on either table');
select pg_temp.check(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
     from pg_proc p where p.oid = 'public.unregister_push_token(text)'::regprocedure),
  'unregister_push_token is security definer with an empty search_path');

-- Worker grants for sub-step (ii): exactly these, and no DELETE.
select pg_temp.check(
  has_table_privilege('flightbuddy_worker', 'public.push_tokens', 'select')
  and has_column_privilege('flightbuddy_worker', 'public.push_tokens', 'invalidated_at', 'update')
  and has_column_privilege('flightbuddy_worker', 'public.push_tokens', 'invalidated_reason', 'update')
  and not has_column_privilege('flightbuddy_worker', 'public.push_tokens', 'token', 'update')
  and not has_column_privilege('flightbuddy_worker', 'public.push_tokens', 'user_id', 'update')
  and not has_table_privilege('flightbuddy_worker', 'public.push_tokens', 'insert')
  and not has_table_privilege('flightbuddy_worker', 'public.push_tokens', 'delete')
  and has_table_privilege('flightbuddy_worker', 'public.push_token_events', 'insert')
  and not has_table_privilege('flightbuddy_worker', 'public.push_token_events', 'select')
  and not has_table_privilege('flightbuddy_worker', 'public.push_token_events', 'update')
  and not has_table_privilege('flightbuddy_worker', 'public.push_token_events', 'delete'),
  'worker: select + update(invalidated_*) on push_tokens, insert on push_token_events, no delete');

-- anon calling for real is refused before the body runs.
set local role anon;
do $$
begin
  perform public.register_push_token('ExponentPushToken[anon-device]');
  raise exception 'FAILED: anon registered a token';
exception when insufficient_privilege then null;
end $$;
reset role;
select pg_temp.check(
  not exists (select 1 from public.push_tokens where token = 'ExponentPushToken[anon-device]'),
  'anon call is denied with 42501 and writes nothing');

-- A signed-in user cannot read the table directly either.
select pg_temp.act_as('00000000-0000-4000-8000-0000000000c1');
do $$
begin
  perform 1 from public.push_tokens;
  raise exception 'FAILED: authenticated read push_tokens';
exception when insufficient_privilege then null;
end $$;
reset role;
select pg_temp.check(true, 'authenticated cannot select push_tokens (42501)');

-- --------------------------------------------- two devices on one account --

select pg_temp.act_as('00000000-0000-4000-8000-0000000000c1');
select public.register_push_token('ExponentPushToken[c-phone]');
select public.register_push_token('ExpoPushToken[c-ipad]');
reset role;
select pg_temp.check(
  pg_temp.active_of('00000000-0000-4000-8000-0000000000c1')
    = array['ExpoPushToken[c-ipad]', 'ExponentPushToken[c-phone]'],
  'two devices on one account are both active');
select pg_temp.check(
  pg_temp.column_of('00000000-0000-4000-8000-0000000000c1') = 'ExpoPushToken[c-ipad]',
  'dual-written column holds the most recently registered device');
select pg_temp.check(
  (select bool_and(token_sha256 = pg_temp.sha(token)) from public.push_tokens),
  'token_sha256 equals the worker''s SHA-256 formula');

-- The phone relaunches: it becomes the newest; no new trace row for a plain relaunch.
select pg_temp.act_as('00000000-0000-4000-8000-0000000000c1');
select public.register_push_token('ExponentPushToken[c-phone]');
reset role;
select pg_temp.check(
  pg_temp.column_of('00000000-0000-4000-8000-0000000000c1') = 'ExponentPushToken[c-phone]'
  and pg_temp.events_of('00000000-0000-4000-8000-0000000000c1', 'ExponentPushToken[c-phone]')
      = array['registered'],
  'relaunch bumps the device to newest without a second registered event');

-- -------------------------------------------- sign-out removes one device --

select pg_temp.act_as('00000000-0000-4000-8000-0000000000c1');
select public.unregister_push_token('ExponentPushToken[c-phone]');
reset role;
select pg_temp.check(
  pg_temp.active_of('00000000-0000-4000-8000-0000000000c1') = array['ExpoPushToken[c-ipad]'],
  'sign-out removes only that device');
select pg_temp.check(
  pg_temp.column_of('00000000-0000-4000-8000-0000000000c1') = 'ExpoPushToken[c-ipad]',
  'column falls back to the remaining device');
select pg_temp.check(
  pg_temp.events_of('00000000-0000-4000-8000-0000000000c1', 'ExponentPushToken[c-phone]')
    = array['registered', 'signed_out'],
  'trace records registered then signed_out');

-- D cannot sign C's device out by naming it.
select pg_temp.act_as('00000000-0000-4000-8000-0000000000d1');
select public.unregister_push_token('ExpoPushToken[c-ipad]');
reset role;
select pg_temp.check(
  pg_temp.active_of('00000000-0000-4000-8000-0000000000c1') = array['ExpoPushToken[c-ipad]']
  and pg_temp.events_of('00000000-0000-4000-8000-0000000000d1', 'ExpoPushToken[c-ipad]') = '{}',
  'unregister cannot touch another account''s device, and logs nothing');

-- Unknown and malformed tokens on sign-out are quiet no-ops.
select pg_temp.act_as('00000000-0000-4000-8000-0000000000c1');
select public.unregister_push_token('ExponentPushToken[never-registered]');
select public.unregister_push_token('not-a-token');
select public.unregister_push_token(null);
reset role;
select pg_temp.check(
  pg_temp.column_of('00000000-0000-4000-8000-0000000000c1') = 'ExpoPushToken[c-ipad]'
  and pg_temp.active_of('00000000-0000-4000-8000-0000000000c1') = array['ExpoPushToken[c-ipad]'],
  'unregister with an unknown, malformed or null token changes nothing');

-- Last device signs out: column NULL.
select pg_temp.act_as('00000000-0000-4000-8000-0000000000c1');
select public.unregister_push_token('ExpoPushToken[c-ipad]');
reset role;
select pg_temp.check(
  pg_temp.column_of('00000000-0000-4000-8000-0000000000c1') is null
  and pg_temp.active_of('00000000-0000-4000-8000-0000000000c1') = '{}',
  'signing out the last device leaves no token');

-- -------------------------------------------- a device moves between accounts --

select pg_temp.act_as('00000000-0000-4000-8000-0000000000c1');
select public.register_push_token('ExponentPushToken[c-old-phone]');
select public.register_push_token('ExponentPushToken[shared-phone]');
reset role;

-- D signs in on the shared phone without C signing out.
select pg_temp.act_as('00000000-0000-4000-8000-0000000000d1');
select public.register_push_token('ExponentPushToken[shared-phone]');
reset role;
select pg_temp.check(
  (select user_id from public.push_tokens where token = 'ExponentPushToken[shared-phone]')
    = '00000000-0000-4000-8000-0000000000d1'
  and (select count(*) from public.push_tokens where token = 'ExponentPushToken[shared-phone]') = 1,
  'the moved device has exactly one row, now owned by D');
select pg_temp.check(
  pg_temp.column_of('00000000-0000-4000-8000-0000000000d1') = 'ExponentPushToken[shared-phone]'
  and (select count(*) from public.profiles
        where expo_push_token = 'ExponentPushToken[shared-phone]') = 1,
  'D''s column holds it and no other profile does');
select pg_temp.check(
  pg_temp.column_of('00000000-0000-4000-8000-0000000000c1') = 'ExponentPushToken[c-old-phone]'
  and pg_temp.active_of('00000000-0000-4000-8000-0000000000c1') = array['ExponentPushToken[c-old-phone]'],
  'C keeps its other device, and its column falls back to it');
select pg_temp.check(
  pg_temp.events_of('00000000-0000-4000-8000-0000000000c1', 'ExponentPushToken[shared-phone]')
    = array['registered', 'moved_to_other_account']
  and pg_temp.events_of('00000000-0000-4000-8000-0000000000d1', 'ExponentPushToken[shared-phone]')
    = array['registered'],
  'trace: moved_to_other_account against C, registered for D');

-- ------------------------------------------------------- malformed tokens --

select pg_temp.act_as('00000000-0000-4000-8000-0000000000e1');
do $$
declare
  v_bad text;
begin
  foreach v_bad in array array[
    '', 'not-a-token', 'ExponentPushToken[]', 'ExponentPushToken[a b]',
    'ExponentPushToken[x\y]', 'ExponentPushToken[x];drop table x',
    'ExponentPushToken[' || repeat('a', 201) || ']'
  ] loop
    begin
      perform public.register_push_token(v_bad);
      raise exception 'FAILED: accepted a malformed token';
    exception when sqlstate '22023' then null;
    end;
  end loop;
end $$;
reset role;
select pg_temp.check(
  not exists (select 1 from public.push_tokens where user_id = '00000000-0000-4000-8000-0000000000e1')
  and not exists (select 1 from public.push_token_events where user_id = '00000000-0000-4000-8000-0000000000e1'),
  'malformed tokens are rejected with 22023 and write nothing');

-- The table refuses a malformed token on any path.
do $$
begin
  insert into public.push_tokens (user_id, token)
  values ('00000000-0000-4000-8000-0000000000e1', 'ExponentPushToken[a b]');
  raise exception 'FAILED: table accepted a malformed token';
exception when check_violation then null;
end $$;
select pg_temp.check(true, 'push_tokens shape check refuses a malformed token');

-- ------------------------------------------------------ over-cap retirement --

select pg_temp.act_as('00000000-0000-4000-8000-0000000000e1');
do $$
begin
  for i in 1..11 loop
    perform public.register_push_token(format('ExponentPushToken[e-device-%s]', lpad(i::text, 2, '0')));
  end loop;
end $$;
reset role;
select pg_temp.check(
  cardinality(pg_temp.active_of('00000000-0000-4000-8000-0000000000e1')) = 10,
  'an eleventh device leaves ten active');
select pg_temp.check(
  not exists (select 1 from public.push_tokens where token = 'ExponentPushToken[e-device-01]')
  and pg_temp.events_of('00000000-0000-4000-8000-0000000000e1', 'ExponentPushToken[e-device-01]')
      = array['registered', 'retired_over_cap'],
  'the least recently registered device is retired and traced');
select pg_temp.check(
  pg_temp.column_of('00000000-0000-4000-8000-0000000000e1') = 'ExponentPushToken[e-device-11]',
  'column holds the newest device after retirement');

-- --------------------------------- the live worker's dead-token clear (bridge) --

-- C has c-old-phone (column) and registers c-new-phone, then the old one again
-- so it is in the column; the worker then clears it as DeviceNotRegistered.
select pg_temp.act_as('00000000-0000-4000-8000-0000000000c1');
select public.register_push_token('ExponentPushToken[c-new-phone]');
select public.register_push_token('ExponentPushToken[c-old-phone]');
reset role;

set local role flightbuddy_worker;
-- services/poller/src/push/pushSend.ts CLEAR_DEAD_TOKEN_SQL, verbatim shape.
update public.profiles
   set expo_push_token = null
 where id = '00000000-0000-4000-8000-0000000000c1'
   and expo_push_token is not null
   and encode(sha256(convert_to(expo_push_token, 'UTF8')), 'hex')
       = encode(sha256(convert_to('ExponentPushToken[c-old-phone]', 'UTF8')), 'hex');
reset role;
-- Since 20261024224009_push_tokens_hardening the bridge re-points the column
-- to the newest remaining active device (push_tokens_hardening.test.sql).
select pg_temp.check(
  pg_temp.column_of('00000000-0000-4000-8000-0000000000c1') = 'ExponentPushToken[c-new-phone]',
  'the worker''s clear re-points the column to the remaining active device');
select pg_temp.check(
  (select invalidated_reason from public.push_tokens where token = 'ExponentPushToken[c-old-phone]')
    = 'device_not_registered'
  and pg_temp.active_of('00000000-0000-4000-8000-0000000000c1') = array['ExponentPushToken[c-new-phone]']
  and (pg_temp.events_of('00000000-0000-4000-8000-0000000000c1', 'ExponentPushToken[c-old-phone]'))[
        cardinality(pg_temp.events_of('00000000-0000-4000-8000-0000000000c1', 'ExponentPushToken[c-old-phone]'))]
      = 'device_not_registered',
  'the clear is mirrored: that device invalidated and traced, the other untouched');

-- A later sign-out elsewhere must not recompute the dead device back in.
select pg_temp.act_as('00000000-0000-4000-8000-0000000000c1');
select public.register_push_token('ExpoPushToken[c-tablet]');
select public.unregister_push_token('ExpoPushToken[c-tablet]');
reset role;
select pg_temp.check(
  pg_temp.column_of('00000000-0000-4000-8000-0000000000c1') = 'ExponentPushToken[c-new-phone]',
  'recompute skips the invalidated device');

-- The dead device registering again re-activates it.
select pg_temp.act_as('00000000-0000-4000-8000-0000000000c1');
select public.register_push_token('ExponentPushToken[c-old-phone]');
reset role;
select pg_temp.check(
  (select invalidated_at is null and invalidated_reason is null
     from public.push_tokens where token = 'ExponentPushToken[c-old-phone]')
  and pg_temp.column_of('00000000-0000-4000-8000-0000000000c1') = 'ExponentPushToken[c-old-phone]',
  're-registering an invalidated device re-activates it');

-- Clears made by the functions themselves (running as the owner) do not mirror.
select pg_temp.check(
  not exists (select 1 from public.push_token_events
               where event = 'device_not_registered'
                 and user_id <> '00000000-0000-4000-8000-0000000000c1'),
  'only the worker''s clear produces device_not_registered');

-- ------------------------------------------------- the trace holds no tokens --

select pg_temp.check(
  not exists (select 1 from public.push_token_events e
               where row_to_json(e)::text ~ '(Exponent|Expo)PushToken'),
  'no trace row contains a token value');
select pg_temp.check(
  (select count(*) from public.push_token_events
    where user_id in ('00000000-0000-4000-8000-0000000000c1',
                      '00000000-0000-4000-8000-0000000000d1',
                      '00000000-0000-4000-8000-0000000000e1')) > 0,
  'the trace did record this test''s events');

-- ----------------------------------------------------- account deletion --

delete from auth.users where id = '00000000-0000-4000-8000-0000000000e1';
select pg_temp.check(
  not exists (select 1 from public.push_tokens where user_id = '00000000-0000-4000-8000-0000000000e1')
  and not exists (select 1 from public.push_token_events where user_id = '00000000-0000-4000-8000-0000000000e1'),
  'deleting the account removes its devices and its trace');

\warn PASS: push_tokens_per_device
rollback;
