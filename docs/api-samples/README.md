# AeroDataBox response samples

Real responses from AeroDataBox via RapidAPI (`aerodatabox.p.rapidapi.com`), captured with the
**development** key. Every unit test in `packages/flight-provider` runs against these files and
none of them touch the network: §12.1 allows 20 exploratory calls per agent, which is not a budget
tests can draw on.

Bodies are verbatim, only pretty-printed. No request headers, and therefore no API key, are stored.
An empty body is recorded as `{"_note": "HTTP <status> ... with an empty body"}` so the file is
still valid JSON — those cases are marked below.

**Captured:** 2026-09-12 (UTC), which was the evening of 2026-09-11 in New York.
**Exploratory calls used: 14 of the 20 allowed.** The raw ledger is `calls.tsv`.

## Regenerating

One call per invocation, appended to `calls.tsv`:

```
node packages/flight-provider/scripts/capture-samples.mjs <case-name> '<api-path>'
```

The key comes from `RAPIDAPI_KEY` in the root `.env` via dotenv. The script refuses to write a file
whose body contains the key.

## Fixtures

All flight lookups pass `dateLocalRole=Departure`, because the canonical key in §6.2 is the local
date at the **origin**; the provider's default, `Both`, also returns flights that merely *arrive*
that day and departed the day before.

| File | Request | Status | What it shows |
|---|---|---|---|
| `flights-number-domestic-single.json` | `GET /flights/number/AA1/2026-09-15?dateLocalRole=Departure` | 200 | One leg, schedule only (`quality: ["Basic"]`). JFK→LAX. No `revisedTime`, no registration. The baseline mapping case. |
| `flights-number-multileg.json` | `GET /flights/number/AS65/2026-09-15?dateLocalRole=Departure` | 200 | **Five legs on one number and one date** — Alaska's milk run SEA→KTN→WRG→PSG→JNU→ANC. Proves §8.12: never take `[0]`. Five distinct canonical keys, three time zones. |
| `flights-number-codeshare-marketing.json` | `GET /flights/number/DL9659/2026-09-12?dateLocalRole=Departure` | 200 | **Codeshare resolution.** Asked for the Delta marketing number, answered `number: "KL 1405"`, `airline: KLM`, `codeshareStatus: "IsOperator"`. The provider resolves to the operating flight server-side. |
| `flights-number-live-today.json` | `GET /flights/number/B6 1411/2026-09-11?dateLocalRole=Departure` | 200 | Live data (`quality: ["Basic","Live"]`), `callSign`, registration, `revisedTime`. Also the **late-night departure**: 21:59 local on the 11th at JFK is 01:59Z on the 12th, so `departureDateLocal` and the UTC date differ. |
| `flights-number-past-date.json` | `GET /flights/number/AA1/2026-08-15?dateLocalRole=Departure` | 200 | A completed flight: `status: "Arrived"`, `runwayTime` on both ends, arrival `revisedTime` (gate) and `runwayTime` (landing) 3 minutes apart. |
| `flights-number-nonexistent-empty.json` | `GET /flights/number/DL8517/2026-09-15?dateLocalRole=Departure` | **204, empty body** | A well-formed number that does not operate that day. Maps to `[]`, not an error. |
| `flights-number-nonexistent-invalid.json` | `GET /flights/number/ZZ9999/2026-09-15?dateLocalRole=Departure` | **204, empty body** | An airline code that does not exist. Same shape as the above — the provider does not distinguish. |
| `flights-number-bad-request.json` | `GET /flights/number/AA1/2026-13-45?dateLocalRole=Departure` | **404, empty body** | A malformed date is rejected by the gateway with no `ErrorContract` body at all. The client validates the date locally so this never costs quota in production. |
| `health-feeds-KJFK.json` | `GET /health/services/airports/KJFK/feeds` | 200 | Major US hub: schedules `OK`, live updates `OK`, ADS-B `OKPartial` → **`live` tier**. |
| `health-feeds-PAWG.json` | `GET /health/services/airports/PAWG/feeds` | 200 | Wrangell, Alaska (on the AS 65 milk run): schedules `OK`, live updates `Unavailable`, ADS-B `Down` → **`scheduled` tier**, "Not live-tracked". |
| `subscriptions-balance.json` | `GET /subscriptions/balance` | **200, empty body** | The §11 smoke test. See the warning below. |
| `flights-airport-KJFK-departures-codeshare-discovery.json` | `GET /flights/airports/icao/KJFK/2026-09-11T21:00/2026-09-11T22:00?direction=Departure&withLeg=true&withCancelled=true&withCodeshared=true&withCargo=false&withPrivate=false` | 200 | Discovery, not a mapper fixture. 58 departures, **zero** marked `IsCodeshared` — only `IsOperator` and `Unknown`. |
| `flights-airport-EHAM-departures-codeshare-discovery.json` | `GET /flights/airports/icao/EHAM/2026-09-12T08:00/2026-09-12T09:00?direction=Departure&withLeg=true&withCancelled=true&withCodeshared=true&withCargo=false&withPrivate=false` | 200 | Discovery. 128 departures, 98 `IsCodeshared` — this is where `DL 9659` was found. Also shows the marketing entry and its operating twin (`KL 1405`) side by side. |

## Provider behaviour worth knowing

**Timestamps are not ISO-8601.** The provider emits `"2026-09-12 01:59Z"` and
`"2026-09-11 21:59-04:00"`: a space instead of `T`, and no seconds. `toUtcIso` in the mapper
normalises; nothing else should parse these strings.

**Local dates are reliable.** Every movement carries `scheduledTime.local` with the airport's
offset and `airport.timeZone` as an IANA name, and they agree. `departureDateLocal` is read from
the local string rather than derived from UTC.

**Codeshares are resolved by the flight-number endpoint, and only there.** `FlightContract` has no
codeshare block: there is no field anywhere in the response that names the operating flight. What
saves us is that `GET /flights/number/{marketing}/{date}` *substitutes* the operating flight in its
answer. The airport FIDS endpoint does the opposite — it lists `DL 9659` and `KL 1405` as separate
entries with the same aircraft, times and gate, and the only link between them is the registration.
So: look flights up by number, never reconstruct them from an airport feed.

**Codeshare status is mostly absent at US airports.** In the JFK sample every flight is `IsOperator`
or `Unknown`; at Amsterdam, 77% are `IsCodeshared`. This matches the provider's own note that
code-share status is "rare" in the schedules feed.

**Gate is frequently missing.** Present at AMS, absent at JFK and on every leg of AS 65. Terminal is
more reliable. Treat both as optional.

## ⚠️ `GET /subscriptions/balance` returns 200 with an empty body

On the development key, the balance endpoint answers **HTTP 200 with a zero-length body** rather
than the documented `FlightSubscriptionBalanceContract`. There is no error message to report.

The reading is that the account has no flight-alert credit balance record — the RapidAPI plan needs
subscribing (or re-subscribing) to the Flight Alert API before Phase 2's webhook lifecycle (§7.6)
and credit failover (§7.7) can be built or tested. **This needs resolving before Phase 2 starts**,
and §7.7 calls the credit balance the most critical reliability requirement in the system.

`getCreditBalance()` reads an empty body as `0` credits, which is both the truthful reading and the
fail-safe one: zero means fall back to polling rather than trust alerts that will never arrive.
