/**
 * `POST /webhooks/aerodatabox/:token` — the AeroDataBox alert receiver
 * (ADR 0003, PHASE2_PLAN §5).
 *
 * There is no JWT here: the provider cannot send one, and it does not sign its
 * deliveries. The only thing between the internet and this handler is the
 * secret path segment, so every rule below is about keeping that secret and
 * doing nothing on a request that has not proved it knows it.
 *
 * Order, cheapest and most secret-preserving first. Both guards run in
 * `onRequest`, so a rejected request never has its body read:
 *
 * 1. **Token**, compared in constant time on SHA-256 digests (so neither the
 *    content nor the length of the secret leaks through timing). Mismatch → the
 *    exact 404 an unknown route gets, nothing written, one counter log line.
 * 2. **Per-IP fixed window** (60/min) → 429. It counts only requests that
 *    carried the right token: a wrong guess is already a cheap 404 with no
 *    read and no write, and counting guesses would let anyone behind the same
 *    proxy address exhaust the budget the provider's real deliveries need.
 * 3. **Body**: JSON only (`text/plain` is removed for this route → 415), at most
 *    256 KB (→ 413), parsed by Fastify's own JSON parser (prototype-poisoning
 *    protection on; a parse failure carries no payload text).
 * 4. **Schema**: the documented `FlightNotificationContract` envelope
 *    (`docs/api-samples/webhook-notification-schema.md`), strict at the top
 *    level like the provider's own contract. Invalid → 400, generic message.
 * 5. **One `webhook_inbox` row** via the service-role client, then `200
 *    {"status":"accepted"}` at once — the provider requires a 2XX within 10 s
 *    and bills per retry. Insert failure → 503, so it retries once (ADR 0003).
 *    The worker drains the inbox; nothing here parses the flights further.
 *
 * Rule 7: this file never touches `flights`.
 *
 * The payload is data. It is never logged, echoed, interpolated into SQL
 * (supabase-js sends it as a JSON body; PostgREST parameterizes), a shell or a
 * prompt. Log lines from this file carry fixed messages plus counts or codes;
 * `logging.ts` removes the URL from Fastify's own request lines.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import type { Database } from '@flightbuddy/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { notFoundBody, type ApiErrorBody } from '../errors';
import { createFixedWindowLimiter } from '../rateLimit';
import type { Client } from '../supabase';

type InboxPayload = Database['public']['Tables']['webhook_inbox']['Insert']['payload'];

export const WEBHOOK_ROUTE = '/webhooks/aerodatabox/:token';
export const WEBHOOK_BODY_LIMIT_BYTES = 256 * 1024;
/** One credit per item per delivery; a real delivery carries one or a few. */
export const WEBHOOK_MAX_FLIGHTS = 50;
export const WEBHOOK_RATE_LIMIT = { limit: 60, windowMs: 60_000, maxKeys: 10_000 } as const;
/** Replaces `subscription.subscriber`, which can echo our secret delivery URL. */
export const REDACTED_SUBSCRIBER = '[redacted: may contain the delivery URL]';

/**
 * The only `subscription` fields copied into `webhook_inbox`. Everything else the
 * provider sends is dropped, so no undocumented field can carry the delivery URL
 * (and with it WEBHOOK_TOKEN) into the database.
 */
export const STORED_SUBSCRIPTION_FIELDS = [
  'id',
  'isActive',
  'billingType',
  'createdOnUtc',
  'expiresOnUtc',
  'activateBeforeUtc',
  'subject',
] as const;

// ---------------------------------------------------------------- schema ---

/**
 * One `FlightNotificationItemContract`. Only what the receiver needs to trust
 * the shape is required here; the rest passes through untouched, because the
 * worker re-parses every item with `@flightbuddy/flight-provider`'s schema.
 */
export const webhookFlightItemSchema = z.looseObject({
  number: z.string().min(1),
  status: z.string().min(1),
  departure: z.looseObject({}),
  arrival: z.looseObject({}),
  lastUpdatedUtc: z.string().min(1),
});

/**
 * `FlightNotificationContract`. `strictObject` because the provider declares
 * `additionalProperties: false` at this level: an extra key is not them.
 *
 * `subscription.id` is checked as a GUID (any 8-4-4-4-12 hex), which is exactly
 * what the Postgres `uuid` column accepts. zod's stricter `uuid()` also demands
 * RFC version/variant bits; rejecting a real delivery over those would lose an
 * alert for no security gain.
 */
export const webhookEnvelopeSchema = z.strictObject({
  flights: z.array(webhookFlightItemSchema).max(WEBHOOK_MAX_FLIGHTS),
  subscription: z.looseObject({ id: z.guid() }),
  balance: z.looseObject({}).nullish(),
});

export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;

// ----------------------------------------------------------------- token ---

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Constant-time token check. Both sides are hashed first, so the comparison is
 * always 32 bytes against 32 bytes: no early return on a length mismatch and no
 * `RangeError` from `timingSafeEqual`.
 */
export function tokenMatches(expectedDigest: Buffer, candidate: unknown): boolean {
  const provided = typeof candidate === 'string' ? candidate : '';
  return timingSafeEqual(expectedDigest, sha256(provided));
}

// ---------------------------------------------------------------- bodies ---

const INVALID_BODY: ApiErrorBody = {
  error: { code: 'VALIDATION_ERROR', message: 'The request body is not a valid alert delivery.' },
};
const TOO_LARGE: ApiErrorBody = {
  error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' },
};
const UNSUPPORTED_MEDIA: ApiErrorBody = {
  error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Send the body as application/json.' },
};
const RATE_LIMITED: ApiErrorBody = {
  error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' },
};
const UNAVAILABLE: ApiErrorBody = {
  error: { code: 'SERVICE_UNAVAILABLE', message: 'Could not accept the delivery. Try again.' },
};
const INTERNAL: ApiErrorBody = {
  error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Try again.' },
};

