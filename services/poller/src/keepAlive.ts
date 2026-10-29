/**
 * The keep-alive ping for the API's free Render web service (ADR 0004).
 *
 * Its own module so `keepAlive.test.ts` never imports `main.ts`, which starts a
 * worker on import: with a `.env` present that is a real connection to its
 * database, and possibly a poll pass, from inside `npm test`.
 */
import { errorName } from './errors';
import type { Logger } from './logger';

/**
 * Keeps a Render **free** web service awake: it spins down after 15 minutes
 * without inbound traffic and takes about a minute to wake, which is longer than
 * AeroDataBox's 10-second delivery timeout (ADR 0004).
 *
 * Only ever requests `/healthz`, which needs no auth and touches no dependency,
 * so this costs nothing and carries no secret. Failures are warnings: the worker
 * must not exit because the API is briefly down. Started by `main()` only when
 * `KEEPALIVE_URL` is set; stops on shutdown.
 */
export function startKeepAlive(options: {
  url: string;
  intervalMs: number;
  logger: Logger;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}): () => void {
  const doFetch = options.fetchImpl ?? fetch;
  /** One GET to `/healthz`: once at start, then every `intervalMs`. */
  const ping = async (): Promise<void> => {
    try {
      const response = await doFetch(options.url, {
        method: 'GET',
        signal: AbortSignal.timeout(10_000),
      });
      options.logger.debug({ status: response.status }, 'keep-alive ping');
    } catch (error: unknown) {
      // The URL is not secret, but keep logs uniform: class name only.
      options.logger.warn({ errorName: errorName(error, 'unknown') }, 'keep-alive ping failed');
    }
  };

  void ping();
  const timer = setInterval(() => void ping(), options.intervalMs);
  const stop = (): void => clearInterval(timer);
  options.signal.addEventListener('abort', stop, { once: true });
  return stop;
}

/**
 * Process startup, run on import: config, logger, database ping, provider and
 * credit state, pg-boss with every job's real body, then the loop until a signal.
 * Any throw before the loop exits non-zero (see the catch below).
 */
