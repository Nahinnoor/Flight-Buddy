-- trips / trip_segments: how a traveler subscribes to a shared flight (§6.2).

create table public.trips (
  id          uuid primary key default gen_random_uuid(),
  traveler_id uuid not null references public.travelers (id) on delete cascade,
  label       text,
  created_at  timestamptz not null default now()
);

create index trips_traveler_id_idx on public.trips (traveler_id);

create table public.trip_segments (
  id                      uuid primary key default gen_random_uuid(),
  trip_id                 uuid not null references public.trips (id) on delete cascade,
  flight_id               uuid not null references public.flights (id) on delete restrict,
  sequence_number         int  not null,

  -- what the user actually typed; display this, not the operating number
  marketing_carrier_iata  char(2),
  marketing_flight_number text,

  -- per-user corrections. NEVER write these back to flights.
  override_notes          text,

  created_at              timestamptz not null default now(),
  unique (trip_id, sequence_number)
);

-- trip_id is covered by the leading column of the unique constraint above.
create index trip_segments_flight_id_idx on public.trip_segments (flight_id);
