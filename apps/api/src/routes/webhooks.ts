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
 * 4. **Schema**: the `FlightNotificationContract` envelope
 *    (`docs/api-samples/webhook-notification-schema.md`) as real deliveries
 *    send it. Unknown top-level keys are **stripped, not rejected** (see
 *    `webhookEnvelopeSchema`), and item fields beyond the few needed to trust
 *    the shape are left to the worker's strict parse. Invalid → 400, generic
 *    message.
 * 5. **One `webhook_inbox` row** via the service-role client, then `200
 *    {"status":"accepted"}` at once — the provider requires a 2XX within 10 s
 *    and bills per retry. Insert failure → 503, so it retries once (ADR 0003).
 *    The worker drains the inbox; nothing here parses the flights further.
 *
 * Rule 7: this file never touches `flights`.
 *
 * The payload is data. It is never echoed, interpolated into SQL (supabase-js
 * sends it as a JSON body; PostgREST parameterizes), a shell or a prompt. Log
 * lines from this file carry fixed messages plus counts or codes; `logging.ts`
 * removes the URL from Fastify's own request lines.
 *
 * **No payload *value* is ever logged.** A rejected body logs the failing field
 * *paths* and zod's codes, and nothing else (`describeRejection`) — except that
 * an `invalid_type` issue also names the JSON *type* found at its path, from a
 * fixed vocabulary of seven words (`string`, `number`, `boolean`, `null`,
 * `array`, `object`, `undefined`; `jsonTypeOf`). That word is computed by us,
 * never copied from the body, so it is a type name and never a value; the same
 * vocabulary names an optional envelope field that an accepted delivery had
 * dropped for the wrong type. That is the
 * difference between "the envelope has an unexpected key" and printing what the
 * key contained, and it matters here for four reasons: `subscription.subscriber`
 * echoes our delivery URL, which ends in `WEBHOOK_TOKEN`; zod's own `message`
 * quotes the received value, so it is never logged; `notificationSummary` and
 * `notificationRemark` are provider free text, which must never reach a log an
 * agent may read (§12: payloads are data, never instructions); and a value could
 * carry newlines or JSON and forge log entries. Keys are therefore sanitised to
 * identifier shape, and both the number of issues and the keys named by any one
 * of them are capped, so no body can flood the log; this runs only *after* the token
 * guard, so nothing an anonymous caller sends can reach it. The 400 body stays
 * generic: the diagnosis goes to our logs, never back to the caller.
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
 *
 * `status` must be **present** but may be any JSON type. The spec says string;
 * every real delivery so far failed that check (`invalid_type at
 * flights.0.status`, 2026-09-16/17), and its real type is not yet captured. The
 * receiver's job is authenticate, bound and store: typing `status` is the
 * worker's, which stays strict, so a delivery it cannot read waits in
 * `webhook_inbox` for inspection instead of being answered 400 and lost — a
 * rejection is charged a credit and triggers the paid retry as well.
 */
export const webhookFlightItemSchema = z.looseObject({
  number: z.string().min(1),
  status: z.unknown().nonoptional(),
  departure: z.looseObject({}),
  arrival: z.looseObject({}),
  lastUpdatedUtc: z.string().min(1),
});

/** Bounds for the three undocumented envelope fields real deliveries carry. */
export const WEBHOOK_DELIVERY_ID_MAX = 128;
export const WEBHOOK_TIMESTAMP_MAX = 64;
export const WEBHOOK_DELIVERY_ATTEMPT_MAX = 1_000;

/**
 * The envelope fields real deliveries carry that the spec does not document.
 * Optional and bounded. A value of the wrong type is **dropped** (`.catch`), not
 * rejected: none of them authenticates anything, and rejecting a delivery over
 * metadata would lose the alert and cost a second credit (the dropped field is
 * named, by type only, on the accept log line).
 */
export const ENVELOPE_META_FIELDS = ['id', 'timestampUtc', 'deliveryAttempt'] as const;

/**
 * `FlightNotificationContract`, as real deliveries send it.
 *
 * **`z.object`, which strips unknown keys, not `strictObject`.** This used to be
 * strict because the spec declares `additionalProperties: false` here, on the
 * theory that an extra key meant the sender was not AeroDataBox. Both halves of
 * that were wrong: every real delivery carries three undocumented top-level keys
 * (`id`, `timestampUtc`, `deliveryAttempt`), so strictness rejected every real
 * alert (~34 POSTs across two flights, each billed, each retried and billed
 * again); and a key's presence never authenticated anything — the constant-time
 * token guard in `onRequest` does, before this schema runs. Stripping keeps the
 * storage guarantee strictness was also giving: `parsed.data` holds only the
 * keys modelled here, and the handler stores `parsed.data`, never
 * `request.body`, so an unmodelled top-level key cannot reach `webhook_inbox`.
 *
 * `id` is kept (bounded) because it is the natural delivery idempotency key.
 *
 * `subscription.id` is checked as a GUID (any 8-4-4-4-12 hex), which is exactly
 * what the Postgres `uuid` column accepts. zod's stricter `uuid()` also demands
 * RFC version/variant bits; rejecting a real delivery over those would lose an
 * alert for no security gain.
 */
export const webhookEnvelopeSchema = z.object({
  id: z.string().min(1).max(WEBHOOK_DELIVERY_ID_MAX).optional().catch(undefined),
  timestampUtc: z.string().min(1).max(WEBHOOK_TIMESTAMP_MAX).optional().catch(undefined),
  deliveryAttempt: z
    .number()
    .int()
    .min(0)
    .max(WEBHOOK_DELIVERY_ATTEMPT_MAX)
    .optional()
    .catch(undefined),
  flights: z.array(webhookFlightItemSchema).max(WEBHOOK_MAX_FLIGHTS),
  subscription: z.looseObject({ id: z.guid() }),
  balance: z.looseObject({}).nullish(),
});

