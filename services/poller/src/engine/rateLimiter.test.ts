import { describe, expect, it } from 'vitest';

import { createRateLimiter, type Clock } from './rateLimiter';

/**
 * Virtual time. `sleep` parks a continuation at an absolute instant; `drain` runs
 * them in order, jumping the clock forward. Nothing here waits on real time, so
 * "200 flights over 200 seconds" costs milliseconds.
 */
class FakeClock implements Clock {
  current = 0;
  private timers: { at: number; resolve: () => void }[] = [];

  now(): number {
    return this.current;
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.timers.push({ at: this.current + ms, resolve });
    });
  }

  /** Run every pending timer, earliest first, letting continuations settle. */
  async drain(): Promise<void> {
    await flush();
    while (this.timers.length > 0) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers.shift();
      if (next === undefined) break;
      this.current = Math.max(this.current, next.at);
      next.resolve();
      await flush();
    }
  }
}

/** Let every queued microtask and immediate run. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Run `count` acquires concurrently and return the virtual instant each returned at. */
async function acquireMany(count: number, options: { rps?: number; burst?: number } = {}) {
  const clock = new FakeClock();
  const limiter = createRateLimiter({ ...options, clock });
  const at: number[] = [];

  const all = Array.from({ length: count }, async () => {
    await limiter.acquire();
    at.push(clock.now());
  });

  await clock.drain();
  await Promise.all(all);
  return { at, clock, limiter };
}

describe('createRateLimiter', () => {
  it('lets the first caller through immediately', async () => {
    const clock = new FakeClock();
    const limiter = createRateLimiter({ clock });

    await limiter.acquire();

    expect(clock.now()).toBe(0);
  });

  it('spaces two callers a full second apart at 1 rps', async () => {
    const { at } = await acquireMany(2);
    expect(at).toEqual([0, 1000]);
  });

  it('never grants two calls in the same second for 200 simultaneously due flights', async () => {
    // §8.3, and PHASE2_PLAN §1 criterion 3: the whole failover ladder can make a
    // crowd of flights due at the same instant.
    const { at, limiter } = await acquireMany(200);

    expect(at).toHaveLength(200);
    expect(limiter.granted).toBe(200);

    const perSecond = new Map<number, number>();
    for (const instant of at) {
      const second = Math.floor(instant / 1000);
      perSecond.set(second, (perSecond.get(second) ?? 0) + 1);
    }
    for (const [second, calls] of perSecond) {
      expect(calls, `second ${second} carried ${calls} calls`).toBe(1);
    }

    // And the gaps are exactly one second, in order.
    const sorted = [...at].sort((a, b) => a - b);
    expect(sorted).toEqual(at);
    for (let i = 1; i < sorted.length; i += 1) {
      expect((sorted[i] as number) - (sorted[i - 1] as number)).toBe(1000);
    }
    expect(at.at(-1)).toBe(199_000);
  });

  it('serves callers in the order they asked', async () => {
    const clock = new FakeClock();
    const limiter = createRateLimiter({ clock });
    const order: number[] = [];

    const all = [0, 1, 2, 3, 4].map(async (id) => {
      await limiter.acquire();
      order.push(id);
    });

    await clock.drain();
    await Promise.all(all);

    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('honours a configured rps', async () => {
    const { at } = await acquireMany(4, { rps: 2 });
    expect(at).toEqual([0, 500, 1000, 1500]);
  });

  it('does not bank credit while idle (burst 1 by default)', async () => {
    const clock = new FakeClock();
    const limiter = createRateLimiter({ clock });

    await limiter.acquire();
    // Ten idle seconds must not buy ten free calls.
    clock.current = 10_000;

    await limiter.acquire();
    expect(clock.now()).toBe(10_000);

    const second = limiter.acquire();
    await clock.drain();
    await second;
    expect(clock.now()).toBe(11_000);
  });

  it('allows an explicit burst, and only that much', async () => {
    const { at } = await acquireMany(5, { burst: 3 });
    // Three go straight away; the rest resume the 1/s cadence from there.
    expect(at).toEqual([0, 0, 0, 1000, 2000]);
  });

  it('refuses a rate that would hang every caller', () => {
    expect(() => createRateLimiter({ rps: 0 })).toThrow(RangeError);
    expect(() => createRateLimiter({ rps: -1 })).toThrow(RangeError);
    expect(() => createRateLimiter({ rps: Number.NaN })).toThrow(RangeError);
    expect(() => createRateLimiter({ burst: 0 })).toThrow(RangeError);
  });
});
