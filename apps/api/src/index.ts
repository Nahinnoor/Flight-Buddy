// @flightbuddy/api — Fastify HTTP API (ADR 0001).
//
// Invariant: request handlers never write to `flights` (PROJECT_OVERVIEW §12.7).
// The only writer is `ingestFlight` from `@flightbuddy/flight-provider`, called
// with the service-role client in `routes/flights.ts`.
//
// `server.ts` is the process entry point; this file is the library surface, so
// tests and any future in-process consumer build the same app.

export { buildApp, type BuildAppOptions } from './app';
export { type AppDeps } from './deps';
export { ConfigError, loadConfig, parseConfig, type Config } from './config';
export { createTokenVerifier, type AuthUser, type TokenVerifier } from './auth';
export { type ApiErrorBody } from './errors';
export { type MeResponse } from './routes/me';
