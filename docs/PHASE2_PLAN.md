# Phase 2 — The engine: plan for owner review

**Status:** approved with owner decisions, 2026-09-13 (see §8). Nothing below is built yet. Once approved, the decisions here are copied into `docs/PROJECT_OVERVIEW.md` (rule 14) and the agent briefs in `docs/subagents/`.

**Overview definition (§13):** Render Blueprint, background worker, `next_poll_at` scheduler with leasing, polling ladder, webhook receiver, subscription lifecycle, credit monitoring and failover, change detection, pg-boss, Expo Push.
*Done when:* the app wakes you when your gate changes, and a drained credit balance falls back to polling without losing an alert.

---

## 1. What "Phase 2 finished" means

Each line is a check that passes or fails. Phase 2 is done when all of them pass on the deployed dev stack, the security check passes, and the owner has seen items 6 and 7 happen.

| # | Criterion | How it is proven |
|---|---|---|
| 1 | **Deployed.** API web service and poller worker (with its scheduled jobs) run on Render against the dev Supabase project. | Render dashboard shows all services live; a forced error shows in Render logs with no personal data in it. |
| 2 | **Polling ladder.** Every active flight is polled on the §7.4 schedule with ±10% jitter; `scheduled`-tier flights stay on the failover ladder permanently. | Unit tests at every ladder boundary, including DST changes and flights crossing the date line. |
| 3 | **Rate limit.** The account's 1 request/second limit is never exceeded, even when many flights come due at once. | Fake-clock test with 200 simultaneously due flights; provider call log shows no second with more than one call. |
| 4 | **Leasing survives restarts.** Killing the worker mid-poll loses nothing: the flight is re-claimed after its lease expires and polled once. Two workers never poll the same flight at the same time. | Integration test against a local Postgres; one manual restart during a Render deploy. |
| 5 | **Webhook lifecycle.** A `live`-tier flight subscribes at T-24h (polling stops), receives alerts, and unsubscribes and archives at landed + 30 min. The receiver answers 200 fast, and rejects a wrong token or malformed body without queueing anything. | Tests for each transition; one real subscription observed end to end. |
| 6 | **Gate change wakes you.** On a physical iPhone, a gate change on your own flight produces exactly one push, and tapping it opens the app on that flight. | A captured real alert payload, edited to change the gate, replayed through the deployed endpoint to your phone; plus one real live flight observed if one is available during the phase. |
| 7 | **Failover drill.** With the dev credit balance drained to zero, every subscribed flight goes back on the polling ladder within one run of the hourly credit job, a gate change during that degraded window is still notified exactly once, and the operator is alerted. | Automated integration test plus one manual drill (§7.7 requires the test). |
| 8 | **No duplicates.** When a poll and a webhook detect the same change, one `flight_events` row and one push result. | Race test; the `notification_deliveries` unique key is the backstop. |
| 9 | **Stale and stuck flights.** Five consecutive provider failures back a flight off; any flight is archived by scheduled arrival + 6 h even if landing is never observed. | Unit tests. |
| 10 | **Dead push tokens.** A `DeviceNotRegistered` receipt clears that profile's token. | Unit test with a recorded Expo receipt. |
| 11 | **Security and hygiene.** The pre-commit security check passes on every Phase 2 commit; Supabase advisors are clean; the overview reflects the 2026 alert API. | Check results recorded in each commit report. |

---

## 2. Things only you can do (blocking)

| # | Item | Why it blocks | Needed by |
|---|---|---|---|
| A | **Re-subscribe the RapidAPI AeroDataBox plan to its latest version.** | AeroDataBox's 2026 alert system only works on the latest plan version; your balance endpoint currently returns an empty body, which fits an old plan version. No subscriptions or credits without it. | Wave 3 |
| B | **Render account with billing.** Background workers are paid-only (§11). | The worker cannot run anywhere else in the plan. | Wave 1 |
| C | **Supabase connection string for the worker.** Local development uses the direct string (stored in `.env`). Render must use the **session pooler** string: the direct host is IPv6-only and Render connects over IPv4. Not the transaction pooler: pg-boss needs session-level features (§8.6). | Wave 1 |
| D | **A physical iPhone, and an Apple push key uploaded to EAS.** | The app deliberately skips push registration on simulators, so criterion 6 needs a real device and a development build signed with your Apple team. | Wave 5 |
| E | ~~Sentry~~ skipped for now (§8.4). | — | — |
| F | ~~Decide the open questions in §8.~~ Decided 2026-09-13. | — | — |

