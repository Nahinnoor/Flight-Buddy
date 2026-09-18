# 0005. Open the webhook window after the previous day's occurrence has landed

## Status

Accepted — 2026-09-18 (owner decision). Replaces the "subscribe at T-24 h" rule in overview §7.6.
ADR 0003 and ADR 0004 stand unchanged; neither decided the opening time.

## Context

A subscription is keyed by flight number with **no date** (§7.6): it fires for every occurrence of
that number, every day. It was opened at T-24 h. For a daily flight, T-24 h is the moment the
**previous day's** occurrence departs, so every alert that flight sends — takeoff, en-route updates,
landing — is billed to us (1 credit per item per delivery) before our own flight has sent anything.

This is not hypothetical. The first real delivery we captured
(`docs/api-samples/webhook-delivery-real-enroute.json`, 2026-09-18 23:21 UTC) was for DL1915's
**2026-09-18** occurrence — status 2 = EnRoute, a minute after takeoff — sixteen minutes after we
subscribed for the **2026-09-19** flight we track. The worker correctly ignores it (its canonical key
matches no tracked row; inbox reason `NoTrackedLeg`), but the credit was already spent. A daily route
costs roughly 10–12 credits a day this way.

## Decision

The webhook window opens at **`scheduled_arrival_utc − 24 h + 30 min`**: 30 minutes after the previous
day's same-numbered flight is scheduled to land. Equivalently, T-24 h plus the scheduled duration plus
30 minutes. JFK–LAX (~6 h) subscribes ~17.5 h before departure; a 16 h long-haul ~7.5 h before.

- **No scheduled arrival, or one not after the scheduled departure:** fall back to T-24 h on the
  ladder's departure anchor. Subscribing early is better than never subscribing.
- **Never later than departure** (the departure anchor): a pathological duration still subscribes
  before the aircraft leaves.
- **The ladder's T-24 h boundary does not move.** Between T-24 h and the opening, an unsubscribed
  `live` flight is on the failover ladder (hourly when more than 6 h out), which already covers the
  gap by polling. The poll that lands nearest the opening is pulled forward to it.
- The zero-credit guard (ADR 0003 / wave 4, `pollWebhookSettings`) still applies on top: no
  subscription is opened against an exhausted balance.

One function holds the rule: `webhookWindowOpensAt` in `services/poller/src/engine/subscriptions.ts`,
read by both `shouldSubscribe` and `clampToWindowOpening`.

## Consequences

- **Credits saved:** the previous occurrence's in-flight alerts, roughly 10–12 credits per daily route
  per tracked flight, are no longer bought.
- **Webhook coverage given up:** from T-24 h to the opening (the scheduled duration plus 30 minutes),
  the flight is tracked by hourly polls instead of alerts plus the 2 h backup poll (ADR 0004) —
  roughly 3 extra polls (≈6 units, flight status being Tier 2) for a 6 h flight, fewer for short ones. For a flight, that stretch is its day-before: a schedule change or
  early cancellation is seen within the hour rather than at once.
- **Scheduled-time approximation:** the rule uses the previous occurrence's *scheduled* arrival. If
  that flight lands late, its landing alert (and anything after the opening) can still be billed. We
  do not track the previous occurrence, so this is accepted rather than corrected.
- **Not changed:** a non-daily flight, or one whose previous occurrence is on another route, gains
  nothing but loses nothing beyond the coverage above. Other-day deliveries that still arrive are
  ignored by the worker exactly as before.
