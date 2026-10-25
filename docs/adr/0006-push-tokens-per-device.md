# 0006. Push tokens per device

## Status

Accepted — 2026-10-24 (owner chose "one token per device"). Sub-step (i), the database, is built by
migration `push_tokens_per_device`. Sub-step (ii), the worker, is built by migration
`notification_device_sends` and `services/poller/src/push/*` (section "Sub-step (ii) as built" below).
Sub-step (iii), the app, is designed here and built later. Extends, and does not replace, the single-owner rule of migration
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

### Sub-step (ii): the worker (designed; built, see "Sub-step (ii) as built")

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

## Hardening (2026-10-24, migration `push_tokens_hardening`, after review)

Amends the decision above; where they differ, this section wins.

- **Bounded trace.** Every call that adds a trace row for a user then keeps only that user's newest
  200 rows (by `id`, i.e. insertion order) via `private.trim_push_token_events`. The worker never
  deletes, so the bridge trigger does not trim; its rows are bounded by registrations, which do.
- **Bridge re-points the column.** When the deployed worker's dead-token clear NULLs the column and
  the user still has another active device, the trigger sets the column to the newest one (no other
  profile may hold it). It runs in a subtransaction, so a unique-index conflict leaves the column
  NULL and can never fail the worker's own `update`. Until (ii), an account with two devices keeps
  getting alerts when one dies.
- **`service_role` has no EXECUTE** on either function (nothing server-side calls them).
- **No deadlock between cross-moves.** The case: B registers A's device X while A registers B's
  device Y. Before, each call held its own token's advisory lock, wrote one profile, then waited for
  the other's profile row: a cycle. Now the lock order is fixed, and every path follows it:
  1. a call takes **exactly one** advisory lock (its token), before any row lock;
  2. it then locks **every `profiles` row it will write** — caller, the token's current owner, any
     column holder — in one `select … order by id for update`. Rows are locked in sorted order;
  3. only then does it lock `push_tokens` rows, and only rows owned by users whose profile it holds
     (the owner of a token cannot change without that token's advisory lock);
  4. `unregister` locks only the caller's profile, then its row; the worker's clear locks one profile
     row (the one it updates), and its trigger touches only that user's `push_tokens` rows and the
     same profile row.

  A waits-for cycle needs some transaction to wait on a lock while holding one that comes later in
  this order. Advisory locks come first and no call takes a second one; profile locks are taken in
  ascending `id` in one statement; `push_tokens` locks are only taken while holding the owner's profile
  lock, so any two transactions contending on a `push_tokens` row already met at that profile row.
  So no cycle can form: cross-moves now queue on the lower profile id. (Single-session tests check
  the outcome of cross-moves; the ordering itself is this argument.)

  Scope and edge cases of that argument (migration `push_tokens_lock_strength`):
  - The profile-row lock is **`for no key update`**, the lock the worker's own `update profiles`
    takes. It still serialises every profile writer, but no longer conflicts with the `key share`
    locks that foreign-key checks take, so inserts referencing a profile are not blocked.
  - The lock set covers **only writers of profile rows and these two functions** (and the worker's
    clear with its trigger). Readers and FK checks are outside it and cannot join a cycle with it.
  - An over-cap retire inside **another token's** register can delete this token's row without
    holding this token's advisory lock (it holds the owner's profile lock instead, so this call waits
    for it). Benign: after the wait, the `for update` re-select finds nothing and the call takes the
    insert path; no `moved_to_other_account` row is written for the retired owner, whose trace already
    has `retired_over_cap`.
  - A legacy direct `update profiles` by `authenticated` that lands after the lock query is a plain
    wait on that one row (or on the unique index), never a cycle: it takes no advisory lock and no
    second row lock.

## Sub-step (ii) as built (2026-10-24, migration `notification_device_sends`)

Amends the sub-step (ii) design above; where they differ, this section wins.

- **Table.** `notification_device_sends (delivery_id → notification_deliveries on delete cascade,
  token_sha256, status, expo_ticket_id, error, sent_at, receipt_checked_at)` with **primary key**
  `(delivery_id, token_sha256)` (the designed unique key; it also serves the foreign key). Checks in
  the style of `push_delivery_lifecycle`: status vocabulary, `sent`/`delivered` carry a ticket,
  hex-only hash, `error` ≤ 64 chars. Partial index on `sent_at where status = 'sent'` for receipts.
  RLS on, no policies, nothing for `anon`/`authenticated`/`service_role`; the worker gets `select,
  insert` and `update (status, expo_ticket_id, error, sent_at, receipt_checked_at)` — never the key,
  no DELETE.
