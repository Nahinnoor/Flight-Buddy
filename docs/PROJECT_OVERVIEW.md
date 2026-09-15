# FlightBuddy — Master Project Overview

**Status:** Phase 1 complete — verified end to end 2026-09-13 (sign-in, add-flight, card matches the provider). Phase 2 next.
**Owner:** Solo developer.
**Target:** iOS private beta (~10 testers) via TestFlight, then public launch.
**Last updated:** 2026-09-05

---

## 0. How to use this document

This is the single source of truth for FlightBuddy. The primary agent reads this file in full before any work.

**Deriving subagent documents.** When delegating, copy only the sections a subagent needs into `docs/subagents/<name>.md`. Do not paraphrase — copy verbatim, so there is one wording of every rule. Every subagent document must include §1 (Product Definition), §12 (Agent Working Rules), and whichever technical sections apply.

Recommended subagent documents:

| File | Sections to include |
|---|---|
| `docs/subagents/data-pipeline.md` | §1, §6, §7, §8, §12 |
| `docs/subagents/mobile-client.md` | §1, §3, §5, §6, §9, §12 |
| `docs/subagents/api-backend.md` | §1, §5, §6, §10, §12 |
| `docs/subagents/infra.md` | §4, §5, §11, §12 |

**Maintaining this file.** When a decision changes, edit this document in the same commit as the code change. A subagent doc that contradicts the master is a bug — regenerate it.

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

## 2. Confirmed decisions

Every item below is settled. Do not relitigate without raising it explicitly.

| Area | Decision |
|---|---|
| Platform | iOS only for MVP, React Native + Expo |
| Flight data | AeroDataBox via RapidAPI, PRO plan, behind a swappable `FlightDataProvider` interface |
| Ingestion | Manual entry (flight number + date), enriched by API. No email OAuth. |
| Database + Auth | Supabase (Postgres + Auth), US region |
| Backend | TypeScript + Fastify |
| Hosting | Render — web service and background worker (scheduled jobs run inside the worker, ADR 0003) |
| Scheduling | `flights.next_poll_at` column, drained by a background worker loop |
| Job queue | pg-boss, for notification delivery and webhook processing only |
| Push | Expo Push Notifications |
| Repo | Monorepo |
| Group scope | One group = one trip |
| Times | Stored UTC, displayed in airport-local with zone label |
| Join | 6-character alphanumeric code + owner approval |
| Retention | 90 days after trip completion |
| Ownership transfer | If owner deletes account mid-trip, ownership passes to earliest-joined member |

### Rejected, with reasons

**Render Workflows** — evaluated and rejected for polling. Three blockers: it has no native scheduling (their docs direct you to a cron job, which means building the scheduler anyway); Blueprints cannot create or manage workflows, so you lose infrastructure-as-code; and it bills per task-run instance, which is the wrong shape for a 200ms HTTP call.

**Cron job per polling tier** — rejected. Flights move between tiers continuously, so each cron would have to compute time-to-departure per flight anyway. Bucket boundaries leak. Cron fires on wall-clock time, but a flight departing at 14:07 needs polls relative to 14:07. Cold starts dominate at a 5-minute cadence. No concurrency control.

**Web scraping airline sites** — rejected. Bot detection, ToS violation, no SLA, silent breakage.

**Email as a live-status source** — rejected. Airlines notify inconsistently and late. Fine for discovery, useless for status.

---

## 3. Core user flows

### 3.1 Add a flight

1. User enters flight number and departure date. Free-text parsing accepted (`DL1234 Mar 12`, `DL1234 tomorrow`).
2. `GET /flights/number/{number}/{dateLocal}` — **returns an array**. A flight number can operate multiple legs on one date.
3. If more than one result, present a disambiguation list: `DL 1234 · Mar 12 · JFK → LAX · 3:45 PM EDT`.
4. Resolve codeshare to the operating flight (§7.2).
5. Check airport feed coverage, assign `tracking_tier` (§7.3).
6. Upsert into `flights` on the canonical key; create `trips` and `trip_segments`.

### 3.2 Create a group

Owner names the group, gets a 6-character code. Share via native share sheet.

### 3.3 Join a group

1. Joiner enters the code. Membership row created with `status = 'pending'`.
2. Owner receives a push and approves or denies.
3. On approval, the joiner is asked: *"Marcus added a flight for someone named Sarah. Is this you?"* — the manual claim path (§3.4).
4. Joiner attaches their trip to the membership.

### 3.4 Unclaimed travellers

The owner can add a friend's flight without that friend having an account. That creates a `travelers` row with `user_id = NULL`.

**Rules:**
- Only the owner receives notifications for an unclaimed traveller's flight. Other members do not.
- Only the owner (and the creator, if different) may edit an unclaimed traveller's flight.
- The owner may optionally supply an email or phone. If a joining user's contact matches, offer the merge.
- **Never auto-merge.** Always confirm. Two strangers on the same flight must not have itineraries crossed.
- On claim: the traveller gains edit rights and notifications; the owner loses edit but keeps removal rights.

