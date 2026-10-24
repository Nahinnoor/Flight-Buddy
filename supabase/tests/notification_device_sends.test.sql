-- Contract test for migration 20261024230045_notification_device_sends (ADR 0006,
-- sub-step ii). One transaction, always rolled back; throwaway users and a
-- synthetic flight; fabricated hashes only (never a token). The worker's own
-- statements are exercised against a real Postgres by the poller's SQL, not
-- here; this pins the table's shape, constraints and grants.

\set ON_ERROR_STOP 1
begin;

create function pg_temp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then
    raise exception 'FAILED: %', p_what;
  end if;
  raise notice 'ok - %', p_what;
end $$;

-- Expect `p_sql` to fail with SQLSTATE `p_state`.
create function pg_temp.refused(p_sql text, p_state text, p_what text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_state then
      raise notice 'ok - %', p_what;
      return;
    end if;
    raise exception 'FAILED: % (got %)', p_what, sqlstate;
  end;
  raise exception 'FAILED: % (no error)', p_what;
end $$;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000d1', 'device-sends@example.test');

insert into public.flights (id, operating_carrier_iata, operating_flight_number,
                            departure_date_local, origin_iata, destination_iata,
                            origin_tz, destination_tz)
values ('00000000-0000-4000-8000-0000000000f1', 'ZZ', '9999', '2099-01-01', 'JFK', 'LAX',
        'America/New_York', 'America/Los_Angeles');
insert into public.flight_events (id, flight_id, event_type, new_value, source)
values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000f1',
        'gate_change', '{"gate":"B2"}', 'poll');
insert into public.notification_deliveries (id, flight_event_id, user_id)
values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000e1',
        '00000000-0000-4000-8000-0000000000d1');

-- -------------------------------------------------------------- privileges --

select pg_temp.check(
  (select relrowsecurity from pg_class where oid = 'public.notification_device_sends'::regclass)
  and not exists (select 1 from pg_policies
                   where schemaname = 'public' and tablename = 'notification_device_sends'),
  'RLS on, no policies');
select pg_temp.check(
  not exists (
    select 1
      from (values ('anon'), ('authenticated'), ('service_role')) r(role),
           (values ('select'), ('insert'), ('update'), ('delete')) p(priv)
     where has_table_privilege(r.role, 'public.notification_device_sends', p.priv)),
  'no API role holds any privilege');
select pg_temp.check(
  has_table_privilege('flightbuddy_worker', 'public.notification_device_sends', 'select')
  and has_table_privilege('flightbuddy_worker', 'public.notification_device_sends', 'insert')
  and not has_table_privilege('flightbuddy_worker', 'public.notification_device_sends', 'delete')
  and not has_table_privilege('flightbuddy_worker', 'public.notification_device_sends', 'update')
  and has_column_privilege('flightbuddy_worker', 'public.notification_device_sends', 'status', 'update')
  and has_column_privilege('flightbuddy_worker', 'public.notification_device_sends', 'expo_ticket_id', 'update')
  and has_column_privilege('flightbuddy_worker', 'public.notification_device_sends', 'error', 'update')
  and has_column_privilege('flightbuddy_worker', 'public.notification_device_sends', 'sent_at', 'update')
  and has_column_privilege('flightbuddy_worker', 'public.notification_device_sends', 'receipt_checked_at', 'update')
  and not has_column_privilege('flightbuddy_worker', 'public.notification_device_sends', 'delivery_id', 'update')
  and not has_column_privilege('flightbuddy_worker', 'public.notification_device_sends', 'token_sha256', 'update'),
  'worker: select, insert, update of the outcome columns only; no delete, never the key');

-- ------------------------------------------------------------- as the worker --

set local role flightbuddy_worker;

insert into public.notification_device_sends (delivery_id, token_sha256, status, expo_ticket_id)
values ('00000000-0000-4000-8000-0000000000a1', repeat('a', 64), 'sent', 'ticket-1');

-- The send path's upsert: a settled row is never overwritten.
insert into public.notification_device_sends as s (delivery_id, token_sha256, status, expo_ticket_id)
values ('00000000-0000-4000-8000-0000000000a1', repeat('a', 64), 'sent', 'ticket-2')
on conflict (delivery_id, token_sha256) do update
   set status = excluded.status, expo_ticket_id = excluded.expo_ticket_id
 where s.status = 'pending';
select pg_temp.check(
  (select expo_ticket_id from public.notification_device_sends where token_sha256 = repeat('a', 64)) = 'ticket-1',
  'a settled device row keeps its first ticket');

select pg_temp.refused(
  $q$delete from public.notification_device_sends$q$, '42501', 'worker cannot delete');
select pg_temp.refused(
  $q$update public.notification_device_sends set token_sha256 = repeat('b', 64)$q$, '42501',
  'worker cannot rewrite the key');

reset role;

-- ------------------------------------------------------------- constraints --

select pg_temp.refused(
  $q$insert into public.notification_device_sends (delivery_id, token_sha256, status, expo_ticket_id)
     values ('00000000-0000-4000-8000-0000000000a1', repeat('a', 64), 'failed', null)$q$,
  '23505', 'one row per (delivery, device)');
select pg_temp.refused(
  $q$insert into public.notification_device_sends (delivery_id, token_sha256, status)
     values ('00000000-0000-4000-8000-0000000000a1', repeat('c', 64), 'sent')$q$,
  '23514', 'sent without a ticket is refused');
select pg_temp.refused(
  $q$insert into public.notification_device_sends (delivery_id, token_sha256, status, expo_ticket_id)
     values ('00000000-0000-4000-8000-0000000000a1', repeat('c', 64), 'pending', 'ticket-x')$q$,
  '23514', 'pending with a ticket is refused');
select pg_temp.refused(
  $q$insert into public.notification_device_sends (delivery_id, token_sha256, status)
     values ('00000000-0000-4000-8000-0000000000a1', 'ExponentPushToken[not-a-hash]', 'failed')$q$,
  '23514', 'only a hex SHA-256 is accepted, never a token');
select pg_temp.refused(
  $q$insert into public.notification_device_sends (delivery_id, token_sha256, status)
     values ('00000000-0000-4000-8000-0000000000a1', repeat('c', 64), 'skipped')$q$,
  '23514', 'status vocabulary is pinned');
select pg_temp.refused(
  $q$insert into public.notification_device_sends (delivery_id, token_sha256, status, error)
     values ('00000000-0000-4000-8000-0000000000a1', repeat('c', 64), 'failed', repeat('x', 65))$q$,
  '23514', 'error is a short code');

delete from public.notification_deliveries where id = '00000000-0000-4000-8000-0000000000a1';
select pg_temp.check(
  not exists (select 1 from public.notification_device_sends
               where delivery_id = '00000000-0000-4000-8000-0000000000a1'),
  'device rows go with their delivery');

\warn PASS: notification_device_sends
rollback;
