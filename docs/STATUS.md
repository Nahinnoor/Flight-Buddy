# FlightBuddy — Status / handoff

**Updated:** 2026-09-13 (session 3) · **Phase:** 1 — Foundation · **Branch:** `main` · **Last commit:** wave 2b = `HEAD` (parent `6bc2179`)

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
| Database | `supabase/migrations/` (10 files), applied to dev project `gxfadelutegfuoxkrmno` (us-west-2) | Schema per §6.2, RLS on all 11 tables, security + performance advisors clean. Review fix migration `20260912013345` tightened `group_members` self-writes and `travelers` insert. `20260913035610` made `travelers.created_by` nullable / `on delete set null` so account deletion works. |
| `packages/flight-provider` | `src/aerodatabox/{client,mapper,schemas}.ts`, `lookup.ts`, `trackingTier.ts`, `ingest.ts` | AeroDataBox client (injectable fetch, timeout, 429→rate-limit error), codeshare resolved by the flight-number endpoint itself, tracking tier + 24h feed-health cache, `ingestFlight` = the only `flights` writer. 82 tests on real fixtures. Review fixes: empty body on 5xx is an error, calendar-valid date check, timeout vs network error split. |
| Fixtures | `docs/api-samples/` (14 of 20 calls used, ledger in `calls.tsv`) | Multi-leg `AS65` (5 legs), codeshare `DL9659`→`KL1405`, live, past, empty/invalid, feed health KJFK/PAWG, balance. |
| `parseFlightQuery` | `packages/shared/src/flightQuery.ts` | Free-text `DL1234 Mar 12` / `tomorrow` / `3/12` → `{flightNumber, dateLocal}`, tz-aware. |
| `apps/api` | `src/{app,server,config,auth,errors,identity,supabase,deps}.ts`, `src/routes/{health,me,flights}.ts`, `README.md` | Fastify 5 per ADR 0001: `GET /healthz`, `GET /v1/me`, `POST /v1/flights/lookup`, `POST /v1/flights`. JWT via jose against the project JWKS (ES256; HS* only with `SUPABASE_JWT_SECRET`). Per-request user-scoped client (RLS); service-role client reachable only by `ingestFlight`. Posted candidates are re-looked-up by operating number before anything is written. 36 tests on the real provider parser + an in-memory Supabase. **Smoke-tested live** (see below). |
| `apps/mobile` | `src/app/(auth)/sign-in.tsx`, `src/app/(app)/{index,add-flight}.tsx`, `src/lib/{api,auth,flights,env,push,supabase}.ts`, `src/components/flight-card.tsx`, `src/providers/session-provider.tsx` | Expo SDK 57, expo-router. Apple/Google via `signInWithIdToken`; dashboard reads `trip_segments → trips → travelers` + `flights` under RLS in one query; add-flight goes through the API only, multi-candidate results are always disambiguated in the UI. Mock mode `EXPO_PUBLIC_MOCK_API=1` for offline dev. `expo lint`, `tsc`, 26 tests green. Not yet run in the simulator against the real API. |
| Skeleton | `services/poller` | Untouched. |

## In progress

Nothing uncommitted. Both wave 2b agents (mobile-client, api-backend part 2) finished; their output was reviewed (Sonnet 5), fixed and committed as the wave 2b commit (`HEAD`, parent `6bc2179`).

### Wave 2b review outcome

- **mobile (BLOCK → fixed):** sign-out had no error path (unhandled rejection, button appeared dead) — dashboard now catches and alerts; delay pill used `estimated ?? actual` instead of `actual ?? estimated`; `EXPO_PUBLIC_API_URL` now falls back to localhost only under `__DEV__` and throws at boot in release builds. The nested RLS dashboard query was verified live (owner sees the row, another user sees zero rows).
- **api (APPROVE):** three non-blocking items. Applied: `clockTolerance: 5s` on both `jwtVerify` branches; comment in `fakeSupabase.ts` that the double has no RLS so the orphan-trip cleanup's safety rests on `trips_delete_own` + the user-scoped client. Deferred: a dedicated `apps/api/src/auth.test.ts` driving `createTokenVerifier` directly (HS256 with no secret, ES256 with a foreign key, `alg: none`, expired) — see Next.
- Found during smoke: Fastify body-parser errors leaked `FST_ERR_CTP_*` codes; now `VALIDATION_ERROR` (`apps/api/src/errors.ts`, tests in `app.test.ts`).

### Live smoke test (2026-09-12, dev project + real AeroDataBox, 5 units spent)

