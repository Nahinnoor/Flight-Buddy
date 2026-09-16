/**
 * The error envelope from ADR 0001 — `{ error: { code, message } }` — and the
 * single place that decides which failure becomes which status.
 *
 * Two rules hold everywhere below:
 *
 * 1. **Nothing internal reaches the body.** Stacks, Postgres messages, provider
 *    response bodies and anything that could carry a key are logged and then
 *    replaced with a sentence a user can read. `detail` exists so that context
 *    is still available to the log line.
 * 2. **A 5xx is always logged at error level**, with the request id, because by
 *    definition nobody downstream can see what actually happened.
 */
import {
  FlightIngestError,
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
} from '@flightbuddy/flight-provider';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/** The wire shape every non-2xx answer takes. */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** A failure with a status and a code that are safe to show the caller. */
export class ApiHttpError extends Error {
  readonly status: number;
  readonly code: string;
  /** Internal context for the log line. Never sent. */
  readonly detail: string | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { detail?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ApiHttpError';
    this.status = status;
    this.code = code;
    this.detail = options.detail;
  }
}

/** 400. The request was understood and is wrong. */
export class BadRequestError extends ApiHttpError {
  constructor(message: string, code = 'BAD_REQUEST', options: { detail?: string } = {}) {
    super(400, code, message, options);
    this.name = 'BadRequestError';
  }
}

/** 401. No token, a token that does not verify, or one that has expired. */
export class UnauthorizedError extends ApiHttpError {
  constructor(
    message = 'Sign in and try again.',
    options: { detail?: string; cause?: unknown } = {},
  ) {
    super(401, 'UNAUTHORIZED', message, options);
    this.name = 'UnauthorizedError';
  }
}

/** 404. Includes "the provider has no such flight" (ADR 0001). */
export class NotFoundError extends ApiHttpError {
  constructor(message: string, code = 'NOT_FOUND') {
    super(404, code, message);
    this.name = 'NotFoundError';
  }
}

/** 500. Postgres refused something the API cannot turn into a user's mistake. */
export class DatabaseError extends ApiHttpError {
  constructor(message: string, options: { detail?: string; cause?: unknown } = {}) {
    super(500, 'DATABASE_ERROR', message, options);
    this.name = 'DatabaseError';
  }
}

// ------------------------------------------------------------------- zod ---

/**
 * `instanceof` works here because zod resolves to exactly one physical copy:
 * the root `node_modules/zod` is a direct devDependency of the workspace root,
 * so `@flightbuddy/shared`, `@flightbuddy/flight-provider` and this package all
 * import the same module instance and a `ZodError` thrown in one is an instance
 * of the class imported by another. `npm ls zod` must keep showing one version.
 */

/** `candidate.originIata: expected a 3-letter IATA airport code`, capped. */
function describeZodError(error: ZodError): string {
  const parts = error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.map(String).join('.');
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });
  const extra =
    error.issues.length > parts.length ? ` (+${error.issues.length - parts.length} more)` : '';
  return `${parts.join('; ')}${extra}`;
}

// ---------------------------------------------------------------- mapping ---

interface MappedError {
  status: number;
  code: string;
  /** Safe to send. */
  message: string;
  /** Logged, never sent. */
  detail: string | undefined;
  retryAfterSeconds: number | undefined;
}

const INTERNAL: MappedError = {
  status: 500,
  code: 'INTERNAL_ERROR',
  message: 'Something went wrong. Try again.',
  detail: undefined,
  retryAfterSeconds: undefined,
};

/** Decide the status, code and public message for anything thrown in a handler. */
export function mapError(error: unknown): MappedError {
  if (error instanceof ApiHttpError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      detail: error.detail,
      retryAfterSeconds: undefined,
    };
  }

  if (error instanceof ZodError) {
    return {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: describeZodError(error),
      detail: undefined,
      retryAfterSeconds: undefined,
    };
  }

  // Order matters: both subclasses below are `ProviderError`s.
  if (error instanceof ProviderRateLimitError) {
    return {
      status: 429,
      code: 'PROVIDER_RATE_LIMITED',
      message: 'The flight data provider is rate-limiting us. Try again in a moment.',
      detail: error.message,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
  if (error instanceof ProviderTimeoutError) {
    return {
      status: 502,
      code: 'PROVIDER_TIMEOUT',
      message: 'The flight data provider did not answer in time. Try again.',
      detail: error.message,
      retryAfterSeconds: undefined,
    };
  }
  if (error instanceof ProviderError) {
    return {
      status: 502,
      code: 'PROVIDER_ERROR',
      message: 'The flight data provider could not answer that. Try again.',
      // `error.body` may be large; the provider already truncates it.
      detail: `${error.message}${error.status === undefined ? '' : ` (status ${error.status})`}`,
      retryAfterSeconds: undefined,
    };
  }
  if (error instanceof FlightIngestError) {
    return {
      status: 500,
      code: 'INGEST_FAILED',
      message: 'Could not save that flight. Try again.',
      detail: `${error.message}${error.code === undefined ? '' : ` (${error.code})`}`,
      retryAfterSeconds: undefined,
    };
  }

  // Fastify's own 4xx: empty body, bad JSON, wrong content type, too large.
  // Its messages name the problem and carry nothing of ours, but its codes
  // (`FST_ERR_CTP_*`) are an implementation detail: a body the parser rejects
  // is a validation failure to the client, the same as one zod rejects.
  const fastifyStatus = (error as { statusCode?: unknown }).statusCode;
  if (typeof fastifyStatus === 'number' && fastifyStatus >= 400 && fastifyStatus < 500) {
    const code = (error as { code?: unknown }).code;
    const isBodyParseError = typeof code === 'string' && code.startsWith('FST_ERR_CTP_');
    return {
      status: fastifyStatus,
      code: isBodyParseError ? 'VALIDATION_ERROR' : 'BAD_REQUEST',
      message: error instanceof Error ? error.message : 'Bad request.',
      detail: typeof code === 'string' ? code : undefined,
      retryAfterSeconds: undefined,
    };
  }

  return INTERNAL;
}

/** Install the error and not-found handlers. Called once by `buildApp`. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error);

    const context = { err: error, detail: mapped.detail, code: mapped.code };
    if (mapped.status >= 500) {
      request.log.error(context, 'request failed');
    } else if (mapped.status === 429 || mapped.status === 401) {
      request.log.warn(context, 'request rejected');
    } else {
      request.log.info(context, 'request rejected');
    }

    if (mapped.retryAfterSeconds !== undefined) {
      void reply.header('retry-after', String(mapped.retryAfterSeconds));
    }

    const body: ApiErrorBody = { error: { code: mapped.code, message: mapped.message } };
    void reply.status(mapped.status).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send(notFoundBody(request));
  });
}

/**
 * The body of a 404 for an unmatched route.
 *
 * Exported because the webhook receiver answers a wrong token with exactly this
 * body, so a guess at the secret cannot tell "wrong token" from "no such route"
 * (ADR 0003). It echoes only what the caller sent.
 */
export function notFoundBody(request: FastifyRequest): ApiErrorBody {
  return {
    error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}.` },
  };
}
