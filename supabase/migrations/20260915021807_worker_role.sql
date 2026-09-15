-- Dedicated, least-privilege login for the Render worker (Phase 2 plan §5,
-- owner-approved 2026-09-14). The worker must not hold the `postgres` password.
--
-- The role is created NOLOGIN here. Its password is set outside migrations as a
-- pre-hashed SCRAM verifier, so no secret is ever committed or sent in clear.
--
-- BYPASSRLS: the worker's job is global (every flight, every recipient), so row
-- filters would only be `using (true)`. Its reach is bounded instead by the
-- table- and column-level grants below; it can touch nothing else in the
-- database, and it has no DELETE anywhere.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'flightbuddy_worker') then
    create role flightbuddy_worker nologin noinherit bypassrls connection limit 10;
  end if;
end
$$;

alter role flightbuddy_worker set statement_timeout = '60s';

grant usage on schema public to flightbuddy_worker;

-- The engine's own tables.
grant select, insert, update on public.flights to flightbuddy_worker;
grant select, insert on public.flight_events to flightbuddy_worker;
grant select, insert, update on public.notification_deliveries to flightbuddy_worker;
grant select, insert on public.provider_credit_log to flightbuddy_worker;
grant usage on sequence public.provider_credit_log_id_seq to flightbuddy_worker;

-- Recipient lookup only: ids and the push token. No names, emails or invite contacts.
grant select (id, expo_push_token) on public.profiles to flightbuddy_worker;
grant update (expo_push_token) on public.profiles to flightbuddy_worker;   -- clear dead tokens (§8.10)
grant select (id, user_id) on public.travelers to flightbuddy_worker;
grant select (id, traveler_id) on public.trips to flightbuddy_worker;
grant select (id, trip_id, flight_id, marketing_carrier_iata, marketing_flight_number)
  on public.trip_segments to flightbuddy_worker;

-- pg-boss lives in its own schema, owned by the worker, invisible to API roles.
-- PostgREST only exposes configured schemas, and this one is not among them.
grant flightbuddy_worker to postgres;
create schema if not exists pgboss authorization flightbuddy_worker;
revoke all on schema pgboss from public, anon, authenticated;
