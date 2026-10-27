/**
 * A plain JSON object: not `null`, not an array. Used to narrow untrusted
 * request bodies in `routes/flights.ts` and `routes/webhooks.ts`.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
