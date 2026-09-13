/**
 * `GET /v1/me` — who the caller is, creating them if this is their first call.
 *
 * The client treats this as "sign-in finished, give me my identity". It is the
 * only place a `profiles` row is repaired when the auth trigger did not run,
 * and the place a self-`travelers` row is born (ADR 0001).
 *
 * Idempotent, including under the concurrent-first-request race — see
 * `identity.ts` for why the insert is allowed to fail.
 */
import type { FastifyInstance } from 'fastify';

import { requireUser, requireUserClient } from '../auth';
import { ensureIdentity, type ProfileView, type TravelerView } from '../identity';

export interface MeResponse {
  profile: ProfileView;
  traveler: TravelerView;
}

export function registerMeRoutes(app: FastifyInstance): void {
  app.get('/v1/me', async (request): Promise<MeResponse> => {
    const user = requireUser(request);
    return ensureIdentity(requireUserClient(request), user.id, user.email);
  });
}
