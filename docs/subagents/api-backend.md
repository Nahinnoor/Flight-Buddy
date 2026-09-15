# FlightBuddy — subagent doc: api-backend

> Derived verbatim from `docs/PROJECT_OVERVIEW.md`. If this contradicts the master, the master wins — regenerate this file.

## Phase 2 task for this agent

Phase 2 (see `docs/PHASE2_PLAN.md` and ADR 0003): Wave 0 — `apps/api/src/auth.test.ts` for the real JWT verifier. Wave 3 — the webhook receiver route `POST /webhooks/aerodatabox/<WEBHOOK_TOKEN>`: constant-time token check (wrong token → 404, nothing queued, no payload logged), strict zod schema, body-size cap, per-IP rate limit, then enqueue to pg-boss and answer 200 immediately. Never write `flights` from the route (rule 7); the worker's job does the ingest.

## Phase 1 task for this agent (done)

Build the Phase 1 backend: Supabase migrations in `supabase/migrations/` (schema §6.2, one migration per logical change), RLS on every table (§10), generated types committed to `packages/shared`, and `apps/api` (Fastify) with the add-flight endpoints: lookup candidates, and confirm/ingest one candidate into flights/trips/trip_segments via the shared `ingestFlight` in `packages/flight-provider`. Auth: verify the Supabase JWT on every request.

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