export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;

// ------------------------------------------------ rejection diagnostics ---

/** Caps, so one rejected body cannot flood the log. */
export const MAX_LOGGED_ISSUES = 8;
export const MAX_LOGGED_KEYS = 10;

/**
 * A key printable verbatim: identifier-shaped and short. Anything else becomes
 * `[key]`, so a value cannot carry a newline or a JSON fragment into a log line.
 */
const SAFE_KEY = /^[A-Za-z_$][A-Za-z0-9_$-]{0,39}$/;

export function safeKey(key: string): string {
  return SAFE_KEY.test(key) ? key : '[key]';
}

/** `flights.0.departure`, with every non-numeric segment sanitised. */
export function issuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)';
  return path
    .map((segment) => (typeof segment === 'number' ? String(segment) : safeKey(String(segment))))
    .join('.');
}

/**
 * The only words `jsonTypeOf` can return. A fixed vocabulary, so what reaches
 * a log line is always one of these and never anything from the body.
 */
export const JSON_TYPE_NAMES = [
  'string',
  'number',
  'boolean',
  'null',
  'array',
  'object',
  'undefined',
] as const;

export type JsonTypeName = (typeof JSON_TYPE_NAMES)[number];

/** The JSON type of a value, as one word of `JSON_TYPE_NAMES`. Never the value. */
export function jsonTypeOf(value: unknown): JsonTypeName {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
    case 'bigint':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'undefined':
      return 'undefined';
    default:
      // Objects; nothing else comes out of JSON.parse.
      return 'object';
  }
}

/**
 * The value at `path` inside `input`, following **own** properties only (so a
 * path can never reach `__proto__` or anything inherited) and array indexes
 * only on arrays. Anything that does not resolve is `undefined`.
 */
function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let current = input;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (typeof segment !== 'number' || !Number.isInteger(segment)) return undefined;
      if (segment < 0 || segment >= current.length) return undefined;
      current = current[segment] as unknown;
    } else if (typeof current === 'object' && current !== null) {
      if (typeof segment === 'symbol') return undefined;
      const key = String(segment);
      if (!Object.hasOwn(current, key)) return undefined;
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

/** What a rejected body may contribute to a log line: codes and paths, no values. */
export interface RejectionIssue {
  readonly code: string;
  readonly path?: readonly PropertyKey[] | undefined;
  /** `unrecognized_keys` carries the offending key names; they are keys, so they are sanitised too. */
  readonly keys?: unknown;
}

/**
 * One short string per issue: `invalid_type at flights.0.status (received number)`.
 *
 * zod's `message` is deliberately absent — it quotes the received value, which is
 * exactly what must not be logged here (see the module note). When the parsed
 * `input` is passed, an `invalid_type` issue also names the JSON type found at its
 * path — one word of `JSON_TYPE_NAMES`, computed here, never a value.
 */
export function describeRejection(
  issues: readonly RejectionIssue[],
  options?: { input: unknown },
): string[] {
  return issues.slice(0, MAX_LOGGED_ISSUES).map((issue) => {
    let where = `${safeKey(String(issue.code))} at ${issuePath(issue.path ?? [])}`;
    if (options !== undefined && issue.code === 'invalid_type') {
      where += ` (received ${jsonTypeOf(valueAt(options.input, issue.path ?? []))})`;
    }
    if (!Array.isArray(issue.keys) || issue.keys.length === 0) return where;
    const keys = issue.keys.slice(0, MAX_LOGGED_KEYS).map((key) => safeKey(String(key)));
    return `${where}: ${keys.join(',')}`;
  });
}

/**
 * Envelope metadata fields the body carried but the schema dropped for the wrong
 * type or size, as `id (received number)`: a field name from our own list and a
 * type name, never a value.
 */
export function droppedMetaFields(input: unknown, envelope: WebhookEnvelope): string[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return [];
  const dropped: string[] = [];
  for (const field of ENVELOPE_META_FIELDS) {
    if (!Object.hasOwn(input, field)) continue;
    const received = (input as Record<string, unknown>)[field];
    if (received !== undefined && envelope[field] === undefined) {
      dropped.push(`${field} (received ${jsonTypeOf(received)})`);
    }
  }
  return dropped;
}

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
          // Codes, field paths and JSON type names, never values, and only past the token guard
          // (see the module note). Without this a real delivery that does not
          // match the documented contract is indistinguishable from a forgery,
          // and each one costs a credit — which is how six real alerts were
          // rejected before anyone could see why.
          request.log.info(
            {
              issues: parsed.error.issues.length,
              rejected: describeRejection(parsed.error.issues, { input: request.body }),
            },
            'webhook body rejected',
          );
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
        // `envelope` is the parse result, never `request.body`: it holds only the
        // keys `webhookEnvelopeSchema` models, because `z.object` stripped the rest.
        // Items pass through whole (`looseObject`) for the worker's strict parse.
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

        const dropped = droppedMetaFields(request.body, envelope);
        request.log.info(
          dropped.length === 0
            ? { flights: envelope.flights.length }
            : { flights: envelope.flights.length, dropped },
          'webhook accepted',
        );
        return reply.code(200).send({ status: 'accepted' as const });
      },
    );
  };
}
