# `@flightbuddy/poller`

The Render **background worker** from PROJECT_OVERVIEW §4 and §7.5. It runs forever with no inbound
port: it claims due flights by lease, polls AeroDataBox, writes `flights` and `flight_events`, and
hosts the queue consumers and the scheduled jobs.

**Wave 1** was the boot skeleton: start, connect, bring the queue up, tick, shut down cleanly.

**Wave 2 (this) is the polling engine**, in [`src/engine/`](src/engine). `tick()` now claims a batch
by lease and polls it: ladder → lease → token bucket → lookup → `ingestFlight` → change detection →
`flight_events` → `next_poll_at`. `archive-backstop` has a real body. `credit-check` (wave 4) and
`reconcile-subscriptions` (wave 3) are still no-ops.

Two seams wave 3 will use, both already named:

- **`webhooksEnabled`** in [`src/engine/ladder.ts`](src/engine/ladder.ts), default `false`. Until
  subscriptions exist, a `live`-tier flight inside T-24 h **keeps polling** on the failover ladder
  rather than falling into a 24-hour blind spot. With the flag on, a flight holding an
  `alert_subscription_id` returns `null` — the "set `next_poll_at = NULL`" of §7.6.
- **`startQueue({ handlers })`**, which replaces a scheduled job's no-op with a real body without
  `queue.ts` needing to know about pools or providers.

## Run

```sh
npm install                        # from the repo root, once
npm start -w @flightbuddy/poller   # tsx src/main.ts
npm run dev -w @flightbuddy/poller # tsx watch
```

Expect roughly this, then a heartbeat every `POLL_INTERVAL_MS`, then a clean exit on Ctrl-C:

```json
{"level":"info","time":"…","service":"poller","msg":"database reachable"}
{"level":"info","time":"…","service":"poller","queues":["webhook-ingest","push-send","push-receipts"],"schema":"pgboss","msg":"queues declared"}
{"level":"info","time":"…","service":"poller","msg":"scheduled jobs registered"}
{"level":"info","time":"…","service":"poller","intervalMs":30000,"batchSize":25,"msg":"poller started"}
```

```sh
npm run typecheck -w @flightbuddy/poller
npm test -w @flightbuddy/poller                  # offline: config parsing and log redaction
INTEGRATION=1 npm test -w @flightbuddy/poller    # + one real connection (see Tests)
```

## Environment

Read from the repo-root `.env` via dotenv, validated once at boot in
[`src/config.ts`](src/config.ts) — the same convention as `apps/api`. A bad environment kills the
process before it connects and reports variable **names** and zod's issue code, never a value.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | **yes** | — | **Session pooler** string for the `flightbuddy_worker` role. Must be a `postgres://` / `postgresql://` URL. |
| `RAPIDAPI_KEY` | **yes** | — | Development key only in a development context (§12.3). |
| `AERODATABOX_HOST` | no | `aerodatabox.p.rapidapi.com` | |
| `WEBHOOK_URL` | no | — | Wave 3. Full public receiver URL including its secret path segment; the worker registers it with AeroDataBox. |
| `OPERATOR_USER_ID` | no | — | Wave 4. The owner's profile id, so low-credit and failover alerts reach a phone. A uuid. |
| `LOG_LEVEL` | no | `info` | A pino level. |
| `POLL_INTERVAL_MS` | no | `30000` | Sleep between passes (§7.5). 1 000–600 000. |
| `POLL_BATCH_SIZE` | no | `25` | Flights claimed per pass (§7.5). 1–100. |
| `PROVIDER_RPS` | no | `1` | Token-bucket rate for provider calls (§7.8). Capped at 2, the whole plan limit; the worker takes 1 and leaves the other for the API's interactive lookups. |

A variable set to the empty string counts as unset, so a blank line in `.env` does not turn into an
"invalid URL" at boot.

### Which connection string

Three exist and only one works:

- **Session pooler** (`aws-0-<region>.pooler.supabase.com:5432`) — **use this.** Reachable over
  IPv4, which is all Render has, and it keeps the session-level features pg-boss relies on.
- **Direct** (`db.<ref>.supabase.co:5432`) — IPv6-only. Fine locally, unreachable from Render.
- **Transaction pooler** (port `6543`) — pg-boss does not work on it (§8.6).

Keep `?sslmode=require` on the string.

### TLS: the CA is pinned, not skipped

Supabase's pooler presents a chain rooted at **Supabase's own CA**, which is in no public trust
store, and `pg` 8.23 treats `sslmode=require` as `verify-full`. A plain connection string therefore
fails the handshake with `self-signed certificate in certificate chain`, and both of the usual
answers to that — `rejectUnauthorized: false`, or `uselibpqcompat=true&sslmode=require` — mean
encrypted but *unauthenticated*: whatever answers for the pooler's address gets the worker's
password.

