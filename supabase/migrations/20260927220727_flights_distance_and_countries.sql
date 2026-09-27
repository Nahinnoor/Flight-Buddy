-- Great-circle distance and origin/destination countries on `flights`
-- (overview §6.2, §6.3 note dated 2026-09-27).
--
-- Why. The Profile screen shows lifetime distance flown and countries visited.
-- AeroDataBox already returns both on every lookup (`greatCircleDistance.km`,
-- and each airport's `countryCode`), and every webhook delivery carries the
-- distance too, so the provider mapper now carries them into `FlightCandidate`
-- and `ingestFlight` writes them. They are properties of the flight, so they
-- belong on the shared row (§6.1), not on a user's segment.
--
-- Shape.
-- - `distance_km`: great-circle distance, rounded to whole kilometres. The
--   longest possible great circle is half the Earth's circumference (~20,038 km),
--   so anything above 20,100 is a bad value, not a long flight.
-- - `origin_country_code`, `destination_country_code`: ISO 3166-1 alpha-2,
--   stored UPPERCASE (the provider sends lowercase, e.g. "gb"; the mapper
--   uppercases and rejects anything that is not two letters).
--
-- All three are nullable, with no default:
-- - `manual`-tier flights (§7.3) have no provider data at all;
-- - rows ingested before this migration have none;
-- - a provider payload may omit them, and the mapper turns an invalid value
--   into NULL rather than failing the whole leg.
--
-- Writers never erase a known value. Both `FlightsWriter` implementations
-- update these columns as `coalesce(new, existing)`: the worker's SQL uses
-- `coalesce(excluded.col, flights.col)`, and the API's supabase-js writer omits
-- a NULL value from the upsert payload so PostgREST leaves the column alone.
-- So a webhook delivery that lacks a distance cannot wipe the one a lookup
-- stored. A non-NULL value always replaces the stored one.
--
-- No backfill. There is nothing to backfill from: `flights.raw_payload` holds
-- our own domain `FlightCandidate` snapshot (`ingestFlight`'s default, and no
-- caller passes the provider body), never the AeroDataBox response, so it has
-- no distance and no country code. Existing rows fill in on their next poll or
-- delivery; manual-tier rows stay NULL.
--
-- Grants: none needed. `flightbuddy_worker` already holds table-level
-- `select, insert, update on public.flights` (20260915021807_worker_role.sql),
-- which covers new columns; there are no column-level grants on `flights`.
--
-- RLS: unchanged. `flights` keeps its single select policy
-- (`flights_select_subscribed`) and no user-facing write policy (§10); the new
-- columns are readable exactly where the rest of the row is.

alter table public.flights
  add column distance_km integer,
  add column origin_country_code char(2),
  add column destination_country_code char(2);

alter table public.flights
  add constraint flights_distance_km_range
    check (distance_km is null or distance_km between 0 and 20100),
  add constraint flights_origin_country_code_format
    check (origin_country_code is null or origin_country_code ~ '^[A-Z]{2}$'),
  add constraint flights_destination_country_code_format
    check (destination_country_code is null or destination_country_code ~ '^[A-Z]{2}$');

comment on column public.flights.distance_km is
  'Great-circle distance, whole km, from the provider. NULL for manual-tier and pre-2026-09-27 rows.';
comment on column public.flights.origin_country_code is
  'ISO 3166-1 alpha-2 of the origin airport, uppercase. NULL when unknown.';
comment on column public.flights.destination_country_code is
  'ISO 3166-1 alpha-2 of the destination airport, uppercase. NULL when unknown.';
