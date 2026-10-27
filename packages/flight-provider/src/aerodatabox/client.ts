/**
 * The AeroDataBox implementation of `FlightDataProvider`, over RapidAPI.
 *
 * `fetch` is injectable so every test in this package runs against the captured
 * fixtures in `docs/api-samples/` rather than the network — §12.1 rations real
 * calls to 20 per agent, which is not a budget unit tests can draw on.
 */
import type { FlightCandidate } from '@flightbuddy/shared';
import type { z } from 'zod';

import {
  ProviderDataError,
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
} from '../errors';
import {
  DEFAULT_MAX_DELIVERY_RETRIES,
  FEED_STATUSES,
  isFeedUp,
  type AlertSubscription,
  type FeedHealth,
  type FeedStatus,
  type FlightDataProvider,
  type SubscribeAlertsOptions,
} from '../provider';
import { localDatePart, requireDesignator, toFlightCandidate, toUtcIso } from './mapper';
import {
  airportFeedsSchema,
  balanceSchema,
  flightListSchema,
  subscriptionContractSchema,
  subscriptionIdSchema,
  subscriptionListSchema,
  type AeroDataBoxAirportFeeds,
  type AeroDataBoxSubscription,
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

/**
 * Shape AND calendar validity — `2026-02-30` must never reach the provider.
 * The test behind `requireLocalDate`.
 */
export function isLocalDate(value: string): boolean {
  if (!LOCAL_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Throws a `ProviderDataError` unless `dateLocal` is a real `YYYY-MM-DD` date.
 * Run by `lookupCandidates` and `lookupFlight` before any request is made.
 */
export function requireLocalDate(dateLocal: string): void {
  if (!isLocalDate(dateLocal)) {
    throw new ProviderDataError(`"${dateLocal}" is not a YYYY-MM-DD date.`);
  }
}

/** Response bodies are only ever logged, so they are truncated on the way in. */
const MAX_LOGGED_BODY = 500;

/**
 * How error bodies are handled for one endpoint.
 *
 * The `/subscriptions/webhook*` endpoints echo the subscriber URL — our receiver
 * URL **with its secret token** — in their responses, and a 4xx on create may
 * quote the URL we sent. `ProviderError` keeps a truncated body for debugging, and
 * pino's error serialiser copies an error's own properties into the log line, so
 * for those endpoints the body (and any zod `cause`) is dropped at the source.
 */
interface BodyPolicy {
  keepBody: boolean;
}

const KEEP_BODY: BodyPolicy = { keepBody: true };
/** For every endpoint whose response can contain the webhook URL. */
const SECRET_BEARING: BodyPolicy = { keepBody: false };

/** A receiver URL the provider can call: absolute http(s). Never echoed in an error. */
function isWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** A provider subscription as the domain's `AlertSubscription`; used by `listSubscriptions`. */
function toAlertSubscription(raw: AeroDataBoxSubscription): AlertSubscription {
  return {
    subscriptionId: raw.id,
    isActive: raw.isActive,
    createdAtUtc: toUtcIso(raw.createdOnUtc),
    flightNumber: raw.subject.id,
  };
}

/** What `request` hands back: status, full body text and any `Retry-After`. */
interface RawResponse {
  status: number;
  body: string;
  retryAfterSeconds: number | undefined;
}

/** A provider feed status as a `FeedStatus`; anything unrecognised is `Unknown`. */
function normaliseFeedStatus(value: string | null | undefined): FeedStatus {
  const found = FEED_STATUSES.find((status) => status === value);
  return found ?? 'Unknown';
}

/**
 * The provider's feeds response as `FeedHealth`, for `getAirportFeedHealth`.
 * `raw` is `null` when the airport is not carried, which reads as no coverage.
 */
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
    minAvailableLocalDate: localDatePart(raw?.generalAvailability?.minAvailableLocalDate),
    maxAvailableLocalDate: localDatePart(raw?.generalAvailability?.maxAvailableLocalDate),
  };
}

/**
 * Build a provider bound to one API key. The API's `app.ts` and the poller's
 * `main.ts` each build one at startup.
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

  /**
   * One HTTP call to the gateway with the RapidAPI headers and timeout. Every
   * method below goes through it; it throws only for timeouts and network errors.
   */
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
      const isTimeout =
        typeof cause === 'object' &&
        cause !== null &&
        (cause as { name?: string }).name === 'TimeoutError';
      if (isTimeout) {
        throw new ProviderTimeoutError(`Request to the flight provider timed out: ${path}`, {
          cause,
        });
      }
      throw new ProviderError(`Request to the flight provider failed: ${path}`, { cause });
    }

    const body = await response.text();
    const retryAfter = Number(response.headers.get('Retry-After'));
    return {
      status: response.status,
      body,
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    };
  }

  /** The body to attach to an error under `policy`: truncated, or nothing at all. */
  function errorBody(raw: RawResponse, policy: BodyPolicy): { body?: string } {
    return policy.keepBody ? { body: raw.body.slice(0, MAX_LOGGED_BODY) } : {};
  }

  /** Applies the shared status policy; callers only handle their own 404/204. */
  function assertOk(path: string, raw: RawResponse, policy: BodyPolicy = KEEP_BODY): void {
    if (raw.status === 429) {
      throw new ProviderRateLimitError(`Flight provider rate limit hit on ${path}.`, {
        ...errorBody(raw, policy),
        ...(raw.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: raw.retryAfterSeconds }),
      });
    }
    if (raw.status < 200 || raw.status >= 300) {
      throw new ProviderError(`Flight provider returned ${raw.status} for ${path}.`, {
        status: raw.status,
        ...errorBody(raw, policy),
      });
    }
  }

  /** The body as JSON, or a `ProviderDataError` that keeps the body only under `policy`. */
  function parseJson(path: string, raw: RawResponse, policy: BodyPolicy = KEEP_BODY): unknown {
    try {
      return JSON.parse(raw.body);
    } catch (cause) {
      throw new ProviderDataError(`Flight provider sent unparseable JSON for ${path}.`, {
        ...errorBody(raw, policy),
        ...(policy.keepBody ? { cause } : {}),
      });
    }
  }

  /** `parseJson`, then `schema`; a mismatch keeps body and zod cause only under `policy`. */
  function parseBody<S extends z.ZodType>(
    schema: S,
    path: string,
    raw: RawResponse,
    policy: BodyPolicy = KEEP_BODY,
  ): z.output<S> {
    const parsed = schema.safeParse(parseJson(path, raw, policy));
    if (!parsed.success) {
      throw new ProviderDataError(`Flight provider sent an unexpected shape for ${path}.`, {
        ...errorBody(raw, policy),
        ...(policy.keepBody ? { cause: parsed.error } : {}),
      });
    }
    return parsed.data;
  }

  return {
    /** `GET /flights/number/...`: every leg, mapped. Reached through `lookupCandidates`. */
    async lookupFlight(number: string, dateLocal: string): Promise<FlightCandidate[]> {
      const designator = requireDesignator(number);
      requireLocalDate(dateLocal);

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
      if (raw.status === 204 || raw.status === 404) return [];
      assertOk(path, raw);
      // Only a 2xx with nothing in it means "nothing found". A 5xx with an
      // empty body is a failure and must surface as one (ADR 0001 → 502).
      if (raw.body.trim() === '') return [];

      const flights = parseBody(flightListSchema, path, raw);

      // Every leg, never `[0]` (§8.12). A leg the mapper cannot express — no
      // IATA code or no time zone — is dropped rather than failing the lookup:
      // it could not be stored against the canonical key anyway.
      const candidates: FlightCandidate[] = [];
      for (const flight of flights) {
        try {
          candidates.push(toFlightCandidate(flight, designator.designator));
        } catch (error) {
          if (!(error instanceof ProviderDataError)) throw error;
        }
      }
      return candidates;
    },

    /** `GET /health/services/airports/{icao}/feeds`. Reached through `FeedHealthCache`. */
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
      if (raw.status === 204 || raw.status === 404) return toFeedHealth(code, null);
      assertOk(path, raw);
      if (raw.body.trim() === '') return toFeedHealth(code, null);

      return toFeedHealth(code, parseBody(airportFeedsSchema, path, raw));
    },

    // ---------- Alert API (ADR 0003; webhook-notification-schema.md) ----------
    //
    // Every call here uses `SECRET_BEARING`: no response body and no zod cause is
    // ever attached to an error, and the webhook URL never appears in a message.

    /** `POST /subscriptions/webhook/FlightByNumber/...`. The poller calls it at window opening. */
    async subscribeAlerts(
      flightNumber: string,
      url: string,
      options: SubscribeAlertsOptions = {},
    ): Promise<{ subscriptionId: string }> {
      const designator = requireDesignator(flightNumber);
      const maxDeliveryRetries = options.maxDeliveryRetries ?? DEFAULT_MAX_DELIVERY_RETRIES;
      if (
        !Number.isInteger(maxDeliveryRetries) ||
        maxDeliveryRetries < 0 ||
        maxDeliveryRetries > 2
      ) {
        throw new ProviderDataError('maxDeliveryRetries must be 0, 1 or 2.');
      }
      // The URL carries the receiver's secret token: validated, never quoted.
      if (!isWebhookUrl(url)) {
        throw new ProviderDataError('The webhook URL must be an absolute http(s) URL.');
      }

      // Subscriptions carry no date: one subscription fires for every occurrence
      // of the number, which is why §7.6 opens them about a day out, once the
      // previous day's occurrence has landed (ADR 0005), never at add time.
      // No `useCredits` query parameter: the current spec lists none and credit-based
      // is the default (docs/api-samples/webhook-notification-schema.md).
      const path = `/subscriptions/webhook/FlightByNumber/${encodeURIComponent(designator.designator)}`;
      const raw = await request(path, {
        method: 'POST',
        json: { url, maxDeliveryRetries },
      });
      assertOk(path, raw, SECRET_BEARING);

      const created = parseBody(subscriptionContractSchema, path, raw, SECRET_BEARING);
      return { subscriptionId: created.id };
    },

    /** `DELETE /subscriptions/webhook/{id}`. Called by the poller's unsubscribe and reconcile. */
    async unsubscribeAlerts(subscriptionId: string): Promise<void> {
      if (!subscriptionIdSchema.safeParse(subscriptionId).success) {
        throw new ProviderDataError('A subscription id must be a GUID.');
      }
      const path = `/subscriptions/webhook/${encodeURIComponent(subscriptionId.toLowerCase())}`;
      const raw = await request(path, { method: 'DELETE' });
      // Already gone is the desired end state, not a failure.
      if (raw.status === 404) return;
      assertOk(path, raw, SECRET_BEARING);
    },

    /** `GET /subscriptions/webhook`. The poller's hourly reconcile reads it. */
    async listSubscriptions(): Promise<AlertSubscription[]> {
      const path = '/subscriptions/webhook';
      const raw = await request(path);
      // Observed 2026-09-14 (`calls.tsv`): 204 with an empty body when the account
      // has no subscriptions.
      if (raw.status === 204) return [];
      assertOk(path, raw, SECRET_BEARING);
      if (raw.body.trim() === '') return [];

      // One unparseable element fails the whole list on purpose: reconcile acts on
      // what is *missing* from this list, so a silently shortened list would detach
      // flights whose subscriptions are fine.
      return parseBody(subscriptionListSchema, path, raw, SECRET_BEARING).map(toAlertSubscription);
    },

    /** `GET /subscriptions/balance` (free). The poller's hourly credit check (§7.7). */
    async getCreditBalance(): Promise<number> {
      const path = '/subscriptions/balance';
      const raw = await request(path);
      // Observed on the dev plan: HTTP 200 with an empty body when the account
      // has no alert balance record. Zero is the truthful reading, and it is
      // the reading that makes §7.7 fail safe — zero credits means fall back to
      // polling rather than trust alerts that will never be sent.
      if (raw.status === 204) return 0;
      assertOk(path, raw);
      if (raw.body.trim() === '') return 0;

      return parseBody(balanceSchema, path, raw).creditsRemaining;
    },

    /** `POST /subscriptions/balance/refill`. Not called by code (ADR 0003): the owner refills. */
    async refillCredits(credits: number): Promise<number> {
      if (!Number.isInteger(credits) || credits < 1) {
        throw new ProviderDataError(`Refill needs a positive whole number of credits.`);
      }
      const path = '/subscriptions/balance/refill';
      const raw = await request(path, { method: 'POST', json: { credits } });
      assertOk(path, raw);

      return parseBody(balanceSchema, path, raw).creditsRemaining;
    },
  };
}
