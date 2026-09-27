/**
 * Who is told about a flight event (§9), as SQL the event insert runs in the same
 * statement (`repository.ts`), so an event and its deliveries commit together or
 * not at all.
 *
 * ## Phase 2: your own flights only (ADR 0003 decision 9)
 *
 * A recipient is a user whose **own** trip contains the flight:
 *
 * ```
 * flight_events.flight_id → trip_segments.flight_id → trips.traveler_id
 *   → travelers.user_id (not null) → a profile
 * ```
 *
 * `travelers.user_id` is null for an unclaimed traveller (§3.4), so the owner's
 * friend who has no account produces no recipient here at all. In Phase 3 that
 * flight notifies the group owner instead (below).
 *
 * Own-flight notifications ignore quiet hours by definition (§9: "always
 * notified, no exceptions"), which is why no quiet-hours column is read.
 *
 * ## Where Phase 3 slots in
 *
 * Each rule is one `select` in `RECIPIENTS_CTE`, producing
 * `(flight_event_id, user_id, recipient_reason)`. Phase 3 adds, as `union all`
 * branches inside the CTE:
 *
 * 1. `'group_member'`: active members of a group whose other active member's trip
 *    holds the flight (`group_members` → `trip_id` → `trip_segments`), minus any
 *    `notification_prefs` mute on that traveller (by the user or the owner).
 * 2. `'unclaimed_owner'`: for an unclaimed traveller's flight, the owner of each
 *    group that traveller belongs to — and nobody else (§3.4).
 *
 * The migration's `recipient_reason` check constraint widens with them, and the
 * `distinct` below must then become a `distinct on (flight_event_id, user_id)`
 * that prefers `'own_flight'` when one user qualifies twice, because only own-flight deliveries skip quiet hours. **Quiet hours are
 * a send-time filter, not a fan-out one** (a delivery row is still written, then
 * held or dropped in `push/pushSend.ts` by its reason and the flight's 24–48 h
 * window, §9) — that keeps the row as the audit of who would have been told.
 * The worker role will need column grants on `group_members`, `groups` and
 * `notification_prefs` for them; today it has none.
 *
 * `$notify` is the list of event types allowed to notify for this batch
 * (`notificationPolicy.ts`), so an event the policy suppressed gets no row.
 */

/**
 * Recipient rules over the `inserted` CTE (the new `flight_events` rows).
 * `$notifyParam` is a `text[]` of notifying event types.
 */
export function recipientsCte(notifyParam: string): string {
  return `recipients as (
  -- Phase 2 rule: the users whose own trips contain the flight.
  select distinct i.id as flight_event_id, tr.user_id, 'own_flight'::text as recipient_reason
    from inserted i
    join public.trip_segments s on s.flight_id = i.flight_id
    join public.trips t on t.id = s.trip_id
    join public.travelers tr on tr.id = t.traveler_id
   where tr.user_id is not null
     and i.event_type = any(${notifyParam}::text[])
  -- Phase 3: union all the group_member and unclaimed_owner rules here.
)`;
}
