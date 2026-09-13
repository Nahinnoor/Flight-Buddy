/**
 * "Make sure this user exists as a person in the domain."
 *
 * Two rows stand behind every other write: a `profiles` row (identity) and a
 * self-`travelers` row (the person who takes flights, §6.2). `GET /v1/me` and
 * `POST /v1/flights` both call the ensure functions below, so a first-time user
 * can add a flight without having opened any other screen first.
 *
 * ## Why an insert that may fail is the right shape
 *
 * Both rows have a uniqueness rule the database enforces — `profiles.id` is the
 * primary key, `travelers` has a partial unique index on `user_id` — so the
 * honest idempotent form is *try to insert, and treat `23505` as "somebody
 * already did"*. Reading first and inserting second is a check-then-act race:
 * two concurrent first requests (the app fires `/v1/me` and an add at once)
 * both read nothing and both insert. The read is still done first because in
 * the overwhelmingly common case the row exists and that costs one round trip
 * instead of a guaranteed failed insert.
 *
 * Everything here runs on the **user-scoped** client, so RLS is what keeps a
 * caller from creating a profile or a traveller for anyone but themselves.
 */
import { DatabaseError } from './errors';
import { isUniqueViolation, type Client } from './supabase';

/** `profiles`, camelCase. `expo_push_token` is deliberately not exposed. */
export interface ProfileView {
  id: string;
  displayName: string;
  email: string | null;
  quietHoursEnabled: boolean;
  createdAt: string;
}

/** `travelers`, camelCase. */
export interface TravelerView {
  id: string;
  userId: string | null;
  displayName: string;
  /** NULL once the creator has deleted their account (§6.2). */
  createdBy: string | null;
  claimedAt: string | null;
  createdAt: string;
}

const PROFILE_COLUMNS = 'id, display_name, email, quiet_hours_enabled, created_at';
const TRAVELER_COLUMNS = 'id, user_id, display_name, created_by, claimed_at, created_at';

/**
 * A name to show before the user has chosen one. The auth trigger normally
 * supplies this from the OAuth profile; this is the fallback for the case
 * where the trigger did not run or the identity carried no name at all.
 */
export function fallbackDisplayName(email: string | null): string {
  const local = email === null ? '' : (email.split('@')[0] ?? '').trim();
  return local === '' ? 'Traveller' : local;
}

interface Row {
  [key: string]: unknown;
}

function toProfile(row: Row): ProfileView {
  return {
    id: row.id as string,
    displayName: row.display_name as string,
    email: (row.email as string | null) ?? null,
    quietHoursEnabled: (row.quiet_hours_enabled as boolean | null) ?? true,
    createdAt: row.created_at as string,
  };
}

function toTraveler(row: Row): TravelerView {
  return {
    id: row.id as string,
    userId: (row.user_id as string | null) ?? null,
    displayName: row.display_name as string,
    createdBy: row.created_by as string | null,
    claimedAt: (row.claimed_at as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

/**
 * The `profiles` row for `userId`, created if it is not there yet.
 *
 * @param supabase The caller's own client. RLS permits exactly `id = auth.uid()`.
 */
export async function ensureProfile(
  supabase: Client,
  userId: string,
  email: string | null,
): Promise<ProfileView> {
  const existing = await supabase
    .from('profiles')
    .select(PROFILE_COLUMNS)
    .eq('id', userId)
    .maybeSingle();
  if (existing.error !== null) {
    throw new DatabaseError('Could not read your profile.', { detail: existing.error.message });
  }
  if (existing.data !== null) return toProfile(existing.data as Row);

  const inserted = await supabase
    .from('profiles')
    .insert({ id: userId, display_name: fallbackDisplayName(email), email })
    .select(PROFILE_COLUMNS)
    .single();

  if (inserted.error === null && inserted.data !== null) {
    return toProfile(inserted.data as Row);
  }
  // The auth trigger or a concurrent request won. Read what they wrote.
  if (isUniqueViolation(inserted.error)) {
    const raced = await supabase
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('id', userId)
      .maybeSingle();
    if (raced.error === null && raced.data !== null) return toProfile(raced.data as Row);
  }
  throw new DatabaseError('Could not create your profile.', {
    detail: inserted.error?.message ?? 'insert returned no row',
  });
}

/**
 * The caller's own `travelers` row, created if it is not there yet.
 *
 * `user_id = created_by = uid`: the user is both the person and the person who
 * added them. Claiming somebody *else's* unclaimed traveller row is a different
 * operation entirely, needs confirmation, and is Phase 3 (§12.10).
 */
export async function ensureSelfTraveler(
  supabase: Client,
  userId: string,
  displayName: string,
): Promise<TravelerView> {
  const existing = await supabase
    .from('travelers')
    .select(TRAVELER_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();
  if (existing.error !== null) {
    throw new DatabaseError('Could not read your traveller record.', {
      detail: existing.error.message,
    });
  }
  if (existing.data !== null) return toTraveler(existing.data as Row);

  const inserted = await supabase
    .from('travelers')
    .insert({ user_id: userId, created_by: userId, display_name: displayName })
    .select(TRAVELER_COLUMNS)
    .single();

  if (inserted.error === null && inserted.data !== null) {
    return toTraveler(inserted.data as Row);
  }
  // `travelers_self_traveler_uniq` fired: a concurrent request created it.
  if (isUniqueViolation(inserted.error)) {
    const raced = await supabase
      .from('travelers')
      .select(TRAVELER_COLUMNS)
      .eq('user_id', userId)
      .maybeSingle();
    if (raced.error === null && raced.data !== null) return toTraveler(raced.data as Row);
  }
  throw new DatabaseError('Could not create your traveller record.', {
    detail: inserted.error?.message ?? 'insert returned no row',
  });
}

/** `ensureProfile` then `ensureSelfTraveler`, which is what both routes want. */
export async function ensureIdentity(
  supabase: Client,
  userId: string,
  email: string | null,
): Promise<{ profile: ProfileView; traveler: TravelerView }> {
  const profile = await ensureProfile(supabase, userId, email);
  const traveler = await ensureSelfTraveler(supabase, userId, profile.displayName);
  return { profile, traveler };
}
