# FlightBuddy — subagent doc: mobile-client

> Derived verbatim from `docs/PROJECT_OVERVIEW.md`. If this contradicts the master, the master wins — regenerate this file.

## Phase 2 task for this agent

Phase 2 (see `docs/PHASE2_PLAN.md`): Wave 5 — foreground notification handling and deep link: tapping a push opens the dashboard on that flight; `registerPushToken` already stores the Expo token. Phase 1 follow-ups when touching these files: `getSession()` timeout fallback in `session-provider.tsx`, break the `mock/store.ts` ↔ `flights.ts` import cycle.

## Phase 1 task for this agent (done)

Build the Phase 1 mobile client in `apps/mobile` (Expo SDK 57, expo-router): Sign in with Apple + Google via Supabase Auth, an add-flight screen (flight number + date, free-text parsing, disambiguation list when the API returns multiple legs), and a personal flight card (status, gate, terminal, scheduled/estimated times in airport-local with zone label, duration, delay, countdown, 'Not live-tracked' badge, codeshare display per §7.2). Talk to the Fastify API in `apps/api` and read flight data from Supabase with the anon key under RLS.

---

> Regenerated 2026-10-25 from `docs/PROJECT_OVERVIEW.md` (verbatim, per §0). Phase 2 is done; the task blurbs above are history. The master wins on any conflict.

## 1. Product definition

FlightBuddy tracks flights for a group of people travelling to the same place, in one view.

Solo flight tracking is a commodity — Flighty, TripIt, and airline apps all do it well. The differentiator is **group coordination**: four friends converging on one destination from three cities, with one screen showing every leg, every delay, and every gate change.

### MVP scope — in

- Auth: email + password with the address confirmed before the account works, Sign in with Apple, and Google (email added 2026-09-18; PKCE links back into the app at `flightbuddy://auth/callback`)
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

  -- route facts for Profile stats; NULL for manual tier and pre-2026-09-27 rows
  distance_km              integer check (distance_km is null or distance_km between 0 and 20100),
  origin_country_code      char(2) check (origin_country_code ~ '^[A-Z]{2}$'),       -- ISO 3166-1 alpha-2
  destination_country_code char(2) check (destination_country_code ~ '^[A-Z]{2}$'),

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

-- one row per device (ADR 0006); profiles.expo_push_token is dual-written until it is dropped
create table push_tokens (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references profiles(id) on delete cascade,
  token              text not null unique,   -- shape-checked; a bearer credential (§10)
  token_sha256       text generated always as (encode(sha256(decode(token, 'escape')), 'hex')) stored,
  created_at         timestamptz not null default now(),
  last_registered_at timestamptz not null default now(),
  invalidated_at     timestamptz,            -- NULL = active
  invalidated_reason text                    -- 'device_not_registered' | NULL
);

-- why a token appeared or disappeared; never the token itself
create table push_token_events (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references profiles(id) on delete cascade,
  token_sha256 text not null,
  event        text not null,   -- registered | moved_to_other_account | signed_out | device_not_registered | retired_over_cap
  at           timestamptz not null default now()
);

