/**
 * `GET /healthz` — the one route with no bearer token.
 *
 * It deliberately does not touch Supabase or the provider. A liveness probe
 * that fails when a *dependency* is down takes the process out of rotation for
 * something a restart cannot fix, and on Render that turns a provider blip into
 * a crash loop. Dependency health belongs in a separate readiness check if one
 * is ever needed (§11).
 */
import type { FastifyInstance } from 'fastify';

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/healthz', async () => ({ status: 'ok' as const }));
}
