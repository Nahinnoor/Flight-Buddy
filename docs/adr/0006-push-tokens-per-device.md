# 0006. Push tokens per device

## Status

Accepted — 2026-10-24 (owner chose "one token per device"). Sub-step (i), the database, is built by
migration `push_tokens_per_device`. Sub-steps (ii) the worker and (iii) the app are designed here and
built later. Extends, and does not replace, the single-owner rule of migration
`20260926130000_push_token_single_owner` (overview §6.3, §10): a device's token still belongs to at
most one account.

## Context

Each account holds one push token, `profiles.expo_push_token`, written only by
`register_push_token` / `unregister_push_token`. That has two failure modes:

- a second device (an iPad, a simulator, a reinstall) replaces the first device's token, so only the
  most recent device ever gets alerts;
- signing out on any device clears the one column, which can leave the account with no token at all.

It happened live: the owner's real `departed` and `landed` pushes for a tracked flight on 2026-09-28 were
`skipped` / `NoPushToken`, and nothing recorded why the column had become NULL. We could only guess
(the sign-out path, most likely).

A hard constraint: Render auto-deploys the worker from `main`, and the live worker reads
`profiles.expo_push_token`, clears it on `DeviceNotRegistered` (guarded by the token's SHA-256), and
inserts `notification_deliveries` with `on conflict (flight_event_id, user_id)`. Sub-step (i) must
not break any of that.

## Decision

### Sub-step (i): the database (built)

**`public.push_tokens`, one row per device.** `id`, `user_id → profiles on delete cascade`,
`token text unique` with the same shape check as the function and the worker, `token_sha256`
(generated, lowercase hex of the token's bytes, equal to the worker's
`encode(sha256(convert_to(token,'UTF8')),'hex')`), `created_at`, `last_registered_at`,
`invalidated_at`, `invalidated_reason` (`device_not_registered` or NULL, set together). Active means
`invalidated_at is null`. A user has at most **10** active devices: registering an 11th deletes the
least recently registered one. Ten bounds the worker's fan-out per recipient and is far above any
real household; a retired device that is still alive comes back as the newest on its next launch.

**`public.push_token_events`, the trace.** `id`, `user_id → profiles on delete cascade`,
`token_sha256` (never the token), `event` (`registered` | `moved_to_other_account` | `signed_out` |
`device_not_registered` | `retired_over_cap`), `at`. The next "why was there no token?" is answered
by reading this table, not guessed. It cascades with the account, so account deletion removes it.

Both tables: **RLS enabled with no policies, and every privilege revoked from `anon`,
`authenticated` and `service_role`.** No client and no API route reads or writes them. The app goes
through the two functions only; the worker gets the column-level grants below.

**`register_push_token(p_token)`** keeps its security model exactly: `security definer`,
`search_path = ''`, `auth.uid()` required (`42501`), shape check (`22023`, value not echoed),
per-token advisory lock, returns nothing, EXECUTE for `authenticated` only. Under the lock it:

1. upserts this device's row for the caller. A row held by another account is **moved** (its
   `created_at` restarts) and `moved_to_other_account` is logged against the old account;
2. re-activates the row and bumps `last_registered_at` (`clock_timestamp()`, so two registrations
   in one transaction still order);
3. logs `registered` when the row is new, moved or re-activated. A plain re-registration of an
   active row (every app launch) only bumps `last_registered_at`, so the trace records state changes
   and does not grow with every launch;
4. retires the caller's active devices beyond 10 (deleted, `retired_over_cap` logged);
5. **dual-writes** `profiles.expo_push_token`: NULLs this token on every other profile, then sets it
   on the caller's own, exactly as before. One change: an account that just lost this token gets its
   column recomputed from its own remaining active devices instead of being left NULL. It only ever
   receives one of its own tokens, so nothing can be planted on or read from another account.

**`unregister_push_token(p_token)`** changes from `security invoker` to **`security definer`**,
because it must delete from `push_tokens`, which has no client policies (and no client privileges).
Writing a policy instead would expose the table to direct PostgREST writes for a single use. Its
reach is the same as before: it deletes only the caller's own row for that token (`auth.uid()`
required, `42501`), logs `signed_out` if it removed anything, and recomputes the caller's
`profiles.expo_push_token` from their remaining active devices, most recently registered first, or
NULL. It never raises on an unknown or malformed token (sign-out must not fail) and returns nothing.
A sign-out on one device now leaves the account's other devices registered.

**Recompute rule** (`private.sync_profile_push_token`): the caller's most recently registered active
token that no other profile's column holds; if the unique index still refuses it (a concurrent
registration), the column is set to NULL — the old behaviour — rather than failing the call.