-- one row per device a delivery was sent to (ADR 0006 sub-step ii); the delivery stays one per person
create table notification_device_sends (
  delivery_id        uuid not null references notification_deliveries(id) on delete cascade,
  token_sha256       text not null,          -- = push_tokens.token_sha256; never the token
  status             text not null,          -- pending | sent | delivered | failed | unconfirmed
  expo_ticket_id     text,
  error              text,                   -- short code only
  sent_at            timestamptz not null default now(),
  receipt_checked_at timestamptz,
  primary key (delivery_id, token_sha256)
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

**Implementation notes (applied 2026-09-15, migration `seed_next_poll_at`).** The worker claims only rows whose `next_poll_at` is set (§7.5), and `ingestFlight` never writes scheduling columns, so a new flight was never polled. Trigger `flights_seed_next_poll_at` sets `next_poll_at = now()` on INSERT, and on UPDATE when a row goes from archived to active (a re-add), unless the flight is `manual`-tier or already holds a webhook subscription. The worker's first poll then places it on the §7.4 ladder. It writes no other column. On `insert … on conflict do update` the BEFORE INSERT trigger only modifies the proposed row; the conflict path applies the SET list, which never includes `next_poll_at`, so an existing row's schedule is untouched. "Due immediately" is deliberately unjittered, a bounded exception to §7.4's jitter rule: the claim batch (`limit 25`) and the 1 req/s token bucket already bound the burst, and the first poll's ladder step is jittered. The one-time backfill skips a non-`manual` row with no departure or arrival time at all; the archive backstop retires such a row 30 days after `created_at`.

**Implementation notes (applied 2026-09-27, migration `push_token_single_owner`).** `profiles.expo_push_token` carries a partial unique index (`profiles(expo_push_token) where expo_push_token is not null`), so a device's token belongs to at most one profile; the migration's one-time cleanup nulled every value already held by more than one profile before building it (each device re-registers on its next launch). The app writes this column only through two functions. `public.register_push_token(p_token)` is `security definer` with `search_path = ''`, EXECUTE revoked from `public`/`anon` and granted to `authenticated`: it rejects a missing `auth.uid()`, validates the token shape, takes a per-token advisory lock, nulls the token on every other profile, then sets it on the caller's own. It only ever writes NULL to other rows and returns nothing, so it can neither plant a token on someone else nor reveal one. `public.unregister_push_token(p_token)` is `security invoker` and nulls the caller's own token only while it still equals `p_token`; the app calls it on sign-out, and it exists so the token travels in a POST body rather than a PostgREST URL filter that request logs record. A direct `update profiles set expo_push_token = …` (the pre-wave-5 write path) still succeeds for a token no one else holds, and now fails with a unique violation instead of silently creating a second holder. The worker's dead-token clears write only NULL, so the index cannot affect them. Amended 2026-10-24 by `push_tokens_per_device` (note below): both functions now also maintain `push_tokens`, and `unregister_push_token` is `security definer`.

**Implementation notes (applied 2026-09-27, migration `flights_distance_and_countries`).** Three nullable columns on `flights` for the Profile screen's lifetime distance and countries visited: `distance_km` (great-circle, whole km, 0–20100 — half the Earth's circumference is ~20,038 km) and `origin_country_code` / `destination_country_code` (ISO 3166-1 alpha-2, uppercase; the provider sends lowercase and the mapper uppercases). They come from the provider on every lookup and delivery (`greatCircleDistance`, lowercase keys on the lookup and PascalCase on a webhook, and each airport's `countryCode`) and reach the domain as `FlightCandidate.distanceKm` / `originCountryCode` / `destinationCountryCode`; the mapper turns an invalid value into NULL rather than failing the leg. Nullable because `manual`-tier flights have no provider data and older rows have none. Writers never erase them: the worker's upsert sets each as `coalesce(excluded.col, flights.col)`, and the API's supabase-js writer omits a NULL one from the payload so PostgREST leaves it alone, so a delivery without a distance keeps the one a lookup stored while a non-NULL value still replaces it. No backfill: `raw_payload` holds our own candidate snapshot, not the provider body, so there is nothing to derive them from; existing rows fill in on their next poll or delivery. No grant or RLS change (`flightbuddy_worker` has table-level grants on `flights`).

**Implementation notes (applied 2026-10-24, migration `push_tokens_per_device`, ADR 0006).** Push tokens are now one row per device in `push_tokens` (active = `invalidated_at is null`), so a second device no longer replaces the first and signing out on one device no longer clears the others. This is sub-step (i) of three: the worker (ii) still reads `profiles.expo_push_token`, which the functions **dual-write** to the most recently registered active token, so until (ii) ships alerts still reach one device per account. `register_push_token` keeps its security model (definer, `search_path = ''`, `auth.uid()` required, shape check `22023`, per-token advisory lock, returns nothing); it creates, moves (from another account) or re-activates this device's row, retires the least recently registered device beyond **10 active per user**, then nulls the token on every other profile and sets it on the caller's own, as before — except that an account which just lost the token now falls back to its own newest remaining device rather than NULL. `unregister_push_token` is now `security definer` (it must delete from a table no client role can touch); it deletes only the caller's own row for that token, never raises on an unknown token, and recomputes the caller's column from their remaining active devices, or NULL. `push_token_events` traces every gain and loss (`registered` on a new, moved or re-activated row — a plain relaunch only bumps `last_registered_at` — `moved_to_other_account`, `signed_out`, `device_not_registered`, `retired_over_cap`) with only the token's SHA-256. Both tables: RLS on, no policies, and all privileges revoked from `anon`, `authenticated` and `service_role`. `token_sha256` is generated with `decode(token, 'escape')`, the immutable equivalent of the worker's `convert_to(token, 'UTF8')` for the ASCII-only token shape. Interim bridge: an `after update` trigger on `profiles` mirrors the live worker's `DeviceNotRegistered` clear (only when running as `flightbuddy_worker`) into `push_tokens` and the trace, without changing the worker's write, so a dead device is never recomputed back into the column. The worker role now also holds `select` and `update (invalidated_at, invalidated_reason)` on `push_tokens` and `insert` on `push_token_events` for sub-step (ii); still no DELETE. Backfill: the one well-formed token on dev became one row. Invalidated rows and trace events are not purged yet (Phase 4 retention). **Hardened the same day (migration `push_tokens_hardening`):** each user's trace is capped at their newest 200 rows; the bridge trigger now re-points the column to the user's newest remaining active device after the worker clears a dead one (in a subtransaction, so the worker's clear cannot fail); both functions lock every profile row they write in `id` order right after the token's advisory lock, so cross-moves cannot deadlock (ADR 0006); and `service_role` has no EXECUTE on either function. The profile-row lock is `for no key update` (migration `push_tokens_lock_strength`), the same lock the worker's update takes, so it does not block foreign-key checks. The worker side (sub-step ii) is the next note.

**Implementation notes (applied 2026-10-24, migration `notification_device_sends`, ADR 0006 sub-step ii).** The worker now sends each alert to **every active device** of the recipient (`push_tokens`, newest first, at most 10) and no longer reads or writes `profiles.expo_push_token`, which is legacy: the app's functions still dual-write it until a later sub-step drops the dual-write, the interim trigger and the column. `notification_deliveries` is unchanged and still one row per (event, person), so §9's guard holds; each device's outcome is a `notification_device_sends` row (primary key `(delivery_id, token_sha256)`, so a retry can never add a second; checks: status vocabulary, `sent`/`delivered` need a ticket, `pending` has none, hex-only hash, error ≤ 64 chars; partial index on `sent_at where status = 'sent'` for receipts). A device with a row other than `pending` is never sent that delivery again, which is how a re-claimed delivery (crash, lease overrun, a retry of another device) skips devices that already hold a ticket; each Expo request's rows (≤ 100 messages) are written as soon as it answers. **Parent status is derived from its device rows** in the statement that writes it: `pending` while a device's send failed retryably and attempts remain; else the best device outcome, `delivered` > `sent` > `unconfirmed` > `failed` (so `sent` = at least one device got a ticket); `skipped` / `NoPushToken` only when the person has no active device. The parent keeps one representative ticket and hash, so its existing ticket check is unchanged. `DeviceNotRegistered` invalidates only that device (`update push_tokens set invalidated_at, invalidated_reason = 'device_not_registered' where user_id = $1 and token_sha256 = $2 and invalidated_at is null and last_registered_at <= sent_at`) and logs a `device_not_registered` trace event, so a device that registered again after the send, or any other device, stays active. Deliveries the previous single-device build sent (ticket on the parent, no device row) are adopted by the receipt job on its first runs. A device row waiting for a re-send (`pending`, after `MessageRateExceeded`) whose device is no longer active, or whose delivery is closing unsent (expired), is closed `failed` with the code it was waiting on, so it can never hold its delivery `pending`. Device rows carry `sent_at` = when the devices were read, before the request; the lease is renewed before each further Expo request; receipt results and the re-derived deliveries are written in one transaction. Operator alerts go to every active device of `OPERATOR_USER_ID`. RLS on with no policies and no privileges for `anon`/`authenticated`/`service_role`; the worker holds `select, insert` and `update (status, expo_ticket_id, error, sent_at, receipt_checked_at)`, never the key, no DELETE (rows go with their delivery by cascade). Additive: the previous worker build ignores the table, so the migration was applied before the code deploys.

**Forward compatibility.** `groups.destination_iata`, `start_date`, and `end_date` are unused in MVP. They exist because expense splitting and itineraries need a bounded trip, and adding them later is a migration on a live table.

## 9. Notifications

**Own flight:** always notified, no exceptions, no quiet hours. The user may need to act.

**Other members' flights:** notified unless muted by the user or by the group owner. Unclaimed travellers' flights notify **only** the owner.

**Events that notify:** cancellation, delay over 30 minutes, gate change, departed, landed, diverted.

**Quiet hours:** suppressed until the 24–48 hour window before the relevant flight. Inside that window, group notifications flow normally subject to mutes. Cancellations always break through.

Every send writes a `notification_deliveries` row. The unique constraint on `(flight_event_id, user_id)` makes a second, independent delivery of one event to one person structurally impossible. That one delivery goes to **each of the person's active devices** (ADR 0006), one message per device, all with the same `collapseId`, and each device's outcome is its own `notification_device_sends` row; while any device's send failed retryably and attempts remain, the delivery stays `pending` — even if another device already has a ticket — and only that device is re-sent; otherwise it is `sent` once any device has a ticket, and `skipped` / `NoPushToken` only when the person has no active device and no device ever got the message. The one remaining duplicate is deliberate: sending is at-least-once, so a crash after Expo accepts a request but before its device rows are recorded re-sends to those devices once — and because every push carries `collapseId` = the event id, iOS replaces the first notification instead of showing two. A device whose outcome is recorded is never sent the same delivery again. A dropped cancellation is worse than a duplicate buzz.

Cancellations and diversions always notify, even a second time for the same flight (cancelled, reinstated, cancelled again), and are still sent up to two days late after an outage; `departed` and `landed` notify once per flight, and other news expires after three hours rather than arriving stale.

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
7. **Never write to `flights` from a request handler.** Poller and webhook processor only. (Documented exceptions, all in §6.3: `ingestFlight` — service-role client in the API, the `flightbuddy_worker` role in the worker; the database trigger that sets `archived_at` when a flight's last segment is deleted; and the trigger that sets `next_poll_at` when a flight is created or re-added.)
8. All timestamps stored UTC. All display airport-local with a zone label.
9. Resolve codeshares before insert, never after.
10. Never auto-merge an unclaimed traveller. Always confirm.

**Workflow**
11. Run `generate_typescript_types` after every migration and commit the result.
12. Run `get_advisors` after every migration; resolve RLS findings before merging.
13. One migration per logical change, in `supabase/migrations/`, never edited after being applied.
14. Update `docs/PROJECT_OVERVIEW.md` in the same commit as any change that contradicts it.
