/**
 * Dynamic Expo config.
 *
 * Two jobs, both of them about environment:
 *
 * 1. Expo's dotenv loader reads `.env` from the *project* root (`apps/mobile`),
 *    but FlightBuddy keeps one `.env` at the monorepo root so the API, the
 *    poller and the app share it. This file loads that file into `process.env`
 *    without overriding anything the shell already set.
 *
 * 2. It copies the public values into `extra`. `EXPO_PUBLIC_*` inlining happens
 *    inside Metro's transform workers, which are separate processes that may be
 *    spawned before or after this config is evaluated; `extra` is serialised
 *    into the app manifest, so it is the one channel that is always there.
 *    `src/lib/env.ts` reads `extra` first and falls back to `process.env`.
 *
 * Everything forwarded here is publishable by design: the Supabase anon key
 * (RLS is the authority — see supabase/migrations/*_rls.sql) and the Google
 * OAuth client IDs, which ship inside every native binary anyway.
 */
/// <reference types="node" />
import fs from 'node:fs';
import path from 'node:path';

import type { ConfigContext, ExpoConfig } from 'expo/config';

const MONOREPO_ROOT = path.resolve(__dirname, '../..');

/** Keys forwarded from `.env` into the manifest. Public values only. */
const PUBLIC_KEYS = [
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  'EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID',
  'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID',
  'EXPO_PUBLIC_API_URL',
  'EXPO_PUBLIC_MOCK_API',
] as const;

/**
 * Minimal `KEY=value` reader. Deliberately not `dotenv`: this runs before
 * dependency resolution matters and the format we control is trivial. Handles
 * comments, blank lines, `export ` prefixes and single/double quoting.
 */
function loadRootEnv(): void {
  const file = path.join(MONOREPO_ROOT, '.env');
  let contents: string;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    return; // No root .env (CI, fresh clone). Shell env still applies.
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // The shell wins: `EXPO_PUBLIC_MOCK_API=0 npx expo start` must work.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export default ({ config }: ConfigContext): ExpoConfig => {
  loadRootEnv();

  const publicEnv: Record<string, string | undefined> = {};
  for (const key of PUBLIC_KEYS) publicEnv[key] = process.env[key];

  return {
    ...config,
    // `config` comes from app.json, where these two are always present.
    name: config.name ?? 'FlightBuddy',
    slug: config.slug ?? 'mobile',
    extra: {
      ...config.extra,
      env: publicEnv,
    },
  };
};
