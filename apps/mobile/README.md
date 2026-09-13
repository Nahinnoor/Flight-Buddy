# FlightBuddy — mobile

Expo SDK 57 / expo-router app. iOS is the only supported platform in Phase 1
(§1: Android is deliberately deferred).

Read `docs/PROJECT_OVERVIEW.md` at the repo root before changing anything here,
and `AGENTS.md` in this directory before touching an Expo API.

## Layout

```
src/
  app/
    _layout.tsx        theme + session + the route guard (the only redirector)
    (auth)/sign-in.tsx Apple / Google, both via signInWithIdToken
    (app)/index.tsx    dashboard: next flight pinned, the rest below
    (app)/add-flight.tsx  free text → lookup → disambiguate → confirm → add
  components/flight-card.tsx  one renderer for rows and candidates alike
  lib/
    env.ts             public config, from app.config.ts `extra` then process.env
    supabase.ts        client + chunked expo-secure-store adapter + auto-refresh
    auth.ts            the two sign-in flows and sign-out
    api.ts             the Fastify API client (ADR 0001), zod-validated
    flights.ts         the one nested Supabase read the dashboard runs
    flight-display.ts  labels, tones, durations, countdowns, staleness
    push.ts            Expo push token → profiles.expo_push_token
    mock/              fixtures + in-memory store for EXPO_PUBLIC_MOCK_API=1
```

## Configuration

Environment lives in the **monorepo-root** `.env` (see `.env.example`), not in
`apps/mobile/.env`. `app.config.ts` loads it and forwards the public keys into
the app manifest; `src/lib/env.ts` reads them.

| Key | Purpose |
|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | anon/publishable key — RLS is the boundary |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | audience Supabase validates the Google ID token against |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | what the native Google SDK presents |
| `EXPO_PUBLIC_API_URL` | Fastify API base, default `http://localhost:3001` |
| `EXPO_PUBLIC_MOCK_API` | `1` answers lookups from fixtures and keeps added flights in memory |

## Running

Both sign-in providers are native modules, so **Expo Go will not run this app**.
Build a dev client:

```bash
npx expo run:ios                          # prebuild + build + install
EXPO_PUBLIC_MOCK_API=1 npx expo start     # then reload the dev client
```

Mock mode knows three designators: `DL1234` (direct), `DL8517` (codeshare,
operated by AF 3612, 45 minutes late) and `WN1234` (two legs on one date — the
disambiguation list). Anything else is the "no flight found" branch.

## Checks

```bash
npx tsc --noEmit        # from this directory
npx expo lint
npx expo export --platform ios   # proves Metro resolves @flightbuddy/shared
```
