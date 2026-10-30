/**
 * Typed access to the app's public configuration.
 *
 * Values arrive by two routes and both are checked, in this order:
 *
 * 1. `Constants.expoConfig.extra.env` — written by `app.config.ts` from the
 *    monorepo-root `.env`. This is the reliable one: `extra` is serialised into
 *    the manifest, so it survives however Metro decided to spawn its workers.
 * 2. `process.env.EXPO_PUBLIC_*` — Babel-inlined at transform time. Present in
 *    a plain `apps/mobile/.env` setup, absent when the value only lives at the
 *    monorepo root.
 *
 * Every value here is publishable. The Supabase key is the anon/publishable
 * key and RLS is what actually guards the data (supabase/migrations/*_rls.sql);
 * the Google client IDs are compiled into the binary regardless.
 *
 * Missing required values fail loudly at start-up rather than producing a
 * client that 401s in a way nobody can read.
 */
import Constants from 'expo-constants';

type PublicEnvKey =
  | 'EXPO_PUBLIC_SUPABASE_URL'
  | 'EXPO_PUBLIC_SUPABASE_ANON_KEY'
  | 'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID'
  | 'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID'
  | 'EXPO_PUBLIC_API_URL'
  | 'EXPO_PUBLIC_MOCK_API';

const extraEnv = (Constants.expoConfig?.extra?.env ?? {}) as Partial<Record<PublicEnvKey, string>>;

/**
 * `process.env.X` is only substituted for *literal* member expressions, so this
 * map cannot be built with a dynamic key. Every entry has to be spelled out.
 */
const inlinedEnv: Partial<Record<PublicEnvKey, string | undefined>> = {
  EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
  EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
  EXPO_PUBLIC_MOCK_API: process.env.EXPO_PUBLIC_MOCK_API,
};

/** A value from either route above; an empty string counts as missing. */
function read(key: PublicEnvKey): string | undefined {
  const value = extraEnv[key] ?? inlinedEnv[key];
  return value === undefined || value === '' ? undefined : value;
}

/** `read` for a value the app cannot start without: throws, naming the fix. */
function requireEnv(key: PublicEnvKey): string {
  const value = read(key);
  if (value === undefined) {
    throw new Error(
      `Missing ${key}. Add it to the monorepo-root .env (see .env.example) and restart the ` +
        'dev server with `npx expo start --clear`.',
    );
  }
  return value;
}

/** Supabase project URL. */
export const SUPABASE_URL = requireEnv('EXPO_PUBLIC_SUPABASE_URL');

/** Supabase anon/publishable key. Safe to ship; RLS is the real boundary. */
export const SUPABASE_ANON_KEY = requireEnv('EXPO_PUBLIC_SUPABASE_ANON_KEY');

/**
 * Google OAuth *web* client ID. Counter-intuitive but correct: this is the
 * audience Supabase validates the ID token against, so it has to be the web
 * client even on iOS.
 */
export const GOOGLE_WEB_CLIENT_ID = read('EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID');

/** Google OAuth iOS client ID — the one whose reversed form is the URL scheme. */
export const GOOGLE_IOS_CLIENT_ID = read('EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID');

/**
 * Base URL of the Fastify API (ADR 0001). The localhost fallback exists for
 * development only: a release build that forgot the variable must fail at
 * boot with a named cause, not time out against localhost on every add.
 */
export const API_URL =
  read('EXPO_PUBLIC_API_URL') ??
  (__DEV__ ? 'http://localhost:3001' : requireEnv('EXPO_PUBLIC_API_URL'));

/**
 * When set, `src/lib/mock/` answers instead of the network: lookups and adds in
 * `api.ts`, and the flight, group and profile reads, so every signed-in screen
 * renders without a backend.
 */
export const MOCK_API = read('EXPO_PUBLIC_MOCK_API') === '1';
