# 0003. Phase 2: AeroDataBox's 2026 alert API, webhook authentication, and worker topology

## Status

Accepted — 2026-09-14 (owner decisions recorded in `docs/PHASE2_PLAN.md` §8).

## Context

The overview's §7.6–§7.8 and §11 were written against AeroDataBox's original Flight Alert API and
the RapidAPI PRO plan as it was then. Before building Phase 2 we checked the current documentation
and the live account:

- AeroDataBox replaced lifetime-billed subscriptions with a **credit-based** system (old
  subscriptions were converted or halted on 4 April 2026). Subscriptions are created with
  `POST /subscriptions/webhook/{subjectType}/{subjectId}?useCredits=true`, **never expire**, cost
  1 credit per flight item per delivery attempt, and `maxDeliveryRetries` defaults to 0 (range 0–2).
  Every delivery carries the remaining balance. Credits are **not** drawn from the plan's monthly
  units automatically: the balance only grows through `POST /subscriptions/balance/refill`
  (1 credit = 1 API unit), there is no dashboard for it, and at zero balance every subscription
  pauses.
- AeroDataBox documents **no signature or shared secret** on webhook deliveries.
- The RapidAPI Pro plan is now **5,000 units/month, 2 requests/second, $8/month** (was 6,000 units,
  1 req/s, $5.35). Per-refill and maximum-balance caps for RapidAPI plans are not published.
- Render background workers are paid; cron jobs are billed per service. The worker's database and
  provider secrets would otherwise be duplicated into four services.
- The owner's pre-commit security rule (2026-09-13) requires that external text is never treated as
  instructions, that no user data leaks, and least privilege for every credential.

## Decisions

1. **Webhook authentication = secret URL token + verification poll.** The receiver path carries a
   32+ byte random token that lives only in Render env (`WEBHOOK_TOKEN` on the API, inside
   `WEBHOOK_URL` on the worker) and is compared in constant time. A wrong token answers 404, queues
   nothing and logs no payload. Because deliveries are unsigned, a gate change or cancellation that
   arrives **by webhook** is confirmed with one provider poll (2 units) before a notification is
   emitted; other fields are ingested as data without confirmation. The payload is validated by a
   strict schema, size-capped, rate-limited per IP, and never interpolated into SQL, shell or any
   prompt.
2. **`maxDeliveryRetries: 1`.** Our endpoint answers 200 before processing, so retries are for our
   outages only; one retry bounds the cost at 2 credits per alert.
3. **No automatic credit refill.** The hourly job records the balance in `provider_credit_log` and
   alerts the owner at 300, 100 and 0 credits; the owner refills by hand. At zero, every subscribed
   flight is put back on the polling ladder immediately (§7.7 step 3 stands). This replaces §7.7
   step 2.
4. **Operator alerts are push notifications to the owner's own phone** through the same Expo
   pipeline, addressed by `OPERATOR_USER_ID`. No email service and no Sentry for now; Render's logs
   and failure emails cover crashes.
5. **Scheduled jobs run inside the worker** on pg-boss's scheduler (`credit-check` hourly,
   `reconcile-subscriptions` hourly, `archive-backstop` daily). There are no Render cron services.
   The retention purge (Phase 4) will be a fourth scheduled job.
6. **The worker connects as a dedicated role**, `flightbuddy_worker` (migration
   `20260915021807_worker_role`): table- and column-level grants only, no DELETE, no access to
   names, emails or invite contacts, owner of the `pgboss` schema, `BYPASSRLS`, 10 connections,
   60 s statement timeout. It connects through the Supabase **session pooler** because the direct
   host is IPv6-only and Render egresses over IPv4, and because pg-boss needs session-mode
   features (§8.6). The worker never holds the service-role key, the anon key or the `postgres`
   password.
7. **The worker keeps a 1 request/second limiter** even though the plan allows 2, leaving the
   other request per second for the API's interactive lookups.
8. **Subscriptions never expire, so reconciliation is mandatory:** the hourly job lists the
   provider's subscriptions and deletes any that no active, unarchived flight claims.
9. **Phase 2 notifies a user about their own flights only.** Group fan-out, mutes and
   unclaimed-traveller routing are Phase 3; quiet hours are Phase 4 and never apply to one's own
   flight.

## Consequences

- Overview §4 (housekeeping row and job table), §7.6, §7.7, §7.8, §10 and §11 are updated in the
  same commit as this ADR (rule 14).
- The `FlightDataProvider.subscribeAlerts` wrapper gains the `useCredits` flag and a
  `maxDeliveryRetries` parameter; `refillCredits` stays in the interface but nothing calls it.
- `provider_credit_log.source` gains no new values; `'post_refill'` is simply unused.
- The verification poll makes a webhook-driven gate change cost 2 units on top of the credit; at
  beta scale this is negligible against 5,000 units/month.
- The worker verifies the pooler's TLS chain against Supabase's published root CA, committed at
  `services/poller/certs/` (a public certificate, not a secret); verification is never disabled.
  Supabase's `function_search_path_mutable` warnings on pg-boss's own `pgboss.*` functions are
  accepted: SECURITY INVOKER, owned by the worker role, unreachable from `anon`/`authenticated`.
- Two Render services instead of five: one web service (API + webhook receiver) and one worker.
- If AeroDataBox later adds delivery signing, decision 1's token stays and the verification poll can
  be dropped by a one-line change; the ADR should be amended then.
