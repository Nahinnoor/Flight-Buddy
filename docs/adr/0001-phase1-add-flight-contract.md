# ADR 0001 — Phase 1 add-flight contract and the ingest path

**Status:** accepted 2026-09-11

## Context

§3.1 step 6 says the add-flight flow upserts into `flights`; §12 rule 7 says never write to `flights` from a request handler. Both are true only if the write goes through one shared, service-role-only function that writes exactly what the provider returned and nothing the user typed.

## Decision

1. `packages/flight-provider` exports `ingestFlight(candidate: FlightCandidate, deps)`: resolves codeshare (already done in the candidate), upserts `flights` on the canonical key `(operating_carrier_iata, operating_flight_number, departure_date_local, origin_iata)` with `on conflict do update`, and returns the `flights.id`. It uses the service-role client. The poller (Phase 2) reuses the same function for status updates.
2. The API never touches `flights` directly. It calls `ingestFlight`, then writes `travelers` (self, if missing), `trips` and `trip_segments` (marketing number goes on the segment).
3. Mobile reads `trips → trip_segments → flights` directly from Supabase under RLS (anon key + user JWT). Mobile uses the API only for lookup and add.

## API (Fastify, `apps/api`, all under `/v1`, bearer = Supabase access token)

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/v1/flights/lookup` | `{ query: string }` free text (`"DL1234 Mar 12"`, `"DL1234 tomorrow"`) **or** `{ flightNumber: string, dateLocal: "YYYY-MM-DD" }` | `{ candidates: FlightCandidate[] }` — may be 0, 1 or many. Never pick `[0]` server-side. |
| `POST` | `/v1/flights` | `{ candidate: FlightCandidate, tripId?: string }` — the exact candidate the user picked; `tripId` appends a segment to an existing trip (layovers) | `{ tripId, segmentId, flightId, sequenceNumber }` |
| `GET` | `/v1/me` | — | `{ profile, traveler }` (creates both rows on first call) |

Errors: `{ error: { code: string, message: string } }` with 400 (validation), 401 (no/invalid JWT), 404 (no flights found), 502 (provider failure), 429 (provider rate-limited).

`FlightCandidate` is defined once in `@flightbuddy/shared` (`src/types.ts`) and validated with the zod schema there. The server re-validates the posted candidate against the provider (re-lookup by operating number + date + origin) before ingesting, so a client cannot forge times.

## Consequences

- Rule 7 holds: the only `flights` writer is `ingestFlight`, callable only with the service-role key.
- The poller in Phase 2 gets the same upsert for free.