### 3.5 Dashboard

Countdown to the user's own next flight. If a user belongs to multiple groups, **the soonest departure takes priority**; other groups are reachable from a list.

### 3.6 Group page

Own flight pinned to the top. Other members as collapsible rows showing name, route, status, and a per-flight badge. Expanding shows gate, terminal, times, and layovers.

### 3.7 Leaving, deleting and what survives

Decided 2026-09-13. A `flights` row is a shared fact about one aircraft movement; a person is *subscribed* to it through a `trip_segments` row on their own trip, and is *in a group* through a `group_members` row.

- **Leaving a group** flips the membership to `removed`. The person's traveller, trips and segments are untouched — they still see their own flights on their own dashboard. The group stops showing them.
- **Deleting an account** deletes the person: their self-traveller and, by cascade, their trips, segments and memberships. Travellers they added for other people survive with `created_by = NULL`. Nothing with their name on it remains.
- **A flight nobody references any more is archived** (`archived_at`), not deleted — the row still carries the provider alert subscription the poller must cancel, and the 90-day purge removes it afterwards. Adding it again (`ingestFlight`) un-archives it.
- **Owner leaving or deleting:** ownership goes to a member the owner chose (an explicit transfer action, Phase 3), otherwise to the earliest-joined active member; with nobody left, the group is deleted.

**The manual path is primary, not a fallback.** Apple's Hide My Email issues relay addresses like `x7k2@privaterelay.appleid.com`, so contact matching will fail for a meaningful share of iOS users. Build the "is this you?" prompt as the main flow and treat contact matching as an accelerator.

---

## 4. Tech stack

| Layer | Choice | Rationale |
|---|---|---|
| Client | React Native + Expo, iOS first | Push notifications are the product; iOS web push is unreliable. Expo wraps APNs and gives OTA updates for hotfixing mid-trip. |
| Language | TypeScript end to end | Shared types across client, API, and worker remove a whole class of boundary bug. |
| API | Fastify | Fast, small. NestJS ceremony isn't earning its keep at this size. |
| DB + Auth | Supabase | Genuinely relational data. RLS and Realtime included. One vendor for auth and data. |
| Scheduler | Render Background Worker | Long-running process, no HTTP port, doesn't spin down. |
| Queue | pg-boss | Runs on the Postgres you already have. Retries and dead-lettering for notification sends. |
| Housekeeping | pg-boss scheduled jobs inside the worker | Wall-clock scheduled, idempotent work, without duplicating secrets into extra Render services (ADR 0003). |
| Push | Expo Push | One API over APNs. |
| Errors | Sentry | You will have provider outages and parsing failures. |

### Service types, in plain terms

A **background worker** is a Render service that runs continuously with no inbound port. Render starts `node dist/poller.js` and restarts it if it crashes. It is not an AI agent — no AI runs in production. Agents write the code; the worker executes it forever afterwards.

