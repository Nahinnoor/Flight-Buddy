# FlightBuddy — subagent doc: infra

> Derived verbatim from `docs/PROJECT_OVERVIEW.md`. If this contradicts the master, the master wins — regenerate this file.

## Phase 2 task for this agent

Phase 2 (see `docs/PHASE2_PLAN.md` and ADR 0003): Wave 1 — `services/poller` boots on Render and locally: zod config (names only in errors), `pg` pool over `DATABASE_URL` (the `flightbuddy_worker` role via the session pooler, TLS on), pg-boss in schema `pgboss` with scheduled jobs `credit-check` (hourly), `reconcile-subscriptions` (hourly), `archive-backstop` (daily), pino logger with redaction, heartbeat loop with a `tick()` seam, graceful shutdown; `render.yaml` with one web service and one worker (no cron services); `.node-version` 22.

## Phase 1 task for this agent (done)

Set up the monorepo: npm workspaces, root `tsconfig.base.json`, per-package tsconfig, `packages/shared` (domain types, zod schemas, airport-local time helpers), lint/format config, `.env.example`, scripts. Render/worker deployment is Phase 2 — only scaffold `services/poller` as an empty workspace.

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
