-- notification_prefs, flight_events, notification_deliveries, provider_credit_log (§6.2).

create table public.notification_prefs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles (id) on delete cascade,
  group_id          uuid not null references public.groups (id) on delete cascade,
  muted_traveler_id uuid not null references public.travelers (id) on delete cascade,
  muted_by_owner    boolean not null default false,
  unique (user_id, group_id, muted_traveler_id)
);

-- user_id is covered by the leading column of the unique constraint above.
create index notification_prefs_group_id_idx on public.notification_prefs (group_id);
create index notification_prefs_muted_traveler_id_idx on public.notification_prefs (muted_traveler_id);

create table public.flight_events (
  id             uuid primary key default gen_random_uuid(),
  flight_id      uuid not null references public.flights (id) on delete cascade,
  event_type     text not null,   -- gate_change | delay | cancelled | departed | landed | diverted
  previous_value jsonb,
  new_value      jsonb,
  detected_at    timestamptz not null default now(),
  source         text not null    -- 'poll' | 'webhook'
);

create index flight_events_flight_id_idx on public.flight_events (flight_id);

create table public.notification_deliveries (
  id              uuid primary key default gen_random_uuid(),
  flight_event_id uuid not null references public.flight_events (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  sent_at         timestamptz,
  status          text,
  error           text,
  unique (flight_event_id, user_id)   -- idempotency guard
);

-- flight_event_id is covered by the leading column of the unique constraint above.
create index notification_deliveries_user_id_idx on public.notification_deliveries (user_id);

create table public.provider_credit_log (
  id          bigserial primary key,
  balance     int not null,
  observed_at timestamptz not null default now(),
  source      text not null   -- 'webhook_payload' | 'balance_check' | 'post_refill'
);
