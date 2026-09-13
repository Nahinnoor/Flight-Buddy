/**
 * Provider failures, as domain errors.
 *
 * The API maps these onto the ADR 0001 error envelope: `ProviderRateLimitError`
 * → 429, everything else → 502. Nothing here carries an AeroDataBox shape, so
 * swapping providers changes this file and nothing above it (§7.1).
 */

/** Any non-success answer from the flight data provider. */
export class ProviderError extends Error {
  /** HTTP status, when the failure came back as a response. */
  readonly status: number | undefined;
  /** Response body, truncated. Useful in logs, never shown to a user. */
  readonly body: string | undefined;

  constructor(message: string, options: { status?: number; body?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.status = options.status;
    this.body = options.body;
  }
}

/**
 * HTTP 429. The PRO plan allows 1 request per second (§7.8), so this is the
 * error the poller's token bucket exists to avoid and the one the API surfaces
 * as 429 rather than 502 — the client may usefully retry.
 */
export class ProviderRateLimitError extends ProviderError {
  /** Seconds to wait, from `Retry-After`, when the provider supplied one. */
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, options: { body?: string; retryAfterSeconds?: number } = {}) {
    super(message, { status: 429, body: options.body });
    this.name = 'ProviderRateLimitError';
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** The request exceeded `timeoutMs` or the connection failed outright. */
export class ProviderTimeoutError extends ProviderError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'ProviderTimeoutError';
  }
}

/**
 * The provider answered 2xx with something this package cannot turn into a
 * `FlightCandidate` — a body that fails the loose schema, or a leg with no
 * origin IATA code (which the canonical key in §6.2 cannot do without).
 */
export class ProviderDataError extends ProviderError {
  constructor(message: string, options: { body?: string; cause?: unknown } = {}) {
    super(message, { body: options.body, cause: options.cause });
    this.name = 'ProviderDataError';
  }
}
