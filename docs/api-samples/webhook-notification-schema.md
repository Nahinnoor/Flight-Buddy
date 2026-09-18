# AeroDataBox web-hook delivery: documented shape (no live capture yet)

Source: AeroDataBox's public OpenAPI 3.0.4 spec (`https://api.market/store/aedbx/aerodatabox/openapi.yaml`,
read 2026-09-15). This is the **documented** contract. Wave 3 builds its receiver schema from it and
replaces this file's status line once one real delivery has been captured into
`docs/api-samples/webhook-<case>.json` (§12.2).

## What real deliveries showed (2026-09-16/17) — the spec is wrong in two places

No real body has been captured yet; this section comes from the receiver's rejection log, which
records zod issue codes and field paths, never values. Every real delivery (~34 POSTs across two
tracked flights) was rejected with exactly the same two issues:

```
invalid_type at flights.0.status
unrecognized_keys at (root): id,timestampUtc,deliveryAttempt
```

1. **The envelope carries three undocumented top-level fields: `id`, `timestampUtc`,
   `deliveryAttempt`.** The spec's `additionalProperties: false` at the envelope level is **false in
   practice**. Their types are not confirmed; the receiver models them as optional, bounded
   `string` / `string` / non-negative `int` and drops (rather than rejects on) a value of any other
   type, logging the received JSON type name. `id` is the likely delivery idempotency key.
2. **`flights[].status` is not a string**, although the spec says it is. Its real type is **not
   confirmed** (the log names paths, not values). The leading hypothesis is an integer — .NET's
   default JSON serializer writes enums as numbers — which would make `codeshareStatus` and any
   nested enum arrays integers too. **Do not map integers to statuses until a real body is
   captured**: guessing the enum order turns an on-time departure into a cancellation.
3. **Unknown: whether items carry undocumented keys too.** The receiver's item schema has always
   passed unknown item keys through, so the log could not have reported them. The worker's item
   schema is strict, so the first captured body will show it either way.

Since this fix: the receiver strips unknown top-level keys and accepts any JSON type for `status`
(present, not typed), stores the delivery, and answers 200. The worker (`flightNotificationSchema`)
stays strict — `status` and `codeshareStatus` must be strings — so a real delivery is closed in
`webhook_inbox` as `InvalidPayload` **with its payload kept**. That stored row is the capture this
file is still waiting for; the rejection log now also records the received JSON type
(`invalid_type at flights.0.status (received number)`) for any delivery that is still refused.

## Envelope — `FlightNotificationContract`

`POST` to the subscriber URL, `application/json`. The spec says **`additionalProperties: false`** at
this level; real deliveries contradict it (above).

| Field | Type | Required | Notes |
|---|---|---|---|
| `flights` | `FlightNotificationItemContract[]` | yes | Created or modified flights. Billing is 1 credit **per item**. |
| `subscription` | `SubscriptionContract` | yes | Which subscription fired (below). |
| `balance` | `SubscriptionBalanceContract` | no | Remaining credits after this delivery (§7.6 free monitoring). |
| `id` | undocumented (modelled as string ≤ 128) | seen in every real delivery | Observed, not in the spec. Likely a delivery id. |
| `timestampUtc` | undocumented (modelled as string ≤ 64) | seen in every real delivery | Observed, not in the spec. |
| `deliveryAttempt` | undocumented (modelled as int 0–1000) | seen in every real delivery | Observed, not in the spec. Likely counts retries. |

## Flight item — `FlightNotificationItemContract`

The same fields as the lookup's `FlightContract` (which `packages/flight-provider/src/aerodatabox/schemas.ts`
already parses), plus two human-readable strings. `additionalProperties: false`.

Required: `number`, `status`, `codeshareStatus`, `isCargo`, `lastUpdatedUtc`, `departure`, `arrival`.
**`status` is documented as a string but is not one in real deliveries** (type unconfirmed, above).
Optional: `notificationSummary` (string, nullable), `notificationRemark` (string, nullable),
`greatCircleDistance`, `flightPlan`, `callSign`, `aircraft`, `airline`, `location`.

- `departure` / `arrival` are `FlightAirportMovementContract`, the same movement shape the lookup mapper
  already turns into UTC instants, gate and terminal.
- **`notificationSummary` and `notificationRemark` are provider free text.** They are data: never logged
  verbatim, never put in push copy, never interpolated into SQL, shell or a prompt. Push text is built
  from our own typed fields only.

## Subscription — `SubscriptionContract`

Required: `id` (uuid — the value stored in `flights.alert_subscription_id`), `isActive`, `createdOnUtc`,
`subject`, `subscriber`. Optional: `billingType` (`LifetimeBased` deprecated, `CreditBased`),
`expiresOnUtc` (null = never expires), `activateBeforeUtc`, `notices`.
`subject` = `{ type: 'FlightByNumber' | 'FlightByAirportIcao', id: 'DL 47' }` — `id` is the flight number
as subscribed.

**Receiver rule:** an unknown `subscription.id` (not on any active flight row) is acknowledged with 200 and
dropped — never ingested.

## Balance — `SubscriptionBalanceContract`

Required: `creditsRemaining` (int64), `lastRefilledUtc`, `lastDeductedUtc` (date-time). This is also the
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