---

## 3. What changed since the overview was written

AeroDataBox moved to a new credit-based alert system (migration deadline 4 April 2026). Differences from §7.6 and §7.7:

- **Create:** `POST /subscriptions/webhook/{subjectType}/{subjectId}?useCredits=true`, where `subjectType` is `FlightByNumber`. Our provider wrapper needs the `useCredits` flag.
- **Retries** default to 0 (range 0–2). The overview says to set 2. Every retry costs a credit, and our endpoint will answer 200 immediately, so I propose **1** (see §8).
- **Subscriptions never expire.** Cleanup is entirely our job, which makes the hourly reconcile job mandatory, not optional.
- **Payload signing is not documented** anywhere I could find. The endpoint has to be secured by us (§5).
- Every alert payload still carries the remaining balance, so free balance monitoring (§7.6) still works.
- **Credits are never drawn automatically from the plan.** The alert balance is separate from the API-unit quota and only grows when `POST /subscriptions/balance/refill` is called with a credit amount (1 credit = 1 API unit). There is no dashboard for it. At zero, all subscriptions pause.
- **The RapidAPI Pro plan changed** (checked 2026-09-14 on aerodatabox.com/pricing): **5,000 API units/month and 2 requests/second at $8/month**, not the 6,000 units, 1 req/s and $5.35 in overview §7.8 and §11. The worker keeps its 1 req/s limit as headroom for the API's own lookups. The per-refill cap for RapidAPI plans is not published; the overview's "600 per call, 6,000 max" came from the old plan and is unverified.

These go into a new **ADR 0003** and the overview in the first Phase 2 commit.

---

## 4. Architecture

```
                AeroDataBox (RapidAPI)
                 │ poll (GET)        ▲ subscribe / unsubscribe / balance
                 ▼                   │
┌──────────────────────────┐    ┌──────────────────────────────┐
│ Render worker: poller     │    │ Scheduled pg-boss jobs        │
│  • claim due flights      │    │ (run inside the worker)       │
│                           │    │  • hourly: credit balance,    │
│    (lease, commit, poll)  │    │    low-credit alert, failover │
│  • 1 req/s token bucket   │    │  • hourly: reconcile orphaned │
│  • ladder → next_poll_at  │    │    subscriptions              │
│  • T-24h subscribe,       │    │  • daily: archive backstop    │
│    landed+30 unsubscribe  │    └──────────────────────────────┘
│  • pg-boss consumers:     │
│    webhook jobs, push     │◀── pg-boss queue (Supabase Postgres, session pooler)
│    sends, push receipts   │                     ▲
└─────────────┬────────────┘                     │ enqueue only
              │ ingest + change detection        │
              ▼                                   │
     flights ─▶ flight_events ─▶ notification_deliveries ─▶ Expo Push ─▶ iPhone
                                                  │
┌──────────────────────────────┐                  │
│ Render web service: apps/api  │ POST /webhooks/aerodatabox/<secret>
│  • validate, enqueue, 200     │◀── AeroDataBox alert deliveries
└──────────────────────────────┘
```

- **Rule 7 holds.** The webhook route only validates and enqueues; the worker's job consumer does the `flights` write through `ingestFlight`, as the overview requires.
- **Phase 2 notifies your own flights only.** Group fan-out, mutes and unclaimed-traveller rules are Phase 3; quiet hours are Phase 4 and never apply to your own flight anyway (§9).

---

## 5. Security design (your pre-commit rule, applied to Phase 2)

The new surfaces are an unauthenticated webhook URL, a long-running process holding the service-role key, a queue, and outbound push. Each gets a named control.

