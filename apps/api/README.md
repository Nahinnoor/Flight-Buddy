# `@flightbuddy/api`

The Fastify HTTP API from [ADR 0001](../../docs/adr/0001-phase1-add-flight-contract.md). It does
three things the mobile client cannot do for itself:

1. **Looks flights up** through `@flightbuddy/flight-provider`, so the RapidAPI key never ships in
   an app bundle.
2. **Writes `flights`** — via `ingestFlight` with the service-role key, which is the *only* writer
   of that table (PROJECT_OVERVIEW §12.7).
3. **Re-verifies** the candidate a client posts back before believing a single timestamp on it.

Everything else the app needs — reading trips, segments and flights — it reads straight from
Supabase under RLS. The API is not a proxy for the database.

## Run

```sh
npm install                      # from the repo root, once
npm run dev -w @flightbuddy/api  # tsx watch, http://localhost:3001
npm start -w @flightbuddy/api    # no watcher
```

```sh
npm run typecheck -w @flightbuddy/api
npm test -w @flightbuddy/api     # vitest, no network: fixtures + an in-memory Supabase
```

## Environment

Read from the repo-root `.env` via dotenv, validated once at boot in
[`src/config.ts`](src/config.ts). A bad environment fails before the socket opens and reports
variable **names** only — no value from `.env` is ever logged or returned in a response body.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SUPABASE_URL` | yes | — | Falls back to `EXPO_PUBLIC_SUPABASE_URL`. Also the JWT issuer and JWKS host. |
| `SUPABASE_ANON_KEY` | yes | — | Falls back to `EXPO_PUBLIC_SUPABASE_ANON_KEY`. Used with the caller's bearer token for RLS-scoped reads and writes. |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | — | Bypasses RLS. Handed to `ingestFlight` and nothing else. |
| `SUPABASE_JWT_SECRET` | no | — | Legacy HS256 secret. Only consulted for tokens whose `alg` starts with `HS`; this project's JWKS publishes ES256, so it is unused. |
| `RAPIDAPI_KEY` | yes | — | Development key only in a development context (§12.3). |
| `AERODATABOX_HOST` | no | `aerodatabox.p.rapidapi.com` | |
| `PORT` | no | `3001` | |
| `HOST` | no | `0.0.0.0` | |
| `LOG_LEVEL` | no | `info` | A pino level. |
| `CORS_ORIGIN` | no | `*` | Comma-separated origins, or `*`. The mobile client is not a browser. |

## Auth

Every route except `GET /healthz` requires `Authorization: Bearer <supabase access token>`.

Tokens are verified against the project's JWKS
(`$SUPABASE_URL/auth/v1/.well-known/jwks.json`, ES256) with `jose`, which caches the key set, so a
burst of requests costs one fetch rather than one per request. The verifier enforces the signature,
`iss`, `aud = authenticated` and expiry. An `HS*` token is verified against `SUPABASE_JWT_SECRET`
if one is configured and rejected outright if not — an unverifiable token is never accepted,
whatever it claims.

Each request gets its own Supabase client built from the anon key plus *the caller's own token*, so
`profiles`, `travelers`, `trips` and `trip_segments` are read and written under RLS with
`auth.uid()` set to them. There is no un-scoped client in scope anywhere a route can reach.

## Endpoints

All errors share one envelope:

```json
{ "error": { "code": "CANDIDATE_MISMATCH", "message": "…" } }
```

| Status | When |
|---|---|
| 400 | Body failed validation (`VALIDATION_ERROR`), free text was not a flight and a date (`INVALID_QUERY`), or the posted candidate no longer matches the provider (`CANDIDATE_MISMATCH`). |
| 401 | Missing, malformed, unverifiable or expired token (`UNAUTHORIZED`). |
| 404 | No such flight (`NOT_FOUND`), or a `tripId` that is not yours (`TRIP_NOT_FOUND`). |
| 429 | The provider rate-limited us (`PROVIDER_RATE_LIMITED`). Carries `Retry-After` when the provider supplied one. |
| 502 | Provider failure or timeout (`PROVIDER_ERROR`, `PROVIDER_TIMEOUT`). |
| 500 | Anything else. Logged in full with the request id; the body says nothing. |

Every response carries `x-request-id` — echoed from the request if it had one. That id is the only
way to tie a 500's log line to the opaque message the client saw.

### `GET /healthz`

No auth, and deliberately no dependency check: a liveness probe that fails when Supabase or the
provider is down turns an upstream blip into a crash loop.

```sh
curl -s localhost:3001/healthz
# {"status":"ok"}
```

### `GET /v1/me`

Returns `{ profile, traveler }`, creating both rows on first call. `travelers.user_id =
travelers.created_by = auth.uid()` — this is the caller's *own* traveller. Claiming somebody else's
unclaimed traveller row is a different operation that always needs confirmation (§12.10) and is not
in Phase 1.

Idempotent, including when two first requests race: the insert is allowed to fail with `23505` and
the winner's row is read back.

```sh
TOKEN=...  # a Supabase access token; the app logs one at sign-in
curl -s localhost:3001/v1/me -H "authorization: Bearer $TOKEN"
```

### `POST /v1/flights/lookup`

Either shape is accepted:

```sh
curl -s localhost:3001/v1/flights/lookup \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"flightNumber":"DL9659","dateLocal":"2026-09-12"}'