So [`certs/supabase-prod-ca-2021.crt`](certs/supabase-prod-ca-2021.crt) is bundled and used as the
only trust anchor. That is full verification against a pinned root: the certificate must chain to
Supabase's CA **and** match the hostname. The file is a public certificate published by Supabase,
not a secret; it was checked against the certificate the pooler actually presents
(SHA-256 `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`)
and expires **26 April 2031**.

Consequences worth knowing:

- `src/db.ts` splits `DATABASE_URL` into fields and never passes a `connectionString`, because `pg`
  lets a connection string overwrite an explicit `ssl` option — the one arrangement in which the
  pinned CA would silently do nothing.
- Pointing `DATABASE_URL` at a non-Supabase Postgres needs `?sslmode=disable` (honoured, for a local
  server with no TLS) or a second trust anchor. Nothing in the code disables verification.

### What the worker deliberately does *not* have

No `SUPABASE_SERVICE_ROLE_KEY`, no anon key, no Google client ids, and not the owner's `postgres`
password. It talks to Postgres directly as a restricted role with table- and column-level grants,
no `DELETE`, and ownership of the `pgboss` schema (migration `20260915021807_worker_role`,
PHASE2_PLAN §8.7). Its statement timeout comes from the role, not from this code.

## What Render needs

[`render.yaml`](../../render.yaml) at the repo root declares both services. Everything secret is a
key with `sync: false` — Render prompts once, in its own UI, and no value is ever in this repo.

| | |
|---|---|
| Service type | Background worker (paid only) |
| Region | `oregon` |
| Plan | `starter` |
| Build | `npm ci` |
| Start | `npm start -w @flightbuddy/poller` |
| Node | `22`, from the root `.node-version` and `NODE_VERSION` |
| Env vars | `DATABASE_URL`, `RAPIDAPI_KEY`, `WEBHOOK_URL` (wave 3), `OPERATOR_USER_ID` (wave 4), `LOG_LEVEL` |

**No cron services.** The hourly credit check, hourly subscription reconcile and daily archive
backstop run as pg-boss schedules inside this process (owner decision, PHASE2_PLAN §8.8).

Render sends `SIGTERM` on every deploy. The worker stops the queue, drains the pool and exits 0; an
interrupted poll costs nothing, because the lease expires and the flight is re-claimed (§8.7). Any
unhandled error exits 1 so Render restarts the process.

## Queue

pg-boss, in schema **`pgboss`** — owned by the worker role and not exposed through Supabase's REST
API, so job payloads are not reachable from a browser. `createSchema` is off: the schema comes from
a migration, so the process never needs `CREATE` on the database, and a missing schema fails loudly
instead of being silently repaired at runtime.

| Queue | Wave | |
|---|---|---|
| `webhook-ingest` | 3 | An accepted AeroDataBox alert body, ingested off the request path (§7.6). |
| `push-send` | 5 | Expo push sends, batched. |
| `push-receipts` | 5 | Expo receipt reads, which clear dead tokens (§8.10). |

| Scheduled job | Cron (UTC) | Wave | |
|---|---|---|---|
| `credit-check` | `0 * * * *` | 4 | Balance → `provider_credit_log`; alert and fail over to polling at zero (§7.7). |
| `reconcile-subscriptions` | `20 * * * *` | 3 | Delete provider subscriptions that map to no active flight. |
| `archive-backstop` | `40 3 * * *` | **2, done** | Archive flights past their latest known arrival + 6 h that never reported landing (§8.9). |

The plan fixes the cadence and leaves the minute to us; they are spread across the hour so two jobs
that both call RapidAPI do not land on the same minute as each other or as a poll pass.

## Layout

| File | |
|---|---|
| `src/main.ts` | Process entry point: config → `ping` → queue → loop → graceful shutdown. Holds `tick()`. |
| `src/config.ts` | Env schema, and the failure report that names variables and never values. |
| `src/db.ts` | The `pg` pool, `withClient`, `ping`. |
| `src/queue.ts` | pg-boss, the declared queues and the three schedules. |
| `src/logger.ts` | pino, JSON, with the redaction list. |
| `src/index.ts` | The workspace's importable surface — importing it does not start a worker. |
| `certs/` | Supabase's public root CA, the only TLS trust anchor. |

### `src/engine/` — the polling engine (wave 2)