- **One more device status, `pending`.** A receipt saying `MessageRateExceeded` puts that device
  back to `pending` (ticket cleared) so it alone is re-sent; a `pending` row is the only one the send
  path may overwrite. A device with any other row is never sent that delivery again.
- **When a device row is written.** Only once there is an outcome: an ok ticket (`sent`), an error
  ticket (`failed`), an unreadable ticket (`unconfirmed`), or retries exhausted (`failed` with our
  code). A retryable failure (429/5xx/401, network, timeout, `MessageRateExceeded` on the ticket)
  writes nothing, so the device is tried again with its delivery. Each Expo request (≤ 100 messages,
  devices of several people mixed) has its rows written as soon as it answers, so a crash re-sends
  only the request in flight. A retryable request failure stops the rest of that batch.
- **Parent status rule**, derived in SQL from the device rows in the same statement that writes the
  parent (`services/poller/src/push/deliveryStatus.ts`, "Parent status"): `pending` while any device
  still has a retryable send and attempts remain — even if another device already got a ticket; else
  the best device outcome, `delivered` > `sent` > `unconfirmed` > `failed`; with no device row,
  `skipped` / `NoPushToken` (no active device), `expired`, or `failed` with our code. The parent keeps
  one **representative ticket and hash** (its earliest `sent`/`delivered` device's), so
  `notification_deliveries_ticket_check` stays true without altering the parent table. The finalize
  only touches a parent still `sending` under the same `attempts`, so a late answer after a lease
  overrun cannot overwrite the re-claimer's result.
- **Receipts** are per device row; afterwards each `sent` parent is re-derived (or put back to
  `pending` when a device must be re-sent). `DeviceNotRegistered` runs exactly the designed update
  (`… and last_registered_at <= $3`, `$3` = the device row's `sent_at`, read back at millisecond
  precision, which only makes the guard stricter) plus one `device_not_registered` trace event, in one
  statement. The operator path uses the read time of the device list as `$3`.
- **Legacy deliveries.** A delivery sent by the previous single-device build is `sent` with its ticket
  and hash on the parent and no device row. Each receipt run first adopts such rows into one device
  row each (`ADOPT_LEGACY_SENDS_SQL`), so they still get receipts and dead-device invalidation. Expo
  keeps receipts 24 h, so this is idle a day after the deploy; the final sub-step can remove it.
- **The worker no longer writes `profiles.expo_push_token`.** It neither reads nor clears it, so the
  interim bridge trigger no longer fires from the worker, and the column can keep a token the worker
  has since invalidated (it is only read by a rollback to the previous build, which would clear it
  again and so fire the trigger). The register/unregister functions still dual-write it.
- **Lock order.** The worker's invalidation locks one `push_tokens` row, then the trace insert's FK
  check takes `key share` on the owner's profile, which does not conflict with the functions'
  `for no key update`. So the worker never waits on a lock the functions hold while holding one they
  want, and no cycle can form with the order above.
- **Review follow-ups (same day).** A `pending` device row is closed `failed` (keeping the
  `MessageRateExceeded` code it was waiting on, else `DeviceInactive`) when its device is no longer
  active or its delivery closes unsent (expired, unbuildable), before the devices are read
  (`CLOSE_STALE_PENDING_SENDS_SQL`). Without that it held the delivery `pending` until attempts ran
  out, and a delivery whose only ticketed device went away could end `NoPushToken`. Device rows'
  `sent_at` is the database time the devices were read, before any request leaves (the guard can
  then only keep a device that registered while the send was in flight). The lease is renewed before
  each further Expo request, and a delivery re-claimed meanwhile is dropped from the batch
  (`RENEW_SEND_LEASE_SQL`), so 10 devices × 100 deliveries cannot outlast it. The receipt job writes
  device rows and re-derives their deliveries in one transaction. No schema change.
- **Operator alerts** go to every active device of `OPERATOR_USER_ID` (≤ 10, one request); the alert
  counts as sent if any device got a ticket, and a dead device is invalidated as above.

**A later sub-step** (after (iii)) stops the dual-write in both functions, drops the interim
`profiles` trigger, `profiles.expo_push_token` and its unique index, revokes the worker's
`select`/`update` on that column, and removes the legacy adoption step.

