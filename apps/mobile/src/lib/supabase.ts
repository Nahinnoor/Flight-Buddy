/**
 * The Supabase client for the app, plus the storage adapter its session lives
 * in.
 *
 * Mobile reads `trips → trip_segments → flights` straight from Postgres under
 * RLS with this client (ADR 0001); it only calls the Fastify API for lookup and
 * add. So this client is on the hot path for every screen, and it is created
 * exactly once, at module scope.
 */
import { AppState, type AppStateStatus } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { createClient, type SupportedStorage } from '@supabase/supabase-js';
import type { Database } from '@flightbuddy/shared';

import { SUPABASE_ANON_KEY, SUPABASE_URL } from './env';

/**
 * iOS keychain items have historically been rejected above roughly 2 KB, and a
 * Supabase session carrying a fat `user_metadata` blob clears that easily. The
 * SDK does not enforce a limit, it just surfaces the native error — by which
 * point the user is signed out with no explanation.
 *
 * So values are split. A chunked value is stored as a manifest at `key`
 * (`__chunks__:<n>`) plus `key.0 … key.n-1`. Small values are stored inline, so
 * the common case costs one keychain round-trip, and a value written by an
 * older build (inline, unprefixed) still reads back correctly.
 */
const CHUNK_SIZE = 1536;
const CHUNK_MANIFEST_PREFIX = '__chunks__:';

/**
 * Keychain keys accept only alphanumerics, `.`, `-` and `_`. Supabase's default
 * storage key (`sb-<ref>-auth-token`) is already legal, but `userStorage` and
 * future keys may not be, so everything is normalised.
 */
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

function chunkKey(key: string, index: number): string {
  return `${safeKey(key)}.${index}`;
}

async function getItem(key: string): Promise<string | null> {
  const head = await SecureStore.getItemAsync(safeKey(key));
  if (head === null) return null;
  if (!head.startsWith(CHUNK_MANIFEST_PREFIX)) return head;

  const count = Number.parseInt(head.slice(CHUNK_MANIFEST_PREFIX.length), 10);
  if (!Number.isInteger(count) || count <= 0) return null;

  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const part = await SecureStore.getItemAsync(chunkKey(key, i));
    // A torn write (app killed mid-save) must read as "no session", not as a
    // truncated JSON blob that throws somewhere deep inside gotrue-js.
    if (part === null) return null;
    parts.push(part);
  }
  return parts.join('');
}

/**
 * Deletes chunks from `from` upwards until one is missing. Keychain has no
 * prefix listing, so the terminator is the only way to know where to stop.
 */
async function deleteChunksFrom(key: string, from: number): Promise<void> {
  for (let i = from; ; i += 1) {
    const existing = await SecureStore.getItemAsync(chunkKey(key, i));
    if (existing === null) return;
    await SecureStore.deleteItemAsync(chunkKey(key, i));
  }
}

async function setItem(key: string, value: string): Promise<void> {
  if (value.length <= CHUNK_SIZE) {
    await SecureStore.setItemAsync(safeKey(key), value);
    // The previous write may have been chunked; its tail would otherwise leak.
    await deleteChunksFrom(key, 0);
    return;
  }

  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += CHUNK_SIZE) {
    chunks.push(value.slice(offset, offset + CHUNK_SIZE));
  }

  // Chunks first, manifest last: a crash between the two leaves the *old*
  // manifest pointing at a consistent set, never the new count at old data.
  for (const [index, chunk] of chunks.entries()) {
    await SecureStore.setItemAsync(chunkKey(key, index), chunk);
  }
  await SecureStore.setItemAsync(safeKey(key), `${CHUNK_MANIFEST_PREFIX}${chunks.length}`);
  await deleteChunksFrom(key, chunks.length);
}

async function removeItem(key: string): Promise<void> {
  await SecureStore.deleteItemAsync(safeKey(key));
  await deleteChunksFrom(key, 0);
}

/** `expo-secure-store` shaped as the storage gotrue-js expects. */
export const secureStoreAdapter: SupportedStorage = { getItem, setItem, removeItem };

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: secureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    /**
     * PKCE, set explicitly because the auth-js default is `'implicit'` and the
     * default is invisible. This is deliberate — do not remove it.
     *
     * It only matters for the flows that leave the app and come back through
     * an email link: sign-up confirmation, password reset, resend. Under
     * implicit flow those links deliver the access and refresh tokens in the
     * URL fragment, so the credential itself travels through a link that any
     * app registered for the scheme could receive, and nothing ties it to the
     * device that asked for it. Under PKCE the link carries a short-lived,
     * single-use `code`; exchanging it needs the verifier this client wrote to
     * the keychain when the flow started (`exchangeCodeForSession`, handled in
     * `src/app/(auth)/auth/callback.tsx`). A code on its own is worthless.
     *
     * Apple and Google are untouched by this: they go through
     * `signInWithIdToken`, which never consults `flowType` (no redirect, no
     * verifier). Stored-session restore is untouched too — the session lives
     * under the same storage key either way.
     */
    flowType: 'pkce',
    /**
     * Off on native. This is browser behaviour: it makes gotrue-js read
     * `window.location` at start-up, which does not exist under Hermes. The
     * incoming link is handled explicitly by the auth callback route instead,
     * which is also where it can be validated before anything is exchanged.
     */
    detectSessionInUrl: false,
  },
});

/**
 * Auto-refresh must not run while the app is backgrounded: iOS suspends timers,
 * and a refresh that fires as the process is frozen can burn the refresh token
 * without storing the replacement, signing the user out on next launch.
 *
 * Called once from the root layout. Returns an unsubscribe for symmetry; in
 * practice the app owns this for its whole lifetime.
 */
export function startSupabaseAutoRefresh(): () => void {
  const handle = (state: AppStateStatus) => {
    if (state === 'active') {
      void supabase.auth.startAutoRefresh();
    } else {
      void supabase.auth.stopAutoRefresh();
    }
  };

  handle(AppState.currentState);
  const subscription = AppState.addEventListener('change', handle);

  return () => {
    subscription.remove();
    void supabase.auth.stopAutoRefresh();
  };
}
