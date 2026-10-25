/**
 * Push tokens per device (ADR 0006, sub-step ii): the worker's side of
 * `push_tokens` and `notification_device_sends`.
 *
 * - `notification_deliveries` stays one row per (event, person) — §9's guard.
 * - Each of that person's **active** devices (`push_tokens.invalidated_at is
 *   null`, at most `MAX_DEVICES_PER_RECIPIENT`) gets its own message, and its
 *   own `notification_device_sends` row once there is an outcome to record.
 * - The parent's status is **derived from its device rows** in SQL, by the
 *   rule in `deliveryStatus.ts` ("Parent status"), in the same statement that
 *   writes it, so a receipt landing between our read and our write cannot be
 *   lost.
 * - `DeviceNotRegistered` invalidates **that device only**, and only if it has
 *   not registered again since the send (`invalidateDeadDevice`). The legacy
 *   `profiles.expo_push_token` column is no longer written by the worker.
 *
 * Tokens never leave this process except in the Expo request: rows, logs and
 * errors carry only `token_sha256`.
 */
import type { Pool } from '../db';
import { ENGINE_TYPES } from '../engine/types';

/** ADR 0006: a user has at most 10 active devices; the read is bounded the same. */
export const MAX_DEVICES_PER_RECIPIENT = 10;

export const DEVICE_SEND_STATUSES = [
  'pending',
  'sent',
  'delivered',
  'failed',
  'unconfirmed',
] as const;

export type DeviceSendStatus = (typeof DEVICE_SEND_STATUSES)[number];

/**
 * The CTE `c`: per delivery in `idSource` (a CTE with an `id` column), the best
 * device outcome (delivered > sent > unconfirmed > failed; `pending` rows do
 * not count), whether any device waits to be re-sent, the error to show, and
 * one representative ticket (the earliest `sent`/`delivered` device's), which
 * keeps `notification_deliveries_ticket_check` true for a `sent` parent.
 *
 * `memoryDb.childAggregate` mirrors this; keep them together.
 */
function deviceOutcomesCte(idSource: string): string {
  return `c as (
  select s.delivery_id,
         case when bool_or(s.status = 'delivered') then 'delivered'
              when bool_or(s.status = 'sent') then 'sent'
              when bool_or(s.status = 'unconfirmed') then 'unconfirmed'
              when bool_or(s.status = 'failed') then 'failed'
         end as status,
         bool_or(s.status = 'pending') as has_pending,
         (array_agg(s.error order by s.status = 'unconfirmed' desc, s.token_sha256)
            filter (where s.status in ('failed', 'unconfirmed') and s.error is not null))[1] as error,
         (array_agg(s.expo_ticket_id order by s.sent_at, s.token_sha256)
            filter (where s.status in ('sent', 'delivered')))[1] as ticket_id,
         (array_agg(s.token_sha256 order by s.sent_at, s.token_sha256)
            filter (where s.status in ('sent', 'delivered')))[1] as token_sha256
    from public.notification_device_sends s
   where s.delivery_id in (select id from ${idSource})
   group by s.delivery_id)`;
}

/**
 * The parent's new status and error, from `c` and a fallback the caller knows
 * (what this attempt concluded with no device outcome to go on: `skipped`,
 * `expired`, an exhausted retry, …). `retry` wins; then the device aggregate;
 * then the fallback. A `failed` parent keeps the caller's own failure code when
 * it has one (e.g. retries ran out), else the first device's.
 */
function parentOutcome(retry: string, fallbackStatus: string, fallbackError: string): string {
  return `case when ${retry} then 'pending'
              when c.status is not null then c.status
              else ${fallbackStatus} end as status,
         case when ${retry} then null
              when c.status in ('sent', 'delivered') then null
              when c.status = 'failed'
                then coalesce(case when ${fallbackStatus} = 'failed' then ${fallbackError} end, c.error)
              when c.status = 'unconfirmed' then c.error
              else ${fallbackError} end as error,
         c.ticket_id,
         c.token_sha256`;
}