**Webhook endpoint**
- The URL carries a secret path segment: 32+ random bytes, stored only in Render env, compared in constant time. A wrong token returns 404, queues nothing, and logs no payload. Rotating it is free: create new subscriptions, delete old ones.
- Strict zod schema, a small body-size cap, and a per-IP rate limit. Unknown subscription ids are acknowledged and dropped.
- The payload is **data, never instructions**: parsed into typed fields, mapped through the existing status enum, never interpolated into SQL, shell or any prompt. Only provider fields reach `flights`, through `ingestFlight`'s parameterized upsert.
- Because deliveries are unsigned, a forged request with a stolen URL could inject a fake gate. Mitigation (owner decision in §8): before notifying a *gate* or *cancellation* change that arrived by webhook, cross-check it with one provider poll (2 units).

**Keys and privilege**
- The service-role key and RapidAPI key live only in Render env for the worker and API; never in the mobile app, logs, fixtures or commits.
- pg-boss gets its own schema that is not exposed through the Supabase REST API; advisors must stay clean.

**Personal data**
- Logs carry ids only: no names, emails, push tokens, connection strings, or Authorization headers.
- Push text contains only the recipient's own flight facts (number, route, gate, time), never another person's data.
- Error bodies stay generic, as in Phase 1.

**Engineering basics**
- Validation at every trust boundary, parameterized queries only, idempotent job handlers, timeouts on every outbound call.
- No new dependency without checking its maintenance and licence. Expected additions: `pg-boss`, `pg`, `expo-server-sdk`.

---

### Render environment variables (least privilege)

Only what the code actually reads goes into Render. Each service gets only its own.

| Variable | Service | When | Notes |
|---|---|---|---|
| `DATABASE_URL` | worker | Wave 1 | **Session pooler** string for the `flightbuddy_worker` role (§8.7). |
| `RAPIDAPI_KEY` | worker | Wave 1 | Development key (§12.3). |
| `WEBHOOK_URL` | worker | Wave 3 | Full public receiver URL including the secret token; the worker registers it with AeroDataBox. |
| `WEBHOOK_TOKEN` | API web service | Wave 3 | The same secret, so the receiver can check it. |
| `OPERATOR_USER_ID` | worker | Wave 4 | Your profile id, so low-credit and failover alerts go to your phone. Not a secret. |

Deliberately **not** on the worker: `SUPABASE_SERVICE_ROLE_KEY` (the worker talks to Postgres directly, so it has no use for the REST admin key), the anon key, the Google client IDs, and the owner's `postgres` password. The API web service keeps the Supabase variables it already has (`apps/api/README.md`).

**Least-privilege database role.** The worker should not hold the `postgres` superuser password. Proposed: a `flightbuddy_worker` role that can read and write only `flights`, `flight_events`, `notification_deliveries`, `provider_credit_log`, read `profiles.expo_push_token` and the trip tables it needs for recipients, and own the `pgboss` schema. Its password is generated once, stored in Render and the local `.env`, and never committed. Owner approval needed before creating it.

## 6. Work plan

Builders run on Opus 5, the reviewer on Sonnet 5. Every wave goes build → review → fix → security check → commit. Waves 2 and 3 can overlap because they touch different files.

**Wave 0 — carry-over and decisions** (project head, api-backend)
- `apps/api/src/auth.test.ts`, owed from Phase 1's review, because Phase 2 adds an unauthenticated route beside the authenticated ones.
- ADR 0003 (2026 alert API, webhook auth, retry count), overview §7.6/§7.7 updates.
- Capture one real alert payload into `docs/api-samples/` once prerequisite A is done (spends a handful of credits; counts toward the 20-call cap).

**Wave 1 — infrastructure** (infra)
- `render.yaml`: API web service and poller worker, env var declarations with no values. No cron services (§8.8).
- Worker config schema (fails fast on missing env, reports names only), pg-boss on the session-pooler connection (the direct host is IPv6-only), log scrubbing.
- Migration only if needed (for example a lease-claim function); advisors and generated types after it.

