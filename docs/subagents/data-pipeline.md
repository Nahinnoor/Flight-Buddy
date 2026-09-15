# FlightBuddy — subagent doc: data-pipeline

> Derived verbatim from `docs/PROJECT_OVERVIEW.md`. If this contradicts the master, the master wins — regenerate this file.

## Phase 2 task for this agent

Phase 2 (see `docs/PHASE2_PLAN.md` and ADR 0003): Wave 2 — polling ladder (`nextPollAt` with ±10% jitter), lease-claim (`for update skip locked`), 1 req/s token bucket, `pollAndUpdate` reusing `lookupCandidates` + `ingestFlight`, change detection → `flight_events`, failure back-off, archive backstop. Wave 3 — T-24h subscribe with `useCredits=true` and `maxDeliveryRetries: 1`, landed+30 unsubscribe, `webhook-ingest` job (payload is data only; gate/cancellation changes confirmed with one poll before notifying), hourly reconcile of orphaned subscriptions. Wave 4 — hourly credit check → `provider_credit_log`, owner alert at 300/100/0, zero-balance failover to polling; no automatic refill. Wave 5 — event → recipients (own flights only) → `notification_deliveries` → Expo Push with receipts and dead-token clearing.

## Phase 1 task for this agent (done)

Build `packages/flight-provider`: the `FlightDataProvider` interface (§7.1), the AeroDataBox implementation via RapidAPI, codeshare resolution to the operating flight (§7.2), tracking-tier assignment (§7.3), and a shared `ingestFlight` function (service-role, writes only provider-returned values to `flights` via upsert on the canonical key) reused later by the poller. Capture real responses to `docs/api-samples/` (max 20 calls) and unit-test against those fixtures. Polling/webhooks are Phase 2 — do NOT build them.

---

## 1. Product definition

FlightBuddy tracks flights for a group of people travelling to the same place, in one view.

Solo flight tracking is a commodity — Flighty, TripIt, and airline apps all do it well. The differentiator is **group coordination**: four friends converging on one destination from three cities, with one screen showing every leg, every delay, and every gate change.

### MVP scope — in

- Email/social auth (Sign in with Apple + Google)
- Add a flight by flight number + date, enriched from AeroDataBox
- Personal dashboard: status, gate, terminal, scheduled/estimated times, duration, delay, countdown
- Multi-segment trips (layovers)
- Create a group, share a 6-character join code
- Join a group by code, subject to owner approval
- Owner adds an unclaimed traveller's flight (no account required for that person)
- Claim flow for unclaimed travellers, including a manual "is this you?" path
- Group page: own flight pinned top, other members as expandable rows
- Push notifications: delay, cancellation, gate change, departed, landed
- Per-member notification mute (by the user, and by the owner)
- "Not live-tracked" badge for flights outside provider coverage
- Auto-archive at trip completion, 90-day retention

### MVP scope — out, deliberately

| Deferred | Reason |
|---|---|
| Gmail/Outlook OAuth ingestion | Google verification requires a security assessment (CASA Tier 2 for restricted scopes), costs money annually, and takes 2–8 weeks. Gates launch on a process with no predictable end date. Manual entry ships now. |
| Android | Solo developer. Expo makes it cheap to add after iOS validates. |
| Baggage carousel | Poor coverage, low pre-arrival value. |
| In-app chat | iMessage and WhatsApp already won. |
| Live map / aircraft position | Impressive, changes no decisions, costs API budget. |
| Web app | Push is the value. iOS web push is unreliable. |
| Expense splitting, itineraries, recommendations | Post-MVP platform expansion. Schema anticipates them (§6). |

### Long-term direction

One-stop group travel: expense splitting, itinerary management, recommendations. This is why a group is scoped to a single trip with a destination and date range (§6) — expenses only settle inside a bounded trip.

---

## 6. Data model

### 6.1 The central idea: flights are shared entities

**A flight is a real-world fact, not a row belonging to a user.**

Four travellers on two aircraft produce **two** `flights` rows and two poll streams, not four. Users subscribe via `trip_segments`. Deduplication is global across the platform, not per group — if a stranger is on the same flight, they subscribe to the same row.

