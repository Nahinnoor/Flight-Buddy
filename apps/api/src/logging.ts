/**
 * The request serializer every Fastify log line uses.
 *
 * Fastify's default `req` serializer logs `request.url` verbatim on the
 * "incoming request" line of *every* request, matched or not. For the webhook
 * receiver that URL carries the secret token (ADR 0003), and the line is
 * written even when the route is not registered (no `WEBHOOK_TOKEN` on this
 * deployment) or the provider was given a slightly wrong URL (a trailing slash,
 * a doubled slash). So the redaction lives here, globally, rather than on the
 * route: any URL that mentions "webhook" — raw or percent-decoded — is replaced
 * whole, query string included.
 *
 * Headers are never serialized (the default does not either, apart from
 * `accept-version`, which is dropped here as unused).
 */
import type { FastifyRequest } from 'fastify';

export const REDACTED_WEBHOOK_URL = '[redacted webhook path]';

const WEBHOOK_MENTION = /webhook/i;

function decoded(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    // A malformed escape cannot be decoded; test the raw string only.
    return url;
  }
}

/** The URL as it may appear in a log line. */
export function redactUrl(url: string): string {
  return WEBHOOK_MENTION.test(url) || WEBHOOK_MENTION.test(decoded(url))
    ? REDACTED_WEBHOOK_URL
    : url;
}

export function serializeRequest(request: FastifyRequest): {
  method: string;
  url: string;
  host: string;
  remoteAddress: string;
  remotePort: number | undefined;
} {
  return {
    method: request.method,
    url: redactUrl(request.url),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}