/**
 * The active devices of each claimed delivery's recipient that still need this
 * message: no device row yet, or a `pending` one (re-send after
 * MessageRateExceeded). A device with any other row — a ticket, a definitive
 * error — is never sent to again for this delivery, so a re-claim after a crash
 * or a retry of one device does not double-send to the others.
 *
 * Read at send time, so a device registered after the event is included.
 * `$2` = `MAX_DEVICES_PER_RECIPIENT`, newest first. `read_at` is the database
 * time of this read, before any request leaves: it becomes the device rows'
 * `sent_at`, so the DeviceNotRegistered guard (`last_registered_at <= sent_at`)
 * can only ever keep a device that registered while the send was in flight.
 * Worker grants: `select` on `push_tokens` (which includes `token`) and on
 * `notification_device_sends`.
 */
export const LOAD_SENDABLE_DEVICES_SQL = `select d.id as delivery_id,
       t.token,
       t.token_sha256,
       now() as read_at
  from public.notification_deliveries d
  cross join lateral (
         select pt.id, pt.token, pt.token_sha256, pt.last_registered_at
           from public.push_tokens pt
          where pt.user_id = d.user_id
            and pt.invalidated_at is null
          order by pt.last_registered_at desc, pt.id desc
          limit $2) t
 where d.id = any($1::uuid[])
   and d.status = 'sending'
   and not exists (select 1
                     from public.notification_device_sends s
                    where s.delivery_id = d.id
                      and s.token_sha256 = t.token_sha256
                      and s.status <> 'pending')
 order by d.id, t.last_registered_at desc, t.id desc`;

/**
 * Record one outcome per device. A new row is inserted; an existing row is
 * overwritten **only while it is `pending`** (the re-send it was waiting for),
 * so a slow duplicate sender can never replace a ticket already recorded.
 * `$6` = `sent_at`: the database time the devices were read
 * (`LOAD_SENDABLE_DEVICES_SQL.read_at`), the clock `push_tokens.last_registered_at`
 * uses. Returns the rows actually written (the DeviceNotRegistered check needs
 * their `sent_at`).
 */
export const INSERT_DEVICE_SENDS_SQL = `insert into public.notification_device_sends as s
       (delivery_id, token_sha256, status, expo_ticket_id, error, sent_at)
select u.delivery_id, u.token_sha256, u.status, u.ticket_id, u.error, $6::timestamptz
  from unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[])
       as u(delivery_id, token_sha256, status, ticket_id, error)
on conflict (delivery_id, token_sha256) do update
   set status = excluded.status,
       expo_ticket_id = excluded.expo_ticket_id,
       error = excluded.error,
       sent_at = excluded.sent_at,
       receipt_checked_at = null
 where s.status = 'pending'
returning s.delivery_id, s.token_sha256, s.status, s.sent_at`;

/**
 * Close `pending` device rows (waiting for a re-send after MessageRateExceeded)
 * that will never be re-sent, so they cannot hold their delivery in `pending`:
 *
 * - every one of a delivery this attempt closes without sending (`$2`: expired,
 *   unbuildable);
 * - any whose device is no longer active (signed out, moved, retired over the
 *   cap, invalidated).
 *
 * They become `failed` with the code they were waiting on (`$4` if none), so a
 * delivery that once reached a device ends `failed` with that code, never
 * `skipped` / `NoPushToken`. `$1`/`$2` = the claimed deliveries and the
 * `attempts` of this claim: only rows still `sending` **under this claim**, so a
 * worker whose lease lapsed cannot close rows under another worker's newer claim.
 * `$3` = the deliveries closing unsent.
 */
export const CLOSE_STALE_PENDING_SENDS_SQL = `update public.notification_device_sends s
   set status = 'failed',
       error = coalesce(s.error, $4)
  from unnest($1::uuid[], $2::int[]) as u(id, attempts)
  join public.notification_deliveries d on d.id = u.id
 where s.delivery_id = d.id
   and d.status = 'sending'
   and d.attempts = u.attempts
   and s.status = 'pending'
   and (d.id = any($3::uuid[])
        or not exists (select 1
                         from public.push_tokens t
                        where t.user_id = d.user_id
                          and t.token_sha256 = s.token_sha256
                          and t.invalidated_at is null))`;