// ----------------------------------------------------------------- route ---

export interface WebhookRouteOptions {
  /** `WEBHOOK_TOKEN`. Hashed once here and never kept in any other form. */
  token: string;
  serviceClient: Client;
  now: () => Date;
}

interface WebhookRoute {
  Params: { token: string };
}

/** Status of a Fastify error (body parser, content type), if it has one. */
function statusOf(error: unknown): number | undefined {
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? status : undefined;
}

/** A Fastify error code such as `FST_ERR_CTP_INVALID_JSON_BODY`: fixed text, no payload. */
function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('FST_') ? code : undefined;
}

/**
 * The receiver as an encapsulated Fastify plugin. `buildApp` registers it at
 * the root — beside `/v1`, not under it — only when `WEBHOOK_TOKEN` is set.
 */
export function createWebhookRoutes(options: WebhookRouteOptions) {
  const expectedDigest = sha256(options.token);
  const limiter = createFixedWindowLimiter({ ...WEBHOOK_RATE_LIMIT, now: options.now });
  let tokenRejections = 0;

  async function guard(
    request: FastifyRequest<WebhookRoute>,
    reply: FastifyReply<WebhookRoute>,
  ): Promise<FastifyReply<WebhookRoute> | undefined> {
    if (!tokenMatches(expectedDigest, request.params.token)) {
      tokenRejections += 1;
      // A counter and nothing else: no token, no path, no body.
      request.log.warn({ webhookTokenRejections: tokenRejections }, 'webhook token rejected');
      return reply.code(404).send(notFoundBody(request));
    }

    const decision = limiter.hit(request.ip);
    if (!decision.allowed) {
      request.log.warn({ retryAfterSeconds: decision.retryAfterSeconds }, 'webhook rate limited');
      return reply
        .code(429)
        .header('retry-after', String(decision.retryAfterSeconds))
        .send(RATE_LIMITED);
    }
    return undefined;
  }

  return async function webhookRoutes(instance: FastifyInstance): Promise<void> {
    // JSON only. Content-type parsers are encapsulated, so this affects this
    // plugin alone; Fastify's default JSON parser stays.
    instance.removeContentTypeParser('text/plain');

    // Replaces the app-wide handler for this plugin only. The app-wide one logs
    // `err` and returns Fastify's own messages; neither is acceptable for a
    // body we must never echo or log.
    instance.setErrorHandler((error, request, reply) => {
      const status = statusOf(error);
      const code = codeOf(error);
      if (status === 413) {
        request.log.info({ code }, 'webhook body rejected');
        return reply.code(413).send(TOO_LARGE);
      }
      if (status === 415) {
        request.log.info({ code }, 'webhook body rejected');
        return reply.code(415).send(UNSUPPORTED_MEDIA);
      }
      if (status !== undefined && status >= 400 && status < 500) {
        request.log.info({ code }, 'webhook body rejected');
        return reply.code(400).send(INVALID_BODY);
      }
      request.log.error(
        { errorClass: error instanceof Error ? error.name : typeof error },
        'webhook request failed',
      );
      return reply.code(500).send(INTERNAL);
    });

    instance.post<WebhookRoute>(
      WEBHOOK_ROUTE,
      { bodyLimit: WEBHOOK_BODY_LIMIT_BYTES, onRequest: guard },
      async (request, reply) => {
        const parsed = webhookEnvelopeSchema.safeParse(request.body);
        if (!parsed.success) {
          // The issue count only: issue paths can name attacker-chosen keys.
          request.log.info({ issues: parsed.error.issues.length }, 'webhook body rejected');
          return reply.code(400).send(INVALID_BODY);
        }
        const envelope = parsed.data;

        // `subscription.subscriber` echoes the delivery target back, and our
        // delivery URL ends in WEBHOOK_TOKEN: storing it would put the secret in
        // a row, a backup and every later read. `notices` is free text that could
        // quote the same URL, and the documented contract is not yet confirmed
        // against a real delivery — so the stored subscription is an **allow
        // list** of documented, token-free fields rather than a block list of one.
        // The worker matches deliveries by id and needs nothing else.
        const subscription = envelope.subscription as Record<string, unknown>;
        const storedSubscription: Record<string, unknown> = { subscriber: REDACTED_SUBSCRIBER };
        for (const key of STORED_SUBSCRIPTION_FIELDS) {
          if (subscription[key] !== undefined) storedSubscription[key] = subscription[key];
        }
        const stored = { ...envelope, subscription: storedSubscription };

        let failure: string | undefined;
        try {
          const { error } = await options.serviceClient.from('webhook_inbox').insert({
            subscription_id: envelope.subscription.id,
            // Parsed from JSON and re-validated, so it is JSON; zod's loose
            // index signature (`unknown`) is what needs the cast.
            payload: stored as unknown as InboxPayload,
          });
          if (error !== null) failure = error.code ?? 'unknown';
        } catch (error: unknown) {
          failure = error instanceof Error ? error.name : 'unknown';
        }

        if (failure !== undefined) {
          // Request id (bound on `request.log`) plus a Postgres/PostgREST code
          // or an error class name. Never the payload.
          request.log.error({ code: failure }, 'webhook inbox insert failed');
          return reply.code(503).send(UNAVAILABLE);
        }

        request.log.info({ flights: envelope.flights.length }, 'webhook accepted');
        return reply.code(200).send({ status: 'accepted' as const });
      },
    );
  };
}