**Wave 2 — polling engine** (data-pipeline)
- Pure `nextPollAt(flight, now)` for the §7.4 ladder with jitter; exhaustive boundary tests.
- Lease claim (§7.5 SQL, `for update skip locked`), token-bucket limiter, `pollAndUpdate` reusing `lookupCandidates` + `ingestFlight`.
- Pure change detector: previous row vs fresh data → typed events (gate, delay over 30 min, cancelled, departed, landed, diverted), written to `flight_events`.
- Failure back-off after 5, archive backstop, stop at landed + 30 min.

**Wave 3 — webhooks and subscriptions** (api-backend for the route; data-pipeline for lifecycle and processing)
- T-24h subscribe (store id, null `next_poll_at`), landed + 30 min unsubscribe.
- Receiver route per §5; pg-boss job that ingests, detects changes and logs the balance.
- Hourly reconcile: list provider subscriptions, delete any we cannot map to an active flight.

**Wave 4 — credit monitor and failover** (data-pipeline)
- Hourly balance check, logged to `provider_credit_log`.
- No automatic refill (§8.3). Below the low-water mark, alert the owner; at zero, put every subscribed flight back on the polling ladder immediately and alert the owner.
- The drain integration test (§7.7).

**Wave 5 — notifications** (data-pipeline for sending; mobile-client for the app side)
- Event → recipients (the users whose own trips contain that flight) → `notification_deliveries` insert (unique key) → pg-boss send job → Expo Push in batches → receipts job → clear dead tokens.
- Message copy with airport-local times and zone labels.
- App: foreground notification handling; tapping opens the dashboard on that flight.

**Wave 6 — end-to-end proof**
- Deploy, then run criteria 1–11 in order, with you holding the phone for 6 and watching 7.

---

## 7. Budget

- Development key only (§12.3); at most 20 exploratory calls per agent.
- Tests run against captured fixtures, never the live API.
- Live spend in Phase 2 is small but real: a few alert credits to capture a payload, one real subscription for criterion 5, and the failover drill. I will log every paid call in `docs/api-samples/calls.tsv` as in Phase 1.

---

## 8. Owner decisions (2026-09-13)

1. **Webhook authentication:** secret URL token **plus** a verification poll before notifying a gate change or cancellation that arrived by webhook (2 units per such alert).
2. **Retries:** 1 per delivery (`maxDeliveryRetries: 1`).
3. **Credits: no automatic refill.** The hourly job checks the balance, records it in `provider_credit_log`, and alerts the owner when it falls below a low-water mark (proposed: 300 credits, and again at 100 and at zero). The owner refills manually. The zero-balance failover to polling (§7.7 step 3) still applies. This replaces §7.7 step 2 in the overview.
4. **Operator alerts** go to the owner as push notifications to their own phone through the same Expo pipeline, so no email service or extra API key is needed. Recipients are configured by user id, not stored credentials. **Sentry is skipped for now**; Render's own logs and crash emails cover errors.
5. **Delay threshold** stays at "over 30 minutes".
6. **Environment:** all of Phase 2 runs on the dev Supabase project and dev RapidAPI key.
7. **Dedicated worker login (approved 2026-09-14).** The worker connects as `flightbuddy_worker`, a restricted role with table- and column-level grants and no DELETE, through the session pooler. The owner's `postgres` password is removed from Render and rotated.
8. **Scheduled jobs run inside the worker (approved 2026-09-14),** on pg-boss's built-in scheduler, instead of separate Render cron jobs. The hourly credit check, hourly subscription reconcile and daily archive backstop become scheduled pg-boss jobs. This saves the cron cost and keeps the database and RapidAPI secrets in one service instead of four. It replaces the cron rows in overview §4 (recorded in ADR 0003).

Prerequisites done: A (RapidAPI plan re-subscribed), C (direct connection string stored in the local git-ignored `.env`). E (Sentry) dropped. B (Render worker) in progress.

## 9. Explicitly not in Phase 2

Group notifications, mutes and unclaimed-traveller routing (Phase 3). Quiet hours, retention purge, tier badges and multi-segment UI (Phase 4). Production project and TestFlight (Phase 5). The Phase 1 follow-ups other than `auth.test.ts` (session timeout fallback, import cycle, input keystrokes) are small and will be folded into whichever wave touches those files.