curl -s localhost:3001/v1/flights/lookup \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"query":"dl 9659 tomorrow","timeZone":"America/New_York"}'
```

Answers `{ "candidates": [...] }`. **It may contain several** — a flight number can operate several
legs on one date (§8.12), e.g. `AS65` on 2026-09-15 is five. The client disambiguates; the server
never picks `[0]`. Zero candidates is a 404, not an empty list, because "we have no such flight" is
a different thing for the UI to say.

Free text is resolved against the **client's** clock: pass `timeZone` (IANA) or `today`
(`YYYY-MM-DD`). "Tomorrow" in Auckland is not "tomorrow" where this process runs (§8.4).

### `POST /v1/flights`

```sh
curl -s localhost:3001/v1/flights \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"candidate": <one candidate, verbatim from lookup>, "tripId": "<optional>"}'
# {"tripId":"…","segmentId":"…","flightId":"…","sequenceNumber":1}
```

What happens, in order:

1. The caller's `profiles` and self `travelers` rows are ensured, so a brand-new user can add a
   flight without having opened any other screen.
2. **The candidate is looked up again** by its *operating* number and departure date, and the leg is
   matched on `originIata`. No match → 400 `CANDIDATE_MISMATCH`. Everything written below comes from
   what the provider just said; the posted candidate only identifies which leg was meant.
3. `ingestFlight` upserts `flights` on the canonical key with the service-role client. This file
   never touches `flights` itself (§12.7).
4. `tripId`, if given, must be a trip of the caller's own traveller — a co-member's trip is readable
   but not appendable, and both cases answer 404 `TRIP_NOT_FOUND`. Without it, a new trip is created.
5. A `trip_segments` row is written as the user with `sequence_number = max + 1`, recomputed if a
   concurrent add took it, and with **the marketing carrier and number the client sent**. That pair
   is what the user typed, it is display data, and it belongs on the segment — never on the `flights`
   row shared by every traveller on that aircraft (§6.1, §7.2).

If the segment write fails after a trip was created *by this request*, that trip is deleted, so a
failed add leaves nothing on the dashboard. The ingest is an upsert of a shared real-world fact and
is left alone.

## Layout

| File | |
|---|---|
| `src/server.ts` | Process entry point: load env, listen, drain on `SIGTERM`. |
| `src/app.ts` | `buildApp(deps)` — the whole service as one value, every edge injectable. |
| `src/deps.ts` | What those edges are. |
| `src/config.ts` | Env schema and parsing. |
| `src/auth.ts` | JWT verification and the `preHandler` that guards `/v1`. |
| `src/supabase.ts` | The user-scoped and service-role clients, and the line between them. |
| `src/errors.ts` | The error envelope and the one place a failure becomes a status. |
| `src/identity.ts` | Ensure `profiles` and the self `travelers` row, idempotently. |
| `src/routes/` | `healthz`, `/v1/me`, `/v1/flights*`. |
| `src/testing/` | Fixture-backed provider and an in-memory Supabase. Test-only. |

## Testing

Tests build the same app the server builds and drive it with `app.inject()` — no port, no network,
no database.

The provider double is the **real** `createAeroDataBoxProvider` with an injected `fetch` serving the
captured responses in [`docs/api-samples/`](../../docs/api-samples/) (§12.2), so the tests exercise
the same parsing, codeshare resolution and tracking-tier logic the server runs. The Supabase double
is a small in-memory store that enforces the unique constraints from §6.2, because the things worth
asserting — idempotency, sequence numbers, no orphan trip, and that the user client never touches
`flights` — are things only state can show.