Why this matters:

- **Cost.** API spend scales with distinct flights, not users. Group travel means overlapping flights by definition.
- **Consistency.** Independent rows drift. One polls at 10:00 and shows gate B12, another at 10:04 and shows B27, and the group page displays two gates for one aircraft. Users notice instantly and stop trusting everything else.
- **No notification storms.** One change, one event.
- **A clean scheduler query.** "Which flights are due" is a single indexed query.

**Two invariants:**

1. **Only the poller writes to `flights`.** If a user can correct that row, one person's typo corrupts everyone's view. User corrections live on `trip_segments` and merge at read time.
2. **`next_poll_at` is computed from the earliest departure among subscribers**, never per subscriber.

### 6.2 Schema

```sql
-- ---------- enums ----------
create type tracking_tier   as enum ('live','scheduled','manual');
create type flight_status   as enum ('scheduled','delayed','boarding','departed',
                                     'en_route','diverted','landed','cancelled','unknown');
create type membership_status as enum ('pending','active','removed');

-- ---------- identity ----------
-- auth.users is managed by Supabase Auth.

create table profiles (
  id                  uuid primary key references auth.users(id) on delete cascade,
  display_name        text not null,
  email               citext,
  expo_push_token     text,
  quiet_hours_enabled boolean not null default true,
  created_at          timestamptz not null default now()
);

create table travelers (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references profiles(id) on delete cascade,   -- NULL = unclaimed; a claimed row is that user's self-traveller and goes with the account (§3.7)
  display_name   text not null,
  invite_email   citext,
  invite_phone   text,
  created_by     uuid references profiles(id) on delete set null,  -- NULL only after the creator deleted their account
  claimed_at     timestamptz,
  created_at     timestamptz not null default now()
);
create index on travelers (user_id);
create index on travelers (invite_email) where user_id is null;

-- ---------- flights (shared, poller-owned) ----------
create table flights (
  id                       uuid primary key default gen_random_uuid(),

  -- canonical identity: the OPERATING flight, post codeshare resolution
  operating_carrier_iata   char(2) not null,
  operating_flight_number  text    not null,
  departure_date_local     date    not null,   -- local date at ORIGIN
  origin_iata              char(3) not null,
  destination_iata         char(3) not null,

  status                   flight_status not null default 'scheduled',
  tracking_tier            tracking_tier not null default 'scheduled',

  gate                     text,
  terminal                 text,

  scheduled_departure_utc  timestamptz,
  estimated_departure_utc  timestamptz,
  actual_departure_utc     timestamptz,
  scheduled_arrival_utc    timestamptz,
  estimated_arrival_utc    timestamptz,
  actual_arrival_utc       timestamptz,

  origin_tz                text not null,      -- IANA, e.g. 'America/New_York'
  destination_tz           text not null,

  aircraft_reg             text,
  aircraft_model           text,

  -- scheduling
  next_poll_at             timestamptz,
  poll_lease_until         timestamptz,
  last_polled_at           timestamptz,
  poll_failure_count       int not null default 0,

  -- webhook lifecycle
  alert_subscription_id    text,
  alert_subscribed_at      timestamptz,

  raw_payload              jsonb,              -- last provider response, for debugging
  archived_at              timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  unique (operating_carrier_iata, operating_flight_number,
          departure_date_local, origin_iata)
);

create index on flights (next_poll_at)
  where archived_at is null and next_poll_at is not null;
create index on flights (alert_subscription_id)
  where alert_subscription_id is not null;

-- ---------- trips ----------
create table trips (
  id           uuid primary key default gen_random_uuid(),
  traveler_id  uuid not null references travelers(id) on delete cascade,
  label        text,
  created_at   timestamptz not null default now()
);

create table trip_segments (
  id                       uuid primary key default gen_random_uuid(),
  trip_id                  uuid not null references trips(id) on delete cascade,
  flight_id                uuid not null references flights(id) on delete restrict,
  sequence_number          int  not null,

  -- what the user actually typed; display this, not the operating number
  marketing_carrier_iata   char(2),
  marketing_flight_number  text,

  -- per-user corrections. NEVER write these back to flights.
  override_notes           text,

  created_at               timestamptz not null default now(),
  unique (trip_id, sequence_number)
);

-- ---------- groups ----------
create table groups (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  destination_iata     char(3),
  start_date           date,
  end_date             date,
  owner_traveler_id    uuid not null references travelers(id),
  join_code            char(6) not null unique,
  join_code_expires_at timestamptz,
  archived_at          timestamptz,
  created_at           timestamptz not null default now()
);

create table group_members (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references groups(id) on delete cascade,
  traveler_id  uuid not null references travelers(id) on delete cascade,
  trip_id      uuid references trips(id) on delete set null,
  status       membership_status not null default 'pending',
  role         text not null default 'member',   -- 'owner' | 'member'
  joined_at    timestamptz,
  created_at   timestamptz not null default now(),
  unique (group_id, traveler_id)
);

-- ---------- notifications ----------
create table notification_prefs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references profiles(id) on delete cascade,
  group_id          uuid not null references groups(id) on delete cascade,
  muted_traveler_id uuid not null references travelers(id) on delete cascade,
  muted_by_owner    boolean not null default false,
  unique (user_id, group_id, muted_traveler_id)
);

create table flight_events (
  id             uuid primary key default gen_random_uuid(),
  flight_id      uuid not null references flights(id) on delete cascade,
  event_type     text not null,   -- gate_change | delay | cancelled | departed | landed | diverted
  previous_value jsonb,
  new_value      jsonb,
  detected_at    timestamptz not null default now(),
  source         text not null    -- 'poll' | 'webhook'
);

create table notification_deliveries (
  id              uuid primary key default gen_random_uuid(),
  flight_event_id uuid not null references flight_events(id) on delete cascade,
  user_id         uuid not null references profiles(id) on delete cascade,
  sent_at         timestamptz,
  status          text,
  error           text,
  unique (flight_event_id, user_id)   -- idempotency guard
);

-- ---------- ops ----------
create table provider_credit_log (
  id          bigserial primary key,
  balance     int not null,
  observed_at timestamptz not null default now(),
  source      text not null   -- 'webhook_payload' | 'balance_check' | 'post_refill'
);
```

