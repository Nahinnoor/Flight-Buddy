# AeroDataBox web-hook delivery: documented shape, corrected by a real capture

Source: AeroDataBox's public OpenAPI 3.0.4 spec (`https://api.market/store/aedbx/aerodatabox/openapi.yaml`,
read 2026-09-15 and again 2026-09-18), **corrected by the first real delivery**, captured 2026-09-18
23:21 UTC and saved (sanitised) as `webhook-delivery-real-enroute.json`. Where the two disagree,
the capture wins and the difference is marked below.

## What the real capture showed — five things the spec gets wrong or leaves out

1. **The envelope carries three undocumented top-level fields: `id` (string, a GUID),
   `timestampUtc` (string) and `deliveryAttempt` (an object).** The spec's
   `additionalProperties: false` at the envelope level is false in practice. The receiver strips
   unknown top-level keys, keeps `id` and `timestampUtc`, and **drops `deliveryAttempt`**: it models it
   as a bounded int, the real value is an object, and a wrongly typed metadata field is dropped
   rather than refused. So `deliveryAttempt` never reaches `webhook_inbox`, and its inner shape has
   not been captured.
2. **Enums are integers, not strings.** The webhook serializer writes every enum as its number; the
   lookup REST API (and the spec's `type: string`) write the name. The numbering is the spec's own:
   each enum schema's description lists `0 - Name, 1 - Name, ...`, in the same order as its `enum`
   array. Tables below.
3. **`greatCircleDistance` has PascalCase keys** (`Feet`, `Km`, `Meter`, `Mile`, `Nm`), where the
   lookup API uses lowercase. Nothing reads it; the worker types it `unknown`.
4. **Timestamps are not uniformly zoned.** `balance.lastRefilledUtc` and
   `subscription.createdOnUtc` arrived without a `Z` (`"2026-09-15 01:46"`), while
   `lastDeductedUtc` and every flight time had one. Nothing parses those two fields.
5. **Airports carry a nested `location` (`lat`, `lon`)** not in the lookup schema. The movement and
   airport schemas are loose, so it passes through unread.

Every other field matched its documented type. The item carried no key outside the strict item
schema, and **no `notificationSummary` or `notificationRemark`** keys were present.

### Integer enums (spec numbering, confirmed 2026-09-18)

One table per enum, in code at `packages/flight-provider/src/aerodatabox/enums.ts`. The worker
accepts **either** the string name **or** the integer and normalises to the name, so the existing
lookup mapper handles both. An integer outside its table is never guessed at and never throws; the
worker logs the field path (e.g. `flights[0].status`), never the value. For `codeshareStatus` and
`quality` it reads as `Unknown`. For **`status`** the whole leg is dropped instead, and the delivery
closes as `UnmappableLeg` if nothing else was mappable: the stored status stands, because a status
wiped to `unknown` and later restored would fire `cancelled`/`diverted` a second time (the detector
fires on the edge into them). Any other JSON type is still refused.

| Spec schema | Where | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `FlightStatus` | `flights[].status` | Unknown | Expected | EnRoute | CheckIn | Boarding | GateClosed | Departed | Delayed | Approaching | Arrived | Canceled | Diverted | CanceledUncertain |
| `CodeshareStatus` | `flights[].codeshareStatus` | Unknown | IsOperator | IsCodeshared | | | | | | | | | | |
| `FlightAirportMovementQualityEnum` | `departure.quality[]`, `arrival.quality[]` | Basic | Live | Approximate | | | | | | | | | | |
| `SubscriptionBillingType` | `subscription.billingType` | LifetimeBased | CreditBased | | | | | | | | | | | |
| `SubscriptionSubjectType` | `subscription.subject.type` | FlightByNumber | FlightByAirportIcao | | | | | | | | | | | |

The capture checks out against reality: DL1915's status **2** (EnRoute) arrived one minute after
that aircraft's takeoff; codeshare **1** (IsOperator — Delta operates DL1915); quality **[0,1]**
(Basic + Live); subject **0** (FlightByNumber); billing **1** (CreditBased). The REST list endpoint
(`GET /subscriptions/webhook`) still returns strings, and its schema stays strings-only.

### Other days' occurrences

A subscription is keyed by number with **no date** (overview §7.6), so a delivery can describe any
day's occurrence of that number. The captured one did: it was DL1915's **2026-09-18** flight,
delivered for a subscription opened for the **2026-09-19** one. The worker matches each leg to a
subscribed row on the whole canonical key (carrier, number, origin-local departure date, origin);
a leg with no match is never ingested (no `flights` row, no `flight_events`), and a delivery with no
matching leg at all is closed in `webhook_inbox` with reason **`NoTrackedLeg`**, its balance still
logged to `provider_credit_log`. The credit is spent regardless; ADR 0005 moves the subscription
opening to after the previous occurrence's scheduled landing to stop buying these.

### History: before the capture (2026-09-16/17)

About 34 real POSTs were rejected by the receiver with the same two issues
(`invalid_type at flights.0.status`, `unrecognized_keys at (root): id,timestampUtc,deliveryAttempt`).
Commit `2ddf8c0` made the receiver strip unknown top-level keys and store any JSON type for `status`,
and the worker closed such rows as `InvalidPayload` with the payload kept. The first of those stored
rows is the capture above; the worker now reads it.

## Envelope — `FlightNotificationContract`

`POST` to the subscriber URL, `application/json`. The spec says **`additionalProperties: false`** at
this level; real deliveries contradict it (above).

| Field | Type | Required | Notes |
|---|---|---|---|
| `flights` | `FlightNotificationItemContract[]` | yes | Created or modified flights. Billing is 1 credit **per item**. |
| `subscription` | `SubscriptionContract` | yes | Which subscription fired (below). |
| `balance` | `SubscriptionBalanceContract` | no | Remaining credits after this delivery (§7.6 free monitoring). |
| `id` | undocumented; string (a GUID) | seen in every real delivery | Observed, not in the spec. Likely the delivery idempotency key. Modelled as string ≤ 128. |
| `timestampUtc` | undocumented; string (`"2026-09-18 23:21:13Z"`, with seconds) | seen in every real delivery | Observed, not in the spec. Modelled as string ≤ 64. |
| `deliveryAttempt` | undocumented; **object** (inner shape not captured) | seen in every real delivery | Modelled as int 0–1000, so the receiver drops it and it is never stored. |

## Flight item — `FlightNotificationItemContract`

The same fields as the lookup's `FlightContract` (which `packages/flight-provider/src/aerodatabox/schemas.ts`
already parses), plus two human-readable strings. `additionalProperties: false`.

