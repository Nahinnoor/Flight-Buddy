/**
 * The AeroDataBox implementation of `FlightDataProvider`, over RapidAPI.
 *
 * `fetch` is injectable so every test in this package runs against the captured
 * fixtures in `docs/api-samples/` rather than the network — §12.1 rations real
 * calls to 20 per agent, which is not a budget unit tests can draw on.
 */
import { parseFlightDesignator, type FlightCandidate } from '@flightbuddy/shared';

import {
  ProviderDataError,
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
} from '../errors';
import {
  FEED_STATUSES,
  isFeedUp,
  type FeedHealth,
  type FeedStatus,
  type FlightDataProvider,
} from '../provider';
import { toFlightCandidate } from './mapper';
import {
  airportFeedsSchema,
  balanceSchema,
  flightListSchema,
  subscriptionSchema,
  type AeroDataBoxAirportFeeds,
} from './schemas';

export interface AeroDataBoxOptions {
  /** RapidAPI key. Development key only in a development context (§12.3). */
  apiKey: string;
  /** RapidAPI host. Defaults to the AeroDataBox gateway. */
  host?: string;
  /** Injected for tests. Defaults to the runtime's own `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout. The gateway's own is 10s; this bounds the poller. */
  timeoutMs?: number;
}

const DEFAULT_HOST = 'aerodatabox.p.rapidapi.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Response bodies are only ever logged, so they are truncated on the way in. */
const MAX_LOGGED_BODY = 500;

interface RawResponse {
  status: number;
  body: string;
  retryAfterSeconds: number | undefined;
}

function normaliseFeedStatus(value: string | null | undefined): FeedStatus {
  const found = FEED_STATUSES.find((status) => status === value);
  return found ?? 'Unknown';
}

/** `YYYY-MM-DD` out of the provider's `2025-09-09` / date-time strings. */
function datePart(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match === null ? null : (match[1] as string);
}

function toFeedHealth(icao: string, raw: AeroDataBoxAirportFeeds | null): FeedHealth {
  const schedules = normaliseFeedStatus(raw?.flightSchedulesFeed?.status);
  const liveUpdates = normaliseFeedStatus(raw?.liveFlightUpdatesFeed?.status);
  const adsb = normaliseFeedStatus(raw?.adsbUpdatesFeed?.status);
  return {
    icao,
    schedules,
    liveUpdates,
    adsb,
    hasLiveCoverage: isFeedUp(liveUpdates) || isFeedUp(adsb),
    hasAnyCoverage: isFeedUp(schedules) || isFeedUp(liveUpdates) || isFeedUp(adsb),
    minAvailableLocalDate: datePart(raw?.generalAvailability?.minAvailableLocalDate),
    maxAvailableLocalDate: datePart(raw?.generalAvailability?.maxAvailableLocalDate),
  };
}

/**
 * Build a provider bound to one API key.
 *
 * @example
 * const provider = createAeroDataBoxProvider({ apiKey: process.env.RAPIDAPI_KEY! });
 * const legs = await provider.lookupFlight('DL 9659', '2026-09-12');
 */