### 6.3 Notes on the schema

**`departure_date_local` is the local date at the origin airport**, because that is what AeroDataBox keys on. A 23:50 departure from JFK is one date locally and the next date in UTC. Getting this wrong produces lookups that silently return the wrong day's flight.

**`manual`-tier flights still get a `flights` row.** No `next_poll_at`, times supplied by the user. This keeps `trip_segments.flight_id` non-nullable and every read path uniform.

**Ownership transfer** on owner account deletion: promote the `group_members` row with the earliest `joined_at` (trigger `travelers_handover_groups_before_delete`, §3.7); the owner-chosen transfer is an application action in Phase 3.

**Implementation notes (applied 2026-09-11, migrations 20260912011727–20260912011905).** `citext` is installed in the `extensions` schema, so columns are typed `extensions.citext`. Every FK has an explicit index (performance advisor). A partial unique index on `travelers(user_id) where user_id is not null` enforces one self-traveller per user. RLS helpers live in a `private` schema as `security definer` functions with `search_path = ''`. Policy widenings beyond §10: `notification_prefs` rows are writable by the group owner (owner-set mutes); a pending joiner can read their own `group_members` row; the owner can read/update `groups` directly, not only via an active membership.

**Implementation notes (applied 2026-09-13, migration `travelers_created_by_set_null`).** `travelers.created_by` was `not null` with no `on delete` action, which made every profile delete — and so every account deletion (App Store guideline 5.1.1(v)) — fail, because a user always has a self-traveller pointing at them. It is now nullable with `on delete set null`: travellers the departing user created for other people survive; `cascade` was rejected because it would also delete a traveller that someone else has since claimed. RLS compares `created_by = auth.uid()`, which is false for NULL, so an orphaned unclaimed traveller is read-only until Phase 3 reassigns it to the group owner. Inserts still require `created_by = auth.uid()`. Superseded the same day by the note below for `user_id`.

