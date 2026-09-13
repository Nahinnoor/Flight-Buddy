# FlightBuddy — Status / handoff

**Updated:** 2026-09-12 (session 2, resumed after usage limit) · **Phase:** 1 — Foundation · **Branch:** `main` · **Last commit:** `9afd920`

This file is the handoff point. A human or a fresh agent should be able to read this and `docs/PROJECT_OVERVIEW.md` and continue without the previous conversation.

## Done

| Item | Where | Notes |
|---|---|---|
| Repo hygiene | `.gitignore`, `.env.example`, `CLAUDE.md` | `.env` untracked (still in history at `6102def`; contains dev keys only). |
| Master doc | `docs/PROJECT_OVERVIEW.md` | Renamed from `ProjectOverview.md`. §6.3 has "Implementation notes" for DB deviations. |
| Subagent docs | `docs/subagents/{infra,api-backend,data-pipeline,mobile-client}.md` | Verbatim section copies per §0 + a Phase 1 task blurb. |
| Agent definitions | `.claude/agents/*.md` | Builders = Opus 5 high, reviewer = Sonnet 5 high, project head = see below. Not auto-loaded mid-session; pass `model` on every spawn. |
| ADR 0001 | `docs/adr/0001-phase1-add-flight-contract.md` | Resolves §3.1 vs rule 7: the only `flights` writer is `ingestFlight` (service role) in `packages/flight-provider`. Defines the `/v1` API contract. |
| ADR 0002 | `docs/adr/0002-workspace-module-resolution.md` | Source-first workspaces (`main` → `src/index.ts`), `moduleResolution: bundler`, Metro-safe imports. |
| Tooling | root `package.json`, `tsconfig.base.json`, `eslint.config.mjs`, prettier, vitest | `npm run typecheck / test / lint` green at commit time. TS ~6.0 (not 7: typescript-eslint peer range). Node 22.12 (eslint 10 wants 22.13+, warning only). |
| `packages/shared` | `src/{types,schemas,time,database.types}.ts` | `FlightCandidate` contract, zod schemas matching ADR 0001, Intl-only airport-local time helpers (39 tests), generated Supabase types. |
| Database | `supabase/migrations/` (9 files), applied to dev project `gxfadelutegfuoxkrmno` (us-west-2) | Schema per §6.2, RLS on all 11 tables, security + performance advisors clean. Review fix migration `20260912013345` tightened `group_members` self-writes and `travelers` insert. |
| `packages/flight-provider` | `src/aerodatabox/{client,mapper,schemas}.ts`, `lookup.ts`, `trackingTier.ts`, `ingest.ts` | AeroDataBox client (injectable fetch, timeout, 429→rate-limit error), codeshare resolved by the flight-number endpoint itself, tracking tier + 24h feed-health cache, `ingestFlight` = the only `flights` writer. 82 tests on real fixtures. Review fixes: empty body on 5xx is an error, calendar-valid date check, timeout vs network error split. |
| Fixtures | `docs/api-samples/` (14 of 20 calls used, ledger in `calls.tsv`) | Multi-leg `AS65` (5 legs), codeshare `DL9659`→`KL1405`, live, past, empty/invalid, feed health KJFK/PAWG, balance. |
| `parseFlightQuery` | `packages/shared/src/flightQuery.ts` | Free-text `DL1234 Mar 12` / `tomorrow` / `3/12` → `{flightNumber, dateLocal}`, tz-aware. |
| Skeletons | `apps/api`, `services/poller` | `apps/api` in progress (below). |
| Mobile | `apps/mobile` | Expo SDK 57 template committed as-is; real work in progress (below). |

## In progress (uncommitted; agents relaunched 2026-09-12 after a usage-limit cut-off)

- **mobile-client — resumed.** `apps/mobile/**` unstaged. Previous agent got through auth, API client with mock mode, add-flight, flight card, and was wiring the mock store into the dashboard when cut off. Resumed agent finishes + verifies (tsc, expo lint, expo export, simulator screenshots).
- **api-backend part 2 — resumed.** `apps/api/src/{config,auth,errors}.ts` existed; resumed agent builds app/routes/tests. First job: dedupe zod to a single ^4 copy across workspaces.

If these agents are gone again: `git status`; run `npm run typecheck && npm test && npm run lint`; whatever is in the tree is partial output — relaunch with a "resume, read existing files first" brief.

## Next

1. Review (Sonnet 5 high) + commit the data-pipeline output.
2. Spawn **api-backend part 2**: `apps/api` Fastify routes per ADR 0001 (`POST /v1/flights/lookup`, `POST /v1/flights`, `GET /v1/me`), Supabase JWT verification, uses `lookupCandidates` + `ingestFlight` from the provider package. Server re-validates the posted candidate against the provider before ingesting.
3. Review + commit mobile; then run the app in the iOS Simulator end-to-end against the real API (Phase 1 "done when": one person adds a flight and sees accurate live status).
4. Update this file and `docs/PROJECT_OVERVIEW.md` §13 status line.

## Decisions made this session (not in the overview)

- Supabase project `gxfadelutegfuoxkrmno` is **dev** (writes allowed). No prod project exists yet.
- `citext` lives in `extensions` schema; RLS helpers in `private` schema (`security definer`, `search_path=''`).
- Claiming an unclaimed traveller (setting `user_id` on someone else's row) is NOT possible under RLS — it will be a service-role API operation in Phase 3.
- `lint` runs once at root (does not fan out); `apps/mobile` keeps `expo lint`.

## Owner-only items / open questions

- Confirm Apple Services ID + bundle ID match in Supabase Auth → Apple provider (mobile agent will report what it assumed).
- `GET /subscriptions/balance` returns HTTP 200 with an EMPTY body (no balance record). Re-subscribe the RapidAPI plan / enable the Flight Alert API before Phase 2. Not blocking Phase 1.
- Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to root `.env` (API ingest path). Not yet present as of 2026-09-12.
- Consider rewriting history to purge `.env` from `6102def` before the repo is shared more widely.

## Process rules in force

- Every wave: build (Opus 5 high) → review (Sonnet 5 high) → fix → commit. Subagents never commit.
- No subagent on Fable 5.1. Project head may run on Fable.
- **Before a usage limit or long pause, the project head updates this file** (see `.claude/agents/project-head.md`).
