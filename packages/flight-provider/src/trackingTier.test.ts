import { describe, expect, it } from 'vitest';

import type { FeedHealth, FlightDataProvider } from './provider';
import { assignTrackingTier, createFeedHealthCache } from './trackingTier';

function feeds(icao: string, overrides: Partial<FeedHealth> = {}): FeedHealth {
  return {
    icao,
    schedules: 'OK',
    liveUpdates: 'OK',
    adsb: 'OK',
    hasLiveCoverage: true,
    hasAnyCoverage: true,
    minAvailableLocalDate: null,
    maxAvailableLocalDate: null,
    ...overrides,
  };
}

const LIVE = feeds('KJFK');
const SCHEDULES_ONLY = feeds('PAWG', {
  liveUpdates: 'Unavailable',
  adsb: 'Down',
  hasLiveCoverage: false,
});

describe('assignTrackingTier', () => {
  it('is live only when both ends have live coverage', () => {
    expect(assignTrackingTier(LIVE, feeds('KLAX'))).toBe('live');
  });

  it('degrades to scheduled when either end is schedules-only', () => {
    expect(assignTrackingTier(LIVE, SCHEDULES_ONLY)).toBe('scheduled');
    expect(assignTrackingTier(SCHEDULES_ONLY, LIVE)).toBe('scheduled');
    expect(assignTrackingTier(SCHEDULES_ONLY, SCHEDULES_ONLY)).toBe('scheduled');
  });

  it('degrades to scheduled when feed health is unknown', () => {
    expect(assignTrackingTier(null, LIVE)).toBe('scheduled');
    expect(assignTrackingTier(LIVE, undefined)).toBe('scheduled');
  });

  it('counts a degraded feed as live coverage', () => {
    const degraded = feeds('EGLL', { liveUpdates: 'Degraded', adsb: 'Down' });
    expect(assignTrackingTier(LIVE, degraded)).toBe('live');
  });

  it("never returns manual — that is the caller's decision (§7.3)", () => {
    const none = feeds('ZZZZ', {
      schedules: 'Unavailable',
      liveUpdates: 'Unavailable',
      adsb: 'Unavailable',
      hasLiveCoverage: false,
      hasAnyCoverage: false,
    });
    expect(assignTrackingTier(none, none)).toBe('scheduled');
  });
});

/** A provider that only answers feed-health questions, and counts them. */
function countingProvider(): { provider: FlightDataProvider; calls: string[] } {
  const calls: string[] = [];
  const provider = {
    async getAirportFeedHealth(icao: string): Promise<FeedHealth> {
      calls.push(icao);
      return feeds(icao);
    },
  } as FlightDataProvider;
  return { provider, calls };
}

describe('createFeedHealthCache', () => {
  it('fetches once per airport and serves the rest from memory', async () => {
    const { provider, calls } = countingProvider();
    const cache = createFeedHealthCache();

    await cache.get('KJFK', provider);
    await cache.get('kjfk', provider);
    await cache.get('KLAX', provider);

    expect(calls).toEqual(['KJFK', 'KLAX']);
    expect(cache.size()).toBe(2);
  });

  it('expires entries after 24 hours, on an injected clock', async () => {
    const { provider, calls } = countingProvider();
    let clock = Date.parse('2026-09-11T00:00:00Z');
    const cache = createFeedHealthCache({ now: () => clock });

    await cache.get('KJFK', provider);
    clock += 23 * 60 * 60 * 1000;
    await cache.get('KJFK', provider);
    expect(calls).toHaveLength(1);

    clock += 2 * 60 * 60 * 1000; // now 25 hours after the first fetch
    await cache.get('KJFK', provider);
    expect(calls).toEqual(['KJFK', 'KJFK']);
    expect(cache.size()).toBe(1);
  });

  it('shares one request between concurrent callers', async () => {
    const { provider, calls } = countingProvider();
    const cache = createFeedHealthCache();

    await Promise.all([
      cache.get('KJFK', provider),
      cache.get('KJFK', provider),
      cache.get('KJFK', provider),
    ]);

    expect(calls).toEqual(['KJFK']);
  });

  it('does not cache a failure', async () => {
    let attempts = 0;
    const provider = {
      async getAirportFeedHealth(icao: string): Promise<FeedHealth> {
        attempts += 1;
        if (attempts === 1) throw new Error('provider down');
        return feeds(icao);
      },
    } as FlightDataProvider;
    const cache = createFeedHealthCache();

    await expect(cache.get('KJFK', provider)).rejects.toThrow('provider down');
    await expect(cache.get('KJFK', provider)).resolves.toMatchObject({ icao: 'KJFK' });
    expect(attempts).toBe(2);
  });

  it('clears', async () => {
    const { provider, calls } = countingProvider();
    const cache = createFeedHealthCache();

    await cache.get('KJFK', provider);
    cache.clear();
    await cache.get('KJFK', provider);

    expect(calls).toHaveLength(2);
    expect(cache.size()).toBe(1);
  });
});