**Implementation notes (applied 2026-09-13, migration `account_deletion_semantics`).** Implements §3.7. `travelers.user_id` is `on delete cascade` (a claimed row is the user's self-traveller; the cascade continues to trips, segments and memberships). Trigger `travelers_handover_groups_before_delete` (`security definer`, `private` schema) reassigns every group the traveller owns to the earliest-joined active member and marks that member `owner`, or deletes the group when nobody is left — without it `groups.owner_traveler_id`, which has no on-delete action, would refuse the delete. Trigger `trip_segments_archive_orphaned_flight_after_delete` sets `flights.archived_at` when the last segment referencing a flight is deleted; it is the one writer of `flights` outside ingest and the poller (rule 7 exception), touches `archived_at` only, and `ingestFlight` clears `archived_at` on every upsert so a re-add is visible again. Known race: a delete of the last segment concurrent with a new add can archive a flight the new segment references; the hourly reconcile job should un-archive any archived flight that still has a segment.

**Forward compatibility.** `groups.destination_iata`, `start_date`, and `end_date` are unused in MVP. They exist because expense splitting and itineraries need a bounded trip, and adding them later is a migration on a live table.

---

## 7. The flight data pipeline

This is the engine. Everything else is UI over the top of it.

### 7.1 Provider abstraction

All provider access goes through `packages/flight-provider`. No AeroDataBox response shape may leak into the domain model.

```ts
interface FlightDataProvider {
  lookupFlight(number: string, dateLocal: string): Promise<FlightCandidate[]>;
  getAirportFeedHealth(icao: string): Promise<FeedHealth>;
  subscribeAlerts(flightNumber: string, url: string): Promise<{ subscriptionId: string }>;
  unsubscribeAlerts(subscriptionId: string): Promise<void>;
  getCreditBalance(): Promise<number>;
  refillCredits(credits: number): Promise<number>;
}
```

### 7.2 Codeshare resolution

One aircraft, multiple flight numbers. Air France operates ATL→CDG as **AF 3612**; Delta sells the same seats as **DL 8517**. AF is the *operating* carrier, DL is a *marketing* number pointing at it.

Four ways this breaks things:

1. Live status is filed against the operating flight. Querying a marketing number may return schedule data with no live status.
2. Two friends on the same aircraft with different numbers deduplicate to two rows — two poll streams, and the group page shows them as separate flights when they're in adjacent seats.
3. Gate and terminal belong to the operating carrier. Showing the Delta terminal at CDG sends someone to the wrong building.
4. It concentrates on long-haul international, which is exactly this product's target.

**Rules:**
- Resolve to the operating flight **before insert**, never after. Resolving afterwards can collide with an existing row on the unique key.
- Use `insert ... on conflict (canonical key) do update`.
- Store the marketing number on `trip_segments`.
- Display the user's number as primary, operating as secondary:
  > **DL 8517** · ATL → CDG
  > Operated by Air France as AF 3612
- Never silently swap the number the user typed. They will assume you looked up the wrong flight.

### 7.3 Tracking tiers

Alerts and live data only exist where the provider has live/ADS-B coverage. Check `/health/services/airports/{icao}/feeds` at add time.

| Tier | Condition | Behaviour |
|---|---|---|
| `live` | Origin and destination have live feeds | Poll pre-window, webhooks inside window |
| `scheduled` | Schedule data only | Poll on the failover ladder permanently. Badge: **Not live-tracked** |
| `manual` | No provider data at all | User-entered times. No polling. Badge: **Not live-tracked** |

Tier lives on the flight row, so one untrackable member degrades exactly one row. Everyone else's live tracking is unaffected.

### 7.4 Polling ladder

Two jobs: the pre-window schedule, and the failover schedule when alerts are unavailable.

| Time to scheduled departure | Interval |
|---|---|
| > 7 days | Weekly |
| 7 days – 48 h | Daily |
| 48 – 24 h | Every 4 h |
| **T-24 h → arrival** | **Webhooks. No polling.** |
| *Failover:* 24 – 6 h | Hourly |
| *Failover:* 6 – 1.25 h | Every 15 min |
| *Failover:* T-75 min → wheels up | Every 5 min |
| *Failover:* in flight | Every 30 min |
| *Failover:* final 45 min of flight | Every 10 min |
| Landed + 30 min | Stop, unsubscribe, archive |

Failover rows apply permanently to `scheduled`-tier flights.

**Why T-75 minutes and not "30 minutes before boarding":** boarding time is rarely published by the API. It's derived as departure minus 30–45 minutes and is the least reliable field you will display. Anchoring the cadence to scheduled departure gives the same behaviour from data you always have.

**Always add ±10% jitter to `next_poll_at`** so flights added together don't clump into a burst against a 1 req/s limit.

### 7.5 The worker loop

```ts
while (running) {
  const due = await claimDueFlights(25);   // lease, commit, THEN poll
  for (const f of due) {
    await rateLimiter.acquire();           // 1 req/s
    await pollAndUpdate(f);
  }
  await sleep(30_000);
}
```

**Use a lease, not a held lock.** Claim in a short transaction that sets `poll_lease_until = now() + interval '2 minutes'` and commit *before* making the HTTP call. Holding `FOR UPDATE` across a network call pins a row lock for the duration of a third-party request.

```sql
update flights
set poll_lease_until = now() + interval '2 minutes'
where id in (
  select id from flights
  where archived_at is null
    and next_poll_at <= now()
    and (poll_lease_until is null or poll_lease_until < now())
  order by next_poll_at
  limit 25
  for update skip lock
)
returning *;
```

### 7.6 Webhook lifecycle

Subscriptions are **keyed by flight number with no date parameter**. A subscription to `KL1600` fires for every occurrence of that number, every day it operates, and **never expires** until we delete it (2026 alert API, ADR 0003). Billing is credit-based: 1 credit per flight item per delivery attempt, deducted when **sent**, not delivered. Deliveries are **not signed** by the provider; the receiver is protected by a secret URL token, and a gate change or cancellation that arrives by webhook is confirmed with one poll before it notifies anyone (§10).

This is why subscriptions open at T-24h and not at add time. Subscribing three weeks out bleeds credits daily on a flight nobody is watching.

| Phase | Action |
|---|---|
| T-24 h | `POST /subscriptions/webhook/FlightByNumber/{number}?useCredits=true` with `maxDeliveryRetries: 1` (ADR 0003). Store `alert_subscription_id`. Set `next_poll_at = NULL`. |
| Window active | Receive alerts, write to `flights`, emit `flight_events` |
| Arrival + 30 min | `DELETE /subscriptions/webhook/{id}`, archive |

Creating and deleting are free. Only alerts cost.

**The webhook endpoint must return 200 immediately.** Validate, enqueue to pg-boss, respond. Never process inline. AeroDataBox charges for send attempts including retries, so a slow or erroring endpoint costs 3× for nothing.

Alert payloads include the remaining credit balance — log it to `provider_credit_log` on every receipt. Free monitoring.

### 7.7 Credit balance and failover

**This is the most critical reliability requirement in the system.** The credit balance is shared across every subscription on the account. When it reaches zero, **all** subscriptions pause platform-wide. One exhausted balance silently stops alerts for every user.

Required behaviour:

1. An hourly scheduled job in the worker calls `GET /subscriptions/balance` (free).
2. **No automatic refill (ADR 0003).** Credits are not drawn from the plan automatically; the balance only grows through `POST /subscriptions/balance/refill` (1 credit = 1 API unit), which the owner calls by hand. Below the low-water mark (300, then 100, then 0 credits) the job alerts the owner.
3. **On zero balance, set `next_poll_at` on every flight with an active subscription and resume polling immediately.** Degraded, not broken.
4. Alert the operator: a push notification to the owner's own phone through the Expo pipeline (`OPERATOR_USER_ID`). No Sentry or email for now (ADR 0003).

Write an integration test that drains a dev balance to zero and asserts the poller takes over. Note the unit quota is per calendar month on RapidAPI; the owner is the only one who refills.

### 7.8 Budget

RapidAPI Pro plan (checked 2026-09-14): 5,000 API units/month, 2 req/s, $8/month. Tier 1 = 1 unit, Tier 2 = 2 units, Tier 3 = 6 units. Flight status is Tier 2. Credits convert 1:1 from units. The worker limits itself to 1 req/s, leaving the rest for interactive lookups.

Approximate per-flight cost: ~14 polls (28 units) plus alert credits during the 24-hour window. At beta scale this is comfortably within budget. Track actual consumption from week one — the alert volume estimate is the least certain number in this document.

---

## 8. Known failure modes

The pipeline is the engine. These are the things that will go wrong.

**1. Credit exhaustion cascades globally.** Covered in §7.7. Highest severity because it is silent and total.

**2. Duplicate notifications from a poll/webhook race.** Both paths can detect the same gate change. Guarded by the `notification_deliveries` unique constraint, and by comparing against the last known value before emitting a `flight_event`.

**3. Rate limit bursts.** Many flights becoming due simultaneously against 1 req/s. Mitigated by `limit 25`, a token bucket, and jitter on `next_poll_at`.

**4. Timezone bugs.** The single largest bug source in flight software. Store UTC. Display airport-local with a zone label. Never use the server's local time for anything. `departure_date_local` is origin-local (§6.3).

**5. Codeshare resolution after insert.** Resolving to the operating flight after a row exists can collide on the unique key. Always resolve before insert.

**6. Supabase connection pooling.** pg-boss requires a direct or session-mode connection. The transaction-mode pooler does not support the session-level features it relies on. This specific stack combination trips people up.

**7. Worker restart mid-poll.** Render restarts the worker on every deploy. The lease pattern (§7.5) means an interrupted poll's lease simply expires and the flight is reclaimed. Do not hold a transaction across the HTTP call.

**8. Stale flights that never resolve.** A flight cancelled far in advance, or one the API stops returning. Increment `poll_failure_count`, back off after 5 consecutive failures, and surface staleness in the UI rather than displaying indefinitely old data as current.

**9. Archive never triggers.** "Landed + 30 minutes" requires observing arrival. A `scheduled`-tier flight may never report it. Hard backstop: archive at `scheduled_arrival_utc + 6 hours` regardless of observed status.

**10. Expo push token rotation.** Tokens change on reinstall and some OS updates. Read delivery receipts and clear `expo_push_token` on `DeviceNotRegistered`. Otherwise you accumulate dead tokens and silently stop notifying real users.

**11. Group page N+1 queries.** Naive implementation issues one query per member. Fetch the whole group in a single join.

**12. Multi-leg flight numbers.** Some numbers operate two legs on one date. The lookup returns an array. Never take `[0]` without disambiguating (§3.1).

---

## 12. Agent working rules

These are binding on every agent and subagent.

**API usage**
1. **Maximum 20 exploratory AeroDataBox calls per agent** before implementing against an endpoint. Every call spends real quota.
2. Write every response to `docs/api-samples/<endpoint>-<case>.json`. Build against those fixtures thereafter.
3. Use the **development** RapidAPI key only. The production key never appears in a development context.

**Secrets**
4. **Never commit MCP configuration containing API keys.** RapidAPI's MCP panel pre-populates config JSON with a live key.
5. Secrets live in Render environment variables and local `.env`. The repo carries `.env.example` with empty values.
6. Add `.mcp.json`, `.env`, and `*.local.json` to `.gitignore` before the first commit.

**Data integrity**
7. **Never write to `flights` from a request handler.** Poller and webhook processor only. (Phase 1 exceptions, both documented in §6.3: `ingestFlight` on the service-role client, and the database trigger that sets `archived_at` when a flight's last segment is deleted.)
8. All timestamps stored UTC. All display airport-local with a zone label.
9. Resolve codeshares before insert, never after.
10. Never auto-merge an unclaimed traveller. Always confirm.

**Workflow**
11. Run `generate_typescript_types` after every migration and commit the result.
12. Run `get_advisors` after every migration; resolve RLS findings before merging.
13. One migration per logical change, in `supabase/migrations/`, never edited after being applied.
14. Update `docs/PROJECT_OVERVIEW.md` in the same commit as any change that contradicts it.
