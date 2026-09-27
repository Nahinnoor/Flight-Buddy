-- Contract test for migration 20260926130000_push_token_single_owner.
--
-- Runs as the database owner inside one transaction that is always rolled back,
-- so it leaves nothing behind. It creates two throwaway auth users (the
-- `handle_new_user` trigger makes their profiles), then impersonates each the way
-- PostgREST does: `set local role authenticated` plus the JWT claims GUC that
-- `auth.uid()` reads.
--
--   Local, against a disposable cluster:  supabase/tests/run-local.sh
--   On the dev project (never production): psql "$DEV_DB_URL" -f supabase/tests/push_token_single_owner.test.sql
--
-- Every check raises on failure; the last line prints PASS only if all ran.
-- The tokens below are fabricated test values, not real device tokens.

\set ON_ERROR_STOP 1
begin;

-- --------------------------------------------------------------- fixtures --

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000000a', 'push-test-a@example.test'),
  ('00000000-0000-4000-8000-00000000000b', 'push-test-b@example.test');

create function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  execute 'set local role authenticated';
end $$;

create function pg_temp.token_of(p_user uuid) returns text language sql as $$
  select expo_push_token from public.profiles where id = p_user;
$$;

create function pg_temp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then
    raise exception 'FAILED: %', p_what;
  end if;
  raise notice 'ok - %', p_what;
end $$;

-- --------------------------------------------------------------- privileges --

select pg_temp.check(
  not has_function_privilege('anon', 'public.register_push_token(text)', 'execute'),
  'anon cannot execute register_push_token');
select pg_temp.check(
  not has_function_privilege('anon', 'public.unregister_push_token(text)', 'execute'),
  'anon cannot execute unregister_push_token');
select pg_temp.check(
  has_function_privilege('authenticated', 'public.register_push_token(text)', 'execute'),
  'authenticated can execute register_push_token');
select pg_temp.check(
  has_function_privilege('authenticated', 'public.unregister_push_token(text)', 'execute'),
  'authenticated can execute unregister_push_token');
select pg_temp.check(
  (select p.prosecdef and p.proconfig @> array['search_path=""']
     from pg_proc p where p.oid = 'public.register_push_token(text)'::regprocedure),
  'register_push_token is security definer with an empty search_path');
select pg_temp.check(
  (select not p.prosecdef and p.proconfig @> array['search_path=""']
     from pg_proc p where p.oid = 'public.unregister_push_token(text)'::regprocedure),
  'unregister_push_token is security invoker with an empty search_path');

-- ------------------------------------------------------ register: move token --

select pg_temp.act_as('00000000-0000-4000-8000-00000000000a');
select public.register_push_token('ExponentPushToken[device-one]');
reset role;
select pg_temp.check(
  pg_temp.token_of('00000000-0000-4000-8000-00000000000a') = 'ExponentPushToken[device-one]',
  'A registers device one');

-- B signs in on the same phone.
select pg_temp.act_as('00000000-0000-4000-8000-00000000000b');
select public.register_push_token('ExponentPushToken[device-one]');
reset role;
select pg_temp.check(
  pg_temp.token_of('00000000-0000-4000-8000-00000000000b') = 'ExponentPushToken[device-one]',
  'B registering device one takes it');
select pg_temp.check(
  pg_temp.token_of('00000000-0000-4000-8000-00000000000a') is null,
  'A no longer holds device one, so A''s alerts stop going to B''s phone');
select pg_temp.check(
  (select count(*) from public.profiles where expo_push_token = 'ExponentPushToken[device-one]') = 1,
  'exactly one profile holds device one');

-- A registers a different phone: B keeps device one.
select pg_temp.act_as('00000000-0000-4000-8000-00000000000a');
select public.register_push_token('ExpoPushToken[device-two]');
reset role;
select pg_temp.check(
  pg_temp.token_of('00000000-0000-4000-8000-00000000000a') = 'ExpoPushToken[device-two]'
  and pg_temp.token_of('00000000-0000-4000-8000-00000000000b') = 'ExponentPushToken[device-one]',
  'registering another device leaves other accounts alone (both token prefixes accepted)');

