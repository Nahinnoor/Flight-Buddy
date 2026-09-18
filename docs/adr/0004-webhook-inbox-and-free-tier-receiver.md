# 0004. The webhook inbox, and running the receiver on a free web service

## Status

Accepted — 2026-09-15. Extends ADR 0003, which stands except where noted below.

## Context

ADR 0003 settled *how* alerts are authenticated. Building wave 3 raised three questions it did not
answer, and the owner made one cost decision:

- **How does the receiver hand an alert to the worker?** The plan said "enqueue to pg-boss". pg-boss
  runs inside the worker on a Postgres connection owned by `flightbuddy_worker`. Giving the API that
  connection means a second database credential on the only publicly reachable service, plus the
  queue library in its dependency tree.
- **What does a delivery contain?** The documented envelope
  (`docs/api-samples/webhook-notification-schema.md`) carries `subscription.subscriber`, which is
  where the provider echoes the delivery target back. Our delivery URL *is* the secret
  (`WEBHOOK_TOKEN` in its path).
- **Which address does the rate limiter key on?** Render terminates TLS at a proxy, so without
  configuration every request appears to come from that proxy.
- **Cost.** Phase 2 is dev-only. A Render free web service costs nothing but sleeps after 15 minutes
  without traffic and takes about a minute to wake, while AeroDataBox abandons a delivery after 10
  seconds and charges for the retry.

## Decisions

1. **The receiver writes to an inbox table, not to a queue.** `public.webhook_inbox` (migration
   `20260915125352_webhook_inbox`) takes one row per accepted delivery, written with the
   service-role key the API already holds; the worker claims rows `for update skip locked`, oldest
   first, at the start of every tick, and marks them processed. The API gains no database password
   and no queue dependency. The cost is latency (one worker tick rather than the queue's push) and
   our own retry bookkeeping (`attempts`, `last_error`, given up after 5).
2. **`subscription.subscriber` is replaced with a fixed placeholder before the row is written.**
   Otherwise the secret delivery URL would sit in a table, in every backup, and in every later read
   of that row. The worker never needs it: deliveries are matched by `subscription.id`.
3. **The API trusts exactly one proxy hop** (`trustProxy` as a hop-0 predicate, not `true`), so the
   per-IP rate limit keys on the caller and a forged `X-Forwarded-For` chain cannot change it.
4. **The receiver runs on a Render free web service while Phase 2 is dev-only.** Two consequences
   follow, both of them required, not optional:
   - **The worker pings `/healthz` every 10 minutes** (`KEEPALIVE_URL`, `KEEPALIVE_INTERVAL_MS`).
     The worker is already paid and always on, so this needs no third-party cron and no extra
     service. `/healthz` needs no auth, touches no dependency and costs no provider units.
   - **A subscribed flight keeps a slow backup poll inside the alert window**
     (`WEBHOOK_BACKUP_POLL_MS`, default 2 hours). This **replaces §7.6's `next_poll_at = NULL`**: a
     delivery lost to a cold start would otherwise never be noticed, because nothing else looks at
     the flight during that window. Setting it to 0 restores the literal §7.6 behaviour.
   Render also grants 750 free instance hours per workspace per month, and one always-awake service
   consumes 720–744 of them. A second awake free service would exhaust the allowance and suspend
   both until the month rolls over.
5. **Processed inbox rows are kept.** `flightbuddy_worker` has no DELETE anywhere, and the audit
   trail is useful. The Phase 4 retention job purges them.

## Consequences

- Overview §7.6's "no polling at all inside the window" is now "the backup cadence, or nothing when
  it is disabled"; §4's service table gains the inbox. Updated in the same commit (rule 14).
- The stored payload is not byte-identical to what the provider sent. Anything reconstructing a
  delivery from `webhook_inbox` must know `subscriber` was removed, and (since 2026-09-18) that any
  unmodelled top-level key was stripped.
- **Envelope strictness reversed (2026-09-18).** The receiver's top level was `strictObject`,
  following the spec's `additionalProperties: false`, and ADR 0003 describes the payload as
  "validated by a strict schema". Real deliveries carry three undocumented top-level keys (`id`,
  `timestampUtc`, `deliveryAttempt`) and a non-string `flights[].status`, so strictness rejected
  every real alert — each rejection billed, and retried and billed again (ADR 0003 decision 2). The
  receiver now **strips** unknown top-level keys and only requires `status` to be present; the
  constant-time token guard, not the key set, is what authenticates a delivery. Decision 2 is
  unchanged and still holds: only the parsed envelope is stored, never the raw body, so a stripped
  key cannot reach `webhook_inbox`, and `subscription` is still an allow-list with `subscriber`
  redacted. The worker's parse stays strict about what it reads (items, and `status` as a string),
  so a delivery it cannot read is closed as `InvalidPayload` with its payload kept for inspection.
- Before beta, switch the API to a paid instance and revisit decision 4: with no cold starts, the
  backup poll can go back to 0 and save ~24 units per tracked flight per day.
- If AeroDataBox ever signs deliveries, ADR 0003's verification poll can go; the inbox, the
  redaction and the keep-alive are unaffected.
