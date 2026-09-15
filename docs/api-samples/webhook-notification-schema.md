# AeroDataBox web-hook delivery: documented shape (no live capture yet)

Source: AeroDataBox's public OpenAPI 3.0.4 spec (`https://api.market/store/aedbx/aerodatabox/openapi.yaml`,
read 2026-09-15). This is the **documented** contract. Wave 3 builds its receiver schema from it and
replaces this file's status line once one real delivery has been captured into
`docs/api-samples/webhook-<case>.json` (§12.2).

## Envelope — `FlightNotificationContract`

`POST` to the subscriber URL, `application/json`. **`additionalProperties: false`** at this level.

| Field | Type | Required | Notes |
|---|---|---|---|
| `flights` | `FlightNotificationItemContract[]` | yes | Created or modified flights. Billing is 1 credit **per item**. |
| `subscription` | `SubscriptionContract` | yes | Which subscription fired (below). |
| `balance` | `SubscriptionBalanceContract` | no | Remaining credits after this delivery (§7.6 free monitoring). |

## Flight item — `FlightNotificationItemContract`

The same fields as the lookup's `FlightContract` (which `packages/flight-provider/src/aerodatabox/schemas.ts`
already parses), plus two human-readable strings. `additionalProperties: false`.

Required: `number`, `status`, `codeshareStatus`, `isCargo`, `lastUpdatedUtc`, `departure`, `arrival`.
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
