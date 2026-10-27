/**
 * `GET /v1/me` — who the caller is, creating them if this is their first call.
 *
 * The client treats this as "sign-in finished, give me my identity". This and
 * `POST /v1/flights` (both via `ensureIdentity`) are where a `profiles` row is
 * repaired when the auth trigger did not run, and where a self-`travelers` row
 * is born (ADR 0001).
 *
 * Idempotent, including under the concurrent-first-request race — see
 * `identity.ts` for why the insert is allowed to fail.
 */
import type { FastifyInstance } from 'fastify';

import { requireUser, requireUserClient } from '../auth';
import { ensureIdentity, type MeResponse } from '../identity';

/** Registered under the `/v1` prefix (`app.ts`). */
export function registerMeRoutes(app: FastifyInstance): void {
  app.get('/me', async (request): Promise<MeResponse> => {
    const user = requireUser(request);
    return ensureIdentity(requireUserClient(request), user.id, user.email);
  });
}
