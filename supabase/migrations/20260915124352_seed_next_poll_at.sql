-- New and re-added flights enter the polling ladder (Phase 2, wave 2 follow-up).
--
-- The worker only claims rows whose next_poll_at is set (§7.5), and ingestFlight
-- deliberately never writes scheduling columns (rule 7). Without this, a flight
-- added through the API was never polled at all. The trigger sets
-- next_poll_at = now() — "due immediately" — and the worker's first poll then
-- places the flight on the §7.4 ladder. It touches no other column.
--
-- Fires on INSERT, and on UPDATE of archived_at only when a row goes from
-- archived to active (ingestFlight clears archived_at on a re-add, §6.3).
-- Never seeds a manual-tier flight (not polled by design) or one that already
-- has a webhook subscription (wave 3 nulls next_poll_at inside the alert window).
--
-- On `insert ... on conflict do update`, Postgres fires BEFORE INSERT for the
-- proposed row first; the conflict path then applies only the SET list, which
-- never includes next_poll_at, so an existing row's schedule is untouched.

create or replace function private.seed_next_poll_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.tracking_tier <> 'manual'
     and new.archived_at is null
     and new.next_poll_at is null
     and new.alert_subscription_id is null
     and (tg_op = 'INSERT' or old.archived_at is not null)
  then
    new.next_poll_at = now();
  end if;
  return new;
end;
$$;

revoke all on function private.seed_next_poll_at() from public, anon, authenticated;

create trigger flights_seed_next_poll_at
  before insert or update of archived_at on public.flights
  for each row execute function private.seed_next_poll_at();

-- One-time backfill: active, pollable flights that have not landed yet.
-- Past flights are left for the archive backstop rather than spending a poll.
update public.flights
   set next_poll_at = now()
 where archived_at is null
   and next_poll_at is null
   and tracking_tier <> 'manual'
   and alert_subscription_id is null
   and coalesce(
         greatest(scheduled_arrival_utc, estimated_arrival_utc, actual_arrival_utc),
         scheduled_departure_utc + interval '18 hours'
       ) > now();