/**
 * Extend the lease of the deliveries this batch still holds (`$1` ids, `$2`
 * the `attempts` of our claim, `$3` lease ms), before each further Expo
 * request, so a batch of many devices cannot outlast its lease. Returns the ids
 * still ours; a delivery missing from it was re-claimed and is not sent to again
 * by this batch.
 */
export const RENEW_SEND_LEASE_SQL = `update public.notification_deliveries d
   set claimed_until = now() + ($3::double precision * interval '1 millisecond')
  from unnest($1::uuid[], $2::int[]) as u(id, attempts)
 where d.id = u.id
   and d.status = 'sending'
   and d.attempts = u.attempts
returning d.id`;

/**
 * Write the outcome of every claimed delivery, derived from its device rows.
 *
 * `$3` retry: a device of this delivery is still to be re-sent (a retryable
 * failure with attempts left). `$4`/`$5`: the fallback status and error when no
 * device row decides. `$6`: when to try again if it ends `pending`. `$7` =
 * `MAX_SEND_ATTEMPTS`: a device the receipt job set back to `pending` while this
 * send was in flight also keeps the delivery `pending`.
 *
 * Only rows still `sending` **under this claim** (`attempts` unchanged) are
 * touched, so a late answer after the lease passed and another worker
 * re-claimed the row cannot overwrite that worker's result.
 */
export const FINALIZE_SENDS_SQL = `with u as (
  select *
    from unnest($1::uuid[], $2::int[], $3::boolean[], $4::text[], $5::text[], $6::timestamptz[])
         as u(id, attempts, retry, status, error, not_before)),
${deviceOutcomesCte('u')},
n as (
  select u.id,
         u.attempts,
         u.not_before,
         ${parentOutcome(
           '(u.retry or (coalesce(c.has_pending, false) and u.attempts < $7))',
           'u.status',
           'u.error',
         )}
    from u
    left join c on c.delivery_id = u.id)
update public.notification_deliveries d
   set status = n.status,
       error = n.error,
       not_before = case when n.status = 'pending' then n.not_before else null end,
       expo_ticket_id = n.ticket_id,
       push_token_sha256 = n.token_sha256,
       sent_at = case when n.status in ('sent', 'delivered') then coalesce(d.sent_at, now())
                      else d.sent_at end,
       claimed_until = null
  from n
 where d.id = n.id
   and d.status = 'sending'
   and d.attempts = n.attempts`;

/**
 * Close `sending` rows whose sender died (lease passed) with no attempts left.
 * A device that already got a ticket still counts (the delivery is `sent`);
 * otherwise the outcome is unknown: Expo may have taken the last attempt.
 * `$1` = `MAX_SEND_ATTEMPTS`, `$2` = `SendOutcomeUnknown`.
 */
export const CLOSE_EXHAUSTED_SENDS_SQL = `with x as (
  select id
    from public.notification_deliveries
   where status = 'sending'
     and claimed_until < now()
     and attempts >= $1),
${deviceOutcomesCte('x')},
n as (
  select x.id,
         ${parentOutcome('false', `'failed'`, '$2::text')}
    from x
    left join c on c.delivery_id = x.id)
update public.notification_deliveries d
   set status = n.status,
       error = n.error,
       expo_ticket_id = n.ticket_id,
       push_token_sha256 = n.token_sha256,
       sent_at = case when n.status in ('sent', 'delivered') then coalesce(d.sent_at, now())
                      else d.sent_at end,
       claimed_until = null
  from n
 where d.id = n.id
   and d.status = 'sending'
returning d.id, d.status`;

/**
 * After the receipt job updated device rows: re-derive each `sent` delivery
 * (it may now be `delivered`, `unconfirmed` or `failed`), or put it back to
 * `pending` (`$2` = when) because a device must be re-sent. Deliveries in any
 * other state are left alone: a `pending`/`sending` one is being retried and
 * its own finalize derives it; a `delivered` one cannot get better.
 */
