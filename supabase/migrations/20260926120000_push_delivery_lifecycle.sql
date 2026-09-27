-- Phase 2, wave 5: the Expo push pipeline's state on `notification_deliveries`
-- (overview §8.10, §9; PHASE2_PLAN criteria 6, 8, 10).
--
-- One row per (flight event, recipient) already exists as the idempotency guard
-- (§9: `unique (flight_event_id, user_id)`). This adds what sending and receipt
-- checking need, and pins the status vocabulary with a check constraint.
--
-- Status lifecycle (services/poller/src/push/deliveryStatus.ts is the one copy
-- in code):
--
--   pending ──claim──▶ sending ──Expo ticket ok──▶ sent ──receipt ok──▶ delivered
--      ▲                 │  │                        │
--      │   retryable     │  └─ ticket error ─▶ failed ◀── receipt error
--      └─ (429/5xx/net) ─┘                        │
--      └──────────── MessageRateExceeded ─────────┘  (back to pending)
--
--   pending ──▶ skipped      (recipient has no push token at send time)
--   pending ──▶ expired      (event older than the send window; never sent late)
--   sent    ──▶ unconfirmed  (no receipt within Expo's 24 h retention, or an
--                             unreadable ticket: sent, outcome unknown)
--
-- A `sending` row whose `claimed_until` has passed was claimed by a worker that
-- died or timed out mid-request. It is claimed again (at-least-once, with the
-- same APNs collapse id so iOS shows one notification), until `attempts` runs
-- out, then closed as `failed` / `SendOutcomeUnknown`.
--
-- Push tokens are sensitive (§10). The token itself is NOT copied here: only
-- its SHA-256, so the receipt job can clear `profiles.expo_push_token` on
-- `DeviceNotRegistered` only while the stored token is still the one that
-- failed (criterion 10: a newer token registered since must survive).
--
-- Grants: `flightbuddy_worker` already holds the TABLE-level
-- `select, insert, update on public.notification_deliveries`
-- (20260915021807_worker_role). A table-level privilege covers every column,
-- including columns added later, so no grant change is needed; it still has no
-- DELETE. RLS stays enabled with no policies: no client role can read the table.

alter table public.notification_deliveries
  add column created_at         timestamptz not null default now(),
  -- Why this user is a recipient. Phase 3 adds 'group_member' and
  -- 'unclaimed_owner' (§9); only 'own_flight' ignores quiet hours.
  add column recipient_reason   text        not null default 'own_flight',
  -- Send attempts, counted at claim time.
  add column attempts           int         not null default 0,
  -- Earliest time a `pending` row may be claimed again (retry back-off).
  add column not_before         timestamptz,
  -- Lease on a `sending` row; past it, the send is presumed interrupted.
  add column claimed_until      timestamptz,
  -- Expo push ticket id, read by the receipt job.
  add column expo_ticket_id     text,
  -- hex SHA-256 of the push token the message was sent to. Never the token.
  add column push_token_sha256  text,
  -- Last time the receipt job asked Expo about this row.
  add column receipt_checked_at timestamptz;

-- Rows written before this pipeline existed would otherwise be sent now, hours
-- or days late. None are expected (nothing wrote this table before wave 5); if
-- any exist they are closed, never sent.
update public.notification_deliveries
   set status = 'expired',
       error = 'PredatesPipeline'
 where status is null
    or status not in ('pending', 'sending', 'sent', 'delivered', 'failed',
                      'skipped', 'expired', 'unconfirmed');

alter table public.notification_deliveries
  alter column status set default 'pending',
  alter column status set not null,
  add constraint notification_deliveries_status_check
    check (status in ('pending', 'sending', 'sent', 'delivered', 'failed',
                      'skipped', 'expired', 'unconfirmed')),
  add constraint notification_deliveries_recipient_reason_check
    check (recipient_reason in ('own_flight')),
  add constraint notification_deliveries_attempts_check
    check (attempts >= 0),
  -- A row Expo accepted always carries the ticket the receipt is fetched with.
  add constraint notification_deliveries_ticket_check
    check (status not in ('sent', 'delivered') or expo_ticket_id is not null),
  add constraint notification_deliveries_token_hash_check
    check (push_token_sha256 is null or push_token_sha256 ~ '^[0-9a-f]{64}$'),
  -- `error` holds a short code (our reason or Expo's error code), never text
  -- from a response body.
  add constraint notification_deliveries_error_check
    check (error is null or char_length(error) <= 64);

-- The send claim: `pending` rows, and `sending` rows whose lease has passed.
create index notification_deliveries_sendable_idx
  on public.notification_deliveries (created_at)
  where status in ('pending', 'sending');

-- The receipt job: rows Expo accepted and has not yet confirmed.
create index notification_deliveries_awaiting_receipt_idx
  on public.notification_deliveries (sent_at)
  where status = 'sent';

-- The once-per-flight guard in the fan-out looks up a user's earlier deliveries;
-- `notification_deliveries_user_id_idx` (20260912011826) already serves it.