A **scheduled job** wakes on a schedule inside the worker process (pg-boss's scheduler), runs once, and is retried by the queue if it fails. Render cron services are not used (ADR 0003).

| Job | Service type | Schedule |
|---|---|---|
| Flight poller | Background worker | Continuous loop |
| Notification sends | pg-boss queue | On demand, with retries |
| Webhook payload processing | pg-boss queue | On demand |
| Archive backstop (completed trips) | pg-boss scheduled job in the worker | Daily |
| Purge past 90-day retention | pg-boss scheduled job in the worker (Phase 4) | Daily |
| Reconcile orphaned subscriptions | pg-boss scheduled job in the worker | Hourly |
| Credit balance check + low-credit alert | pg-boss scheduled job in the worker | Hourly |

---

## 5. Repository structure

```
flightbuddy/
├── CLAUDE.md                      # points at docs/PROJECT_OVERVIEW.md
├── docs/
│   ├── PROJECT_OVERVIEW.md        # this file
│   ├── api-samples/               # captured real API responses (fixtures)
│   ├── adr/                       # architecture decision records
│   └── subagents/                 # derived, task-scoped docs
├── apps/
│   ├── mobile/                    # Expo / React Native
│   └── api/                       # Fastify
├── services/
│   └── poller/                    # background worker
├── packages/
│   ├── shared/                    # types, zod schemas, time helpers
│   └── flight-provider/           # FlightDataProvider interface + AeroDataBox impl
├── supabase/
│   └── migrations/
├── render.yaml                    # Blueprint — web service and worker live here
└── package.json                   # workspaces
```

`render.yaml` is hand-authored. The Render MCP cannot create background workers — it only creates web services, static sites, cron jobs, Postgres, and Key Value. Agents can write the YAML; they cannot call a tool for it.

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

## 9. Notifications

**Own flight:** always notified, no exceptions, no quiet hours. The user may need to act.

**Other members' flights:** notified unless muted by the user or by the group owner. Unclaimed travellers' flights notify **only** the owner.

**Events that notify:** cancellation, delay over 30 minutes, gate change, departed, landed, diverted.

**Quiet hours:** suppressed until the 24–48 hour window before the relevant flight. Inside that window, group notifications flow normally subject to mutes. Cancellations always break through.

Every send writes a `notification_deliveries` row. The unique constraint on `(flight_event_id, user_id)` makes double-sending structurally impossible.

---

## 10. Security

**RLS is mandatory on every table.** Run `get_advisors` via the Supabase MCP after each migration; it flags missing policies. The data is people's itineraries — where they are and when their home is empty.

Policy shape:
- `profiles`: self only.
- `travelers`: readable if you share an active group; writable by `created_by` while unclaimed, by `user_id` once claimed.
- `flights`: readable if you subscribe via a `trip_segment` in a group you belong to. **No user-facing write policy at all** — service role only.
- `groups` / `group_members`: readable by active members. Owner-only for settings.
- `trips` / `trip_segments`: own, plus read access for active co-members.

**Join codes.** 6 characters from Crockford base32 (no I, O, 0, 1 — people read these aloud). Rate-limit join attempts per IP and per account. Expire after the trip. Owner approval is required in all cases.

**Webhook receiver (Phase 2, ADR 0003).** AeroDataBox does not sign deliveries. The receiver lives at a path containing a 32+ byte random token known only to Render env, compared in constant time; a wrong token is a 404 that queues nothing and logs no payload. Bodies are schema-validated, size-capped and rate-limited, and are data only — never interpolated into SQL, shell or a prompt. A gate change or cancellation arriving by webhook is confirmed with one provider poll before it notifies anyone. The worker connects to Postgres as `flightbuddy_worker`, a role with table- and column-level grants only (no names, emails or contacts, no DELETE), never with the service-role key.

**Prompt injection.** The database will contain user-supplied strings — traveller display names and group names typed by one person about another. Supabase's own documentation describes this attack directly. Agents get `read_only=true` and `project_ref` scoping against production. Write access only against a dev project or branch.

---

## 11. External services

| Service | Plan | Notes |
|---|---|---|
| AeroDataBox | Pro, $8/mo via RapidAPI | 5,000 units, 2 req/s (ADR 0003). Separate dev and prod apps/keys. |
| Supabase | US region | Region fixed at creation. |
| Render | Web service + background worker | Worker is paid-only; scheduled jobs run inside it (ADR 0003). `render.yaml` Blueprint. |
| Expo / EAS | — | Push + TestFlight builds |
| Apple Developer | $99/yr | Already held |
| Sentry | Deferred | Not used in Phase 2 (ADR 0003); Render logs and failure emails instead. |

**First smoke test:** call `GET /subscriptions/balance`. If it errors, the RapidAPI plan version is too old and needs re-subscribing.

### MCP and plugins

```sh
claude plugin install expo@claude-plugins-official   # + npx expo install expo-mcp --dev
/plugin install render@claude-plugins-official
# Supabase Plugin for AI Coding Agents
# Context7 for version-specific library docs
```

Supabase MCP, two entries:
- dev: read-write, scoped to the dev project
- prod: `?project_ref=<prod>&read_only=true`

**The Supabase MCP cannot configure auth providers.** Sign in with Apple and Google are dashboard tasks: Services ID, signing key, redirect URLs. Manual, once, by the owner.

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

---

## 13. Build phases

**Phase 1 — Foundation.** Monorepo, Supabase project, schema and migrations, RLS, auth with Apple + Google, `FlightDataProvider` interface with the AeroDataBox implementation, add-flight flow with disambiguation and codeshare resolution, personal flight card.
*Done when:* one person can add a flight and see accurate live status.

**Phase 2 — The engine.** Render Blueprint, background worker, `next_poll_at` scheduler with leasing, polling ladder, webhook receiver, subscription lifecycle, credit monitoring and failover, change detection, pg-boss, Expo Push.
*Done when:* the app wakes you when your gate changes, and a drained credit balance falls back to polling without losing an alert.

This is the hardest phase and must be correct before Phase 3. Group tracking on an unreliable engine is worse than solo tracking on a reliable one.

**Phase 3 — The differentiator.** Groups, join codes, owner approval, unclaimed travellers with the manual claim path, group page, per-member mutes, multi-group priority.

**Phase 4 — Polish.** Multi-segment UI, tracking-tier badges, empty states, countdown, cache clearing, archiving, retention purge, quiet hours.

**Phase 5 — Beta.** TestFlight, 10 testers, instrumentation of real API consumption, error triage.

---

## 14. Deferred, not abandoned

| Item | Trigger to revisit |
|---|---|
| Gmail/Outlook OAuth | After beta validates the group flow. Start Google verification paperwork in parallel — it's a waiting game. |
| Email forwarding ingestion | Cheap alternative to OAuth. Inbound webhook via Postmark. No verification needed. |
| Android | After iOS launch |
| Expense splitting | Post-MVP. `groups` already carries trip bounds. |
| Itinerary management | Post-MVP |
| Provider migration to FlightAware | If AeroDataBox gate coverage proves insufficient. The interface makes this an afternoon. |
| Naming | "FlightBuddy" is a working name. Check App Store and trademark availability before public launch. |