export const SETTLE_DELIVERIES_SQL = `with u as (
  select *
    from unnest($1::uuid[], $2::timestamptz[]) as u(id, requeue_at)),
${deviceOutcomesCte('u')},
n as (
  select u.id,
         u.requeue_at,
         ${parentOutcome('(u.requeue_at is not null)', `'failed'`, 'null::text')}
    from u
    left join c on c.delivery_id = u.id)
update public.notification_deliveries d
   set status = n.status,
       error = n.error,
       not_before = case when n.status = 'pending' then n.requeue_at else d.not_before end,
       expo_ticket_id = n.ticket_id,
       push_token_sha256 = n.token_sha256,
       receipt_checked_at = now()
  from n
 where d.id = n.id
   and d.status = 'sent'`;

/**
 * DeviceNotRegistered: invalidate **only that device**, and only if it has not
 * registered again since the message was sent (`$3` = the send time; a
 * re-registration bumps `last_registered_at`, and a new token is a different
 * row). Logs one `device_not_registered` trace event when it did.
 *
 * Grants: `update (invalidated_at, invalidated_reason)` and `select` on
 * `push_tokens`, `insert` on `push_token_events` (no `select` there, so the
 * count comes from the update's own rows).
 *
 * Locks (ADR 0006 lock order): one `push_tokens` row, then the trace insert's
 * foreign-key check takes `key share` on the owner's profile, which does not
 * conflict with the `for no key update` the two functions hold, so this can
 * neither wait on them while holding the row nor join a cycle.
 *
 * `$3` is read back from the database as an ISO string with millisecond
 * precision; truncating microseconds only ever makes the guard stricter (a
 * registration within the same millisecond before the send is kept).
 */
export const INVALIDATE_DEVICE_SQL = `with invalidated as (
  update public.push_tokens
     set invalidated_at = now(),
         invalidated_reason = 'device_not_registered'
   where user_id = $1
     and token_sha256 = $2
     and invalidated_at is null
     and last_registered_at <= $3::timestamptz
  returning user_id, token_sha256),
traced as (
  insert into public.push_token_events (user_id, token_sha256, event)
  select user_id, token_sha256, 'device_not_registered'
    from invalidated)
select count(*)::int as invalidated
  from invalidated`;

/** Invalidate a dead device. Returns whether it did (false: re-registered or already gone). */
export async function invalidateDeadDevice(
  pool: Pool,
  userId: string,
  tokenSha256: string,
  sentAt: string,
): Promise<boolean> {
  const result = await pool.query<{ invalidated: number }>({
    text: INVALIDATE_DEVICE_SQL,
    values: [userId, tokenSha256, sentAt],
    types: ENGINE_TYPES,
  });
  return (result.rows[0]?.invalidated ?? 0) > 0;
}

export interface DeviceSendRecord {
  deliveryId: string;
  tokenSha256: string;
  status: Exclude<DeviceSendStatus, 'pending' | 'delivered'>;
  ticketId: string | null;
  error: string | null;
}

export interface WrittenDeviceSend {
  delivery_id: string;
  token_sha256: string;
  status: string;
  sent_at: string;
}

/**
 * Write device outcomes (`INSERT_DEVICE_SENDS_SQL`) with `sentAt` = when the
 * devices were read; returns the rows written.
 */
export async function recordDeviceSends(
  pool: Pool,
  records: readonly DeviceSendRecord[],
  sentAt: string,
): Promise<WrittenDeviceSend[]> {
  if (records.length === 0) return [];
  const result = await pool.query<WrittenDeviceSend>({
    text: INSERT_DEVICE_SENDS_SQL,
    values: [
      records.map((r) => r.deliveryId),
      records.map((r) => r.tokenSha256),
      records.map((r) => r.status),
      records.map((r) => r.ticketId),
      records.map((r) => r.error),
      sentAt,
    ],
    types: ENGINE_TYPES,
  });
  return result.rows;
}
