/**
 * The error's class name, and nothing else: what every worker log line carries
 * for an error.
 *
 * `ProviderError` carries a truncated response body, `FlightIngestError` carries
 * Postgres detail, and a `pg` error's message can quote table contents; none of
 * that belongs in a log line, so only the name escapes.
 */
export function errorName(error: unknown, fallback = 'UnknownError'): string {
  return error instanceof Error ? error.name : fallback;
}