export function createAeroDataBoxProvider(options: AeroDataBoxOptions): FlightDataProvider {
  const { apiKey } = options;
  if (apiKey.trim() === '') {
    throw new ProviderError('createAeroDataBoxProvider needs a RapidAPI key.');
  }
  const host = options.host ?? DEFAULT_HOST;
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(
    path: string,
    init: { method?: string; json?: unknown } = {},
  ): Promise<RawResponse> {
    const headers: Record<string, string> = {
      'X-RapidAPI-Key': apiKey,
      'X-RapidAPI-Host': host,
      Accept: 'application/json',
    };
    if (init.json !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await doFetch(`https://${host}${path}`, {
        method: init.method ?? 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      });
    } catch (cause) {
      throw new ProviderTimeoutError(`Request to the flight provider failed: ${path}`, { cause });
    }

    const body = await response.text();
    const retryAfter = Number(response.headers.get('Retry-After'));
    return {
      status: response.status,
      body,
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    };
  }

  /** Applies the shared status policy; callers only handle their own 404/204. */
  function assertOk(path: string, raw: RawResponse): void {
    if (raw.status === 429) {
      throw new ProviderRateLimitError(`Flight provider rate limit hit on ${path}.`, {
        body: raw.body.slice(0, MAX_LOGGED_BODY),
        ...(raw.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: raw.retryAfterSeconds }),
      });
    }
    if (raw.status < 200 || raw.status >= 300) {
      throw new ProviderError(`Flight provider returned ${raw.status} for ${path}.`, {
        status: raw.status,
        body: raw.body.slice(0, MAX_LOGGED_BODY),
      });
    }
  }

  function parseJson(path: string, raw: RawResponse): unknown {
    try {
      return JSON.parse(raw.body);
    } catch (cause) {
      throw new ProviderDataError(`Flight provider sent unparseable JSON for ${path}.`, {
        body: raw.body.slice(0, MAX_LOGGED_BODY),
        cause,
      });
    }
  }

  return {
    async lookupFlight(number: string, dateLocal: string): Promise<FlightCandidate[]> {
      const designator = parseFlightDesignator(number);
      if (designator === null) {
        throw new ProviderDataError(`"${number}" is not a flight number.`);
      }
      if (!LOCAL_DATE.test(dateLocal)) {
        throw new ProviderDataError(`"${dateLocal}" is not a YYYY-MM-DD date.`);
      }

      // `dateLocalRole=Departure` because the canonical key is the local date at
      // the ORIGIN (§6.3). The provider's default, `Both`, also returns flights
      // that merely *arrive* that day, which departed the day before.
      const path =
        `/flights/number/${encodeURIComponent(designator.designator)}/${dateLocal}` +
        `?dateLocalRole=Departure&withAircraftImage=false&withLocation=false`;
      const raw = await request(path);

      // No such flight on that date: 204 with an empty body, or 404. Both mean
      // "nothing found", which is an empty list and not an error — the API
      // turns that into its own 404 (ADR 0001).
      if (raw.status === 204 || raw.status === 404 || raw.body.trim() === '') return [];
      assertOk(path, raw);

      const parsed = flightListSchema.safeParse(parseJson(path, raw));
      if (!parsed.success) {
        throw new ProviderDataError(`Flight provider sent an unexpected shape for ${path}.`, {
          body: raw.body.slice(0, MAX_LOGGED_BODY),
          cause: parsed.error,
        });
      }

      // Every leg, never `[0]` (§8.12). A leg the mapper cannot express — no
      // IATA code or no time zone — is dropped rather than failing the lookup:
      // it could not be stored against the canonical key anyway.
      const candidates: FlightCandidate[] = [];
      for (const flight of parsed.data) {
        try {
          candidates.push(toFlightCandidate(flight, designator.designator));
        } catch (error) {
          if (!(error instanceof ProviderDataError)) throw error;
        }
      }
      return candidates;
    },

    async getAirportFeedHealth(icao: string): Promise<FeedHealth> {
      const code = icao.trim().toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(code)) {
        throw new ProviderDataError(`"${icao}" is not an ICAO airport code.`);
      }
      const path = `/health/services/airports/${code}/feeds`;
      const raw = await request(path);

      // An airport the provider does not carry reports no coverage rather than
      // failing: "no provider data at all" is the `manual` tier (§7.3), which
      // is a decision for the caller, not an error.
      if (raw.status === 204 || raw.status === 404 || raw.body.trim() === '') {
        return toFeedHealth(code, null);
      }
      assertOk(path, raw);

      const parsed = airportFeedsSchema.safeParse(parseJson(path, raw));
      if (!parsed.success) {
        throw new ProviderDataError(`Flight provider sent an unexpected shape for ${path}.`, {
          body: raw.body.slice(0, MAX_LOGGED_BODY),
          cause: parsed.error,
        });
      }
      return toFeedHealth(code, parsed.data);
    },

    // ---------- Phase 2 surface: implemented, not yet wired ----------

    async subscribeAlerts(flightNumber: string, url: string): Promise<{ subscriptionId: string }> {
      const designator = parseFlightDesignator(flightNumber);
      if (designator === null) {
        throw new ProviderDataError(`"${flightNumber}" is not a flight number.`);
      }
      const path = `/subscriptions/webhook/FlightByNumber/${encodeURIComponent(designator.designator)}`;
      // Subscriptions carry no date: one subscription fires for every
      // occurrence of the number, which is why §7.6 opens them at T-24h.
      const raw = await request(path, {
        method: 'POST',
        json: { url, maxDeliveryRetries: 2 },
      });
      assertOk(path, raw);

      const parsed = subscriptionSchema.safeParse(parseJson(path, raw));
      if (!parsed.success) {
        throw new ProviderDataError(`Flight provider sent an unexpected shape for ${path}.`, {
          body: raw.body.slice(0, MAX_LOGGED_BODY),
          cause: parsed.error,
        });
      }
      return { subscriptionId: parsed.data.id };
    },

    async unsubscribeAlerts(subscriptionId: string): Promise<void> {
      const path = `/subscriptions/webhook/${encodeURIComponent(subscriptionId)}`;
      const raw = await request(path, { method: 'DELETE' });
      // Already gone is the desired end state, not a failure.
      if (raw.status === 404) return;
      assertOk(path, raw);
    },

    async getCreditBalance(): Promise<number> {
      const path = '/subscriptions/balance';
      const raw = await request(path);
      // Observed on the dev plan: HTTP 200 with an empty body when the account
      // has no alert balance record. Zero is the truthful reading, and it is
      // the reading that makes §7.7 fail safe — zero credits means fall back to
      // polling rather than trust alerts that will never be sent.
      if (raw.status === 204 || raw.body.trim() === '') return 0;
      assertOk(path, raw);

      const parsed = balanceSchema.safeParse(parseJson(path, raw));
      if (!parsed.success) {
        throw new ProviderDataError(`Flight provider sent an unexpected shape for ${path}.`, {
          body: raw.body.slice(0, MAX_LOGGED_BODY),
          cause: parsed.error,
        });
      }
      return parsed.data.creditsRemaining;
    },

    async refillCredits(credits: number): Promise<number> {
      if (!Number.isInteger(credits) || credits < 1) {
        throw new ProviderDataError(`Refill needs a positive whole number of credits.`);
      }
      const path = '/subscriptions/balance/refill';
      const raw = await request(path, { method: 'POST', json: { credits } });
      assertOk(path, raw);

      const parsed = balanceSchema.safeParse(parseJson(path, raw));
      if (!parsed.success) {
        throw new ProviderDataError(`Flight provider sent an unexpected shape for ${path}.`, {
          body: raw.body.slice(0, MAX_LOGGED_BODY),
          cause: parsed.error,
        });
      }
      return parsed.data.creditsRemaining;
    },
  };
}
