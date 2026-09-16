import { describe, expect, it } from 'vitest';

import { createFixedWindowLimiter } from './rateLimit';

function clockAt(startIso: string) {
  let nowMs = Date.parse(startIso);
  return {
    now: () => new Date(nowMs),
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe('createFixedWindowLimiter', () => {
  it('allows `limit` requests per window, then refuses with the time left', () => {
    const clock = clockAt('2026-09-15T12:00:00.000Z');
    const limiter = createFixedWindowLimiter({
      limit: 3,
      windowMs: 60_000,
      maxKeys: 10,
      now: clock.now,
    });

    expect([1, 2, 3].map(() => limiter.hit('a').allowed)).toEqual([true, true, true]);
    clock.advance(15_000);
    expect(limiter.hit('a')).toEqual({ allowed: false, retryAfterSeconds: 45 });
  });

  it('starts a fresh window once the old one has fully elapsed', () => {
    const clock = clockAt('2026-09-15T12:00:00.000Z');
    const limiter = createFixedWindowLimiter({
      limit: 1,
      windowMs: 60_000,
      maxKeys: 10,
      now: clock.now,
    });

    expect(limiter.hit('a').allowed).toBe(true);
    clock.advance(59_999);
    expect(limiter.hit('a').allowed).toBe(false);
    clock.advance(1);
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('counts each key separately', () => {
    const clock = clockAt('2026-09-15T12:00:00.000Z');
    const limiter = createFixedWindowLimiter({
      limit: 1,
      windowMs: 60_000,
      maxKeys: 10,
      now: clock.now,
    });

    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(false);
    expect(limiter.hit('b').allowed).toBe(true);
  });

  it('never tracks more than maxKeys, sweeping expired windows first', () => {
    const clock = clockAt('2026-09-15T12:00:00.000Z');
    const limiter = createFixedWindowLimiter({
      limit: 5,
      windowMs: 1_000,
      maxKeys: 3,
      now: clock.now,
    });

    for (const key of ['a', 'b', 'c']) limiter.hit(key);
    expect(limiter.size()).toBe(3);

    clock.advance(1_000);
    limiter.hit('d');
    // a, b and c had all expired, so the sweep alone made room.
    expect(limiter.size()).toBe(1);
  });

  it('drops the oldest live key when every tracked window is still live', () => {
    const clock = clockAt('2026-09-15T12:00:00.000Z');
    const limiter = createFixedWindowLimiter({
      limit: 1,
      windowMs: 60_000,
      maxKeys: 2,
      now: clock.now,
    });

    limiter.hit('a');
    expect(limiter.hit('a').allowed).toBe(false);
    limiter.hit('b');
    limiter.hit('c');

    expect(limiter.size()).toBe(2);
    // 'a' was evicted: forgetting a key errs towards letting it through.
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.size()).toBe(2);
  });

  it('stays bounded under a flood of distinct keys', () => {
    const clock = clockAt('2026-09-15T12:00:00.000Z');
    const limiter = createFixedWindowLimiter({
      limit: 1,
      windowMs: 60_000,
      maxKeys: 100,
      now: clock.now,
    });

    for (let index = 0; index < 5_000; index += 1) limiter.hit(`10.0.${index >> 8}.${index & 255}`);

    expect(limiter.size()).toBe(100);
  });

  it.each([
    ['limit', { limit: 0, windowMs: 1, maxKeys: 1 }],
    ['windowMs', { limit: 1, windowMs: 1.5, maxKeys: 1 }],
    ['maxKeys', { limit: 1, windowMs: 1, maxKeys: -1 }],
  ])('rejects a non-positive-integer %s', (_name, options) => {
    expect(() => createFixedWindowLimiter({ ...options, now: () => new Date() })).toThrow(
      RangeError,
    );
  });
});