-- Registering the same token again is a no-op, not an error.
select pg_temp.act_as('00000000-0000-4000-8000-00000000000a');
select public.register_push_token('ExpoPushToken[device-two]');
reset role;
select pg_temp.check(
  pg_temp.token_of('00000000-0000-4000-8000-00000000000a') = 'ExpoPushToken[device-two]',
  're-registering is idempotent');

-- ------------------------------------------------------ register: rejections --

select pg_temp.act_as('00000000-0000-4000-8000-00000000000a');
do $$
declare
  v_bad text;
begin
  foreach v_bad in array array[
    '', 'not-a-token', 'ExponentPushToken[]', 'ExponentPushToken[a b]',
    'ExponentPushToken[x];drop table x', 'ExponentPushToken[x]x',
    'ExponentPushToken[' || repeat('a', 201) || ']'
  ] loop
    begin
      perform public.register_push_token(v_bad);
      raise exception 'FAILED: accepted a malformed token';
    exception when sqlstate '22023' then
      -- The error must not carry the value back.
      null;
    end;
  end loop;
  begin
    perform public.register_push_token(null);
    raise exception 'FAILED: accepted a null token';
  exception when sqlstate '22023' then null;
  end;
end $$;
reset role;
select pg_temp.check(
  pg_temp.token_of('00000000-0000-4000-8000-00000000000a') = 'ExpoPushToken[device-two]',
  'malformed tokens are rejected with 22023 and change nothing');

-- Not signed in: authenticated role but no user claim.
set local role authenticated;
select set_config('request.jwt.claims', '', true);
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  perform public.register_push_token('ExponentPushToken[device-three]');
  raise exception 'FAILED: registered without a user';
exception when sqlstate '42501' then null;
end $$;
reset role;
select pg_temp.check(
  not exists (select 1 from public.profiles where expo_push_token = 'ExponentPushToken[device-three]'),
  'no user claim: rejected with 42501, nothing written');

-- ---------------------------------------------------- the invariant, any path --

-- A direct PostgREST-style update (an older app build) cannot create a second holder.
select pg_temp.act_as('00000000-0000-4000-8000-00000000000a');
do $$
begin
  update public.profiles
     set expo_push_token = 'ExponentPushToken[device-one]'
   where id = '00000000-0000-4000-8000-00000000000a';
  raise exception 'FAILED: a direct update duplicated a token';
exception when unique_violation then null;
end $$;
reset role;
select pg_temp.check(
  pg_temp.token_of('00000000-0000-4000-8000-00000000000b') = 'ExponentPushToken[device-one]',
  'the unique index refuses a second holder on the direct-update path');

-- Registration still cannot read anyone else's row.
select pg_temp.act_as('00000000-0000-4000-8000-00000000000a');
select pg_temp.check(
  (select count(*) from public.profiles where id = '00000000-0000-4000-8000-00000000000b') = 0,
  'A still cannot see B''s profile (RLS unchanged)');
reset role;

-- ------------------------------------------------------------- unregister --

-- B tries to clear A's token by naming it: only B's own row is in scope.
select pg_temp.act_as('00000000-0000-4000-8000-00000000000b');
select public.unregister_push_token('ExpoPushToken[device-two]');
reset role;
select pg_temp.check(
  pg_temp.token_of('00000000-0000-4000-8000-00000000000a') = 'ExpoPushToken[device-two]',
  'unregister cannot clear another account''s token');

-- A stale device (its token was since replaced by a newer phone) must not clear the new one.
select pg_temp.act_as('00000000-0000-4000-8000-00000000000a');
select public.unregister_push_token('ExponentPushToken[an-older-phone]');
reset role;
select pg_temp.check(
  pg_temp.token_of('00000000-0000-4000-8000-00000000000a') = 'ExpoPushToken[device-two]',
  'unregister with a token that is no longer stored leaves the newer one');

-- Sign-out on the phone that holds it clears it.
select pg_temp.act_as('00000000-0000-4000-8000-00000000000b');
select public.unregister_push_token('ExponentPushToken[device-one]');
reset role;
select pg_temp.check(
  pg_temp.token_of('00000000-0000-4000-8000-00000000000b') is null,
  'unregister on the holding device clears the token');

\warn PASS: push_token_single_owner
rollback;
