-- Webhook inbox (Phase 2 wave 3, ADR 0003, PHASE2_PLAN §5).
--
-- Why an inbox table and not pg-boss on the API: the API web service is the one
-- process that accepts unauthenticated internet traffic (the AeroDataBox
-- receiver). Enqueuing into pg-boss from it would put a second database
-- credential (a Postgres connection string) and a queue library on exactly that
-- process. Instead the receiver writes each accepted delivery here through the
-- service-role REST client it already holds, and the worker (flightbuddy_worker)
-- drains the table. Least privilege on both sides: the public-facing service
-- gains no new secret and no new dependency; the worker can read rows and mark
-- them processed, but cannot insert, delete, or rewrite a payload.
--
-- The payload is provider data only. The receiver validates it before insert;
-- nothing downstream may interpolate it into SQL, shell, a log line or a prompt.

create table public.webhook_inbox (
  id              uuid primary key default gen_random_uuid(),
  received_at     timestamptz not null default now(),
  subscription_id uuid not null,           -- payload.subscription.id
  payload         jsonb not null,          -- the validated envelope, as parsed (not the raw bytes)
  processed_at    timestamptz,             -- set by the worker
  attempts        int not null default 0,  -- incremented by the worker
  last_error      text                     -- short class name only, set by the worker
);

-- The worker's drain query: oldest unprocessed first.
create index webhook_inbox_unprocessed_received_at_idx
  on public.webhook_inbox (received_at)
  where processed_at is null;

-- RLS on with NO policies: anon and authenticated get no rows at all. The
-- service role (the API receiver) bypasses RLS; the worker role has BYPASSRLS
-- and is bounded by the grants below instead.
alter table public.webhook_inbox enable row level security;

-- Supabase's default privileges grant every new public table to anon and
-- authenticated. RLS already denies them every row; this takes the table out of
-- their reach entirely, so a future policy mistake cannot expose it.
revoke all on public.webhook_inbox from anon, authenticated;

-- Read the queue, record the outcome. No insert (only the API writes rows), no
-- delete, and no update of subscription_id or payload.
grant select, update (processed_at, attempts, last_error)
  on public.webhook_inbox to flightbuddy_worker;
