/**
 * Worker environment, validated once at boot (PROJECT_OVERVIEW §12.5, PHASE2_PLAN §5).
 *
 * Same shape and the same loader convention as `apps/api/src/config.ts`: the
 * repo-root `.env` locally, Render environment variables in deployment. The one
 * deliberate difference is the failure report. The API joins zod's messages; this
 * file reports the offending variable **names** and zod's issue *code* and nothing
 * else, because every variable here is either a database URL with a password in it
 * or an API key, and a config error is exactly the moment someone is most likely to
 * paste a log into a chat window.
 *
 * The worker connects as the restricted `flightbuddy_worker` role through the
 * Supabase **session** pooler (PHASE2_PLAN §8.7, §2 item C). It deliberately holds
 * no Supabase REST key at all — not the service-role key, not the anon key.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/** Repo root: `services/poller/src/config.ts` → three levels up. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Pino levels, so `LOG_LEVEL` cannot be a string the logger rejects at boot. */
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);

/**
 * True for a parseable `postgres://` / `postgresql://` URL.
 *
 * Kept as a predicate rather than a `z.url()` so that zod's issue carries our own
 * static message instead of anything derived from the input.
 */
function isPostgresUrl(value: string): boolean {
  try {
    return POSTGRES_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** True for a parseable `https://` URL. A predicate for the same reason as above. */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export const configSchema = z.object({
  /**
   * Session-pooler connection string for the `flightbuddy_worker` role. Contains a
   * password: never logged, never included in an error, never sent anywhere.
   */
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(isPostgresUrl, 'must be a postgres:// or postgresql:// URL'),

  /** Development RapidAPI key (§12.3). Used by `@flightbuddy/flight-provider` from wave 2. */
  RAPIDAPI_KEY: z.string().min(1),
  AERODATABOX_HOST: z.string().min(1).default('aerodatabox.p.rapidapi.com'),

  /**
   * Public receiver URL including its secret path segment, registered with
   * AeroDataBox when a subscription opens (wave 3). **Absent = webhooks off**:
   * nothing subscribes and every flight stays on the polling ladder.
   *
   * https only — the path segment is the receiver's only credential (ADR 0003
   * decision 1), so it never travels in clear. Never logged: config errors name
   * the variable only, and the logger redacts `WEBHOOK_URL` / `webhookUrl` keys.
   */
  WEBHOOK_URL: z.string().refine(isHttpsUrl, 'must be an absolute https:// URL').optional(),

  /**
   * The owner's profile id, so low-credit and failover alerts reach a phone
   * (PHASE2_PLAN §8.4). Wave 4; not a secret.
   */
  OPERATOR_USER_ID: z.uuid().optional(),

  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  /** Sleep between worker passes (§7.5). */
  POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  /** `claimDueFlights` batch size (§7.5 uses 25; §8.3 relies on it to bound bursts). */
  POLL_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
  /**
   * Backup poll cadence for a subscribed flight inside the alert window
   * (ADR 0004). The receiver runs on a Render free web service that can take
   * ~1 minute to wake, while AeroDataBox gives up after 10 s, so a delivery can
   * be lost with nothing else watching. 0 disables the backup poll.
   */
  WEBHOOK_BACKUP_POLL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .default(2 * 60 * 60 * 1000),
  /**
   * The API's health URL, pinged on an interval so a free Render web service
   * does not sleep (it spins down after 15 minutes without inbound traffic).
   * Unset = no ping. Never carries a secret: this is `/healthz`, not the
   * webhook path.
   */
  KEEPALIVE_URL: z
    .url()
    .refine((value) => new URL(value).pathname === '/healthz', {
      message: 'must end in /healthz',
    })
    .optional(),
  KEEPALIVE_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(10 * 60 * 1000),

  /**
   * Provider requests per second for the token bucket (§7.5, §7.8).
   *
   * The plan allows 2; the worker takes 1 and leaves the other for the API's
   * interactive lookups (ADR 0003 §7). Capped at 2 here so a typo cannot put the
   * account over its limit — 429s count as failed polls.
   */
  PROVIDER_RPS: z.coerce.number().positive().max(2).default(1),
});

export type Config = z.infer<typeof configSchema>;

/** Reads the root `.env` without clobbering anything already in the process. */
export function loadEnvFile(): void {
  loadDotenv({ path: resolve(REPO_ROOT, '.env'), quiet: true });
}

/** Thrown when the environment is unusable. Carries names and codes, never values. */
export class ConfigError extends Error {
  /** The offending variable names, so a caller can react without parsing prose. */
  readonly variables: readonly string[];

  constructor(variables: readonly string[], message: string) {
    super(message);
    this.name = 'ConfigError';
    this.variables = variables;
  }
}

/**
 * Validate `source` (defaults to `process.env`) into a `Config`.
 *
 * A variable set to the empty string is treated as unset: `.env.example` ships
 * `WEBHOOK_URL=` style blanks, and "present but empty" is never what anybody meant.
 *
 * @throws ConfigError naming the offending variables. No value is ever included —
 *   not zod's message, not `issue.input`, not a truncated prefix.
 */
export function parseConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const candidate: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') candidate[key] = value;
  }

  const result = configSchema.safeParse(candidate);
  if (result.success) return result.data;

  // Names and zod's issue code only. `issue.message` can quote the input for some
  // codes and `issue.input` always does, so neither is allowed near this string.
  const seen = new Map<string, string>();
  for (const issue of result.error.issues) {
    const name = issue.path.join('.') || '(root)';
    if (!seen.has(name)) seen.set(name, issue.code);
  }
  const problems = [...seen].map(([name, code]) => `${name} (${code})`).join(', ');
  throw new ConfigError([...seen.keys()], `Invalid environment: ${problems}`);
}

/** `loadEnvFile()` then `parseConfig()`. What `main.ts` calls. */
export function loadConfig(): Config {
  loadEnvFile();
  return parseConfig();
}
