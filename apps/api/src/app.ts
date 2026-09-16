/**
 * `buildApp` — the whole HTTP service as one value, with its edges injectable.
 *
 * `server.ts` calls this with real dependencies; the tests call it with fakes
 * and drive it through `app.inject()`, so there is no port, no network and no
 * second code path that only tests exercise.
 */
import { randomUUID } from 'node:crypto';

import { createAeroDataBoxProvider } from '@flightbuddy/flight-provider';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import { createAuthenticate, createTokenVerifier } from './auth';
import type { Config } from './config';
import type { AppDeps } from './deps';
import { registerErrorHandler } from './errors';
import { serializeRequest } from './logging';
import { registerFlightRoutes } from './routes/flights';
import { registerHealthRoutes } from './routes/health';
import { registerMeRoutes } from './routes/me';
import { createWebhookRoutes } from './routes/webhooks';
import { createServiceClient, createUserClientFactory } from './supabase';

/** `config` is required; every other edge falls back to the real thing. */
export interface BuildAppOptions extends Partial<Omit<AppDeps, 'config'>> {
  config: Config;
  /** Set `false` in tests that do not want request logs on stdout. */
  logger?: boolean;
  /** Where log lines go instead of stdout. Tests use it to assert what is never logged. */
  logStream?: LogStream;
}

/** One JSON log line per `write`. */
export interface LogStream {
  write(line: string): void;
}

/** Header the platform (and the mobile client) may set to correlate a request. */
const REQUEST_ID_HEADER = 'x-request-id';

function corsOrigin(value: string): true | string[] {
  const trimmed = value.trim();
  if (trimmed === '*') return true;
  return trimmed
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
}

/** Fill in whatever the caller did not inject. */
function resolveDeps(options: BuildAppOptions): AppDeps {
  const { config } = options;
  return {
    config,
    provider:
      options.provider ??
      createAeroDataBoxProvider({ apiKey: config.RAPIDAPI_KEY, host: config.AERODATABOX_HOST }),
    serviceClient: options.serviceClient ?? createServiceClient(config),
    createUserClient: options.createUserClient ?? createUserClientFactory(config),
    verifyToken:
      options.verifyToken ??
      createTokenVerifier({
        supabaseUrl: config.SUPABASE_URL,
        jwtSecret: config.SUPABASE_JWT_SECRET,
      }),
    now: options.now ?? (() => new Date()),
  };
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const deps = resolveDeps(options);

  const serverOptions: FastifyServerOptions = {
    // Render terminates TLS at one proxy hop in front of the service. Without
    // this, `request.ip` is the proxy's address and the webhook rate limit is
    // one shared bucket for every caller. Trusting exactly the immediate peer
    // (hop 0) and nothing beyond it means a forged X-Forwarded-For chain cannot
    // change which address we key on — unlike `true`, which trusts them all.
    trustProxy: (_address: string, hop: number) => hop === 0,
    logger:
      (options.logger ?? true)
        ? {
            level: deps.config.LOG_LEVEL,
            // Replaces Fastify's `req` serializer so a webhook URL — which
            // carries the secret token — never reaches a log line (logging.ts).
            serializers: { req: serializeRequest },
            ...(options.logStream === undefined ? {} : { stream: options.logStream }),
          }
        : false,
    // Accept an inbound correlation id, mint one otherwise. `request.log` stamps
    // every line with it, which is the only way to tie a 500's log entry to the
    // opaque message the client was given.
    requestIdHeader: REQUEST_ID_HEADER,
    genReqId: () => randomUUID(),
  };
  const app = Fastify(serverOptions);

  registerErrorHandler(app);

  app.addHook('onSend', async (request, reply) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
  });

  // Registered synchronously via a plugin closure so `buildApp` stays sync and
  // callers only have to `await app.ready()`.
  void app.register(async (instance) => {
    await instance.register(cors, {
      origin: corsOrigin(deps.config.CORS_ORIGIN),
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['authorization', 'content-type', REQUEST_ID_HEADER],
      maxAge: 86_400,
    });

    registerHealthRoutes(instance);

    // Everything under here is authenticated. The hook is registered on a
    // child instance so `/healthz` cannot accidentally inherit it — and, more
    // importantly, so no future `/v1` route can accidentally skip it.
    await instance.register(async (authed) => {
      authed.addHook(
        'preHandler',
        createAuthenticate({
          verifyToken: deps.verifyToken,
          createUserClient: deps.createUserClient,
        }),
      );
      registerMeRoutes(authed);
      registerFlightRoutes(authed, deps);
    });
  });

  // The AeroDataBox receiver (ADR 0003) sits at the root, beside `/v1` rather
  // than under it: no JWT (the provider cannot send one), no CORS (it is
  // server-to-server, and CORS headers would make its wrong-token 404 differ
  // from an unknown route's), and its own body parser and error handler. With
  // no `WEBHOOK_TOKEN` the route does not exist at all.
  const webhookToken = deps.config.WEBHOOK_TOKEN;
  if (webhookToken !== undefined) {
    void app.register(
      createWebhookRoutes({
        token: webhookToken,
        serviceClient: deps.serviceClient,
        now: deps.now,
      }),
    );
  }

  return app;
}