| File | |
|---|---|
| `ladder.ts` | Pure `nextPollAt(flight, now, rng)` for §7.4, ±10 % jitter, and the `webhooksEnabled` seam. UTC arithmetic only — no zone, no local clock. |
| `lease.ts` | `claimDueFlights` (§7.5's `for update skip locked`, committed before any HTTP call) and `releaseLease`. |
| `rateLimiter.ts` | 1 req/s token bucket with an injectable clock. Reserves its slot synchronously, so a crowd of concurrent callers cannot share a second. |
| `changeDetector.ts` | Pure `detectChanges(previousRow, freshCandidate)` → typed events (§9), compared against the **last known value** so an unchanged flight yields nothing (§8.2). |
| `poll.ts` | `pollAndUpdate`: one flight, end to end, plus the failure back-off (§8.8). |
| `repository.ts` | The scheduling and `flight_events` statements. No provider data passes through it — that is `ingestFlight`'s job (rule 7). |
| `archiveBackstop.ts` | The `archive-backstop` body: archive anything past its latest known arrival + 6 h (§8.9). |
| `tick.ts` | One pass: claim → poll each, sequentially, the limiter pacing it. |
| `types.ts` | `FlightRow`, and the per-query `pg` type parsers that keep a `date` a date and a `timestamptz` a UTC ISO string. |

**Why `ingestFlight` grew a `FlightsWriter`.** The worker has a `pg` pool and, by design, no Supabase
key at all. Rule 7 still says `ingestFlight` is the only writer of `flights`, so the *transport* moved
behind a one-method interface in `@flightbuddy/flight-provider`: `createSupabaseFlightsWriter` for the
API, `createPgFlightsWriter` for the worker. The row — which columns are written, which are left for
the poller — is decided in one place and shared by both.

## Logging

JSON on stdout, which is what Render collects. `src/logger.ts` redacts anything that could carry a
secret or personal data — `authorization`, `password`, `connectionString`, `expo_push_token`,
`email`, `display_name`, the env var names — at the top level and two levels deep, which covers
`{ headers }`, `{ profile }` and `{ job: { data } }`.

Two limits worth knowing, both covered by a test:

1. Redaction matches **object keys, not text**. `logger.info(\`token=${t}\`)` prints verbatim. Log
   fields (`logger.info({ flightId }, 'polled')`), never interpolate.
2. It is a backstop, not the rule. The rule is §5 of the plan: logs carry ids only.

## Tests

`npm test` is offline and deterministic. Config parsing (defaults, coercion, blank-as-unset, every
rejection, and that no value reaches the error message), connection-string splitting and the TLS
settings, log redaction — and the whole engine: every ladder boundary including a DST transition in
the origin zone and a date-line crossing, the jitter bounds, 200 simultaneously due flights against a
fake clock, every change-detector event and its no-op, the poll paths and the back-off, and the shape
of every statement. Provider responses come from `docs/api-samples/` through a real provider instance
with an injected `fetch`; **nothing in this workspace calls AeroDataBox** (§12.2).

Two files skip unless **both** `INTEGRATION=1` and a `DATABASE_URL` are set:

- `src/engine/lease.integration.test.ts` inserts synthetic `ZZ`-carrier flights due in the past, then
  claims from **two pools at once** and asserts each row went to exactly one claimer — which is the
  only way to test `for update skip locked` at all. It also asserts the type parsers against real
  wire values, and that archived and `next_poll_at is null` rows are never claimed. Cleanup
  **archives** the synthetic rows rather than deleting them, because the role has no DELETE grant;
  they stay in the table, invisible to every later claim.
- `src/queue.integration.test.ts` skips unless **both** `INTEGRATION=1` and a `DATABASE_URL` are set.
It opens a real pool and starts pg-boss, then asserts the connection is the `flightbuddy_worker`
role, that pg-boss's tables are in `pgboss` and not `public`, and that the three schedules and three
queues are registered. Its side effects are intended and idempotent — pg-boss creates its own tables
inside its own schema, and `createQueue`/`schedule` upsert. It writes to no application table and
makes no provider call.

## Notes for maintainers

- **TLS depends on `pg` 8.x semantics.** `db.ts` never passes a connection string to `pg`, because a connection string can overwrite an explicit `ssl` option and silently drop the pinned CA. `pg` 9 / `pg-connection-string` 3 change `sslmode` handling; re-verify `db.test.ts`'s TLS assertions on that upgrade.
- **Accepted Supabase advisor warnings:** `function_search_path_mutable` on `pgboss.*` functions. They are pg-boss's own SECURITY INVOKER functions, owned by `flightbuddy_worker`, in a schema `anon`/`authenticated` cannot use; editing them would be undone by pg-boss's next migration.