`npm start -w @flightbuddy/api`, a throwaway user minted with the admin API (`auth.admin.createUser` + `signInWithPassword`), then: `/healthz` 200 · no/bad token → 401 envelope · `GET /v1/me` creates profile + self traveller, idempotent · lookup `"DL9659 tomorrow"` + `timeZone` → one candidate, operating `KL1405`, date resolved on the client zone · `POST /v1/flights` creates trip + segment; again with `tripId` → `sequenceNumber: 2`; foreign `tripId` → 404 `TRIP_NOT_FOUND`; tampered `originIata` → 400 `CANDIDATE_MISMATCH` · direct REST insert into `flights` as the user → RLS 403. Smoke rows and users were deleted afterwards. The RapidAPI key works even though `/subscriptions/balance` returns an empty body.

## Next

1. **Run the app in the iOS Simulator end-to-end** against the real API (Phase 1 "done when": one person adds a flight and sees accurate live status). `apps/mobile/ios` was deleted to free disk; `npx expo run:ios` regenerates it. Needs the owner-only auth items below confirmed first (Apple/Google sign-in cannot be faked from a script).
2. **Product decision (owner):** on account deletion the user's self-traveller and its trips now survive as an orphan (`user_id` and `created_by` both NULL) because §6.2 makes `user_id` `on delete set null`. Decide whether account deletion should delete the self-traveller (privacy) or keep it (group itinerary intact); the account-deletion endpoint itself is a Phase 3 service-role operation. Verified on dev 2026-09-13.
3. **Fast-follow:** `apps/api/src/auth.test.ts` (review item above) before any further auth-dependent work.
4. `services/poller` (Phase 1 live status refresh) — brief from the overview §5/§9 + `docs/subagents/data-pipeline.md`.
5. Update `docs/PROJECT_OVERVIEW.md` §13 status line.

## Decisions made this session (not in the overview)

- Supabase project `gxfadelutegfuoxkrmno` is **dev** (writes allowed). No prod project exists yet.
- `citext` lives in `extensions` schema; RLS helpers in `private` schema (`security definer`, `search_path=''`).
- Claiming an unclaimed traveller (setting `user_id` on someone else's row) is NOT possible under RLS — it will be a service-role API operation in Phase 3.
- `lint` runs once at root (does not fan out); `apps/mobile` keeps `expo lint`.
- API error codes: a body Fastify's parser rejects is `VALIDATION_ERROR` (same as a zod rejection); any other Fastify 4xx is `BAD_REQUEST`. Fastify's own codes never reach the client.
- `EXPO_PUBLIC_API_URL` is required in non-dev builds (throws at boot); the localhost fallback is `__DEV__` only.
- Smoke-test cleanup: `auth.admin.deleteUser` now works directly, but delete the user's `travelers` first (cascades trips/segments) or the self-traveller is left behind as an orphan (Next item 2).

## Owner-only items / open questions

- **Done (2026-09-13):** `travelers.created_by` is now nullable with `on delete set null` (migration `20260913035610_travelers_created_by_set_null`, applied to dev; overview §6.2 + implementation notes updated). An auth user delete now succeeds. See Next item 2 for the follow-on decision.
- Mobile review's list to confirm before the simulator run: iOS bundle id `com.nahinnoor.flightbuddy` matches the Apple App ID and the Supabase Apple provider; Sign in with Apple capability enabled for it; `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` is the one entered in Supabase's Google provider (it validates the token `aud` against it); `iosUrlScheme` in `app.json` matches the iOS client; `EXPO_PUBLIC_API_URL`/`EXPO_PUBLIC_MOCK_API` set in any EAS build profile.
- Disk: `~/Library/Containers/com.docker.docker` (35 GB) is an orphan of an uninstalled Docker Desktop; the agent sandbox refused to delete it — run `rm -rf ~/Library/Containers/com.docker.docker` yourself.

- `GET /subscriptions/balance` returns HTTP 200 with an EMPTY body, but flight lookups succeed (smoke test 2026-09-12). Re-check the plan / enable the Flight Alert API before Phase 2.
- Consider rewriting history to purge `.env` from `6102def` before the repo is shared more widely.

## Process rules in force

- Every wave: build (Opus 5 high) → review (Sonnet 5 high) → fix → commit. Subagents never commit.
- No subagent on Fable 5.1. Project head may run on Fable.
- **Before a usage limit or long pause, the project head updates this file** (see `.claude/agents/project-head.md`).