Required: `number`, `status`, `codeshareStatus`, `isCargo`, `lastUpdatedUtc`, `departure`, `arrival`.
**`status` and `codeshareStatus` are documented as strings but arrive as integers**, as do the
`quality[]` members of `departure` / `arrival` (tables above).
Optional: `notificationSummary` (string, nullable), `notificationRemark` (string, nullable),
`greatCircleDistance` (real: object with PascalCase keys), `flightPlan`, `callSign`, `aircraft`,
`airline`, `location`.

- `departure` / `arrival` are `FlightAirportMovementContract`, the same movement shape the lookup mapper
  already turns into UTC instants, gate and terminal.
- **`notificationSummary` and `notificationRemark` are provider free text.** They are data: never logged
  verbatim, never put in push copy, never interpolated into SQL, shell or a prompt. Push text is built
  from our own typed fields only.

## Subscription — `SubscriptionContract`

Required: `id` (uuid — the value stored in `flights.alert_subscription_id`), `isActive`, `createdOnUtc`,
`subject`, `subscriber`. Optional: `billingType` (`LifetimeBased` deprecated, `CreditBased`; **an integer
in deliveries**, a string from the REST API),
`expiresOnUtc` (null = never expires), `activateBeforeUtc`, `notices`.
`subject` = `{ type: 'FlightByNumber' | 'FlightByAirportIcao', id: 'DL 47' }` — `id` is the flight number
as subscribed; `type` is **an integer in deliveries** (`0`), a string from the REST API.

The receiver stores an **allow list** of subscription fields (`id`, `isActive`, `billingType`,
`createdOnUtc`, `expiresOnUtc`, `activateBeforeUtc`, `subject`) and replaces `subscriber`, which echoes
our delivery URL and so the secret token, with a fixed redaction placeholder.

**Unknown subscription:** the receiver stores every authenticated delivery; the worker closes one whose
`subscription.id` is on no active flight row with reason `UnknownSubscription` — never ingested. One whose
subscription is ours but whose legs match no tracked row is closed as `NoTrackedLeg` (above).

## Balance — `SubscriptionBalanceContract`

Required: `creditsRemaining` (int64), `lastRefilledUtc`, `lastDeductedUtc` (date-time; the capture's
`lastRefilledUtc` had no zone suffix). The receiver stores only these three fields (an allow list, like
`subscription`). This is also the
body of `GET /subscriptions/balance`, which returns 200 with an **empty** body when the account has never
been refilled (observed 2026-09-13).

## Creating a subscription

`POST /subscriptions/webhook/{subjectType}/{subjectId}` with body `CreateWebHookSubscription`:

| Field | Type | Notes |
|---|---|---|
| `url` | string, required | Public HTTP(S), ports 80/443/8008/8080 or ≥ 49152, **no additional authorization**, must answer 2XX within **10 s**, and the owner must consent. A secret token in the path meets this (ADR 0003). |
| `maxDeliveryRetries` | int 0–2, nullable | **Defaults to 0 for credit-based subscriptions.** ADR 0003 decision 2 sends `1` explicitly. |

- `subjectType` = `FlightByNumber`; `subjectId` = the **operating** flight number (codeshare resolved, §7.2),
  spaces and case optional.
- The spec lists **no `useCredits` query parameter**; its description says the move to credit billing is
  complete and credit-based is the default. The 2026 guide's `?useCredits=true` is likely obsolete —
  confirm on the first real subscription and record the result here.
- Response: `SubscriptionContract` (store `id`).

## Refill (owner-only, never called by code)

`POST /subscriptions/balance/refill` with `{ "credits": <int32 ≥ 1> }` → `SubscriptionBalanceContract`.