**Backfill:** every well-formed non-NULL `profiles.expo_push_token` becomes one `push_tokens` row
(with a `registered` event); the partial unique index already guarantees one holder. A malformed
legacy value, if any, is left in the column untouched and never copied (the worker rejects it anyway).

**Interim bridge for the live worker.** Until (ii) ships, the worker still clears
`profiles.expo_push_token` on `DeviceNotRegistered`. An `after update` trigger on `profiles` mirrors
that clear into `push_tokens`: when the statement runs as `flightbuddy_worker` and the column goes
from a token to NULL, the matching active row is invalidated with `device_not_registered` and the
event is logged. Without it the dead token would stay "active", and the next sign-out or move would
recompute it straight back into the column. The trigger is `security invoker` and uses exactly the
worker grants below; it never changes the worker's own write, so the live worker's behaviour is
unchanged. Clears made by the two functions (which run as the owner) and by a legacy direct update
do not fire it.

**Worker grants, given now** (style of `20260915021807_worker_role`, no DELETE anywhere):
`select` on `push_tokens`; `update (invalidated_at, invalidated_reason)` on `push_tokens`;
`insert` on `push_token_events`. The table- and column-level grants on `profiles` and
`notification_deliveries` are unchanged.

**Backward compatibility.** Additive only: no existing column, constraint, index, grant or policy is
changed or dropped. The legacy direct `update profiles set expo_push_token` path (pre-wave-5 builds)
still works under RLS and the unique index; it bypasses `push_tokens`, and the next
`register_push_token` call from that device reconciles it.

### Sub-step (ii): the worker (designed, not built)

- `notification_deliveries` stays **one row per (event, person)**, so §9's per-person idempotency
  guard `unique (flight_event_id, user_id)` and the fan-out SQL are unchanged.
- A child table, **`notification_device_sends`**: `delivery_id → notification_deliveries on delete
  cascade`, `token_sha256`, `expo_ticket_id`, `status` (`sent` | `delivered` | `failed` |
  `unconfirmed`), `error`, `sent_at`, `receipt_checked_at`, `unique (delivery_id, token_sha256)`.
  RLS on, no policies; worker `select, insert, update`.
- `push-send` reads the recipient's active `push_tokens` at send time (at most 10) and sends one
  message per device with the same `collapseId` (the event id), inserting one child row per device;
  a re-claimed row skips devices that already hold a ticket. The parent row is `sent` if any device
  got a ticket and `skipped` / `NoPushToken` only when there is no active device.
- `push-receipts` checks each child row's ticket. `DeviceNotRegistered` invalidates **only that
  device**: `update push_tokens set invalidated_at = now(), invalidated_reason =
  'device_not_registered' where user_id = $1 and token_sha256 = $2 and invalidated_at is null and
  last_registered_at <= $3` (`$3` = the child row's `sent_at`), plus one `device_not_registered`
  event. A new token is a different row; the same token registered again after the send has a newer
  `last_registered_at`; either way only the device that failed is invalidated.
  The parent becomes `delivered` when any device is delivered.
- The child table is created by **(ii)'s own migration**, not this one: its status vocabulary, lease
  and retry columns are shaped by the send and receipt code, and an unused table now would be guessed
  schema to alter later. That migration is additive and is applied to the database before the worker
  code reaches `main`, so the deploy order stays safe.

Then (iii) the app needs no change to keep working (it already registers on every launch and
unregisters on sign-out). After (ii) and (iii) have shipped, a final step stops the dual-write,
removes the interim trigger and drops `profiles.expo_push_token` and its index.

## Consequences

- A second device no longer silences the first in the database, and signing out on one device no
  longer clears the others. **Until (ii) ships, the worker still sends to one device only** — the
  most recently registered active one, via the dual-written column.
- Every token gain or loss is explained by a row in `push_token_events`, holding only a SHA-256.
- Tokens remain bearer credentials (§10): they live only in `push_tokens.token` and the dual-written
  column, are readable only by the database owner and the worker role, and never appear in the
  trace, logs or errors.
- Accepted residual risk is unchanged from §10: a caller who already knows another device's token can
  register it to themselves (moving it) until that device next registers.
- `unregister_push_token` is now `security definer`; the advisor will list it alongside
  `register_push_token` under `authenticated_security_definer_function_executable`. Intentional.
- Invalidated rows and trace events are never purged yet. Both are small and bounded by device
  history; the Phase 4 retention job should purge invalidated rows and events older than 90 days.
