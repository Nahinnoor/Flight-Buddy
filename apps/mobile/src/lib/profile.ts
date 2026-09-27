/**
 * The signed-in user's profile: reading it, renaming, and the quiet-hours
 * switch. User-scoped client, RLS only — no API route, no service role.
 *
 * ## Which name is "the" name
 *
 * There are two, and they are read by different people:
 *
 * - `profiles.display_name` — RLS `profiles_select_self`: **only you** can
 *   read it. It is the seed for your traveller row: `ensureSelfTraveler`
 *   (apps/api/src/identity.ts) copies it when that row is first created.
 * - `travelers.display_name` on your self-traveller (`user_id = auth.uid()`) —
 *   RLS `travelers_select_visible` lets **active co-members** read it. This is
 *   the name a group shows next to your flight (§3.6).
 *
 * So a rename writes both: the profile, so the name you see here and any
 * traveller row created later start from it; and your own traveller row, if
 * it exists yet, so the people in your groups see the change. Travellers you
 * created *for other people* (unclaimed, §3.4) are other people's names and are
 * never touched. Auth `user_metadata` is not written: a later Google sign-in
 * can overwrite it, so the profile row is the name of record.
 */
import { checkDisplayName } from './display-name';
import { MOCK_API } from './env';
import { getMockProfile, updateMockProfile } from './mock/store';
import { supabase } from './supabase';

export interface ProfileView {
  displayName: string;
  email: string | null;
  quietHoursEnabled: boolean;
  /** When the account was created: the passport's "member since". */
  createdAt: string;
}

export async function fetchProfile(userId: string): Promise<ProfileView> {
  if (MOCK_API) return getMockProfile();

  const { data, error } = await supabase
    .from('profiles')
    .select('display_name, email, quiet_hours_enabled, created_at')
    .eq('id', userId)
    .maybeSingle();

  if (error !== null) throw new Error(error.message);
  // The auth trigger creates this row at sign-up, so its absence is a fault.
  if (data === null) throw new Error('Your profile could not be found. Pull to try again.');

  return {
    displayName: data.display_name,
    email: data.email,
    quietHoursEnabled: data.quiet_hours_enabled,
    createdAt: data.created_at,
  };
}

/** A save that reached the profile but not the traveller row. */
export class PartialNameSaveError extends Error {
  constructor() {
    super(
      'Your name was saved, but the people in your groups may still see the old one. Try saving again.',
    );
    this.name = 'PartialNameSaveError';
  }
}

/**
 * Renames the user. Returns the stored value (trimmed, spaces collapsed).
 * Throws with a user-readable message on a validation or network failure, and
 * `PartialNameSaveError` when only the first of the two writes landed — a
 * retry repeats both, so it is safe.
 */
export async function updateDisplayName(userId: string, input: string): Promise<string> {
  const checked = checkDisplayName(input);
  if (!checked.ok) throw new Error(checked.reason);
  const name = checked.value;

  if (MOCK_API) {
    updateMockProfile({ displayName: name });
    return name;
  }

  // `.select` so an update RLS silently matched to zero rows is an error, not
  // a success.
  const profile = await supabase
    .from('profiles')
    .update({ display_name: name })
    .eq('id', userId)
    .select('id');
  if (profile.error !== null) throw new Error(profile.error.message);
  if ((profile.data ?? []).length !== 1) throw new Error('Your profile could not be updated.');

  // Zero rows is fine: no self-traveller yet (it is created on first add),
  // and it will be seeded from the profile written above.
  const traveler = await supabase
    .from('travelers')
    .update({ display_name: name })
    .eq('user_id', userId);
  if (traveler.error !== null) throw new PartialNameSaveError();

  return name;
}

export async function setQuietHours(userId: string, enabled: boolean): Promise<void> {
  if (MOCK_API) {
    updateMockProfile({ quietHoursEnabled: enabled });
    return;
  }

  const { data, error } = await supabase
    .from('profiles')
    .update({ quiet_hours_enabled: enabled })
    .eq('id', userId)
    .select('id');
  if (error !== null) throw new Error(error.message);
  if ((data ?? []).length !== 1) throw new Error('Your settings could not be saved.');
}
