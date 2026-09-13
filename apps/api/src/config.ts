/**
 * Environment, validated once at boot (ADR 0001, §12.5).
 *
 * Secrets live in the root `.env` locally and in Render environment variables
 * in deployment. Nothing in this file ever logs a value: a bad environment is
 * reported by *name* only, because the thing most likely to be wrong is also
 * the thing that must never reach a log line.
 *
 * The two `EXPO_PUBLIC_*` fallbacks are deliberate. `SUPABASE_URL` and the anon
 * key are not secrets — the mobile app ships with both — and the root `.env`
 * already carries them under the Expo names, so a developer only has to add the
 * service-role key to run the API.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/** Repo root: `apps/api/src/config.ts` → three levels up. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Pino levels, so `LOG_LEVEL` cannot be a string Fastify will reject at boot. */
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  HOST: z.string().min(1).default('0.0.0.0'),

  /** `https://<ref>.supabase.co`. Also the JWT issuer and JWKS host (see `auth.ts`). */
  SUPABASE_URL: z.url(),
  /** Public anon key. Used with the caller's bearer token for RLS-respecting reads. */
  SUPABASE_ANON_KEY: z.string().min(1),
  /** Bypasses RLS. The only key that may write `flights`, via `ingestFlight`. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  /**
   * Legacy HS256 signing secret. Optional, and unused while the project's JWKS
   * publishes asymmetric keys — see `auth.ts` for when the fallback engages.
   */
  SUPABASE_JWT_SECRET: z.string().min(1).optional(),

  RAPIDAPI_KEY: z.string().min(1),
  AERODATABOX_HOST: z.string().min(1).default('aerodatabox.p.rapidapi.com'),

  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** Comma-separated origins, or `*`. The mobile client is not a browser, so `*` is the default. */
  CORS_ORIGIN: z.string().min(1).default('*'),
});

export type Config = z.infer<typeof configSchema>;

/** Reads the root `.env` without clobbering anything already in the process. */
export function loadEnvFile(): void {
  loadDotenv({ path: resolve(REPO_ROOT, '.env'), quiet: true });
}

/** Thrown when the environment is unusable. Carries names, never values. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Validate `source` (defaults to `process.env`) into a `Config`.
 *
 * @throws ConfigError listing the offending variable names.
 */
export function parseConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const candidate = {
    ...source,
    SUPABASE_URL: source.SUPABASE_URL ?? source.EXPO_PUBLIC_SUPABASE_URL,
    SUPABASE_ANON_KEY: source.SUPABASE_ANON_KEY ?? source.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  };

  const result = configSchema.safeParse(candidate);
  if (!result.success) {
    // Issue messages, never `issue.input` — that would print the secret.
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid environment: ${problems}`);
  }
  return result.data;
}

/** `loadEnvFile()` then `parseConfig()`. What `server.ts` calls. */
export function loadConfig(): Config {
  loadEnvFile();
  return parseConfig();
}
