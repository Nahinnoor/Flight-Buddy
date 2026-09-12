-- flights: shared, poller-owned real-world facts (§6.1, §6.2).
-- Only the service role writes here (ADR 0001).

create table public.flights (
  id                      uuid primary key default gen_random_uuid(),

  -- canonical identity: the OPERATING flight, post codeshare resolution
  operating_carrier_iata  char(2) not null,
  operating_flight_number text    not null,
  departure_date_local    date    not null,   -- local date at ORIGIN
  origin_iata             char(3) not null,
  destination_iata        char(3) not null,

  status                  public.flight_status not null default 'scheduled',
  tracking_tier           public.tracking_tier not null default 'scheduled',

  gate                    text,
  terminal                text,

  scheduled_departure_utc timestamptz,
  estimated_departure_utc timestamptz,
  actual_departure_utc    timestamptz,
  scheduled_arrival_utc   timestamptz,
  estimated_arrival_utc   timestamptz,
  actual_arrival_utc      timestamptz,

  origin_tz               text not null,      -- IANA, e.g. 'America/New_York'
  destination_tz          text not null,

  aircraft_reg            text,
  aircraft_model          text,

  -- scheduling
  next_poll_at            timestamptz,
  poll_lease_until        timestamptz,
  last_polled_at          timestamptz,
  poll_failure_count      int not null default 0,

  -- webhook lifecycle
  alert_subscription_id   text,
  alert_subscribed_at     timestamptz,

  raw_payload             jsonb,              -- last provider response, for debugging
  archived_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  unique (operating_carrier_iata, operating_flight_number,
          departure_date_local, origin_iata)
);

create index flights_next_poll_at_idx on public.flights (next_poll_at)
  where archived_at is null and next_poll_at is not null;

create index flights_alert_subscription_id_idx on public.flights (alert_subscription_id)
  where alert_subscription_id is not null;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger flights_set_updated_at
  before update on public.flights
  for each row execute function private.set_updated_at();
