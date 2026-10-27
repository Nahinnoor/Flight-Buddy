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
import type { Database } from '@flightbuddy/shared';

import { dbFailure } from './errors';
import { isUniqueViolation, type Client, type PostgrestErrorLike } from './supabase';

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

/** `GET /v1/me`, and what `ensureIdentity` returns. */
export interface MeResponse {
  profile: ProfileView;
  traveler: TravelerView;
}

type Tables = Database['public']['Tables'];

const PROFILE_COLUMNS = 'id, display_name, email, quiet_hours_enabled, created_at';
const TRAVELER_COLUMNS = 'id, user_id, display_name, created_by, claimed_at, created_at';

/**
 * A name to show before the user has chosen one. The auth trigger normally
 * supplies this from the OAuth profile; this is the fallback for the case
 * where the trigger did not run or the identity carried no name at all.
 */
function fallbackDisplayName(email: string | null): string {
  const local = email === null ? '' : (email.split('@')[0] ?? '').trim();
  return local === '' ? 'Traveller' : local;
}

function toProfile(row: Omit<Tables['profiles']['Row'], 'expo_push_token'>): ProfileView {
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.email ?? null,
    quietHoursEnabled: row.quiet_hours_enabled ?? true,
    createdAt: row.created_at,
  };
}

function toTraveler(
  row: Omit<Tables['travelers']['Row'], 'invite_email' | 'invite_phone'>,
): TravelerView {
  return {
    id: row.id,
    userId: row.user_id ?? null,
    displayName: row.display_name,
    createdBy: row.created_by,
    claimedAt: row.claimed_at ?? null,
    createdAt: row.created_at,
  };
}

interface QueryResult<R> {
  data: R | null;
  error: PostgrestErrorLike | null;
}

/**
 * Read the row; if it is missing, insert it; if the insert loses a race
 * (`23505`), read what the winner wrote.
 */
async function getOrCreate<R, V>(
  read: () => PromiseLike<QueryResult<R>>,
  insert: () => PromiseLike<QueryResult<R>>,
  toView: (row: R) => V,
  failed: { read: string; create: string },
): Promise<V> {
  const existing = await read();
  if (existing.error !== null) throw dbFailure(failed.read, existing.error);
  if (existing.data !== null) return toView(existing.data);

  const inserted = await insert();
  if (inserted.error === null && inserted.data !== null) return toView(inserted.data);
  if (isUniqueViolation(inserted.error)) {
    const raced = await read();
    if (raced.error === null && raced.data !== null) return toView(raced.data);
  }
  throw dbFailure(failed.create, inserted.error);
}

/**
 * The `profiles` row for `userId`, created if it is not there yet. The auth
 * trigger or a concurrent request may win the insert; then we read theirs.
 *
 * @param supabase The caller's own client. RLS permits exactly `id = auth.uid()`.
 */
function ensureProfile(
  supabase: Client,
  userId: string,
  email: string | null,
): Promise<ProfileView> {
  // Declared, not inlined, so the row type comes from the query, not the call.
  const read = () =>
    supabase.from('profiles').select(PROFILE_COLUMNS).eq('id', userId).maybeSingle();
  const insert = () =>
    supabase
      .from('profiles')
      .insert({ id: userId, display_name: fallbackDisplayName(email), email })
      .select(PROFILE_COLUMNS)
      .single();
  return getOrCreate(read, insert, toProfile, {
    read: 'Could not read your profile.',
    create: 'Could not create your profile.',
  });
}

/**
 * The caller's own `travelers` row, created if it is not there yet
 * (`travelers_self_traveler_uniq` makes a concurrent create a `23505`).
 *
 * `user_id = created_by = uid`: the user is both the person and the person who
 * added them. Claiming somebody *else's* unclaimed traveller row is a different
 * operation entirely, needs confirmation, and is Phase 3 (§12.10).
 */
export function ensureSelfTraveler(
  supabase: Client,
  userId: string,
  displayName: string,
): Promise<TravelerView> {
  const read = () =>
    supabase.from('travelers').select(TRAVELER_COLUMNS).eq('user_id', userId).maybeSingle();
  const insert = () =>
    supabase
      .from('travelers')
      .insert({ user_id: userId, created_by: userId, display_name: displayName })
      .select(TRAVELER_COLUMNS)
      .single();
  return getOrCreate(read, insert, toTraveler, {
    read: 'Could not read your traveller record.',
    create: 'Could not create your traveller record.',
  });
}

/** `ensureProfile` then `ensureSelfTraveler`, which is what both routes want. */
export async function ensureIdentity(
  supabase: Client,
  userId: string,
  email: string | null,
): Promise<MeResponse> {
  const profile = await ensureProfile(supabase, userId, email);
  const traveler = await ensureSelfTraveler(supabase, userId, profile.displayName);
  return { profile, traveler };
}
