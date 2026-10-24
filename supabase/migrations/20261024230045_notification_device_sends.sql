-- Push tokens per device, sub-step (ii): one send record per device (ADR 0006;
-- overview §6.2, §6.3, §9, §10).
--
-- `notification_deliveries` stays one row per (flight event, person): §9's
-- idempotency guard `unique (flight_event_id, user_id)`, the fan-out SQL, the
-- claim and the lease are unchanged. The worker now sends that person's alert to
-- every active device in `push_tokens`, and records each device here:
--
--   delivery (one per person) ──< device send (one per device the message went to)
--
-- Child status lifecycle (services/poller/src/push/deliveryStatus.ts is the one
-- copy in code):
--
--   (no row) ──ticket ok──▶ sent ──receipt ok──▶ delivered
--      │                     │  └─ receipt error ─▶ failed
--      │                     ├─ no receipt in 24 h ─▶ unconfirmed
--      │                     └─ MessageRateExceeded ─▶ pending ──re-sent──▶ sent …
--      ├──ticket error──▶ failed
--      └──unreadable ticket──▶ unconfirmed
--
-- A device with no row, or a `pending` row, is sent to when its delivery is
-- claimed; a device with any other row is never sent to again for that
-- delivery. That is how a re-claimed delivery (crash, lease overrun, retry of
-- another device) skips the devices that already hold a ticket.
--
-- The parent's status is derived from its rows by the worker (deliveryStatus.ts):
-- `pending` while a device still has a retryable send and attempts remain;
-- otherwise the best child outcome, delivered > sent > unconfirmed > failed; and
-- `skipped` / `NoPushToken` only when the person had no active device at all.
-- The parent keeps one representative ticket (its first `sent`/`delivered`
-- child's), so `notification_deliveries_ticket_check` holds unchanged.
--
-- Safe while the previous worker build still runs: purely additive. That build
-- never reads or writes this table; its deliveries carry their ticket on the
-- parent and are adopted here by the new receipt job.
--
-- Tokens are bearer credentials (§10): only the token's SHA-256 is stored.

create table public.notification_device_sends (
  delivery_id        uuid not null
                     references public.notification_deliveries (id) on delete cascade,
  -- hex SHA-256 of the device's push token (= push_tokens.token_sha256). Never the token.
  token_sha256       text not null
                     constraint notification_device_sends_token_sha256_check
                     check (token_sha256 ~ '^[0-9a-f]{64}$'),
  status             text not null
                     constraint notification_device_sends_status_check
                     check (status in ('pending', 'sent', 'delivered', 'failed', 'unconfirmed')),
  -- Expo push ticket id, read by the receipt job.
  expo_ticket_id     text,
  -- A short code (ours or Expo's), never text from a response body.
  error              text
                     constraint notification_device_sends_error_check
                     check (error is null or char_length(error) <= 64),
  -- When the message to this device was handed to Expo. Compared with
  -- push_tokens.last_registered_at, so a device that registered again after
  -- the send is not invalidated by this send's DeviceNotRegistered.
  sent_at            timestamptz not null default now(),
  -- Last time the receipt job asked Expo about this device's ticket.
  receipt_checked_at timestamptz,
  -- One record per (delivery, device): a retry can never add a second.
  constraint notification_device_sends_pkey primary key (delivery_id, token_sha256),
  -- A device Expo accepted always carries the ticket its receipt is fetched with.
  constraint notification_device_sends_ticket_check
    check (status not in ('sent', 'delivered') or expo_ticket_id is not null),
  -- A device waiting to be re-sent holds no ticket (the next send gets a new one).
  constraint notification_device_sends_pending_ticket_check
    check (status <> 'pending' or expo_ticket_id is null)
);

comment on table public.notification_device_sends is
  'One row per device a notification_deliveries row was sent to. Token SHA-256 only. Worker-only; no client access.';

-- The receipt job: devices Expo accepted and has not yet confirmed. (The primary
-- key, led by delivery_id, serves the foreign key and every per-delivery read.)
create index notification_device_sends_awaiting_receipt_idx
  on public.notification_device_sends (sent_at)
  where status = 'sent';

alter table public.notification_device_sends enable row level security;
-- No policies, and no privileges for any API role: only the worker touches it.
revoke all on table public.notification_device_sends from public, anon, authenticated, service_role;

-- Style of 20260915021807_worker_role. Insert, read, and update of the outcome
-- columns only (never the key); no DELETE (rows go with their delivery by cascade).
grant select, insert on public.notification_device_sends to flightbuddy_worker;
grant update (status, expo_ticket_id, error, sent_at, receipt_checked_at)
  on public.notification_device_sends to flightbuddy_worker;
